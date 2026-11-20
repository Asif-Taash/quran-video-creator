"""Find the ayahs someone recites into the microphone (2026-11-20; also
typed words with mistakes, see match_text): the
search box's 🎤 records a part of an ayah or several ayahs, this hears it
and returns the closest places in the Quran -- even when the reading (or
the hearing) has mistakes.

1. The Quran-tuned Whisper the aligner already loads (quran_aligner's
   VERIFY_MODEL, free and local) writes down what was recited.
2. Letters only (no spaces, marks or hamza seats -- quran_aligner's
   _norm_words): a wrong word costs a few letters, not the whole match.
3. Every 4-letter piece of what was heard votes for the places it appears
   in the Quran (rarer pieces weigh more), so the few places worth a look
   come out in milliseconds out of ~320,000 letters.
4. Each is scored by edit distance (all of the heard letters against any
   stretch of the Quran there): score = 1 - mistakes / letters heard.

A leading isti'adha / basmala is set aside first (most readings start
with one, and the basmala alone would match 1:1 and 27:30).

The Arabic text is quran-simple-clean as stored by ayah_search.py
(/app/data/ayah_search/texts.json, basmala already off ayah 1).
"""
import difflib
import json
import logging
import subprocess
import threading
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

TEXTS = Path("/app/data/ayah_search/texts.json")
MAX_SECONDS = 180
# Fewer letters than this (about three words) could be anywhere.
MIN_LETTERS = 10
# A piece found in more places than this tells nothing (الله, الذين...).
MAX_PLACES = 1500
BUCKET = 16
# Places looked at closely: more for a short reading, whose few pieces are
# common ("قل هو الله واحد" shares as many with every "إله واحد" as with
# 112:1), and each look costs little then.
CANDIDATES = 24
MAX_CANDIDATES = 120
# Places scoring within this of the best are shown too: the same words
# come in more than one place (فبأي آلاء ربكما تكذبان, 31 times).
NEAR_BEST = 0.12
LIMIT = 8

_lock = threading.Lock()
_state = None


def available():
    return TEXTS.exists()


def _norm_words(text):
    from quran_aligner import _norm_words as norm
    return norm(text)


def _load():
    global _state
    if _state is None:
        with _lock:
            if _state is None:
                t0 = time.time()
                texts = json.loads(TEXTS.read_text(encoding="utf-8"))
                keys = [tuple(int(x) for x in k.split(":")) for k in texts["keys"]]
                parts = ["".join(_norm_words(t)) for t in texts["ar"]]
                lengths = np.array([len(p) for p in parts])
                quran = "".join(parts)
                letters = np.frombuffer(quran.encode("utf-32-le"), dtype=np.uint32)
                ayah_of = np.repeat(np.arange(len(keys)), lengths)
                grams = {}
                for n in (3, 4):
                    places = defaultdict(list)
                    for i in range(len(quran) - n + 1):
                        places[quran[i:i + n]].append(i)
                    grams[n] = {g: np.array(p, dtype=np.int64) for g, p in places.items()}
                _state = {"keys": keys, "quran": quran, "letters": letters, "ayah_of": ayah_of, "grams": grams,
                          "lengths": lengths, "position": {k: i for i, k in enumerate(keys)}}
                logger.info(f"Recitation search ready in {time.time() - t0:.1f}s.")
    return _state


def _distance(heard, place):
    """Fewest letter edits turning all of `heard` into some stretch of
    `place` (both code-point arrays): (edits, end of the stretch)."""
    span = len(place)
    steps = np.arange(span + 1, dtype=np.int32)
    row = np.zeros(span + 1, dtype=np.int32)
    best = np.empty(span + 1, dtype=np.int32)
    for i, letter in enumerate(heard):
        best[0] = i + 1
        np.minimum(row[:-1] + (place != letter), row[1:] + 1, out=best[1:])
        row = np.minimum.accumulate(best - steps) + steps
    end = int(np.argmin(row))
    return int(row[end]), end


def _strip_prefix(words, prefix):
    """words without a leading `prefix` (heard loosely), or None."""
    target = "".join(prefix)
    best, cut = 0.0, 0
    for k in range(max(1, len(prefix) - 2), min(len(words), len(prefix) + 2) + 1):
        ratio = difflib.SequenceMatcher(None, "".join(words[:k]), target).ratio()
        if ratio > best:
            best, cut = ratio, k
    return words[cut:] if best >= 0.8 else None


def match(words, limit=LIMIT, covers=False):
    """[{"surah", "from", "to", "score"}] best first for heard words; with
    covers, also how much of the first and last ayah the words cover
    ("first_cover", "last_cover", 0-1)."""
    st = _load()
    heard_text = "".join(words)
    size = len(heard_text)
    if size < MIN_LETTERS:
        return []
    heard = np.frombuffer(heard_text.encode("utf-32-le"), dtype=np.uint32)
    n = 3 if size < 16 else 4
    index = st["grams"][n]
    total = len(st["quran"])
    votes = np.zeros(total // BUCKET + 2)
    for i in range(size - n + 1):
        places = index.get(heard_text[i:i + n])
        if places is None or len(places) > MAX_PLACES:
            continue
        diagonal = np.clip(places - i, 0, total - 1) // BUCKET
        np.add.at(votes, diagonal, 1.0 / np.log2(2 + len(places)))
    near = votes.copy()
    near[1:] += votes[:-1]
    near[:-1] += votes[1:]

    taken = []
    for b in np.argsort(-near):
        if near[b] <= 0 or len(taken) >= max(CANDIDATES, min(MAX_CANDIDATES, 2400 // size)):
            break
        if all(abs(int(b) - t) > 2 for t in taken):
            taken.append(int(b))

    slack = 32 + size // 4
    found = []
    for b in taken:
        start = max(0, b * BUCKET - slack)
        stop = min(total, b * BUCKET + BUCKET + size + slack)
        place = st["letters"][start:stop]
        edits, end = _distance(heard, place)
        _, back = _distance(heard[::-1], place[:end][::-1])
        first, last = start + end - back, start + end
        if last <= first:
            continue
        ayahs = st["ayah_of"][first:last]
        # An edge ayah touched by only a letter or two is the loose edge of
        # the match, not something that was read -- unless that is all of it
        # (الم، حم، يس).
        idx, counts = np.unique(ayahs, return_counts=True)
        letters_in = dict(zip(idx.tolist(), counts.tolist()))
        idx, counts = list(idx), list(counts)

        def loose(i, n):
            return n < min(4, int(st["lengths"][i]))

        while len(idx) > 1 and loose(idx[0], counts[0]):
            idx.pop(0)
            counts.pop(0)
        while len(idx) > 1 and loose(idx[-1], counts[-1]):
            idx.pop()
            counts.pop()
        (s1, a1), (s2, a2) = st["keys"][idx[0]], st["keys"][idx[-1]]
        if s1 != s2:
            # Across two surahs: keep the part with more of the reading.
            in_first = sum(c for i, c in zip(idx, counts) if st["keys"][i][0] == s1)
            if in_first * 2 >= sum(counts):
                a2 = max(st["keys"][i][1] for i in idx if st["keys"][i][0] == s1)
                s2 = s1
            else:
                s1, a1 = s2, min(st["keys"][i][1] for i in idx if st["keys"][i][0] == s2)
        # How much of these ayahs the reading covers: among places that
        # match equally well, a whole short ayah read (يسألونك عن الساعة
        # أيان مرساها, 79:42) is likelier than the same words inside a
        # longer one (7:187).
        first_idx, last_idx = st["position"][(s1, a1)], st["position"][(s2, a2)]
        cover = min(1.0, (last - first) / max(1, int(st["lengths"][first_idx:last_idx + 1].sum())))
        result = {"surah": s1, "from": a1, "to": a2, "score": round(1 - edits / size, 3), "cover": cover}
        if covers:
            result["first_cover"] = min(1.0, letters_in.get(first_idx, 0) / max(1, int(st["lengths"][first_idx])))
            result["last_cover"] = min(1.0, letters_in.get(last_idx, 0) / max(1, int(st["lengths"][last_idx])))
        found.append(result)

    found.sort(key=lambda r: (-r["score"], -r["cover"], r["surah"], r["from"]))
    out = []
    for r in found:
        r = {k: v for k, v in r.items() if k != "cover"}
        if out and r["score"] < out[0]["score"] - NEAR_BEST:
            break
        if any(o["surah"] == r["surah"] and o["from"] <= r["to"] and r["from"] <= o["to"] for o in out):
            continue
        out.append(r)
        if len(out) >= limit:
            break
    return out


def match_text(text, limit=LIMIT):
    """match() for typed words: the search box's text search finds nothing
    when a word is misremembered ("وكفر عنا خطايانا" for 3:193)."""
    return match(_norm_words(text[:600]), limit)


def _decode(path, seconds=MAX_SECONDS):
    """16 kHz mono float32 samples of an audio file (the browser's webm, a
    reel's m4a, a video)."""
    raw = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-t", str(seconds),
         "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
        check=True, capture_output=True, timeout=120,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32)


def hear(path):
    """The heard words (normalized) of a recording."""
    from quran_aligner import _get_verify_model

    audio = _decode(path)
    if len(audio) < 16000 * 0.5:
        return []
    segments, _ = _get_verify_model().transcribe(
        audio, language="ar", beam_size=5, without_timestamps=True,
        condition_on_previous_text=False, vad_filter=True,
    )
    return _norm_words(" ".join(s.text for s in segments))


def recognize(path):
    """{"heard": str, "basmala": bool, "results": [...]} for a recording."""
    t0 = time.time()
    words = hear(path)
    heard = " ".join(words)
    rest = _strip_prefix(words, _norm_words("أعوذ بالله من الشيطان الرجيم"))
    if rest is not None:
        words = rest
    basmala = False
    rest = _strip_prefix(words, _norm_words("بسم الله الرحمن الرحيم"))
    if rest is not None and len("".join(rest)) >= MIN_LETTERS:
        words, basmala = rest, True
    t1 = time.time()
    results = match(words)
    logger.info(f"Recitation search: heard {len(words)} words in {t1 - t0:.1f}s, matched in {time.time() - t1:.2f}s: "
                f"{[(r['surah'], r['from'], r['to'], r['score']) for r in results[:3]]}")
    return {"heard": heard, "basmala": basmala, "results": results}


# ---------- Which ayahs a whole short recording holds ----------
# A reel pasted as the audio (2026-11-20): its ayahs are picked by
# themselves, so the link is all a video takes. Heard piece by piece
# (Whisper's segments): a piece that isn't Quran -- the poster talking, a
# nasheed, music heard as words -- matches nothing well and is left out,
# and a repeated ayah only matches again where it already was.
IDENTIFY_SECONDS = 300
IDENTIFY_MIN_SCORE = 0.6
# The first/last ayah counts when most of it was heard: a reel cut a word
# into the next ayah, or starting on the end of the one before, doesn't
# bring that ayah in.
EDGE_COVER = 0.5
# A piece matching far from the rest is a stray (a phrase that also occurs
# elsewhere in the surah).
STRAY_AYAHS = 15
# The longest opening-letters ayah (كهيعص).
OPENING_LETTERS_MAX = 5


def identify(path):
    """{"found": {"surah", "from", "to", "score", "basmala"} | None,
    "heard": str} for a recording of up to IDENTIFY_SECONDS."""
    from quran_aligner import _get_verify_model

    t0 = time.time()
    audio = _decode(path, IDENTIFY_SECONDS)
    if len(audio) < 16000:
        return {"found": None, "heard": ""}
    segments, _ = _get_verify_model().transcribe(
        audio, language="ar", beam_size=5, condition_on_previous_text=False, vad_filter=True,
    )
    isti_adha = _norm_words("أعوذ بالله من الشيطان الرجيم")
    basmala_words = _norm_words("بسم الله الرحمن الرحيم")
    # Whisper's pieces, a short one (a slow, drawn-out reading heard a word
    # or two at a time) joined to the next.
    pieces, pending = [], []
    for segment in segments:
        pending.extend(_norm_words(segment.text))
        if len("".join(pending)) >= 2 * MIN_LETTERS:
            pieces.append(pending)
            pending = []
    if pending:
        pieces.append(pending)
    heard, kept, basmala = [], [], False
    for words in pieces:
        heard.extend(words)
        rest = _strip_prefix(words, isti_adha)
        if rest is not None:
            words = rest
        rest = _strip_prefix(words, basmala_words)
        if rest is not None:
            words = rest
            basmala = basmala or not kept
        if len("".join(words)) < MIN_LETTERS:
            continue
        found = match(words, limit=6, covers=True)
        if found and found[0]["score"] >= IDENTIFY_MIN_SCORE:
            kept.append([r for r in found if r["score"] >= found[0]["score"] - 0.02])
    result = {"found": None, "heard": " ".join(heard)}
    if not kept:
        return result

    # The surah most of it is from (a piece matching equally in several
    # surahs gives each a share).
    votes = defaultdict(float)
    for candidates in kept:
        surahs = {c["surah"] for c in candidates}
        for c in candidates:
            votes[c["surah"]] += c["score"] / len(surahs)
    surah = max(votes, key=votes.get)
    pieces = [[c for c in candidates if c["surah"] == surah] for candidates in kept]
    pieces = [p for p in pieces if p]
    # Pieces with one place in the surah fix where the reading is; a piece
    # with several (a refrain) takes the one nearest to them.
    anchors = [p[0] for p in pieces if len(p) == 1] or [p[0] for p in pieces]
    low, high = min(c["from"] for c in anchors), max(c["to"] for c in anchors)

    def distance(c):
        return 0 if c["to"] >= low and c["from"] <= high else min(abs(c["from"] - high), abs(c["to"] - low))

    chosen = [c for c in (min(p, key=distance) for p in pieces) if distance(c) <= STRAY_AYAHS]
    cover = defaultdict(float)
    for c in chosen:
        for ayah in range(c["from"], c["to"] + 1):
            if c["from"] < ayah < c["to"]:
                part = 1.0
            elif ayah == c["from"]:
                part = c["first_cover"]
            else:
                part = c["last_cover"]
            cover[ayah] = min(1.0, cover[ayah] + part)
    first, last = min(cover), max(cover)
    while first < last and cover[first] < EDGE_COVER:
        first += 1
    while last > first and cover[last] < EDGE_COVER:
        last -= 1
    # A reading of the surah's opening letters alone (الم، حم، يس) is often
    # not heard as words at all; one starting right after them has them.
    st = _load()
    if first > 1 and all(
        int(st["lengths"][st["position"][(surah, ayah)]]) <= OPENING_LETTERS_MAX for ayah in range(1, first)
    ):
        first = 1
    # Al-Fatiha's basmala is its first ayah, not a basmala before it.
    if surah == 1 and basmala:
        first, basmala = 1, False
    score = round(sum(c["score"] for c in chosen) / len(chosen), 3)
    result["found"] = {"surah": surah, "from": first, "to": last, "score": score,
                       "basmala": basmala and first == 1 and surah != 9}
    logger.info(f"Identified {surah}:{first}-{last} (score {score}, {len(chosen)}/{len(kept)} pieces, "
                f"basmala {basmala}) in {time.time() - t0:.1f}s.")
    return result
