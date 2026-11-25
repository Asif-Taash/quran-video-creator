"""Checks a recitation from memory -- the memorization page's تسميع: which
words of the chosen ayahs were said right, said wrong (or with a wrong
vowel), left out or not reached, and what was said that isn't there.

Heard by the Quran ear (scripts/quran_ear.py, the Quran Muaalem model) and
judged word by word by scripts/hifz_judge.py -- see there for the rules and
the measurements. (Until 2026-11-21 this was Whisper + MMS: Whisper merged
a word said twice into one and "corrected" what it heard toward the Quran,
and it couldn't hear a wrong vowel.)

Two ways in:
- check(): a whole recording at once.
- Live (LiveSession): the page sends the microphone's audio about every
  second while the reader recites; each answer is the reading so far, word
  by word, so a slip shows at once and clears when put right.

The last recitations are kept on this computer for review (KEEP_DIR).
"""
import json
import logging
import threading
import time
from pathlib import Path

logger = logging.getLogger(__name__)

MAX_SECONDS = 20 * 60
MAX_WORDS = 1500


def _decode(path):
    from recite_search import _decode as decode
    return decode(path, MAX_SECONDS)


def _reference(expected, surah):
    """The expected ayahs in the phonetic script, each sound owned by a word
    of the mushaf as the page shows it."""
    import hifz_judge

    ayahs = sorted({e["a"] for e in expected})
    shown = {a: [e["u"] for e in expected if e["a"] == a] for a in ayahs}
    return hifz_judge.build_reference(surah, ayahs, shown), ayahs[0]


def _summary(result):
    words = result["words"]
    return (f"reached {result['stop']}, {sum(w['s'] == 'wrong' for w in words)} wrong, "
            f"{sum(w['s'] == 'tashkeel' for w in words)} vowel, {sum(w['s'] == 'missing' for w in words)} missing, "
            f"{sum(x['kind'] == 'added' for x in result['extras'])} added, "
            f"{sum(1 for w in words if w.get('checked'))} cleared by the acoustic check")


# ---------- A voice too faint to judge ----------
# 2026-11-24: a reading said almost in a whisper (voice 12 dB over the room,
# against 20-31 dB in the reader's other readings) was heard as «مممم ۦۦۦ»
# and nine right words were called wrong. A slip is only called where the
# ear heard the voice clearly; elsewhere the word is "unclear", and the page
# asks the reader to come closer to the microphone.
# 2026-11-25: loudness alone couldn't tell that whisper from a reader whose
# laptop microphone puts their normal voice only 11-15 dB over the room --
# they got «صوتك منخفض» on and off while reading, and slips faded to
# "unclear". The ear's own confidence does tell them apart: the best sound's
# probability over the word's voiced frames was 0.40 / 0.74 (lowest tenth /
# median) on the whisper, 0.92+ / 0.96 on every normal reading (5
# recordings, 385 words). So: unclear = the ear unsure, or barely any voice.
QUIET_CONF = 0.7          # a slip heard less surely than this is "unclear"
QUIET_ALERT_CONF = 0.8    # the last seconds heard less surely: "come closer"
QUIET_FLOOR_DB = 6.0      # dB over the reading's background: barely a voice
QUIET_LOUD_DB = 16.0      # over this, the voice is loud enough: no «come closer»


def _levels(audio, sr=16000, win=0.05):
    import numpy as np

    n = int(sr * win)
    k = len(audio) // n
    if k == 0:
        return np.array([-120.0])
    frames = audio[: k * n].reshape(k, n)
    return 20 * np.log10(np.sqrt((frames ** 2).mean(axis=1)) + 1e-6)


def _noise_db(audio):
    import numpy as np

    return float(np.percentile(_levels(audio), 10))


def _voice_db(audio, t0, t1):
    import numpy as np

    seg = audio[int(max(0.0, t0) * 16000): int(t1 * 16000)]
    return float(np.percentile(_levels(seg), 90)) if len(seg) >= 800 else -120.0


def _ear_conf(lp, fps, t0, t1):
    """How surely the ear heard t0..t1: the mean probability of the best
    sound over its voiced frames (None: nothing voiced)."""
    f0 = max(0, int(t0 * fps))
    f1 = min(lp.shape[0], max(f0 + 1, int(t1 * fps)))
    seg = lp[f0:f1].exp()
    if seg.shape[0] == 0:
        return None
    voiced = seg[:, 0] < 0.5
    if not bool(voiced.any()):
        return None
    return float(seg[voiced][:, 1:].max(-1).values.mean())


def guard_quiet(audio, result, lp=None, fps=25.0):
    """Slips the ear didn't hear surely (or barely a voice) become "unclear"."""
    noise = _noise_db(audio)
    for w in result["words"]:
        if w["s"] in ("wrong", "tashkeel", "missing") and "t0" in w and "t1" in w:
            v = _voice_db(audio, w["t0"] - 0.1, w["t1"] + 0.1)
            conf = _ear_conf(lp, fps, w["t0"], w["t1"]) if lp is not None else None
            if v - noise < QUIET_FLOOR_DB or (conf is not None and conf < QUIET_CONF):
                w.clear()
                w["s"] = "unclear"
    return result


def recent_quiet(audio, lp=None, fps=25.0, sec=4.0):
    """Is the reader speaking, but too faintly to be heard surely? (the last
    `sec` seconds)"""
    if len(audio) < 16000:
        return False
    # Up to the live edge: the last moments are always heard less surely.
    end = len(audio) / 16000 - 0.5
    noise = _noise_db(audio)
    v = _voice_db(audio, end - sec, end)
    if v - noise < 6.0:
        return False  # not speaking
    if v - noise >= QUIET_LOUD_DB:
        return False  # loud enough: coming closer won't help
    conf = _ear_conf(lp, fps, end - sec, end) if lp is not None else None
    return bool(conf is not None and conf < QUIET_ALERT_CONF)


def check(path, expected, surah):
    """expected: [{"a": ayah, "i": word index in the ayah, "u": the word as
    shown (Uthmani)}] in reading order, at most MAX_WORDS. Returns
    {"words", "extras", "heard", "duration", "checked", "seconds"}."""
    import hifz_judge
    import quran_ear

    t0 = time.time()
    audio = _decode(path)
    duration = len(audio) / 16000
    if duration < 0.5:
        return {"words": [{"s": "unread"} for _ in expected], "extras": [], "heard": "", "duration": duration,
                "checked": 0, "seconds": round(time.time() - t0, 2)}
    ref, first = _reference(expected, surah)
    lp, fps = quran_ear.frame_logprobs(audio)
    result = guard_quiet(audio, hifz_judge.check_frames(lp, fps, ref, surah, first), lp, fps)
    _keep_for_review(audio, expected, result)
    logger.info(f"Hifz check: {len(expected)} words, {duration:.0f}s, {_summary(result)}, {time.time() - t0:.1f}s")
    return {"words": result["words"], "extras": result["extras"], "heard": result["heard"], "fixed": result.get("fixed", []),
            "duration": round(duration, 2), "checked": sum(1 for w in result["words"] if w.get("checked")),
            "seconds": round(time.time() - t0, 2)}


# ---------- Kept recordings ----------
# The last recitations checked, kept on this computer only (git-ignored
# backend/data), so a check that went wrong on the reader's own voice can be
# looked into: the audio as heard, the words expected, what the ear wrote
# and the verdicts.
KEEP_DIR = Path("/app/data/hifz_recordings")
KEEP_LAST = 30


def _keep_for_review(audio, expected, result):
    try:
        import wave

        import numpy as np

        KEEP_DIR.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        base = KEEP_DIR / f"{stamp}-{int(time.time() * 1000) % 1000:03d}"
        with wave.open(str(base.with_suffix(".wav")), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
        base.with_suffix(".json").write_text(json.dumps({
            "engine": "quran-ear", "expected": expected, "heard": result.get("heard"),
            "words": result["words"], "extras": result["extras"], "stop": result.get("stop"),
        }, ensure_ascii=False))
        for f in sorted(KEEP_DIR.glob("*.wav"))[:-KEEP_LAST]:
            f.unlink(missing_ok=True)
            f.with_suffix(".json").unlink(missing_ok=True)
    except Exception as e:  # never fails a check
        logger.warning(f"Couldn't keep the recitation for review: {e}")


# ---------- Live: checked while the reader recites ----------
# The page sends 16 kHz PCM about every second. The ear's frames older than
# LIVE_SETTLED_SEC before the end of the audio are settled and kept; each
# pass hears only the rest (with CONTEXT_SEC of settled audio before it, so
# its first sounds are heard right), a few seconds whatever the reading's
# length. The whole reading so far is then judged as at the end. A word
# said right shows at once. A slip shows once the reader has gone on to the
# next word (and LIVE_EDGE_SEC has passed): the last word before a pause
# lacks its last sounds until the reading goes on («قَدِيرٌ» heard «قَدِۦ»
# while the reader takes a breath), so judging it earlier flashed false
# warnings. Simulated on 12 recitations (405 words, audio every 0.5 s,
# 2026-11-24): words that flashed a warning and cleared, 18 with a 1 s wait
# alone, 10 with this rule and a 0.3 s wait. Stopping judges the whole
# recording's frames once more.

LIVE_SETTLED_SEC = 3.0
# Up to this long, stopping hears the whole recording again (about 0.3 s of
# GPU per minute of reading); longer ones keep the live passes' frames.
FINAL_REHEAR_SEC = 10 * 60
LIVE_EDGE_SEC = 0.3
LIVE_MAX_SESSIONS = 4
LIVE_IDLE_SEC = 15 * 60

_live = {}
_live_lock = threading.Lock()


class LiveSession:
    def __init__(self, expected, surah):
        import numpy as np

        self.expected = expected
        self.surah = surah
        self.ref, self.first = _reference(expected, surah)
        self.audio = np.zeros(0, dtype=np.float32)
        self.settled = None  # settled frames [F, V]
        self.settled_sec = 0.0
        self.fps = 25.0
        self.lock = threading.Lock()
        self.touched = time.time()
        self.last = None
        self.prev_raw = {}    # word -> its state in the last pass (before holding back)

    def add(self, pcm):
        import numpy as np

        x = np.frombuffer(pcm[: len(pcm) // 2 * 2], dtype="<i2").astype(np.float32) / 32768.0
        room = int(MAX_SECONDS * 16000) - len(self.audio)
        if room > 0:
            self.audio = np.concatenate([self.audio, x[:room]])
        self.touched = time.time()

    def _frames(self, settle=True):
        """The ear's frames for all the audio so far: the settled ones, and
        the rest heard now."""
        import quran_ear
        import torch

        end = len(self.audio) / 16000
        start = self.settled_sec
        a = max(0.0, start - quran_ear.CONTEXT_SEC)
        tail, fps = quran_ear.frame_logprobs(self.audio[int(a * 16000):])
        tail = tail[int(round((start - a) * fps)):]
        frames = tail if self.settled is None else torch.cat([self.settled, tail])
        self.fps = fps
        if settle and end - LIVE_SETTLED_SEC > start + 1.0:
            keep = (0 if self.settled is None else self.settled.shape[0]) + int((end - LIVE_SETTLED_SEC - start) * fps)
            self.settled = frames[:keep]
            self.settled_sec = start + (keep - (frames.shape[0] - tail.shape[0])) / fps
        return frames

    def update(self):
        import hifz_judge

        end = len(self.audio) / 16000
        if end < 0.6:
            return {"words": [{"s": "unread"} for _ in self.expected], "extras": [], "stop": 0, "heard": "",
                    "duration": round(end, 2)}
        frames = self._frames()
        result = guard_quiet(self.audio, hifz_judge.check_frames(frames, self.fps, self.ref, self.surah, self.first, live=True),
                             frames, self.fps)
        cutoff = end - LIVE_EDGE_SEC
        words = result["words"]
        bad = ("wrong", "missing", "tashkeel")
        # Judged from the end back: a slip waits for the next word to be heard.
        # So does an "unclear" (a word being said is heard least surely: it
        # flashed faded, then plain, on each new word).
        went_on = False
        for k in range(len(words) - 1, -1, -1):
            w = words[k]
            if w["s"] in bad or w["s"] == "unclear":
                t = w.get("t1")
                if t is None:
                    t = next((x["t0"] for x in words[k + 1:] if "t0" in x), None)
                if t is None or t > cutoff or not went_on:
                    words[k] = {"s": "unread"}
            went_on = went_on or w["s"] != "unread"
        # A slip shows once two passes in a row find it (0.3 s later): one
        # pass alone flashed a word red for a moment while the reading's
        # path turned into a repeat (2026-11-25, 9 kept readings).
        raw = {k: w["s"] for k, w in enumerate(words) if w["s"] != "unread"}
        if self.last is not None:
            for k, w in enumerate(words):
                if w["s"] in bad and self.prev_raw.get(k) != w["s"]:
                    words[k] = self.last["words"][k] if k < len(self.last["words"]) else {"s": "unread"}
        self.prev_raw = raw
        self.last = {"words": words, "extras": [x for x in result["extras"] if x["t1"] <= cutoff],
                     "fixed": result.get("fixed", []),
                     "stop": result["stop"], "heard": result["heard"], "duration": round(end, 2),
                     "repeating": bool(result.get("repeating")),
                     "quiet": recent_quiet(self.audio, frames, self.fps)}
        return self.last

    def finish(self):
        import hifz_judge

        t0 = time.time()
        duration = len(self.audio) / 16000
        if duration < 0.5:
            return {"words": [{"s": "unread"} for _ in self.expected], "extras": [], "heard": "",
                    "duration": duration, "checked": 0, "seconds": 0}
        if duration <= FINAL_REHEAR_SEC:
            # The final word: the whole recording heard again in one go (as
            # check() does). The live passes heard it in pieces, each frame
            # with only a little audio after it; a 52 s reading judged on
            # those pieces had two words wrongly flagged.
            import quran_ear

            frames, self.fps = quran_ear.frame_logprobs(self.audio)
        else:
            frames = self._frames(settle=False)
        result = guard_quiet(self.audio, hifz_judge.check_frames(frames, self.fps, self.ref, self.surah, self.first),
                             frames, self.fps)
        _keep_for_review(self.audio, self.expected, result)
        logger.info(f"Hifz live check: {len(self.expected)} words, {duration:.0f}s, {_summary(result)}, "
                    f"{time.time() - t0:.1f}s")
        return {"words": result["words"], "extras": result["extras"], "heard": result["heard"],
                "fixed": result.get("fixed", []),
                "duration": round(duration, 2), "checked": sum(1 for w in result["words"] if w.get("checked")),
                "seconds": round(time.time() - t0, 2)}


def _warm():
    """Loads the ear before the first words arrive (after an idle spell the
    worker has unloaded it)."""
    try:
        import numpy as np
        import quran_ear

        quran_ear.warm()
        # One short pass too: the first one on the GPU is slow.
        quran_ear.frame_logprobs(np.zeros(16000, dtype=np.float32))
    except Exception as e:
        logger.warning(f"Quran ear warm-up failed: {e}")


def warm_soon():
    threading.Thread(target=_warm, daemon=True).start()


def live_start(expected, surah):
    import uuid

    threading.Thread(target=_warm, daemon=True).start()
    session = uuid.uuid4().hex
    live = LiveSession(expected, surah)
    with _live_lock:
        now = time.time()
        for key in [k for k, v in _live.items() if now - v.touched > LIVE_IDLE_SEC]:
            del _live[key]
        while len(_live) >= LIVE_MAX_SESSIONS:
            del _live[min(_live, key=lambda k: _live[k].touched)]
        _live[session] = live
    return session


def live_audio(session, pcm, final=False):
    """Adds audio to a live session; the reading so far, judged, or (final)
    the check of the whole recording. None for an unknown session."""
    with _live_lock:
        live = _live.get(session)
    if live is None:
        return None
    with live.lock:
        if pcm:
            live.add(pcm)
        if not final:
            return live.update()
        with _live_lock:
            _live.pop(session, None)
        return live.finish()
