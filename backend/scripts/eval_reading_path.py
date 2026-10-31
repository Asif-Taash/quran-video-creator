"""Regression check for repeat handling (quran_aligner._reading_path): every
case is a recitation with KNOWN repeats, spliced from a clean recording at
word boundaries (a jump back gets a real breath pause from the same
recording), plus unspliced controls in which nothing may be found. Each is
aligned the way production aligns it -- an upload (no context) or a
whole-surah recording (neighbouring ayahs as context) -- and the reading
path is compared with the truth word by word. Run in the backend container
(the CPU is fine; the server process holds most of the GPU):

    CUDA_VISIBLE_DEVICES= python /app/scripts/eval_reading_path.py [case-name-prefix ...]
    ... --json /tmp/out.json   also writes every case's prepared-JSON shape
                               (verses, readings) + truth, for the on-screen
                               check (frontend: scripts/check-reading-display.ts)

Sources live in /app/data/reading_path_eval (copied there so the size-capped
surah_cache can't evict them). Emissions are cached next to them.

A case passes when every recited target word is found at its true time
(the reading path names the same ayah:word at the middle of every truth
word) and no repeat is invented. Controls pass when no jump is found (the
fajr upload has two real repeats, 79:29 "وَأَخْرَجَ ضُحَاهَا" and 79:32).

A false start or restart of the selection's FIRST ayah before its reading
is not searched for (see quran_aligner.RETURN_LEAD_SEC): the default trim
cuts it off, so the video starts at the reading that counts.

Baseline (2026-10-28): ctc-v7 (repeats searched in holes of the linear
alignment) 7/26 -- 2 of 21 cases. ctc-v8 (path search) 20/26: 15/21 cases,
3 of the 6 failures flagged for review, 5/5 controls clean and unflagged.
Not found yet: a backstep inside one unsplit ayah (the screen is right, only
the highlight isn't), a tail repeat in the echoing fajr audio, one word of
the next ayah read in connection before going back (fajr79_back_after_next).

Baseline (2026-10-31), 97 cases + 15 controls over 12 reciters, sources
spliced with room tone and faded joins: ctc-v12 46/97 word-level, 68/97 on
screen (every ayah appears in order, within SCREEN_TOL_SEC), 13 silently
wrong on screen, 14/15 controls. ctc-v13 (Whisper's reading track, text
after the selection, verified jumps kept, one-word restarts) 55/97 word-level,
82/97 on screen, 9 silently wrong, 15/15 controls, no case worse on screen.
Still missed: long one-word restarts neither ear hears (Ajmi, some 98:8
"جزاؤهم"), fajr79_back_after_next.
From here the first saying of a one-word restart is played at another speed
and quieter (RESTART_SPEED, RESTART_GAIN_DB), so it is no longer a copy of
the second. On that set, both on the GPU: ctc-v13 82/97 on screen, 10
silently wrong; ctc-v14 (readings start where the voice does, one-word
restarts matched against the reciter's own words) 59/97 word-level, 88/97 on
screen, 6 silently wrong, 15/15 controls, no case worse. Held out: ctc-v13
12/36 on screen, 21 silently wrong; ctc-v14 20/36, 13, controls 6/6, no
case worse.
The HELDOUT_RECITERS_79 cases are never tuned on: run them only to measure.
"""
import argparse
import hashlib
import json
import logging
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import quran_aligner as qa  # noqa: E402

EVAL_DIR = Path("/app/data/reading_path_eval")
CACHE_DIR = EVAL_DIR / "cache"
SR = qa.SAMPLE_RATE

# name: (source file, surah, mode, [(ayah, from, to), ...] in reading order)
# mode "upload": the audio is the reading alone, aligned without context.
# mode "surah": the previous and next ayah are read around it and aligned as
# context, like a built-in reciter's whole-surah recording.
CASES = {
    # Maher, Al-Bayyinah (clean studio)
    "maher98_tail_repeat": ("maher_098.mp3", 98, "upload", [(2, 0, 5), (2, 4, 5), (3, 0, 2), (4, 0, 10)]),
    "maher98_restart_ayah": ("maher_098.mp3", 98, "upload", [(2, 0, 5), (3, 0, 2), (3, 0, 2), (4, 0, 10)]),
    "maher98_one_word_then_back": ("maher_098.mp3", 98, "upload", [(2, 0, 5), (3, 0, 0), (2, 4, 5), (3, 0, 2), (4, 0, 10)]),
    "maher98_back_across_boundary": ("maher_098.mp3", 98, "upload", [(2, 0, 5), (3, 0, 2), (2, 3, 5), (3, 0, 2), (4, 0, 10)]),
    "maher98_mid_ayah_backstep": ("maher_098.mp3", 98, "upload", [(4, 0, 7), (4, 5, 10), (5, 0, 16)]),
    # (A false start before the selection's first word is cut off by the
    # default trim, so the false start here follows a selected ayah.)
    "maher98_false_start": ("maher_098.mp3", 98, "upload", [(3, 0, 2), (4, 0, 4), (4, 0, 10), (5, 0, 16)]),
    "maher98_two_repeats": ("maher_098.mp3", 98, "upload", [(2, 0, 5), (2, 3, 5), (3, 0, 2), (3, 0, 2), (4, 0, 10)]),
    "maher98_back_two_ayahs": ("maher_098.mp3", 98, "upload", [(2, 0, 5), (3, 0, 2), (4, 0, 3), (2, 0, 5), (3, 0, 2), (4, 0, 10)]),
    "maher98_last_ayah_again": ("maher_098.mp3", 98, "upload", [(2, 0, 5), (3, 0, 2), (3, 0, 2)]),
    "maher98_surah_tail_repeat": ("maher_098.mp3", 98, "surah", [(1, 0, 11), (2, 0, 5), (2, 3, 5), (3, 0, 2), (4, 0, 10)]),
    "maher98_surah_back_after_next": ("maher_098.mp3", 98, "surah", [(2, 0, 5), (3, 0, 2), (4, 0, 2), (3, 0, 2), (4, 0, 10), (5, 0, 16)]),
    # Raad Al-Kurdi, An-Nazi'at (studio)
    "kurdi79_tail_repeat": ("kurdi_079.mp3", 79, "upload", [(28, 0, 2), (29, 0, 3), (29, 2, 3), (30, 0, 3), (31, 0, 3), (32, 0, 1)]),
    "kurdi79_restart_ayah": ("kurdi_079.mp3", 79, "upload", [(29, 0, 3), (30, 0, 3), (31, 0, 3), (31, 0, 3), (32, 0, 1)]),
    "kurdi79_short_ayah_twice": ("kurdi_079.mp3", 79, "upload", [(31, 0, 3), (32, 0, 1), (32, 0, 1), (33, 0, 2)]),
    "kurdi79_back_after_next": ("kurdi_079.mp3", 79, "upload", [(29, 0, 3), (30, 0, 3), (31, 0, 1), (30, 2, 3), (31, 0, 3), (32, 0, 1)]),
    "kurdi79_false_start": ("kurdi_079.mp3", 79, "upload", [(29, 0, 3), (30, 0, 1), (30, 0, 3), (31, 0, 3), (32, 0, 1)]),
    "kurdi79_waqf_backstep": ("kurdi_079.mp3", 79, "upload", [(27, 0, 4), (27, 3, 6), (28, 0, 2), (29, 0, 3)]),
    "kurdi79_surah_restart": ("kurdi_079.mp3", 79, "surah", [(28, 0, 2), (29, 0, 3), (30, 0, 3), (30, 0, 3), (31, 0, 3), (32, 0, 1)]),
    # The user's own fajr-prayer upload (mosque echo, long melodic endings)
    "fajr79_tail_repeat": ("kurdi_fajr_079_upload.mp3", 79, "upload", [(27, 0, 6), (28, 0, 2), (28, 1, 2)]),
    "fajr79_restart_ayah": ("kurdi_fajr_079_upload.mp3", 79, "upload", [(27, 0, 6), (28, 0, 2), (28, 0, 2)]),
    "fajr79_back_after_next": ("kurdi_fajr_079_upload.mp3", 79, "upload", [(32, 0, 1), (33, 0, 0), (32, 0, 1), (33, 0, 2)]),
    # One word said, a breath, then said again and read on (user report,
    # 2026-10-29): the word -- at an ayah's start, the ayah -- must show from
    # the FIRST time it is said.
    "maher98_one_word_restart": ("maher_098.mp3", 98, "upload", [(2, 0, 5), (3, 0, 0), (3, 0, 2), (4, 0, 10)]),
    "maher98_one_word_mid": ("maher_098.mp3", 98, "upload", [(3, 0, 2), (4, 0, 1), (4, 1, 10), (5, 0, 5)]),
    "maher98_one_word_restart_long": ("maher_098.mp3", 98, "upload", [(7, 0, 8), (8, 0, 0), (8, 0, 11)]),
    "kurdi79_one_word_restart": ("kurdi_079.mp3", 79, "upload", [(30, 0, 3), (31, 0, 0), (31, 0, 3), (32, 0, 1)]),
    "kurdi79_one_word_mid": ("kurdi_079.mp3", 79, "upload", [(28, 0, 2), (29, 0, 2), (29, 2, 3), (30, 0, 3)]),
    "ajmi79_one_word_restart": ("ajmi_079.mp3", 79, "upload", [(27, 0, 6), (28, 0, 0), (28, 0, 2), (29, 0, 3)]),
    "ajmi79_one_word_restart_31": ("ajmi_079.mp3", 79, "upload", [(30, 0, 3), (31, 0, 0), (31, 0, 3), (32, 0, 1)]),
    "ajmi79_one_word_mid": ("ajmi_079.mp3", 79, "upload", [(28, 0, 2), (29, 0, 2), (29, 2, 3), (30, 0, 3)]),
}

# The same shapes read by eight more reciters (their mp3quran recordings of
# Al-Bayyinah): the thresholds were found on Maher, Al-Kurdi and the fajr
# upload, and must hold for every voice -- slow and fast, studio and echo, a
# 32 kbps file (Abdul Basit).
OTHER_RECITERS_98 = ["husary", "minshawi", "abdulbasit", "sudais", "mishary", "yasser", "shatri", "ghamdi"]
SHAPES_98 = {
    "tail_repeat": ("upload", [(2, 0, 5), (2, 4, 5), (3, 0, 2), (4, 0, 10)]),
    "restart_ayah": ("upload", [(2, 0, 5), (3, 0, 2), (3, 0, 2), (4, 0, 10)]),
    "back_after_next": ("upload", [(2, 0, 5), (3, 0, 2), (4, 0, 2), (3, 0, 2), (4, 0, 10)]),
    "mid_ayah_backstep": ("upload", [(5, 0, 10), (5, 8, 16)]),
    "two_repeats": ("upload", [(2, 0, 5), (2, 3, 5), (3, 0, 2), (3, 0, 2), (4, 0, 10)]),
    "last_ayah_again": ("upload", [(2, 0, 5), (3, 0, 2), (3, 0, 2)]),
    "surah_restart": ("surah", [(1, 0, 11), (2, 0, 5), (3, 0, 2), (3, 0, 2), (4, 0, 10), (5, 0, 16)]),
    "one_word_restart": ("upload", [(2, 0, 5), (3, 0, 0), (3, 0, 2), (4, 0, 10)]),
    "one_word_restart_long": ("upload", [(7, 0, 8), (8, 0, 0), (8, 0, 11)]),
    "one_word_mid": ("upload", [(3, 0, 2), (4, 0, 1), (4, 1, 10), (5, 0, 5)]),
}
# These recordings already read part of 98:5-8 twice (see the controls
# below), so a case built from those ayahs has a wrong truth.
NATURAL_REPEATS_98 = {"yasser": 5, "shatri": 5, "ghamdi": 5, "minshawi": 5}
for _reciter in OTHER_RECITERS_98:
    for _shape, (_mode, _plan) in SHAPES_98.items():
        _from = NATURAL_REPEATS_98.get(_reciter)
        if _from and any(a >= _from for a, _, _ in _plan) and _mode == "upload":
            continue
        CASES[f"{_reciter}98_{_shape}"] = (f"{_reciter}_098.mp3", 98, _mode, _plan)
# Held out: the same kinds of repeat in An-Nazi'at by six of them, never
# looked at while ctc-v13 was tuned -- what it does on recitations it
# wasn't fitted to.
HELDOUT_RECITERS_79 = ["husary", "minshawi", "sudais", "abdulbasit", "mishary", "shatri"]
SHAPES_79 = {
    "tail_repeat": ("upload", [(28, 0, 2), (29, 0, 3), (29, 2, 3), (30, 0, 3)]),
    "restart_ayah": ("upload", [(29, 0, 3), (30, 0, 3), (31, 0, 3), (31, 0, 3), (32, 0, 1)]),
    "back_after_next": ("upload", [(29, 0, 3), (30, 0, 3), (31, 0, 1), (30, 2, 3), (31, 0, 3)]),
    "one_word_restart": ("upload", [(30, 0, 3), (31, 0, 0), (31, 0, 3), (32, 0, 1)]),
    "one_word_mid": ("upload", [(29, 0, 2), (29, 2, 3), (30, 0, 3)]),
    "last_ayah_again": ("upload", [(32, 0, 1), (33, 0, 2), (33, 0, 2)]),
}
for _reciter in HELDOUT_RECITERS_79:
    for _shape, (_mode, _plan) in SHAPES_79.items():
        CASES[f"{_reciter}79_{_shape}"] = (f"{_reciter}_079.mp3", 79, _mode, _plan)

# Unspliced recordings: (source, surah, first ayah, last ayah, extra seconds
# around the ayahs -- None: the whole recording, as an upload is aligned --,
# expected target readings with a jump [(ayah, from, to)]). The first word
# must also stay where the clean alignment of the recording puts it.
CONTROLS = {
    "control_maher98": ("maher_098.mp3", 98, 1, 8, 3.0, []),
    "control_maher74": ("maher_074.mp3", 74, 1, 10, 3.0, []),
    "control_ajmi79": ("ajmi_079.mp3", 79, 27, 33, 3.0, []),
    "control_kurdi79": ("kurdi_079.mp3", 79, 27, 33, 3.0, []),
    # The user hears 79:32 read twice (2026-10-28); the first time inside a
    # stretch the alignment model can't hear (see quran_aligner.DEAF_*).
    "control_fajr79": ("kurdi_fajr_079_upload.mp3", 79, 27, 33, 10.0, [(29, 2, 3), (32, 0, 1)]),
    # The user's whole 7.5-minute upload: ctc-v8 lost 79:29's repeat here
    # (and, fixed alone, put 79:27 into the ayah before it).
    "control_fajr79_whole_upload": ("kurdi_fajr_079_upload.mp3", 79, 27, 33, None, [(29, 2, 3), (32, 0, 1)]),
    # Real repeats, heard by the user. Their upload of Maher's whole Nuh
    # (2026-10-30), aligned for 71:10-15: 12's "وَيَجْعَل لَّكُمْ" and all of
    # 13-14 are read twice, and after 15 he reads on. ctc-v12 verified both
    # repeats in every round, but kept inventing new ones in 16 until the
    # rounds ran out, and fell back to reading everything once.
    "control_maher71_upload": ("maher_upload_071.mp3", 71, 10, 15, None, [(12, 3, 8), (13, 0, 5)]),
    # Al-Ajmi's mp3quran 17:70-72 (75 s from 1028.888 s): "فَأُو۟لَٰٓئِكَ يَقْرَءُونَ
    # كِتَٰبَهُمْ" read twice (39.3 s and 44.8 s), the second time partly in a
    # stretch the alignment model can't hear.
    "control_ajmi17_natural": ("ajmi_017_70-72.mp3", 17, 70, 72, None, [(71, 10, 15)], "surah"),
}
for _reciter in OTHER_RECITERS_98:
    # Yasser, Shatri and Ghamdi read parts of 98:6 and 98:8 twice in these
    # recordings, Minshawi 98:5's "مُخْلِصِينَ لَهُ ٱلدِّينَ" (both ears hear
    # it), so their controls stop at 98:4.
    CONTROLS[f"control_{_reciter}98"] = (f"{_reciter}_098.mp3", 98, 1, 4 if _reciter in NATURAL_REPEATS_98 else 8, 3.0, [])
for _reciter in HELDOUT_RECITERS_79:
    CONTROLS[f"control_{_reciter}79"] = (f"{_reciter}_079.mp3", 79, 27, 33, 3.0, [])
# The clean linear alignment of these sources: only these ayahs (the
# upload's other ayahs repeat too; the clip holds just a few seconds of its
# neighbours).
SOURCE_AYAHS = {"maher_upload_071.mp3": (10, 15), "ajmi_017_70-72.mp3": (70, 72)}


def _cached(key, compute):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / f"{hashlib.sha1(key.encode()).hexdigest()[:16]}.npy"
    if path.exists():
        return np.load(path)
    value = compute()
    np.save(path, value)
    return value


def _emission(wav, tag):
    import torch
    key = f"emission:{tag}:{hashlib.sha1(wav.tobytes()).hexdigest()}"
    return torch.from_numpy(_cached(key, lambda: qa.compute_emission(wav).numpy()))


_sources = {}


def _source(name, surah):
    """(wav, {(ayah, token): (start, end)}) -- every word of the recording's
    ayahs where the clean linear alignment puts it (seconds)."""
    if name in _sources:
        return _sources[name]
    path = EVAL_DIR / name
    wav = qa._to_float(qa.decode_pcm(path, start=0, duration=qa._probe_duration(path)))
    words = qa.fetch_surah_words(surah)
    if name in SOURCE_AYAHS:
        a0, a1 = SOURCE_AYAHS[name]
    else:
        ayahs = sorted({a for c in CASES.values() if c[0] == name for a, _, _ in c[3]}
                       | {a for c in CONTROLS.values() if c[0] == name for a in range(c[2], c[3] + 1)})
        a0, a1 = max(1, ayahs[0] - 1), min(len(words), ayahs[-1] + 1)
    emission = _emission(wav, name)
    units = qa._build_units(surah, words, range(a0, a1 + 1), set(range(a0, a1 + 1)))
    qa._ctc_align(emission, units)
    qa._resolve_times(units, qa._energy_db(wav), 0.0, len(wav) / SR)
    pos = {(u["ayah"], u["index"]): (u["start"], u["end"]) for u in units if "f0" in u}
    _sources[name] = (wav, pos, a0, a1)
    return _sources[name]


DIGITAL_SILENCE_DB = -60.0
SPLICE_FADE_SEC = 0.01


def _pause_audio(wav, pos, seconds):
    """A real breath pause of the recording: its quietest stretch between
    the aligned words (the longest gap can be a melodic hold, not a pause)
    that still has room tone -- the gaps between ayahs in mp3quran's
    recordings are edited to digital silence, which no breath is, and right
    before it the alignment model heard a word much less clearly."""
    env = qa._energy_db(wav)
    n = int(seconds / qa.ENV_HOP_SEC)
    lo = int(min(s for s, _ in pos.values()) / qa.ENV_HOP_SEC)
    hi = int(max(e for _, e in pos.values()) / qa.ENV_HOP_SEC) - n
    from numpy.lib.stride_tricks import sliding_window_view
    mean = np.convolve(env, np.ones(n) / n, mode="valid")[lo:hi]
    floor = sliding_window_view(env, n).min(axis=1)[lo:hi]
    live = np.where(floor > DIGITAL_SILENCE_DB, mean, np.inf)
    start = lo + int(np.argmin(live if np.isfinite(live).any() else mean))
    return wav[int(start * qa.ENV_HOP_SEC * SR):int(start * qa.ENV_HOP_SEC * SR) + int(seconds * SR)]


def _faded(piece):
    """The piece with SPLICE_FADE_SEC fades at both ends: no click where it
    is joined to the next one."""
    k = min(int(SPLICE_FADE_SEC * SR), len(piece) // 2)
    if k < 2:
        return piece
    out = piece.astype(np.float32).copy()
    ramp = np.linspace(0.0, 1.0, k, dtype=np.float32)
    out[:k] *= ramp
    out[-k:] *= ramp[::-1]
    return out


# A word said twice is never said the same way twice: the first saying of
# a one-word restart is played RESTART_SPEED times faster (pitch with it,
# like a tape) and RESTART_GAIN_DB quieter, else it is a copy of the
# second and matches it far too well.
RESTART_SPEED = (0.94, 1.06)
RESTART_GAIN_DB = -2.0


def _varied(seg, speed):
    import torch
    import torchaudio.functional as F
    out = F.resample(torch.from_numpy(np.ascontiguousarray(seg, dtype=np.float32)),
                     orig_freq=int(round(100 * speed)), new_freq=100).numpy()
    return (out * 10 ** (RESTART_GAIN_DB / 20)).astype(seg.dtype)


def _splice(name, surah, plan, speed=1.0):
    wav, pos, _, _ = _source(name, surah)
    words = qa.fetch_surah_words(surah)
    real = lambda a, i, j: [k for k in range(i, j + 1) if (a, k) in pos]  # noqa: E731
    pause = _pause_audio(wav, pos, 0.45)
    pieces = [np.zeros(int(0.3 * SR), dtype=wav.dtype)]
    t = 0.3
    truth = []
    prev = None  # (ayah, last token) of the previous piece
    for p, (ayah, i, j) in enumerate(plan):
        ks = real(ayah, i, j)
        start, end = pos[(ayah, ks[0])][0], pos[(ayah, ks[-1])][1]
        sequential = prev is not None and (
            (prev[0] == ayah and real(ayah, prev[1] + 1, ks[0]) == [ks[0]])
            or (ayah == prev[0] + 1 and ks[0] == real(ayah, 0, len(words[ayah]["tokens"]) - 1)[0]
                and prev[1] == real(prev[0], 0, len(words[prev[0]]["tokens"]) - 1)[-1]))
        if prev is not None:
            if sequential:
                # Carry on with the recording's own gap between the two words.
                gap_from = pos[prev][1]
                pieces.append(wav[int(gap_from * SR):int(start * SR)])
                t += (int(start * SR) - int(gap_from * SR)) / SR
            else:
                pieces[-1] = _faded(pieces[-1])
                pieces.append(_faded(pause))
                t += len(pause) / SR
        seg = wav[int(start * SR):int(end * SR)]
        restart = i == j and p + 1 < len(plan) and plan[p + 1][:2] == (ayah, i)
        rate = speed if restart else 1.0
        if rate != 1.0:
            seg = _varied(seg, rate)
        if (prev is not None and not sequential) or restart:
            seg = _faded(seg)
        for k in ks:
            ws, we = pos[(ayah, k)]
            truth.append((ayah, k, t + (ws - start) / rate, t + (we - start) / rate))
        pieces.append(seg)
        t += len(seg) / SR
        prev = (ayah, ks[-1])
    pieces.append(np.zeros(int(1.0 * SR), dtype=wav.dtype))
    return np.concatenate(pieces), truth


def _run(wav, surah, a0, a1, prev_ctx, next_ctx, tag):
    """Production's steps after the window is chosen (_extract_from_long_audio)."""
    words = qa.fetch_surah_words(surah)
    emission = _emission(wav, tag)
    env = qa._energy_db(wav)
    units = qa._build_units(surah, words, range(a0, a1 + 1), set(range(a0, a1 + 1)),
                            prev_context=prev_ctx, next_context=next_ctx)
    qa._ctc_align(emission, units)
    qa._resolve_times(units, env, 0.0, len(wav) / SR)
    if not hasattr(qa, "_following_units"):  # ctc-v12 and before
        readings, suspects = qa._reading_path(emission, units, env)
        readings, unheard, moved = qa._hear_deaf_stretches(wav, emission, env, units, readings, words)
        if readings or moved:
            qa._resolve_times(units, env, 0.0, len(wav) / SR)
        return units, readings, suspects + [a for a, _ in unheard]
    readings, suspects, unexplained = qa._reading_path(emission, units, env, qa._following_units(surah, words, units),
                                                       wav=wav, words_by_ayah=words)
    qa._resolve_times(units, env, 0.0, len(wav) / SR)
    readings, unheard, moved, explained = qa._hear_deaf_stretches(wav, emission, env, units, readings, words, unexplained)
    suspects = [t for t in suspects if t not in explained]
    if hasattr(qa, "_restarted_words"):
        try:
            moved |= qa._restarted_words(emission, env, units, readings, wav)
        except TypeError:  # before RESTART_SELF_*
            moved |= qa._restarted_words(emission, env, units, readings)
    if moved:
        qa._resolve_times(units, env, 0.0, len(wav) / SR)
    return units, readings, suspects + [a for a, _ in unheard]


def _occurrences(units, readings):
    """[(ayah, token, start, end)] in time order: the readings when there
    are any, else each target word once."""
    if readings:
        return [(r["ayah"], idx, s, e) for r in readings for idx, s, e in r["words"]]
    return [(u["ayah"], u["index"], u["start"], u["end"]) for u in units if u["target"] and "f0" in u]


def _score(truth, occ):
    """Truth words at whose middle the reading path's current word -- the
    last one it has started by then -- is a different word."""
    occ = sorted(occ, key=lambda o: o[2])
    wrong = []
    for a, k, s, e in truth:
        mid = (s + e) / 2
        started = [o for o in occ if o[2] <= mid]
        cur = started[-1] if started else None
        if cur is None or (cur[0], cur[1]) != (a, k):
            wrong.append(f"{a}:{k}@{mid:.1f}s->" + (f"{cur[0]}:{cur[1]}" if cur else "nothing"))
    return wrong


SCREEN_TOL_SEC = 0.5


def _appearances(occ, words):
    """[(ayah, start)]: when each ayah comes on screen, by the display rules
    (frontend lib/readingPath.ts, every ayah one part): another ayah, or a
    restart at its first word, shows it (again); going back inside it keeps
    it -- and so does saying one word twice in a row (a restart of a single
    word holds the text from the first time)."""
    out, prev = [], None
    for a, k, s, _ in sorted(occ, key=lambda o: o[2]):
        first = min(i for i, t in enumerate(words[a]["tokens"]) if not qa._is_mark_token(t))
        if prev is None or a != prev[0] or (k == first and k < prev[1]):
            out.append((a, s))
        prev = (a, k)
    return out


def _screen_wrong(truth, occ, words):
    """What differs between the ayahs on screen by the truth and by the
    reading path: [] when the same ayahs come on in the same order, each
    within SCREEN_TOL_SEC."""
    want, got = _appearances(truth, words), _appearances(occ, words)
    if [a for a, _ in want] != [a for a, _ in got]:
        return [f"ayahs {[a for a, _ in got]} != {[a for a, _ in want]}"]
    return [f"{a}@{w:.1f}s shown at {g:.1f}s" for (a, w), (_, g) in zip(want, got) if abs(w - g) > SCREEN_TOL_SEC]


def _runs(readings):
    return [f"{'↩' if r['jump'] else ''}{r['ayah']}:{r['from']}-{r['to']}" for r in readings or []]


def _export(units, readings, truth, wav, tokens_by_ayah):
    verses = {}
    for u in units:
        if u["target"]:
            verses.setdefault(str(u["ayah"]), {"words": []})["words"].append({
                "w": u["w"], "start": round(u["start"] * 1000), "end": round(u["end"] * 1000),
                **({"conf": round(u["conf"], 3)} if "conf" in u else {})})
    out = {"verses": verses, "truth": [[a, k, round(s * 1000), round(e * 1000)] for a, k, s, e in truth],
           "durationMs": round(len(wav) / SR * 1000), "readings": None}
    if readings:
        out["readings"] = []
        for r in readings:
            times = {idx: (round(s * 1000), round(e * 1000)) for idx, s, e in r["words"]}
            spans, last = [], None
            for idx in range(r["from"], r["to"] + 1):
                s, e = times.get(idx, (last, last))
                spans.append([s, e])
                last = e
            out["readings"].append({"ayah": r["ayah"], "from": r["from"], "to": r["to"], "jump": r["jump"], "words": spans})
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("only", nargs="*")
    parser.add_argument("--json")
    parser.add_argument("-v", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.v else logging.WARNING, format="%(message)s")
    if not args.v:
        # _fail logs every rejected trial alignment as an error.
        logging.getLogger(qa.__name__).setLevel(logging.CRITICAL)
    exported = {}
    passed = total = flagged = false_flags = screen_ok = screen_flagged = cases = 0
    for name, (src, surah, mode, plan) in CASES.items():
        if args.only and not any(name.startswith(p) for p in args.only):
            continue
        wav, truth = _splice(src, surah, plan, RESTART_SPEED[sum(map(ord, name)) % 2])
        n = len(qa.fetch_surah_words(surah))
        if mode == "surah":
            a0, a1 = plan[0][0] + 1, max(a for a, _, _ in plan) - 1
            prev_ctx = (a0 - 1, qa.CONTEXT_WORDS)
            next_ctx = (a1 + 1, qa.CONTEXT_WORDS) if a1 < n else None
        else:
            a0, a1 = min(a for a, _, _ in plan), max(a for a, _, _ in plan)
            prev_ctx = next_ctx = None
        cases += 1
        units, readings, suspects = _run(wav, surah, a0, a1, prev_ctx, next_ctx, name)
        target_truth = [t for t in truth if a0 <= t[0] <= a1]
        occ = _occurrences(units, readings)
        wrong = _score(target_truth, occ)
        screen = _screen_wrong(target_truth, occ, qa.fetch_surah_words(surah))
        total += 1
        passed += not wrong
        screen_ok += not screen
        flagged += bool(wrong) and bool(suspects)
        screen_flagged += bool(screen) and bool(suspects)
        print(f"{'PASS' if not wrong else 'FAIL'} {name}: {' '.join(_runs(readings)) or 'no repeat found'}"
              + (f"  [flagged for review at {', '.join(f'{s:.1f}s' for s in suspects)}]" if suspects else "")
              + f"  screen {'ok' if not screen else 'WRONG'}"
              + (f"\n      wrong words: {' '.join(wrong)}" if wrong else "")
              + (f"\n      on screen: {'; '.join(screen)}" if screen else ""))
        exported[name] = _export(units, readings, target_truth, wav, None)

    for name, (src, surah, a0, a1, margin, expected, *mode) in CONTROLS.items():
        if args.only and not any(name.startswith(p) for p in args.only):
            continue
        swav, pos, _, _ = _source(src, surah)
        first_key = min(k for k in pos if k[0] == a0)
        if margin is None:
            t0, t1, wav = 0.0, len(swav) / SR, swav
        else:
            t0 = max(0.0, pos[first_key][0] - margin)
            t1 = min(len(swav) / SR, pos[max(k for k in pos if k[0] == a1)][1] + margin)
            wav = swav[int(t0 * SR):int(t1 * SR)]
        prev_ctx = next_ctx = None
        if mode == ["surah"]:
            # A built-in reciter's recording: the neighbouring ayahs as context.
            prev_ctx = (a0 - 1, qa.CONTEXT_WORDS) if a0 > 1 else None
            next_ctx = (a1 + 1, qa.CONTEXT_WORDS) if a1 < len(qa.fetch_surah_words(surah)) else None
        units, readings, suspects = _run(wav, surah, a0, a1, prev_ctx, next_ctx, name if margin is not None else src)
        jumps = [(r["ayah"], r["from"], r["to"]) for r in readings or [] if r["jump"]]
        first_start = min(o[2] for o in _occurrences(units, readings) if (o[0], o[1]) == first_key)
        moved = abs(first_start - (pos[first_key][0] - t0))
        ok = jumps == expected and moved <= 1.5
        total += 1
        passed += ok
        false_flags += bool(suspects)
        print(f"{'PASS' if ok else 'FAIL'} {name}: {' '.join(_runs(readings)) or 'no repeat found'}"
              + ("" if jumps == expected else f"  (expected jumps {expected})")
              + ("" if moved <= 1.5 else f"  (first word moved {moved:.1f}s)")
              + (f"  [flagged for review at {', '.join(f'{s:.1f}s' for s in suspects)}]" if suspects else ""))
    print(f"\n{passed}/{total} passed; {flagged} failed cases flagged for review, {false_flags} controls flagged; "
          f"on screen {screen_ok}/{cases} cases right ({screen_flagged} of the wrong ones flagged)")
    if args.json:
        Path(args.json).write_text(json.dumps(exported, ensure_ascii=False))


if __name__ == "__main__":
    main()
