"""CTC forced-alignment engine for cutting exact ayah ranges out of any
recitation audio (built-in reciters or a user's own upload).

Why this replaces extract_precise_clip.py's pipeline: that one asked Whisper
to *transcribe* the audio and then fuzzy-searched the transcript for the
ayah. Whenever Whisper misheard an ayah's first word, the fuzzy search scored
a window that simply skipped it higher, and the boundary cross-check then
shifted every word onto that late start -- the clip began mid-ayah. A long
tail of per-case patches grew around that root cause.

Here the known ayah text is instead *forced* onto the audio with a CTC
aligner (Meta's MMS_FA, via torchaudio): every letter must be placed, in
order, so the first word can never be skipped. Wildcard ("star") tokens
before/after the text, between ayahs and at waqf marks absorb whatever else
the recording contains (isti'adha, basmala, neighbouring ayahs, a reciter
repeating a phrase) at zero cost, so the same code localizes ayahs inside a
whole-surah recording or a short user clip alike. Boundaries are then
snapped to the reciter's actual breath/silence, and every result is verified
twice (CTC confidence + an independent Whisper listen to the clip's first and
last words). A result that fails verification is still returned, but flagged
`needsReview` with the reason, so the UI can send the user to the timing
editor instead of silently shipping a wrong cut.

Built-in reciters are always cut from their continuous whole-surah
recording -- never stitched together from per-ayah files, which leaves an
audible break between consecutive ayahs.
"""
import os

os.environ.setdefault("HF_HOME", "/app/data/huggingface_cache")
os.environ.setdefault("TORCH_HOME", "/app/data/torch_cache")

import argparse
import difflib
import json
import logging
import re
import subprocess
import threading
import unicodedata
import urllib.request
import uuid
from pathlib import Path

import numpy as np

from extract_precise_clip import (
    ExtractionError,
    OUTPUT_DIR,
    RECITERS_MP3QURAN,
    RECITERS_TIMING_ID,
    WORK_DIR,
    download_full_surah,
    is_backup_recording,
)
import job_control

logger = logging.getLogger(__name__)

# Bumped whenever output semantics change, so cached clips written by an
# older engine (or by extract_precise_clip.py, which never wrote this field)
# are never reused.
ENGINE_VERSION = "ctc-v11"

SAMPLE_RATE = 16000
FRAME_SAMPLES = 320  # wav2vec2 emission stride -> 20ms per frame
FRAME_SEC = FRAME_SAMPLES / SAMPLE_RATE
ENV_HOP_SEC = 0.01
ENV_FLOOR_DB = -70.0

# Recordings up to this long are scanned end-to-end by the CTC aligner;
# longer ones are first coarsely located with Whisper. The aligner is ~50x
# faster on the GPU, so the limit is much higher there.
FULL_SCAN_MAX_SEC_CPU = 420.0
FULL_SCAN_MAX_SEC_GPU = 3600.0
# forced_align keeps a (frames x (2*tokens+1)) backtracking table in memory.
FULL_SCAN_MAX_CELLS = 3e8

# The Whisper coarse pass transcribes a long recording in chunks this long,
# so a cancel lands within one chunk (its VAD pass alone over a whole
# Al-Baqarah took over a minute) and progress can be shown.
COARSE_CHUNK_SEC = 600.0
# Fewest words the coarse pass searches for. A one-word ayah (الٓمٓ) is a
# near match for many words of a long recording -- 2:1 was placed in 2:32's
# "لا علم لنا" -- so a short target is searched together with its
# neighbouring ayahs, whose combined text is unique.
COARSE_MIN_WORDS = 20

# How many real words of the neighbouring ayahs are aligned alongside the
# target when the source is a whole-surah recording. They sandwich the
# target, so an ayah whose text repeats elsewhere in the surah (e.g.
# Ar-Rahman's refrain) can only land on the occurrence between its true
# neighbours.
CONTEXT_WORDS = 4

# Confidence = mean CTC posterior over a word's letters. Calibrated on
# known-good alignments (correct words score ~0.6-0.95; a word forced onto
# audio that doesn't contain it scores well under 0.2).
BOUNDARY_WORD_MIN_CONF = 0.2
MEAN_MIN_CONF = 0.3

VERIFY_MODEL = "OdyAsh/faster-whisper-base-ar-quran"

# A recording may hold a selected ayah twice (the reciter went back and
# repeated it, inside the selection or right after it); only one recitation
# can be timed, so that's flagged for review. An ayah counts as recited again
# when, with the timed recitation masked out, it still aligns elsewhere at
# REPEAT_MIN_REL_CONF of that same ayah's timed confidence, and at least
# REPEAT_MIN_CONF. Ayahs shorter than REPEAT_MIN_WORDS, or whose text (or a
# near-identical one, REPEAT_SIMILAR_TEXT) also occurs elsewhere in the
# surah or the basmala, are skipped -- a second match could just be that
# other place.
REPEAT_MIN_WORDS = 3
REPEAT_MIN_REL_CONF = 0.85
REPEAT_MIN_CONF = 0.45
REPEAT_SIMILAR_TEXT = 0.8
BASMALA_CLEAN = "بسم الله الرحمن الرحيم"

# A reciter often goes back and reads part of the selection again: a few
# words after a pause, a whole ayah, the previous ayah after starting the
# next, or a false start. _reading_path finds the order he really read in
# with one Viterbi search over the text in which, at the end of a pause, the
# path may jump back to the first letter of any word up to RETURN_MAX_WORDS /
# RETURN_MAX_AYAHS back. Why not the linear alignment (ctc-v7 searched for
# repeats where it left a 0.9s+ hole): blanks and star tokens absorb a repeat
# almost free, so it usually left no hole -- it stretched a word over both
# readings or let a star swallow the first one (eval: 2 of 21 spliced repeats
# found, see eval_reading_path.py). What makes the search work:
# - No star tokens inside the reading, and a letter the model doesn't hear
#   costs at most RETURN_LETTER_CAP more than a blank: spelling and recitation
#   disagree on some letters (tanween at a pause, a long vowel), and an
#   uncapped cost made re-reading a phrase dearer than skipping it.
# - No word spans a long, deep pause (RETURN_SPAN_PAUSE_*): stretching one
#   word over two readings is impossible.
# - A jump lands ON the first letter of a word as the pause ends -- he starts
#   the word as the breath ends -- so the audio after it can't be skipped.
# Candidate jumps come cheap (RETURN_JUMP_COST); each is then verified: the
# words read again (at least RETURN_MIN_WORDS, RETURN_MIN_LETTERS letters)
# must be heard about as clearly as in their other reading (a word the model
# hears badly is bad in both -- RETURN_MIN_RATIO) and clearly enough for
# this recording (RETURN_MIN_REL of its mean, never below RETURN_MIN_CLEAR),
# see RETURN_ACCEPT. Clarity = the peak posterior of each consonant inside
# the word. The weakest failing jump is banned (that pause, from that word
# back to that word) and the search rerun, until every jump left is verified.
RETURN_MAX_WORDS = 40
RETURN_MAX_AYAHS = 2
RETURN_JUMP_COST = 2.0
RETURN_LETTER_CAP = 1.0
RETURN_MIN_WORDS = 2
RETURN_MIN_LETTERS = 6
RETURN_MIN_RATIO = 0.6
RETURN_MIN_REL = 0.6
RETURN_MIN_CLEAR = 0.3
# Accepted when ratio + (the less clear reading's clarity - what this
# recording needs) reaches RETURN_ACCEPT: eval_reading_path.py's true
# repeats score 0.78+, chance jumps up to 0.72 (a false repeat is an error
# too). Between RETURN_SUSPECT and RETURN_ACCEPT it is flagged for review.
RETURN_ACCEPT = 0.76
RETURN_SUSPECT = 0.68
RETURN_ROUNDS = 24
# A pause = >= RETURN_PAUSE_MIN_SEC at least RETURN_PAUSE_DIP_DB below the
# speech within RETURN_PAUSE_WIN_SEC on both sides (a breath), or
# RETURN_SILENCE_DB below the region's speech level (a long silence, whose
# middle has no speech that near). A jump may land from
# RETURN_ARRIVE_BEFORE_SEC before its end to RETURN_ARRIVE_AFTER_SEC after.
RETURN_PAUSE_MIN_SEC = 0.08
RETURN_PAUSE_DIP_DB = 8.0
RETURN_PAUSE_WIN_SEC = 0.5
RETURN_SILENCE_DB = 18.0
RETURN_SPAN_PAUSE_SEC = 0.2
RETURN_SPAN_PAUSE_DB = 10.0
RETURN_ARRIVE_BEFORE_SEC = 0.06
RETURN_ARRIVE_AFTER_SEC = 0.2
# Audio searched around the linearly aligned words: RETURN_LEAD_SEC before
# them -- not more: given the audio before the selection (the previous
# ayah of the user's fajr upload), the search put the first two words
# there and invented a false start; a false start before the selection is
# cut off by the default trim anyway -- and after them up to
# RETURN_SLACK_SEC for a repeat of the last ayahs, or
# RETURN_CONTEXT_SLACK_SEC past neighbouring-ayah context words (the rest
# of that ayah is beyond).
RETURN_LEAD_SEC = 1.0
RETURN_SLACK_SEC = 15.0
RETURN_CONTEXT_SLACK_SEC = 1.0
# Speech the reading leaves unexplained: between two pauses, at least
# UNEXPLAINED_MIN_SEC long, no letter of the path in it, and
# UNEXPLAINED_MIN_MASS of letter evidence (summed 1 - p(blank)) -- flagged
# for review (eval: clean recordings at most 1.23). Measured per second, or
# between any two letters, it fired on clean recordings: the model hears
# letters the spelling doesn't write, and a first word may sit anywhere in
# the audio before the reading.
UNEXPLAINED_MIN_SEC = 0.6
UNEXPLAINED_MIN_MASS = 1.8
# Stretches the alignment model can't hear: audio within DEAF_LOUD_DB of
# the recitation's level whose letter evidence (1 - p(blank), 0.5s mean)
# stays under DEAF_MAX_EVIDENCE for DEAF_MIN_SEC+ (gaps up to
# DEAF_BRIDGE_SEC bridged). The user's fajr upload has 10s of them around
# 79:31-32 -- a different sound, 2-3x the usual energy at 1-3 kHz (weeping
# or a second voice); 0.001-0.03 there, 0.1-0.2 in its normal recitation --
# and the first reading of 79:32 inside was invisible, so the ayah showed
# only once. Long madds are quiet too (clean recordings have such stretches
# of 2-7s), so it is Whisper (VERIFY_MODEL) that decides: it still hears the
# words, but also invents some, at a window's edges and by carrying on the
# Quran from memory ("طه", "عسق", "والمسلم" in that stretch). So: windows
# of DEAF_WINDOW_SEC every DEAF_HOP_SEC, words within DEAF_EDGE_SEC of a
# window edge dropped, each window matched in order onto the text from
# DEAF_TEXT_BACK words before the stretch to DEAF_TEXT_AHEAD after it at
# DEAF_MIN_SIM, and a text word kept only when DEAF_MIN_SUPPORT windows
# heard it at the same time. Another reading must be RETURN_MIN_WORDS+ consecutive
# words, DEAF_GAP_SEC clear of the path's reading of them.
DEAF_MAX_EVIDENCE = 0.03
DEAF_LOUD_DB = 15.0
DEAF_MIN_SEC = 2.5
DEAF_BRIDGE_SEC = 1.0
DEAF_WINDOW_SEC = 3.0
DEAF_HOP_SEC = 0.5
DEAF_EDGE_SEC = 0.3
DEAF_MIN_SUPPORT = 2
DEAF_TEXT_BACK = 6
DEAF_TEXT_AHEAD = 8
DEAF_MIN_SIM = 0.75
DEAF_GAP_SEC = 0.2
# The search keeps one byte per (frame, state); beyond this the reading path
# is skipped (flagged instead) -- ~10 minutes of a long ayah run.
RETURN_MAX_CELLS = 3e8
# Below this a word was almost certainly forced onto audio that doesn't hold
# it (correct words score ~0.6-0.95) -- flagged even when nothing else is.
WORD_MISMATCH_CONF = 0.15


def _fail(message: str):
    logger.error(message)
    raise ExtractionError(message)


# ========== QURAN TEXT ==========

_BISMILLAH_UTHMANI = unicodedata.normalize("NFC", "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ ")
_BISMILLAH_CLEAN = "بسم الله الرحمن الرحيم "

_text_cache = {}
_text_lock = threading.Lock()


def _fetch_edition(surah_id, edition):
    url = f"https://api.alquran.cloud/v1/surah/{surah_id}/{edition}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.loads(response.read().decode())["data"]["ayahs"]


def fetch_surah_words(surah_id):
    """{ayah: {"tokens": [...], "clean": [...]}}.

    "tokens" mirrors frontend/src/lib/quranWordMap.ts::fetchRealWords
    exactly (NFC-normalized quran-uthmani, Bismillah stripped from ayah 1,
    whitespace split -- standalone waqf marks such as "ۚ" ARE tokens), since
    the frontend indexes wordTimings by that tokenization. "clean" is only
    used to compare against Whisper's output during verification.
    """
    with _text_lock:
        if surah_id in _text_cache:
            return _text_cache[surah_id]

    uthmani = _fetch_edition(surah_id, "quran-uthmani")
    clean = _fetch_edition(surah_id, "quran-simple-clean")
    ayahs = {}
    for au, ac in zip(uthmani, clean):
        number = au["numberInSurah"]
        text_u = unicodedata.normalize("NFC", au["text"]).replace("\uFEFF", "").strip()
        text_c = ac["text"].replace("\uFEFF", "").strip()
        if number == 1 and surah_id != 1:
            if text_u.startswith(_BISMILLAH_UTHMANI):
                text_u = text_u[len(_BISMILLAH_UTHMANI):]
            if text_c.startswith(_BISMILLAH_CLEAN):
                text_c = text_c[len(_BISMILLAH_CLEAN):]
        ayahs[number] = {"tokens": text_u.split(), "clean": text_c.split()}

    with _text_lock:
        _text_cache[surah_id] = ayahs
    return ayahs


# ========== ROMANIZATION (Uthmani -> MMS_FA alphabet) ==========
# MMS_FA was trained on uroman-romanized text, so Arabic has to be spelled
# with its Latin alphabet. Spelled from the fully-vocalized Uthmani text
# (not the bare skeleton) so the vowels the reciter actually voices are
# present as tokens, with the Uthmani conventions for silent/assimilated
# letters applied.

_FATHA, _DAMMA, _KASRA = "\u064E", "\u064F", "\u0650"
_FATHATAN, _DAMMATAN, _KASRATAN = "\u064B", "\u064C", "\u064D"
_SHADDA, _SUKUN = "\u0651", "\u0652"
_HAMZA_ABOVE = "\u0654"
_SUPERSCRIPT_ALEF = "\u0670"
_SILENT_MARKS = {"\u06DF", "\u06E0"}  # small high (rounded|rectangular) zero: letter not pronounced
_WASLA = "ٱ"
_TATWEEL = "\u0640"

_SHORT_VOWELS = {_FATHA: "a", _DAMMA: "u", _KASRA: "i"}
_TANWEEN = {_FATHATAN: "an", _DAMMATAN: "un", _KASRATAN: "in"}

_CONSONANTS = {
    "ب": "b", "ت": "t", "ث": "th", "ج": "j", "ح": "h", "خ": "kh", "د": "d",
    "ذ": "dh", "ر": "r", "ز": "z", "س": "s", "ش": "sh", "ص": "s", "ض": "d",
    "ط": "t", "ظ": "z", "ع": "'", "غ": "gh", "ف": "f", "ق": "q", "ك": "k",
    "ل": "l", "م": "m", "ن": "n", "ه": "h",
}
_HAMZA_LETTERS = {"ء", "أ", "إ", "ؤ", "ئ"}

# Standalone pause marks -- a reciter may stop (and often restarts a few
# words back) at these, so a star token is placed there to absorb it.
_WAQF_MARKS = {"\u06D6", "\u06D7", "\u06D8", "\u06D9", "\u06DA", "\u06DB", "\u06DC"}

# Huroof muqatta'at are recited as letter NAMES ("الٓمٓ" -> alif laam miim).
_HUROOF_NAMES = {
    "ا": "alif", "ل": "lam", "م": "mim", "ص": "sad", "ر": "ra", "ك": "kaf",
    "ه": "ha", "ي": "ya", "ع": "'ayn", "ط": "ta", "س": "sin", "ح": "ha",
    "ق": "qaf", "ن": "nun",
}
_HUROOF_WORDS = {"الم", "المص", "الر", "المر", "كهيعص", "طه", "طسم", "طس", "يس", "ص", "حم", "عسق", "ق", "ن"}


def _is_base_letter(ch):
    return "\u0621" <= ch <= "\u064A" or ch == _WASLA or ch == _TATWEEL


def _skeleton(word):
    return "".join(ch for ch in word if "\u0621" <= ch <= "\u064A" or ch == _WASLA)


def _clusters(word):
    clusters = []
    for ch in word:
        if _is_base_letter(ch):
            clusters.append((ch, []))
        elif clusters:
            clusters[-1][1].append(ch)
    return clusters


def _is_huroof(surah_id, ayah, token_index, token):
    if token_index != 0:
        return False
    if not (ayah == 1 or (surah_id == 42 and ayah == 2)):
        return False
    return _skeleton(token) in _HUROOF_WORDS


def romanize_token(token, pause_after=False, huroof=False):
    if huroof:
        return _collapse("".join(_HUROOF_NAMES.get(ch, "") for ch in _skeleton(token)))

    clusters = _clusters(token)
    pieces = []  # (text, vowel_is_short) per cluster
    prev_fathatan = False

    def last_char():
        for text, _ in reversed(pieces):
            if text:
                return text[-1]
        return ""

    for idx, (base, marks) in enumerate(clusters):
        mark_set = set(marks)
        if mark_set & _SILENT_MARKS:
            pieces.append(("", False))
            prev_fathatan = False
            continue

        vowel = ""
        for m in marks:
            if m in _SHORT_VOWELS:
                vowel = _SHORT_VOWELS[m]
            elif m in _TANWEEN:
                vowel = _TANWEEN[m]
        has_sukun = _SUKUN in mark_set
        has_shadda = _SHADDA in mark_set
        has_sup_alef = _SUPERSCRIPT_ALEF in mark_set
        has_hamza = _HAMZA_ABOVE in mark_set
        bare = not vowel and not has_sukun and not has_shadda
        short = bool(vowel)

        if base == _TATWEEL:
            text = ("'" if has_hamza else "") + (vowel or ("a" if has_sup_alef else ""))
        elif base == _WASLA:
            text = ""  # silent in connected recitation
        elif base in _HAMZA_LETTERS:
            text = "'" + vowel
        elif base == "ا":
            if has_hamza:
                text = "'" + (vowel or "a")
            elif prev_fathatan or last_char() == "a":
                text = ""  # long-a seat, or the silent seat after fathatan
                short = False
            else:
                text = vowel or "a"
        elif base in ("و", "ي"):
            consonant = "w" if base == "و" else "y"
            long_vowel = "u" if base == "و" else "i"
            if has_hamza:
                text = "'" + vowel
            elif vowel or has_shadda:
                text = consonant + vowel
            elif has_sukun:
                text = consonant
            elif has_sup_alef:
                text = "a"
            elif last_char() == long_vowel:
                text = ""
            else:
                text = long_vowel
        elif base == "ى":
            if has_sup_alef:
                text = "a"
            elif vowel:
                text = "y" + vowel
            elif prev_fathatan or last_char() in ("a", "i"):
                text = ""
            else:
                text = "a"
            short = False
        elif base == "ة":
            text = ("t" + vowel) if vowel else "h"
        elif base == "ل" and bare and idx + 1 < len(clusters) and _SHADDA in clusters[idx + 1][1]:
            text = ""  # sun-letter lam, assimilated into the next letter
        else:
            text = _CONSONANTS.get(base, "") + (vowel or ("a" if has_sup_alef else ""))

        pieces.append((text, short))
        prev_fathatan = _FATHATAN in mark_set

    if pause_after:
        # Waqf: the final short vowel/tanween is dropped (fathatan -> "a"),
        # and taa marbuta is pronounced "h".
        for i in range(len(pieces) - 1, -1, -1):
            text, short = pieces[i]
            if not text:
                continue
            base = clusters[i][0]
            if base == "ة":
                pieces[i] = ("h", False)
            elif short:
                if text.endswith("an"):
                    pieces[i] = (text[:-1], False)
                elif text.endswith(("un", "in")):
                    pieces[i] = (text[:-2], False)
                elif text[-1] in "aiu" and len(text) > 1:
                    pieces[i] = (text[:-1], False)
            break

    romanized = _collapse("".join(text for text, _ in pieces))
    if not romanized:
        romanized = _collapse("".join(_CONSONANTS.get(ch, "") for ch in _skeleton(token)))
    return romanized


def _collapse(text):
    # Consecutive identical CTC targets need a blank frame between them; a
    # long vowel or geminate is acoustically one sound, so keep one token.
    return re.sub(r"(.)\1+", r"\1", text)


def _is_mark_token(token):
    return not any(_is_base_letter(ch) for ch in token)


# ========== AUDIO HELPERS ==========

def _probe_duration(path):
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        text=True,
    ).strip()
    return float(out)


def _seek_args(path, start, duration):
    """ffmpeg args placing -ss/-t so the cut is sample-exact.

    Input seeking (-ss before -i) on a VBR MP3 lands wherever the demuxer's
    approximate TOC says, which is how clips used to start slightly off;
    output seeking decodes from the top and is exact, so compressed sources
    always use it. PCM WAV seeks exactly either way and is much faster.
    """
    is_wav = str(path).lower().endswith(".wav")
    pre, post = [], []
    if start and start > 0:
        (pre if is_wav else post).extend(["-ss", f"{start:.4f}"])
    if duration is not None:
        post.extend(["-t", f"{duration:.4f}"])
    return pre, post


def decode_pcm(path, start=None, duration=None, sample_rate=SAMPLE_RATE, channels=1):
    pre, post = _seek_args(path, start, duration)
    cmd = ["ffmpeg", "-v", "error", *pre, "-i", str(path), *post, "-vn",
           "-ac", str(channels), "-ar", str(sample_rate), "-f", "s16le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.int16)


def _to_float(pcm):
    return pcm.astype(np.float32) / 32768.0


def _max_volume_db(path):
    out = subprocess.run(["ffmpeg", "-v", "info", "-i", str(path), "-af", "volumedetect", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    match = re.search(r"max_volume:\s*(-?[\d.]+|-inf) dB", out)
    if not match or match.group(1) == "-inf":
        return -float("inf")
    return float(match.group(1))


def _energy_db(wav):
    hop = int(SAMPLE_RATE * ENV_HOP_SEC)
    win = 2 * hop
    if len(wav) < win:
        return np.full(1, -100.0, dtype=np.float32)
    n = 1 + (len(wav) - win) // hop
    frames = np.lib.stride_tricks.as_strided(
        wav, shape=(n, win), strides=(wav.strides[0] * hop, wav.strides[0]), writeable=False
    )
    rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1) + 1e-12)
    db = np.maximum(20 * np.log10(rms), ENV_FLOOR_DB)
    # 30ms median smoothing: a single dropped/spliced frame (seen as -100dB
    # digital silence inside real recordings) must not read as a pause.
    padded = np.pad(db, 1, mode="edge")
    smooth = np.median(np.stack([padded[:-2], padded[1:-1], padded[2:]]), axis=0)
    return smooth.astype(np.float32)


def _local_threshold(env, quiet_span, loud_span):
    """Silence threshold for ONE boundary, from the quiet side (where the
    pause should be) and the speech side next to it. Recording level drifts
    over a long surah, so a single global threshold isn't reliable. Returns
    None when there is no clear pause to snap to (connected recitation)."""
    def seg(span):
        a = max(0, int(span[0] / ENV_HOP_SEC))
        b = min(len(env), int(span[1] / ENV_HOP_SEC))
        return env[a:b] if b > a else env[:0]

    quiet, loud = seg(quiet_span), seg(loud_span)
    if len(quiet) < 5 or len(loud) < 5:
        return None
    floor = float(np.percentile(quiet, 5))
    level = float(np.percentile(loud, 90))
    if level - floor < 10.0:
        return None
    return floor + 0.35 * (level - floor)


# ========== MMS_FA MODEL ==========

_mms = None
_mms_lock = threading.Lock()


def _get_mms():
    global _mms
    if _mms is None:
        with _mms_lock:
            if _mms is None:
                import torch
                import torchaudio

                device = "cuda" if torch.cuda.is_available() else "cpu"
                if device == "cpu":
                    torch.set_num_threads(max(1, os.cpu_count() or 1))
                bundle = torchaudio.pipelines.MMS_FA
                logger.info("Loading MMS_FA forced-alignment model (first use downloads ~1.2GB)...")
                model = bundle.get_model(with_star=True).to(device)
                model.eval()
                labels = bundle.get_labels(star="*")
                _mms = (model, {c: i for i, c in enumerate(labels)}, labels.index("*"))
                logger.info(f"MMS_FA model ready on {device}.")
    return _mms


def compute_emission(wav):
    """Frame-level log-posteriors [T, V] for a 16kHz mono float waveform,
    computed in overlapping 30s chunks (attention cost is quadratic in
    length, so one pass over minutes of audio is not viable)."""
    import torch

    model, _, _ = _get_mms()
    device = next(model.parameters()).device
    chunk = 30 * SAMPLE_RATE
    context = 2 * SAMPLE_RATE
    n = len(wav)
    pieces = []
    with torch.inference_mode():
        for s0 in range(0, n, chunk):
            s1 = min(n, s0 + chunk)
            a = max(0, s0 - context)
            b = min(n, s1 + context)
            if b - a < 400:
                break
            x = torch.from_numpy(np.ascontiguousarray(wav[a:b])).unsqueeze(0).to(device)
            emission, _ = model(x)
            f0 = (s0 - a) // FRAME_SAMPLES
            f_len = (s1 - s0) // FRAME_SAMPLES
            pieces.append(emission[0, f0:f0 + f_len].float().cpu())
    if not pieces:
        _fail("Audio is too short to align.")
    return torch.cat(pieces)


# ========== ALIGNMENT ==========

def _build_units(surah_id, words_by_ayah, ayahs, target_ayahs, prev_context=None, next_context=None):
    """Flatten the ayahs to align into per-token units.

    prev_context / next_context: (ayah, n_words) -- only the LAST / FIRST
    n real words of that neighbouring ayah are aligned (enough to sandwich
    the target without decoding minutes of a long neighbour).
    """
    _, dictionary, _ = _get_mms()
    units = []

    def add_ayah(ayah, token_slice=None):
        tokens = words_by_ayah[ayah]["tokens"]
        real_idx = [i for i, t in enumerate(tokens) if not _is_mark_token(t)]
        last_real = real_idx[-1] if real_idx else -1
        indices = range(len(tokens)) if token_slice is None else token_slice
        first = True
        after_waqf = False
        for i in indices:
            token = tokens[i]
            if _is_mark_token(token):
                units.append({"ayah": ayah, "index": i, "w": token, "ids": [], "target": ayah in target_ayahs, "star_before": False})
                if set(token) & _WAQF_MARKS:
                    after_waqf = True
                continue
            huroof = _is_huroof(surah_id, ayah, i, token)
            roman = romanize_token(token, pause_after=(i == last_real), huroof=huroof)
            ids = [dictionary[c] for c in roman if c in dictionary]
            units.append({
                "ayah": ayah, "index": i, "w": token, "ids": ids, "roman": roman, "huroof": huroof,
                "target": ayah in target_ayahs, "star_before": first or after_waqf,
            })
            first = False
            after_waqf = False

    if prev_context:
        ayah, n = prev_context
        tokens = words_by_ayah[ayah]["tokens"]
        real_idx = [i for i, t in enumerate(tokens) if not _is_mark_token(t)]
        add_ayah(ayah, real_idx[-n:])
    for ayah in ayahs:
        add_ayah(ayah)
    if next_context:
        ayah, n = next_context
        tokens = words_by_ayah[ayah]["tokens"]
        real_idx = [i for i, t in enumerate(tokens) if not _is_mark_token(t)]
        add_ayah(ayah, real_idx[:n])
    return units


def _ctc_align(emission, units):
    """Forced-align units onto emission frames. Sets f0/f1 (frame span of
    the unit's letters) and conf on every unit that has tokens."""
    import torch
    import torchaudio.functional as F

    _, _, star = _get_mms()
    targets = [star]
    ranges = []
    for u in units:
        if not u["ids"]:
            ranges.append(None)
            continue
        if u["star_before"] and targets[-1] != star:
            targets.append(star)
        a = len(targets)
        targets.extend(u["ids"])
        ranges.append((a, len(targets) - 1))
    if targets[-1] != star:
        targets.append(star)

    repeats = sum(1 for x, y in zip(targets, targets[1:]) if x == y)
    if emission.shape[0] < len(targets) + repeats:
        _fail("The audio is shorter than the selected ayahs could possibly take to recite.")

    aligned, scores = F.forced_align(
        emission.unsqueeze(0).float(), torch.tensor([targets], dtype=torch.int32), blank=0
    )
    spans = F.merge_tokens(aligned[0], scores[0].exp())
    if len(spans) != len(targets):
        _fail("Internal alignment error (token span mismatch).")

    for u, r in zip(units, ranges):
        if r is None:
            continue
        a, b = r
        word_spans = spans[a:b + 1]
        u["f0"] = int(word_spans[0].start)
        u["f1"] = int(word_spans[-1].end)
        u["conf"] = float(np.mean([s.score for s in word_spans]))
        u["spans"] = [(int(s.start), int(s.end)) for s in word_spans]
    return units


def _aligned(units, target_only=False):
    return [u for u in units if "f0" in u and (u["target"] or not target_only)]


def _mean_conf(units):
    confs = [u["conf"] for u in units if "conf" in u]
    return float(np.mean(confs)) if confs else 0.0


def _snap_onset(env, t_token, t_min, max_back=0.6, min_quiet=0.08):
    """Walk back from the first letter's CTC frame to where the voice
    actually starts (end of the preceding breath/silence)."""
    thr = _local_threshold(env, (max(t_min, t_token - 1.5), t_token), (t_token, t_token + 1.0))
    if thr is None:
        return max(t_min, t_token - 0.06), False
    i = int(t_token / ENV_HOP_SEC)
    i_min = max(0, int(np.ceil(t_min / ENV_HOP_SEC)), i - int(max_back / ENV_HOP_SEC))
    need = int(min_quiet / ENV_HOP_SEC)
    run = 0
    run_end = None
    for j in range(min(i, len(env)) - 1, i_min - 1, -1):
        if env[j] < thr:
            if run == 0:
                run_end = j
            run += 1
            if run >= need:
                return (run_end + 1) * ENV_HOP_SEC, True
        else:
            run = 0
    # Reached the lower bound inside a quiet run that started right at it.
    if run > 0 and i_min * ENV_HOP_SEC <= t_min + ENV_HOP_SEC:
        return (run_end + 1) * ENV_HOP_SEC, True
    # Connected (wasl) recitation: no pause to snap to.
    return max(t_min, t_token - 0.06), False


def _snap_offset(env, t_token_end, t_max, max_fwd=4.0, min_quiet=0.15):
    """Walk forward from the last letter's CTC frame until the voice
    (including any madd prolongation) actually stops."""
    thr = _local_threshold(env, (t_token_end, min(t_max, t_token_end + max_fwd) + 0.3),
                           (max(0.0, t_token_end - 1.0), t_token_end))
    if thr is None:
        return min(t_max, t_token_end + 0.25), False
    i = int(np.ceil(t_token_end / ENV_HOP_SEC))
    i_max = min(len(env), int(t_max / ENV_HOP_SEC), i + int(max_fwd / ENV_HOP_SEC))
    need = int(min_quiet / ENV_HOP_SEC)
    run = 0
    run_start = None
    for j in range(i, i_max):
        if env[j] < thr:
            if run == 0:
                run_start = j
            run += 1
            if run >= need:
                return run_start * ENV_HOP_SEC, True
        else:
            run = 0
    if run > 0:
        return run_start * ENV_HOP_SEC, True
    return min(t_max, t_token_end + 0.25), False


def _resolve_times(units, env, region_start, region_end):
    """Turn frame spans into word start/end seconds (relative to the
    analysed region) and per-ayah onset/offset."""
    aligned = _aligned(units)
    for u in aligned:
        u["tok_start"] = u["f0"] * FRAME_SEC
        u["tok_end"] = (u["f1"] + 1) * FRAME_SEC

    ayah_info = {}
    for pos, u in enumerate(aligned):
        info = ayah_info.setdefault(u["ayah"], {"first": pos, "last": pos})
        info["last"] = pos

    prev_offset = region_start
    for ayah, info in ayah_info.items():  # insertion order == recitation order
        first, last = aligned[info["first"]], aligned[info["last"]]
        lo = aligned[info["first"] - 1]["tok_end"] if info["first"] > 0 else region_start
        hi = aligned[info["last"] + 1]["tok_start"] if info["last"] + 1 < len(aligned) else region_end
        # An ayah can't start before the previous one has finished sounding
        # (its madd tail may run past its last letter's CTC frame).
        lo = max(lo, min(prev_offset, first["tok_start"]))
        onset, onset_clean = _snap_onset(env, first["tok_start"], lo)
        offset, offset_clean = _snap_offset(env, last["tok_end"], hi)
        offset = max(offset, last["tok_end"])
        info.update(onset=onset, offset=offset, onset_clean=onset_clean,
                    offset_clean=offset_clean, lo=lo, hi=hi)
        prev_offset = offset

    for pos, u in enumerate(aligned):
        info = ayah_info[u["ayah"]]
        u["start"] = info["onset"] if pos == info["first"] else u["tok_start"]
        if pos == info["last"]:
            u["end"] = info["offset"]
            if not info["offset_clean"] and pos + 1 < len(aligned):
                # No pause before the next ayah: he holds this one into it,
                # so its last word lasts until the next one starts -- the
                # video tells a pause (text gone) from this by that gap.
                # The cut keeps its own offset.
                u["end"] = max(u["tok_end"], ayah_info[aligned[pos + 1]["ayah"]]["onset"])
        else:
            nxt = aligned[pos + 1]["tok_start"]
            # A word stays "current" until the next word starts, unless the
            # reciter actually falls silent in between (a pause, not a repeat).
            end, found = _snap_offset(env, u["tok_end"], nxt, max_fwd=3.0, min_quiet=0.2)
            u["end"] = end if found else nxt

    # Mark-only tokens (waqf signs, ۞ ...) carry no sound: pin them to the
    # end of the previous word of the same ayah, or -- for a mark that opens
    # an ayah, like ۞ -- to the ayah's own onset, since the renderer treats
    # an ayah's words[0].start as the moment that ayah begins on screen.
    for pos, u in enumerate(units):
        if "start" in u:
            continue
        prev = next((v for v in reversed(units[:pos]) if "f0" in v and v["ayah"] == u["ayah"]), None)
        if prev is not None:
            u["start"] = u["end"] = prev["end"]
            continue
        nxt = next((v for v in units[pos + 1:] if "f0" in v), None)
        u["start"] = u["end"] = nxt["start"] if nxt else region_start
    return ayah_info


def _target_text_repeats(words_by_ayah, start_ayah, end_ayah):
    target = []
    for a in range(start_ayah, end_ayah + 1):
        target.extend(_norm_words(" ".join(words_by_ayah[a]["clean"])))
    full = []
    for a in sorted(words_by_ayah):
        full.extend(_norm_words(" ".join(words_by_ayah[a]["clean"])))
    n = len(target)
    if n == 0:
        return False
    hits = sum(1 for i in range(len(full) - n + 1) if full[i:i + n] == target)
    return hits > 1


# ========== VERIFICATION ==========

_verify_model = None
_verify_lock = threading.Lock()


def _get_verify_model():
    global _verify_model
    if _verify_model is None:
        with _verify_lock:
            if _verify_model is None:
                from faster_whisper import WhisperModel
                try:
                    _verify_model = WhisperModel(VERIFY_MODEL, device="cuda", compute_type="float16")
                except Exception as e:
                    logger.warning(f"Verification model on CUDA failed ({e}); using CPU.")
                    _verify_model = WhisperModel(VERIFY_MODEL, device="cpu", compute_type="int8")
    return _verify_model


def _norm_words(text):
    text = re.sub(r"[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]", "", text)
    text = (text.replace("أ", "ا").replace("إ", "ا").replace("آ", "ا").replace("ٱ", "ا")
            .replace("ة", "ه").replace("ى", "ي").replace("ؤ", "و").replace("ئ", "ي").replace("ء", ""))
    text = re.sub(r"[^\u0621-\u064A\s]", "", text)
    return text.split()


def _transcribe(wav):
    model = _get_verify_model()
    segments, _ = model.transcribe(
        wav, language="ar", beam_size=5, without_timestamps=True,
        condition_on_previous_text=False, vad_filter=False,
    )
    return _norm_words(" ".join(s.text for s in segments))


def _similar(a, b):
    return difflib.SequenceMatcher(None, a, b).ratio()


def _heard(word, hyp_words):
    joined = "".join(hyp_words)
    return any(_similar(word, h) >= 0.6 for h in hyp_words) or (
        len(word) >= 3 and _similar(word, joined[:len(word)]) >= 0.6
    )


def _edge_verdict(hyp, ref, at_start):
    """Did Whisper hear the clip begin with ref[0] (or end with ref[-1])?

    ref: the first (last) up-to-3 words of the selection. True = heard at
    the edge. False = heard the NEIGHBOURING ref words at the edge but not
    the edge word itself -- the cut is late (early). None = Whisper didn't
    make sense of the snippet at all (it struggles with long madd-only
    audio), which says nothing about the cut and must not raise an alarm.
    """
    if not hyp or not ref:
        return None
    if at_start:
        edge_hyp = hyp[:2]
        if _heard(ref[0], edge_hyp):
            return True
        inner = ref[1:]
    else:
        edge_hyp = hyp[-2:]
        if _heard(ref[-1], edge_hyp) or _heard(ref[-1], ["".join(hyp)[-len(ref[-1]) - 2:]]):
            return True
        inner = ref[:-1]
    if any(_heard(w, edge_hyp) for w in inner):
        return False
    return None


def verify_edges(wav, target_units, onset, offset, first_ref, last_ref, check_start=True):
    """Independent second opinion on the cut: Whisper (a different model
    and method than the CTC aligner) must hear the selection's first word
    right at the start and its last word right at the end.

    Snippets are cut on word boundaries (onset -> after the 3rd word, and
    3rd-from-last word -> offset): a window starting mid-word, or holding
    nothing but a long madd, makes Whisper hallucinate."""
    results = {}
    real = [u for u in target_units if "start" in u and u["end"] > u["start"]]
    try:
        if check_start and first_ref:
            head_end = real[3]["start"] if len(real) > 3 else offset
            head_end = min(onset + 6.0, max(onset + 1.5, head_end))
            a = max(0, int((onset - 0.1) * SAMPLE_RATE))
            b = min(len(wav), int(head_end * SAMPLE_RATE))
            results["start"] = _edge_verdict(_transcribe(wav[a:b]), first_ref, True)
        if last_ref:
            tail_start = real[-3]["start"] if len(real) >= 3 else onset
            tail_start = max(offset - 8.0, min(offset - 1.5, tail_start - 0.1))
            a = max(0, int(tail_start * SAMPLE_RATE))
            b = min(len(wav), int((offset + 0.3) * SAMPLE_RATE))
            results["end"] = _edge_verdict(_transcribe(wav[a:b]), last_ref, False)
    except Exception as e:
        logger.warning(f"Whisper edge verification unavailable: {e}")
    return results


# ========== CORE: ALIGN TARGET INSIDE A REGION ==========

def _review(code, ar, tr, en, at_sec=None):
    return {"code": code, "ar": ar, "tr": tr, "en": en, "atSec": at_sec}


def _align_region(surah_id, words_by_ayah, start_ayah, end_ayah, wav, *, prev_context=None,
                  next_context=None):
    """Align the target (optionally sandwiched by context words) inside
    `wav`. Returns (units, ayah_info, emission)."""
    targets = set(range(start_ayah, end_ayah + 1))
    region_end = len(wav) / SAMPLE_RATE
    env = _energy_db(wav)
    emission = compute_emission(wav)
    units = _build_units(surah_id, words_by_ayah, range(start_ayah, end_ayah + 1), targets,
                         prev_context=prev_context, next_context=next_context)
    _ctc_align(emission, units)
    ayah_info = _resolve_times(units, env, 0.0, region_end)
    return units, ayah_info, emission


def _assess(units, ayah_info, start_ayah, end_ayah, wav, words_by_ayah, region_start_is_audio_start,
            region_end_is_audio_end, check_whisper=True):
    """Collect review reasons for an alignment (empty list = verified)."""
    reasons = []
    target_units = _aligned(units, target_only=True)
    first, last = target_units[0], target_units[-1]
    onset = ayah_info[start_ayah]["onset"]
    offset = ayah_info[end_ayah]["offset"]
    mean_conf = _mean_conf(target_units)

    if mean_conf < MEAN_MIN_CONF:
        reasons.append(_review(
            "low_confidence",
            "لم يتم التعرف على الآيات المختارة بثقة كافية في هذا الصوت. تأكد أن الصوت يحتوي هذه الآيات.",
            "Seçilen ayetler bu seste yeterli güvenle tanınamadı. Sesin bu ayetleri içerdiğinden emin olun.",
            "The selected ayahs couldn't be recognized in this audio with enough confidence. Make sure the audio contains these ayahs.",
            onset,
        ))
    if first["conf"] < BOUNDARY_WORD_MIN_CONF:
        if region_start_is_audio_start and onset < 0.3:
            reasons.append(_review(
                "audio_starts_late",
                "يبدو أن التسجيل يبدأ بعد بداية الآية الأولى.",
                "Kayıt, ilk ayetin başlangıcından sonra başlıyor gibi görünüyor.",
                "The recording seems to start after the beginning of the first ayah.",
                onset,
            ))
        else:
            reasons.append(_review(
                "start_uncertain",
                "بداية الآية الأولى غير مؤكدة، يرجى التحقق منها.",
                "İlk ayetin başlangıcı kesin değil, lütfen kontrol edin.",
                "The start of the first ayah is uncertain, please check it.",
                onset,
            ))
    if last["conf"] < BOUNDARY_WORD_MIN_CONF:
        if region_end_is_audio_end and offset > len(wav) / SAMPLE_RATE - 0.3:
            reasons.append(_review(
                "audio_ends_early",
                "يبدو أن التسجيل ينتهي قبل نهاية الآية الأخيرة.",
                "Kayıt, son ayetin bitişinden önce bitiyor gibi görünüyor.",
                "The recording seems to end before the end of the last ayah.",
                offset,
            ))
        else:
            reasons.append(_review(
                "end_uncertain",
                "نهاية الآية الأخيرة غير مؤكدة، يرجى التحقق منها.",
                "Son ayetin bitişi kesin değil, lütfen kontrol edin.",
                "The end of the last ayah is uncertain, please check it.",
                offset,
            ))

    if check_whisper and not reasons:
        first_clean = _norm_words(" ".join(words_by_ayah[start_ayah]["clean"]))
        last_clean = _norm_words(" ".join(words_by_ayah[end_ayah]["clean"]))
        # Whisper spells huroof muqatta'at unpredictably ("الم" vs "ألف لام
        # ميم"), so the start check would only produce false alarms there.
        verdict = verify_edges(
            wav, target_units, onset, offset, first_clean[:3], last_clean[-3:],
            check_start=not first.get("huroof"),
        )
        if verdict.get("start") is False:
            reasons.append(_review(
                "start_mismatch",
                "التحقق المستقل لم يسمع أول كلمة من الآية في بداية المقطع. يرجى التحقق من البداية.",
                "Bağımsız doğrulama, klibin başında ayetin ilk kelimesini duymadı. Lütfen başlangıcı kontrol edin.",
                "The independent check didn't hear the ayah's first word at the start of the clip. Please check the start.",
                onset,
            ))
        if verdict.get("end") is False:
            reasons.append(_review(
                "end_mismatch",
                "التحقق المستقل لم يسمع آخر كلمة من الآية في نهاية المقطع. يرجى التحقق من النهاية.",
                "Bağımsız doğrulama, klibin sonunda ayetin son kelimesini duymadı. Lütfen bitişi kontrol edin.",
                "The independent check didn't hear the ayah's last word at the end of the clip. Please check the end.",
                offset,
            ))
    return reasons, mean_conf


# ========== OUTPUT ==========

def _write_outputs(source_path, source_duration, source_offset, units, ayah_info, start_ayah, end_ayah,
                   pad_seconds, clip_name, meta, reasons, confidence, readings=None):
    """Slice the clip from the ORIGINAL source (full quality) and write the
    word-timing JSON. `source_offset` maps region-relative seconds to
    source seconds. `readings`: see _reading_path."""
    onset = source_offset + ayah_info[start_ayah]["onset"]
    offset = source_offset + ayah_info[end_ayah]["offset"]

    clip_start = max(0.0, onset - max(pad_seconds, 0.3))
    clip_end = min(source_duration, offset + max(pad_seconds, 0.5))
    clip_duration = clip_end - clip_start

    final_clip_path = OUTPUT_DIR / f"{clip_name}.mp3"
    final_json_path = OUTPUT_DIR / f"{clip_name}.json"

    # Cut with atrim inside the filter graph rather than -ss: output-side
    # -ss still runs every filter on the ORIGINAL timeline from 0s, so a
    # fade-out placed at "clip_duration - fade" landed near the start of the
    # source and silenced the whole clip. atrim is sample-exact (it works on
    # decoded audio) and asetpts restarts the clock at the clip's start, so
    # the fades below are relative to the clip itself.
    filters = [f"atrim=start={clip_start:.4f}:end={clip_end:.4f}", "asetpts=PTS-STARTPTS"]
    fade = 0.15
    if onset - clip_start > 2 * fade:
        filters.append(f"afade=t=in:st=0:d={fade:.3f}")
    if clip_end - offset > 2 * fade:
        filters.append(f"afade=t=out:st={clip_duration - fade:.3f}:d={fade:.3f}")
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(source_path), "-vn", "-af", ",".join(filters),
         "-b:a", "192k", str(final_clip_path)],
        check=True, capture_output=True,
    )
    if not final_clip_path.exists() or final_clip_path.stat().st_size < 1024:
        _fail("Writing the final clip failed (empty output).")
    # A cut is only useful if it actually contains the recitation.
    if _max_volume_db(final_clip_path) < -60.0:
        _fail("Writing the final clip failed (the output is silent).")

    def rel_ms(t):
        return int(round((source_offset + t - clip_start) * 1000))

    verses = {}
    for u in units:
        if not u["target"]:
            continue
        verses.setdefault(str(u["ayah"]), {"words": []})["words"].append({
            "w": u["w"],
            "start": max(0, rel_ms(u["start"])),
            "end": max(0, rel_ms(u["end"])),
            **({"conf": round(u["conf"], 3)} if "conf" in u else {}),
        })

    # Trim defaults for the UI: a hair before the voice starts / after the
    # last sound decays, never reaching into the neighbouring ayah (whose
    # own onset/offset is known when it was aligned as context).
    start_info, end_info = ayah_info[start_ayah], ayah_info[end_ayah]
    floor = max(start_info["lo"], ayah_info.get(start_ayah - 1, {}).get("offset", start_info["lo"]))
    ceiling = min(end_info["hi"], ayah_info.get(end_ayah + 1, {}).get("onset", end_info["hi"]))
    lead = min(start_info["onset"], max(floor, start_info["onset"] - 0.12))
    tail = max(end_info["offset"], min(ceiling, end_info["offset"] + 0.3))

    review_reasons = [
        {**r, "atMs": rel_ms(r["atSec"]) if r.get("atSec") is not None else None}
        for r in reasons
    ]
    for r in review_reasons:
        r.pop("atSec", None)

    final_json = {
        "surah": meta["surah"],
        "start_ayah": start_ayah,
        "end_ayah": end_ayah,
        "reciter": meta["reciter"],
        "pad_seconds": pad_seconds,
        "engine": ENGINE_VERSION,
        "source": meta["source"],
        "clipSourceStartSec": round(clip_start, 3),
        "ayahStartMs": max(0, rel_ms(lead)),
        "ayahEndMs": max(0, rel_ms(tail)),
        "needsReview": bool(review_reasons),
        "reviewReasons": review_reasons,
        "lowConfidenceEnd": any(r["code"] in ("end_uncertain", "end_mismatch", "audio_ends_early") for r in review_reasons),
        "confidence": confidence,
        "verses": verses,
    }
    if readings:
        # The order the reciter read in, repeats included (only written when
        # he went back): each reading is a run of one ayah's tokens
        # ("from".."to", pause marks included) with [start, end] ms per
        # token on this clip -- a mark takes the end of the word before it.
        final_json["readings"] = []
        for r in readings:
            times = {idx: (rel_ms(s), rel_ms(e)) for idx, s, e in r["words"]}
            spans, last_end = [], None
            for idx in range(r["from"], r["to"] + 1):
                s, e = times.get(idx, (last_end, last_end))
                spans.append([max(0, s), max(0, e)])
                last_end = e
            final_json["readings"].append({"ayah": r["ayah"], "from": r["from"], "to": r["to"], "jump": r["jump"], "words": spans})
    with open(final_json_path, "w", encoding="utf-8") as f:
        json.dump(final_json, f, ensure_ascii=False, indent=2)

    logger.info(
        f"[{ENGINE_VERSION}] {clip_name}: ayah {onset:.2f}s-{offset:.2f}s in source, "
        f"mean conf {confidence['mean']:.2f}, review={[r['code'] for r in review_reasons]}"
    )
    return str(final_clip_path), str(final_json_path)


def _confidence_summary(units, mean_conf):
    target = _aligned(units, target_only=True)
    return {
        "mean": round(mean_conf, 3),
        "min": round(min(u["conf"] for u in target), 3),
        "first": round(target[0]["conf"], 3),
        "last": round(target[-1]["conf"], 3),
    }


# ========== SOURCE: WHOLE-SURAH RECORDING ==========

def _mp3quran_ayah_times(reciter_id, surah_id, actual_duration):
    """Approximate {ayah: (start, end)} seconds from mp3quran's timing API,
    scaled when its total disagrees with the actual file. Used only to pick
    the analysis window -- never trusted for the cut itself."""
    url = f"https://mp3quran.net/api/v3/ayat_timing?surah={surah_id}&read={RECITERS_TIMING_ID[reciter_id]}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as response:
        data = json.loads(response.read().decode())
    if isinstance(data, dict):
        timings = data.get("times") or data.get("ayat_timing") or next(
            (v for v in data.values() if isinstance(v, list)), [])
    else:
        timings = data
    if not timings:
        return None
    api_total = float(timings[-1]["end_time"]) / 1000.0
    ratio = actual_duration / api_total if api_total > 0 and abs(actual_duration - api_total) > 0.05 * api_total else 1.0
    return {int(t["ayah"]): (float(t["start_time"]) / 1000.0 * ratio, float(t["end_time"]) / 1000.0 * ratio)
            for t in timings if int(t["ayah"]) > 0}


def _coarse_locate(audio_path, words_by_ayah, start_ayah, end_ayah, duration, extend=True):
    """Rough (start, end) of the target in a long recording via Whisper +
    fuzzy text search. Only picks a generous window for the CTC aligner,
    which decides the actual boundaries. With `extend`, a short target is
    searched together with its neighbouring ayahs (see COARSE_MIN_WORDS) --
    the window then spans them too, which still contains the target; off
    for uploads that may hold only the requested ayahs."""
    model = _get_verify_model()
    hyp = []
    chunk_start = 0.0
    while chunk_start < duration:
        job_control.check_cancelled()
        job_control.report("locate", percent=100 * chunk_start / duration)
        chunk_len = min(COARSE_CHUNK_SEC, duration - chunk_start)
        wav = _to_float(decode_pcm(audio_path, start=chunk_start, duration=chunk_len))
        segments, _ = model.transcribe(wav, language="ar", beam_size=1, word_timestamps=True,
                                       condition_on_previous_text=False, vad_filter=True)
        # Transcription runs lazily as `segments` is iterated, so checking
        # here too keeps progress moving and a cancel quick within a chunk.
        for seg in segments:
            job_control.check_cancelled()
            job_control.report("locate", percent=100 * (chunk_start + seg.end) / duration)
            for w in seg.words or []:
                for nw in _norm_words(w.word):
                    hyp.append((nw, chunk_start + w.start, chunk_start + w.end))
        chunk_start += chunk_len

    def ayah_words(a):
        return _norm_words(" ".join(words_by_ayah[a]["clean"]))

    lo, hi = start_ayah, end_ayah
    n_ayahs = len(words_by_ayah)
    if extend:
        while sum(len(ayah_words(a)) for a in range(lo, hi + 1)) < COARSE_MIN_WORDS and (lo > 1 or hi < n_ayahs):
            if hi < n_ayahs:
                hi += 1
            if lo > 1 and sum(len(ayah_words(a)) for a in range(lo, hi + 1)) < COARSE_MIN_WORDS:
                lo -= 1
    target = []
    for a in range(lo, hi + 1):
        target.extend(ayah_words(a))
    if not hyp or not target:
        return 0.0, duration
    words = [h[0] for h in hyp]
    n = len(target)

    def score(i, j):
        return difflib.SequenceMatcher(None, words[i:j], target, autojunk=False).ratio()

    # Coarse pass: fixed-length windows at a stride (a whole Al-Baqarah
    # upload is ~6000 words; scoring every (i, j) pair would take hours).
    stride = max(1, n // 10)
    starts = range(0, max(1, len(words) - n + 1), stride)
    best_i = max(starts, key=lambda i: score(i, i + n))
    # Refine start and length around the best coarse hit.
    best = (-1.0, best_i, min(len(words), best_i + n) - 1)
    step = max(1, n // 20)
    for i in range(max(0, best_i - stride), min(len(words), best_i + stride + 1)):
        for length in range(max(1, int(n * 0.6)), int(n * 1.4) + 1, step):
            j = min(len(words), i + length)
            r = score(i, j)
            if r > best[0]:
                best = (r, i, j - 1)
    _, i, j = best
    return hyp[i][1], hyp[j][2]


def _locate_window(source_path, surah_id, words_by_ayah, start_ayah, end_ayah, duration, extend=True):
    """Window to align in when there is no prior about where the target is:
    the whole recording when that's affordable, else a Whisper estimate
    (`extend`: see _coarse_locate)."""
    model, _, _ = _get_mms()
    max_sec = FULL_SCAN_MAX_SEC_GPU if next(model.parameters()).is_cuda else FULL_SCAN_MAX_SEC_CPU
    units = _build_units(surah_id, words_by_ayah, range(start_ayah, end_ayah + 1), set())
    tokens = sum(len(u["ids"]) + 1 for u in units)
    if duration <= max_sec and (duration / FRAME_SEC) * (2 * tokens + 1) <= FULL_SCAN_MAX_CELLS:
        return 0.0, duration
    job_control.report("locate")
    c0, c1 = _coarse_locate(source_path, words_by_ayah, start_ayah, end_ayah, duration, extend=extend)
    return c0 - 30.0, c1 + 30.0


def _extract_from_long_audio(source_path, surah_id, start_ayah, end_ayah, pad_seconds, words_by_ayah,
                             clip_name, meta, approx=None, use_context=True):
    """Shared by whole-surah reciter recordings and user uploads."""
    n_ayahs = len(words_by_ayah)
    duration = _probe_duration(source_path)
    prev_ctx = (start_ayah - 1, CONTEXT_WORDS) if use_context and start_ayah > 1 else None
    next_ctx = (end_ayah + 1, CONTEXT_WORDS) if use_context and end_ayah < n_ayahs else None

    if approx is not None:
        t0, t1 = approx[0] - 15.0, approx[1] + 15.0
    else:
        t0, t1 = _locate_window(source_path, surah_id, words_by_ayah, start_ayah, end_ayah, duration,
                                extend=use_context)

    best = None
    verified = False
    for attempt in range(4):
        job_control.check_cancelled()
        job_control.report("align")
        t0, t1 = max(0.0, t0), min(duration, t1)
        wav = _to_float(decode_pcm(source_path, start=t0, duration=t1 - t0))
        units, ayah_info, emission = _align_region(
            surah_id, words_by_ayah, start_ayah, end_ayah, wav,
            prev_context=prev_ctx, next_context=next_ctx,
        )
        aligned = _aligned(units)
        target = _aligned(units, target_only=True)
        region_len = t1 - t0
        touches_start = t0 > 0 and aligned[0]["tok_start"] < 0.5
        touches_end = t1 < duration and aligned[-1]["tok_end"] > region_len - 0.5
        context_units = [u for u in aligned if not u["target"]]
        context_ok = not context_units or _mean_conf(context_units) >= MEAN_MIN_CONF
        target_ok = _mean_conf(target) >= MEAN_MIN_CONF

        candidate = (_mean_conf(target), t0, units, ayah_info, wav, emission)
        if best is None or candidate[0] > best[0]:
            best = candidate
        if target_ok and context_ok and not touches_start and not touches_end:
            best, verified = candidate, True
            break
        if t0 <= 0.0 and t1 >= duration:
            break  # already looked at the whole recording; widening can't help

        if attempt == 2 and (t0 > 0 or t1 < duration):
            # The approximate position was badly off; fall back to locating
            # the ayahs from the audio itself.
            t0, t1 = _locate_window(source_path, surah_id, words_by_ayah, start_ayah, end_ayah, duration,
                                    extend=use_context)
            continue
        if not (target_ok and context_ok):
            t0, t1 = t0 - 60.0, t1 + 60.0
        else:
            if touches_start:
                t0 -= 30.0
            if touches_end:
                t1 += 30.0
        logger.info(f"Alignment window [{t0:.1f}, {t1:.1f}] retry {attempt + 1} "
                    f"(target_ok={target_ok}, context_ok={context_ok}, edges={touches_start}/{touches_end}).")

    _, t0, units, ayah_info, wav, emission = best
    job_control.check_cancelled()
    job_control.report("verify")
    # Where the reciter went back and read part of it again, the words move
    # onto their first reading and the repeats are timed too.
    env = _energy_db(wav)
    readings, suspects = _reading_path(emission, units, env)
    # Where the model can't hear the recitation at all, Whisper listens.
    readings, unheard, moved = _hear_deaf_stretches(wav, emission, env, units, readings, words_by_ayah)
    if readings or moved:
        ayah_info = _resolve_times(units, env, 0.0, len(wav) / SAMPLE_RATE)
    reasons, mean_conf = _assess(
        units, ayah_info, start_ayah, end_ayah, wav, words_by_ayah,
        region_start_is_audio_start=(t0 <= 0.0),
        region_end_is_audio_end=(t0 + len(wav) / SAMPLE_RATE >= duration - 0.05),
    )
    if not verified and not reasons:
        # Every window was tried and none was fully consistent (e.g. the
        # neighbouring ayahs never matched around the target).
        reasons.append(_review(
            "location_uncertain",
            "لم يتم التأكد تماماً من موضع الآيات داخل التسجيل، يرجى التحقق منه.",
            "Ayetlerin kayıttaki yeri tam olarak doğrulanamadı, lütfen kontrol edin.",
            "The ayahs' position in the recording couldn't be fully verified, please check it.",
            ayah_info[start_ayah]["onset"],
        ))

    weak = _weak_word_reason(units)
    if weak:
        reasons.append(weak)
    for a, b in unheard:
        # Nothing heard there could be confirmed: the text may not match.
        reasons.append(_review(
            "unclear_audio",
            f"لم يُسمع الصوت بوضوح هنا لمدة {b - a:.0f} ثوانٍ تقريباً. إن كان القارئ كرر شيئاً في هذا الموضع فأضفه من لوحة التوقيت.",
            f"Burada yaklaşık {b - a:.0f} saniye boyunca ses net duyulamadı. Kâri burada bir şeyi tekrarladıysa Zamanlama panelinden ekleyin.",
            f"The recitation couldn't be heard clearly here for about {b - a:.0f} seconds. If the reciter repeated something here, add it in the Timing panel.",
            a,
        ))
    if suspects:
        # Looked like the reciter went back here, but it couldn't be
        # verified: the text there may not match the audio.
        reasons.append(_review(
            "possible_repeat",
            "يبدو أن القارئ أعاد جزءاً من الآيات هنا ولم يتم التأكد من ذلك. استمع إلى هذا الموضع، وأضف التكرار من لوحة التوقيت إن وُجد.",
            "Kâri burada ayetlerin bir kısmını tekrar okumuş gibi görünüyor, ancak doğrulanamadı. Bu yeri dinleyin, tekrar varsa Zamanlama panelinden ekleyin.",
            "The reciter seems to go back and repeat part of the ayahs here, but it couldn't be verified. Listen to this spot and add the repeat in the Timing panel if there is one.",
            min(suspects),
        ))

    # A repeat the reading path already timed needs no review.
    repeats = [] if readings else _find_repeated_ayahs(emission, units, surah_id, words_by_ayah, start_ayah, end_ayah, mean_conf)
    if repeats:
        ayahs = [a for a, _ in repeats]
        contiguous = ayahs == list(range(ayahs[0], ayahs[-1] + 1))
        if len(ayahs) == 1:
            label_ar, label_tr, label_en = f"الآية {ayahs[0]}", f"{ayahs[0]}. ayeti", f"ayah {ayahs[0]}"
        elif contiguous:
            label_ar, label_tr, label_en = (f"الآيات {ayahs[0]}–{ayahs[-1]}", f"{ayahs[0]}–{ayahs[-1]}. ayetleri",
                                            f"ayahs {ayahs[0]}–{ayahs[-1]}")
        else:
            nums = ", ".join(str(a) for a in ayahs)
            label_ar, label_tr, label_en = f"الآيات {'، '.join(str(a) for a in ayahs)}", f"{nums}. ayetleri", f"ayahs {nums}"
        reasons.append(_review(
            "internal_repeat",
            f"القارئ يقرأ {label_ar} أكثر من مرة في هذا التسجيل، وتم توقيت قراءة واحدة فقط. افتح لوحة التوقيت وتأكد منها، أو قص التكرار.",
            f"Okuyucu bu kayıtta {label_tr} birden fazla okuyor ve yalnızca bir okuma zamanlandı. Zamanlama panelini açıp kontrol edin veya tekrarı kesin.",
            f"The reciter recites {label_en} more than once in this recording, and only one recitation was timed. Open the Timing panel to check it, or trim the repeat.",
            min(at for _, at in repeats),
        ))

    if not use_context and _target_text_repeats(words_by_ayah, start_ayah, end_ayah):
        # The same text occurs more than once in this surah and we have no
        # neighbouring ayahs to tell occurrences apart: check whether the
        # recording itself holds a second, equally good match.
        if _has_second_occurrence(emission, units, surah_id, words_by_ayah, start_ayah, end_ayah, mean_conf):
            reasons.append(_review(
                "ambiguous_repeat",
                "نص هذه الآيات يتكرر في التسجيل أكثر من مرة. تم اختيار أوضح موضع، يرجى التأكد أنه المطلوب.",
                "Bu ayetlerin metni kayıtta birden fazla geçiyor. En net eşleşen yer seçildi, lütfen doğru olduğunu kontrol edin.",
                "These ayahs' text occurs more than once in the recording. The clearest match was chosen, please check it's the right one.",
                ayah_info[start_ayah]["onset"],
            ))

    return _write_outputs(
        source_path, duration, t0, units, ayah_info, start_ayah, end_ayah, pad_seconds, clip_name,
        meta, reasons, _confidence_summary(units, mean_conf), readings=readings,
    )


def _ayah_text_occurs_elsewhere(words_by_ayah, ayah):
    """The ayah's text -- or a near-identical one (94:5 "فإن مع العسر يسرا"
    vs 94:6 "إن مع العسر يسرا") -- also occurs in another ayah of the surah
    or in the basmala."""
    words = _norm_words(" ".join(words_by_ayah[ayah]["clean"]))
    n = len(words)
    text = " ".join(words)
    sequences = [_norm_words(BASMALA_CLEAN)]
    for a in sorted(words_by_ayah):
        if a == ayah:
            continue
        sequences.append(_norm_words(" ".join(words_by_ayah[a]["clean"])))
    for seq in sequences:
        for i in range(max(1, len(seq) - n + 1)):
            window = " ".join(seq[i:i + n])
            matcher = difflib.SequenceMatcher(None, text, window, autojunk=False)
            if matcher.real_quick_ratio() >= REPEAT_SIMILAR_TEXT and matcher.ratio() >= REPEAT_SIMILAR_TEXT:
                return True
    return False


def _pause_runs(env, lo, hi):
    """[(start_hop, end_hop, depth_db)] of the pauses in env[lo:hi] (see
    RETURN_PAUSE_*)."""
    from numpy.lib.stride_tricks import sliding_window_view

    w = int(RETURN_PAUSE_WIN_SEC / ENV_HOP_SEC)
    win = sliding_window_view(np.pad(env, w, mode="edge"), w + 1)
    depth = np.minimum(win[:len(env)].max(axis=1), win[w:w + len(env)].max(axis=1)) - env
    level = float(np.percentile(env[lo:hi], 90)) if hi > lo else 0.0
    quiet = (depth >= RETURN_PAUSE_DIP_DB) | (env <= level - RETURN_SILENCE_DB)
    runs, i = [], lo
    while i < hi:
        if not quiet[i]:
            i += 1
            continue
        j = i
        while j < hi and quiet[j]:
            j += 1
        if (j - i) * ENV_HOP_SEC >= RETURN_PAUSE_MIN_SEC:
            runs.append((i, j, float(max(depth[i:j].max(), level - env[i:j].min()))))
        i = j
    return runs


def _path_search(em, y, words, start_words, end_words, arrive, no_span, banned=frozenset()):
    """Viterbi over the CTC states of the concatenated words' letters `y`,
    with jumps back (see the RETURN_* comment). em: [T, V] log-posteriors of
    the searched frames; words: [(first token, last token, ayah)]; arrive:
    frame -> pause a jump may land on; no_span: frames no word may be inside
    of; banned: (pause, word gone back to, word gone back from) jumps not
    allowed.
    Returns (state per frame, frames a jump landed on)."""
    T, N, W = em.shape[0], len(y), len(words)
    S = 2 * N + 1
    labels = np.zeros(S, dtype=np.int64)
    labels[1::2] = y
    skip = np.zeros(S, dtype=bool)
    skip[3::2] = y[1:] != y[:-1]
    wa = np.array([w[0] for w in words])
    wb = np.array([w[1] for w in words])
    ayah = np.array([w[2] for w in words])
    start_blank, start_letter = 2 * wa, 2 * wa + 1
    end_letter, end_blank = 2 * wb + 1, 2 * wb + 2
    between = np.zeros(S, dtype=bool)
    for states in (start_blank, start_letter, end_letter, end_blank):
        between[states] = True
    # back[i, k]: a reading that ended at word k may go back to word i.
    i_idx, k_idx = np.meshgrid(np.arange(W), np.arange(W), indexing="ij")
    back = (k_idx >= i_idx) & (k_idx - i_idx < RETURN_MAX_WORDS) & (ayah[k_idx] - ayah[i_idx] <= RETURN_MAX_AYAHS)

    def emit(t):
        e = np.maximum(em[t, labels], em[t, 0] - RETURN_LETTER_CAP)
        e[0::2] = em[t, 0]
        return e

    delta = np.full(S, -np.inf)
    e0 = emit(0)
    for i in start_words:
        delta[start_blank[i]] = e0[start_blank[i]]
        delta[start_letter[i]] = e0[start_letter[i]]
    bp = np.zeros((T, S), dtype=np.int8)
    jump_from = {}
    cols = np.arange(S)
    banned_at = {}
    for pause, i, k in banned:
        banned_at.setdefault(pause, []).append((i, k))
    for t in range(1, T):
        prev1 = np.concatenate(([-np.inf], delta[:-1]))
        prev2 = np.where(skip, np.concatenate(([-np.inf, -np.inf], delta[:-2])), -np.inf)
        stack = np.stack([delta, prev1, prev2])
        arg = stack.argmax(axis=0).astype(np.int8)
        best = stack[arg, cols]
        if t in arrive:
            ends = np.maximum(delta[end_letter], delta[end_blank])
            end_state = np.where(delta[end_letter] >= delta[end_blank], end_letter, end_blank)
            cand = np.where(back, ends[None, :], -np.inf)
            for i, k in banned_at.get(arrive[t], ()):
                cand[i, k] = -np.inf
            k = cand.argmax(axis=1)
            value = cand[np.arange(W), k] - RETURN_JUMP_COST
            better = value > best[start_letter]
            if better.any():
                targets = start_letter[better]
                best[targets] = value[better]
                arg[targets] = 3
                jump_from[t] = dict(zip(targets.tolist(), end_state[k[better]].tolist()))
        if t in no_span:
            best = np.where(between, best, -np.inf)
        bp[t] = arg
        delta = best + emit(t)
    finals = np.concatenate([end_letter[end_words], end_blank[end_words]])
    s = int(finals[np.argmax(delta[finals])])
    path = np.zeros(T, dtype=np.int64)
    jumps = set()
    for t in range(T - 1, 0, -1):
        path[t] = s
        b = bp[t, s]
        if b == 3:
            jumps.add(t)
            s = jump_from[t][s]
        else:
            s -= int(b)
    path[0] = s
    return path, jumps


CLEAR_WIDEN = 6  # frames (0.12s)


def _path_occurrences(path, jumps, em, y, tok_word, consonant):
    """Every reading of a word along the path, in time order: {"w": word,
    "jump": entered by a jump, "f0"/"f1": its letters' frames, "conf" (mean
    posterior over its letters' frames, as _ctc_align), "clear" (mean peak
    posterior of its consonants), "spans": per-letter frame spans}."""
    occ, pending = [], False
    for t, s in enumerate(path):
        if t in jumps:
            pending = True
        if s % 2 == 0:
            continue
        tok = (s - 1) // 2
        w = tok_word[tok]
        if pending or not occ or occ[-1]["w"] != w or tok < occ[-1]["last"]:
            occ.append({"w": w, "jump": pending, "letters": {}, "last": tok})
            pending = False
        occ[-1]["last"] = tok
        occ[-1]["letters"].setdefault(tok, []).append(t)
    for o in occ:
        frames = [f for fs in o["letters"].values() for f in fs]
        o["f0"], o["f1"] = min(frames), max(frames)
        o["conf"] = float(np.mean([np.mean(np.exp(em[fs, y[tok]])) for tok, fs in o["letters"].items()]))
        # A little around the word: the path can squeeze a word the model
        # hears badly into a few frames next to where it really is.
        a, b = max(0, o["f0"] - CLEAR_WIDEN), min(len(em), o["f1"] + 1 + CLEAR_WIDEN)
        peaks = [float(np.exp(em[a:b, y[tok]].max())) for tok in o["letters"] if consonant[y[tok]]]
        o["clear"] = float(np.mean(peaks)) if peaks else o["conf"]
        o["spans"] = [(min(fs), max(fs)) for _, fs in sorted(o["letters"].items())]
    return occ


def _verify_jumps(occ, order):
    """[{"frame", "ok", "margin"}] per jump back on the path (see the RETURN_*
    comment); margin < 0 fails, and says by how much."""
    firsts = {}
    for o in occ:
        firsts.setdefault(o["w"], o)
    need = max(RETURN_MIN_CLEAR, RETURN_MIN_REL * float(np.mean([o["clear"] for o in firsts.values()])))
    checks, seen = [], {}
    for n, o in enumerate(occ):
        if o["jump"]:
            # The words read again: from here to the next jump.
            pairs, letters = [], 0
            for o2 in occ[n:]:
                if o2 is not o and o2["jump"]:
                    break
                if o2["w"] in seen:
                    pairs.append((o2["clear"], seen[o2["w"]]["clear"]))
                    letters += len(order[o2["w"]]["ids"])
            if len(pairs) < RETURN_MIN_WORDS or letters < RETURN_MIN_LETTERS:
                score, ratio, detail = -1.0, 0.0, f"{len(pairs)} words"
            else:
                again, before = zip(*pairs)
                ratio = float(np.mean([min(a, b) / max(a, b, 1e-6) for a, b in pairs]))
                score = ratio + min(np.mean(again), np.mean(before)) - need
                detail = (f"{len(pairs)} words, clear {np.mean(again):.2f}/{np.mean(before):.2f} (need {need:.2f}), "
                          f"ratio {ratio:.2f}")
            ok = ratio >= RETURN_MIN_RATIO and score >= RETURN_ACCEPT
            checks.append({"to": o["w"], "from": occ[n - 1]["w"] if n else o["w"], "frame": o["f0"], "ok": ok, "margin": float(score - RETURN_ACCEPT), "words": len(pairs),
                           "suspect": not ok and score >= RETURN_SUSPECT, "detail": detail})
        seen.setdefault(o["w"], o)
    return checks


def _unexplained_speech(path, em, runs, hop, r0):
    """Frames (on the searched region) where a stretch of speech between two
    pauses, inside the reading, holds no letter of the path at all -- what a
    repeat the search couldn't verify, or anything else read there, looks
    like."""
    letter = np.flatnonzero(path % 2 == 1)
    if len(letter) == 0:
        return []
    mass = 1.0 - np.exp(em[:, 0])
    edges = [(int(i / hop) - r0, int(j / hop) - r0) for i, j, _ in runs]
    found = []
    for (_, a), (b, _) in zip(edges, edges[1:]):
        a, b = max(a, int(letter[0])), min(b, int(letter[-1]))
        if b - a < UNEXPLAINED_MIN_SEC / FRAME_SEC or (path[a:b] % 2 == 1).any():
            continue
        logger.info(f"Unexplained speech {(r0 + a) * FRAME_SEC:.1f}-{(r0 + b) * FRAME_SEC:.1f}s: "
                    f"letter evidence {mass[a:b].sum():.2f}.")
        if mass[a:b].sum() >= UNEXPLAINED_MIN_MASS:
            found.append(a)
    return found


def _reading_path(emission, units, env):
    """The order the reciter actually read the target in, when he went back
    and read part of it again (see the RETURN_* comment). Returns (readings,
    suspects). readings -- [{"ayah", "from", "to", "jump", "words": [(token
    index, start, end)]}] in time order, seconds on the region's timeline,
    each a run of consecutive words of one ayah ("jump": it starts by going
    back), or None when he didn't go back -- moves every unit's
    f0/f1/conf/spans onto its FIRST reading. suspects -- [seconds] where a
    repeat seemed to start but couldn't be verified."""
    order = [u for u in units if u["ids"] and "f0" in u]
    if not any(u["target"] for u in order):
        return None, []
    _, dictionary, _ = _get_mms()
    lead = RETURN_LEAD_SEC
    tail = RETURN_CONTEXT_SLACK_SEC if not order[-1]["target"] else RETURN_SLACK_SEC
    r0 = max(0, order[0]["f0"] - int(lead / FRAME_SEC))
    r1 = min(emission.shape[0], order[-1]["f1"] + int(tail / FRAME_SEC) + 1)
    y, words, tok_word = [], [], []
    for n, u in enumerate(order):
        words.append((len(y), len(y) + len(u["ids"]) - 1, u["ayah"]))
        y.extend(u["ids"])
        tok_word.extend([n] * len(u["ids"]))
    y = np.array(y)
    if (r1 - r0) * (2 * len(y) + 1) > RETURN_MAX_CELLS:
        logger.warning("Reading path skipped: the selection is too long to search.")
        return None, []
    em = emission[r0:r1].numpy().astype(np.float64)
    # A long vowel written with waw/yaa is often heard as the consonant
    # ("يَتْلُوا۟": the model hears y-t-l-w, the spelling says yatlu).
    for vowel, cons in (("u", "w"), ("i", "y")):
        em[:, dictionary[vowel]] = np.maximum(em[:, dictionary[vowel]], em[:, dictionary[cons]])
    consonant = np.ones(em.shape[1], dtype=bool)
    consonant[[0] + [dictionary[c] for c in "aiueo"]] = False

    hop = FRAME_SEC / ENV_HOP_SEC
    arrive, no_span = {}, set()
    runs = _pause_runs(env, int(r0 * hop), min(len(env), int(r1 * hop)))
    for pid, (i, j, depth) in enumerate(runs):
        end = int(j / hop)
        for f in range(end - int(RETURN_ARRIVE_BEFORE_SEC / FRAME_SEC), end + int(RETURN_ARRIVE_AFTER_SEC / FRAME_SEC) + 1):
            if r0 < f < r1:
                arrive[f - r0] = pid
        if (j - i) * ENV_HOP_SEC >= RETURN_SPAN_PAUSE_SEC and depth >= RETURN_SPAN_PAUSE_DB and r0 < (i + j) / 2 / hop < r1:
            no_span.add(int((i + j) / 2 / hop) - r0)

    first_target = next(n for n, u in enumerate(order) if u["target"])
    last_target = max(n for n, u in enumerate(order) if u["target"])
    start_words = list(range(first_target + 1))  # may start inside the context
    end_words = list(range(last_target, len(order)))
    banned, suspects = set(), []
    for round_no in range(RETURN_ROUNDS):
        job_control.check_cancelled()
        path, jumps = _path_search(em, y, words, start_words, np.array(end_words), arrive, no_span, banned)
        occ = _path_occurrences(path, jumps, em, y, tok_word, consonant)
        checks = _verify_jumps(occ, order)
        failed = [c for c in checks if not c["ok"]]
        logger.info(f"Reading path round {round_no + 1}: " + (", ".join(
            f"{'ok' if c['ok'] else 'rejected'} jump at {(r0 + c['frame']) * FRAME_SEC:.1f}s ({c['margin']:+.2f}: {c['detail']})"
            for c in checks) or "no jump back") + ".")
        if not failed:
            break
        # Too short to be a repeat at all: all banned at once; otherwise
        # the weakest, since a false jump can drag a true one down with it.
        short = [c for c in failed if c["words"] < RETURN_MIN_WORDS]
        for c in short or [min(failed, key=lambda c: c["margin"])]:
            # Only this jump: the same pause may still lead back elsewhere.
            # (Closing the whole pause lost 79:29 in the user's fajr upload:
            # the search first offered a one-word repeat there, and the true
            # two-word one at the same pause was never tried.)
            banned.add((arrive[c["frame"]], c["to"], c["from"]))
            if c["suspect"]:
                suspects.append((r0 + c["frame"]) * FRAME_SEC)
    else:
        logger.warning("Reading path: no verified result after the last round; keeping the linear one.")
        return None, suspects
    suspects += [(r0 + f) * FRAME_SEC for f in _unexplained_speech(path, em, runs, hop, r0)]
    if not jumps:
        return None, suspects

    seen = set()
    for o in occ:
        if o["w"] not in seen:
            seen.add(o["w"])
            u = order[o["w"]]
            f0, f1 = r0 + o["f0"], r0 + o["f1"]
            # Where the linear alignment had the word too, its confidence
            # stands (the capped search scores the same word a bit lower,
            # which only raised false weak-word warnings).
            conf = max(o["conf"], u["conf"]) if f0 <= u["f1"] and u["f0"] <= f1 else o["conf"]
            u.update(f0=f0, f1=f1, conf=conf, spans=[(r0 + a, r0 + b) for a, b in o["spans"]])

    # Target words only; a word at or before the one read just before it
    # starts a reading he went back for. A word's reading ends where the
    # voice stops (a madd tail), or where the next one starts.
    target_pos = {n: k for k, n in enumerate(n for n, u in enumerate(order) if u["target"])}
    readings, prev = [], None
    for n, o in enumerate(occ):
        u = order[o["w"]]
        if not u["target"]:
            continue
        k = target_pos[o["w"]]
        jump = prev is not None and k <= prev
        prev = k
        start = (r0 + o["f0"]) * FRAME_SEC
        tok_end = (r0 + o["f1"] + 1) * FRAME_SEC
        nxt = (r0 + (occ[n + 1]["f0"] if n + 1 < len(occ) else len(path))) * FRAME_SEC
        end, found = _snap_offset(env, tok_end, nxt, max_fwd=4.0, min_quiet=0.15)
        cur = readings[-1] if readings else None
        if cur is None or jump or cur["ayah"] != u["ayah"]:
            cur = {"ayah": u["ayah"], "from": u["index"], "to": u["index"], "jump": jump, "words": []}
            readings.append(cur)
        cur["to"] = u["index"]
        cur["words"].append((u["index"], start, max(end if found else nxt, tok_end)))
    if not any(r["jump"] for r in readings):
        return None, suspects
    logger.info("Reading path: " + ", ".join(
        f"{'↩' if r['jump'] else ''}{r['ayah']}:{r['from']}-{r['to']}@{r['words'][0][1]:.1f}s" for r in readings) + ".")
    return readings, suspects


# ========== STRETCHES THE ALIGNMENT MODEL CAN'T HEAR ==========

def _deaf_stretches(emission, env, lo_sec, hi_sec):
    """[(start, end)] seconds, inside [lo_sec, hi_sec], where the audio is
    as loud as the recitation around it but the alignment model hears almost
    no letter (see DEAF_*)."""
    mass = 1.0 - np.exp(emission[:, 0].numpy())
    w = int(0.5 / FRAME_SEC)
    evidence = np.convolve(mass, np.ones(w) / w, mode="same")
    level = env[np.minimum((np.arange(len(mass)) * FRAME_SEC / ENV_HOP_SEC).astype(int), len(env) - 1)]
    lo, hi = max(0, int(lo_sec / FRAME_SEC)), min(len(mass), int(hi_sec / FRAME_SEC))
    if hi - lo < w:
        return []
    deaf = (evidence < DEAF_MAX_EVIDENCE) & (level > np.percentile(level[lo:hi], 90) - DEAF_LOUD_DB)
    runs, i = [], lo
    while i < hi:
        if not deaf[i]:
            i += 1
            continue
        j = i
        while j < hi and deaf[j]:
            j += 1
        if runs and i - runs[-1][1] <= int(DEAF_BRIDGE_SEC / FRAME_SEC):
            runs[-1][1] = j
        else:
            runs.append([i, j])
        i = j
    return [(a * FRAME_SEC, b * FRAME_SEC) for a, b in runs if (b - a) * FRAME_SEC >= DEAF_MIN_SEC]


def _heard_by_whisper(wav, a, b, text):
    """[(text index, start, end)] of the words of `text` (plain spellings)
    Whisper hears in [a, b] seconds, in time order. Overlapping windows
    (DEAF_WINDOW_SEC every DEAF_HOP_SEC), each matched in order onto the
    text on its own, without the words near its edges; a text word counts
    as heard where DEAF_MIN_SUPPORT windows heard it at about the same time
    -- Whisper spells a word differently from window to window, and what
    it invents rarely recurs."""
    model = _get_verify_model()
    t0, t1 = max(0.0, a - 0.5), min(len(wav) / SAMPLE_RATE, b + 0.5)
    hits = []  # (text index, start, end, window)
    for n, ws in enumerate(np.arange(t0, max(t0, t1 - DEAF_WINDOW_SEC) + 1e-6, DEAF_HOP_SEC)):
        we = min(t1, ws + DEAF_WINDOW_SEC)
        job_control.check_cancelled()
        segments, _ = model.transcribe(
            wav[int(ws * SAMPLE_RATE):int(we * SAMPLE_RATE)], language="ar", beam_size=5,
            word_timestamps=True, condition_on_previous_text=False, vad_filter=False,
        )
        words = [(t, ws + w.start, ws + w.end) for seg in segments for w in seg.words or []
                 if DEAF_EDGE_SEC <= (w.start + w.end) / 2 <= we - ws - DEAF_EDGE_SEC for t in _norm_words(w.word)]
        hits += [(x, words[h][1], words[h][2], n) for h, x, sim in _match_in_order(words, text) if sim >= DEAF_MIN_SIM]
    heard = []
    for x, s, e, n in sorted(hits, key=lambda h: h[1]):
        same = next((g for g in heard if g["x"] == x and abs(np.median(g["s"]) - s) < 0.6), None)
        if same is None:
            heard.append({"x": x, "s": [s], "e": [e], "n": {n}})
        else:
            same["s"].append(s)
            same["e"].append(e)
            same["n"].add(n)
    kept = sorted(((g["x"], float(np.median(g["s"])), float(np.median(g["e"]))) for g in heard
                   if len(g["n"]) >= DEAF_MIN_SUPPORT and a - 0.3 <= np.median(g["s"]) <= b + 0.3), key=lambda h: h[1])
    # In text order along time: the longest such chain (a stray match drops).
    best = [[k] for k in range(len(kept))]
    for k in range(len(kept)):
        for j in range(k):
            if kept[j][0] < kept[k][0] and len(best[j]) + 1 > len(best[k]):
                best[k] = best[j] + [k]
    chain = max(best, key=len) if best else []
    return [kept[k] for k in chain]


def _match_in_order(heard, text):
    """Pairs (heard index, text index, similarity) of the best in-order
    matching of heard words onto text words (each pair similarity >= 0.6;
    either side may skip words)."""
    H, X = len(heard), len(text)
    score = np.zeros((H + 1, X + 1))
    move = np.zeros((H + 1, X + 1), dtype=np.int8)  # 0 skip heard, 1 skip text, 2 match
    for i in range(1, H + 1):
        for j in range(1, X + 1):
            score[i, j], move[i, j] = (score[i - 1, j], 0) if score[i - 1, j] >= score[i, j - 1] else (score[i, j - 1], 1)
            sim = _similar(heard[i - 1][0], text[j - 1])
            if sim >= 0.6 and score[i - 1, j - 1] + sim > score[i, j]:
                score[i, j], move[i, j] = score[i - 1, j - 1] + sim, 2
    pairs, i, j = [], H, X
    while i > 0 and j > 0:
        if move[i, j] == 2:
            pairs.append((i - 1, j - 1, _similar(heard[i - 1][0], text[j - 1])))
            i, j = i - 1, j - 1
        elif move[i, j] == 0:
            i -= 1
        else:
            j -= 1
    return pairs[::-1]


def _hear_deaf_stretches(wav, emission, env, units, readings, words_by_ayah):
    """Where the alignment model can't hear the recitation (see DEAF_*),
    lets Whisper listen: words it hears there that the reading path times
    elsewhere or not at all are retimed, and a run of RETURN_MIN_WORDS+
    consecutive words the path reads again outside the stretch is another
    reading of them (79:32 read twice in the user's fajr upload; the first
    time inside such a stretch). Returns (readings, unheard, changed): the
    reading path in _reading_path's shape, [(start, end)] stretches where
    Whisper heard words of the text that fit nowhere, and whether units moved (their times need
    resolving again). Moves units onto their first reading as _reading_path
    does; marks the words Whisper timed "deaf_checked"."""
    targets = [u for u in units if u["target"] and "f0" in u]
    if not targets:
        return readings, [], False
    pos_of = {(u["ayah"], u["index"]): n for n, u in enumerate(targets)}
    if readings:
        occ = [[pos_of[(r["ayah"], idx)], s, e] for r in readings for idx, s, e in r["words"] if (r["ayah"], idx) in pos_of]
    else:
        occ = [[n, u["start"], u["end"]] for n, u in enumerate(targets)]
    occ.sort(key=lambda o: o[1])
    stretches = _deaf_stretches(emission, env, occ[0][1], occ[-1][2])
    if not stretches:
        return readings, [], False

    # The plain spelling of every target word, to compare with Whisper's.
    plain = []
    for u in targets:
        tokens = words_by_ayah[u["ayah"]]["tokens"]
        real = [i for i, t in enumerate(tokens) if not _is_mark_token(t)]
        clean = _norm_words(" ".join(words_by_ayah[u["ayah"]]["clean"]))
        own = _norm_words(u["w"])
        plain.append(clean[real.index(u["index"])] if len(clean) == len(real) else (own[0] if own else ""))

    changed, unheard, timed = False, [], set()
    for a, b in stretches:
        before = [o for o in occ if o[2] <= a + 0.2]
        after = [o for o in occ if o[1] >= b - 0.2]
        k0 = before[-1][0] if before else -1
        k1 = after[0][0] if after else len(targets)
        lo, hi = max(0, k0 - DEAF_TEXT_BACK), min(len(targets), k1 + DEAF_TEXT_AHEAD + 1)
        pairs = [((None, s0, e0), lo + x) for x, s0, e0 in _heard_by_whisper(wav, a, b, plain[lo:hi])]
        matched = ", ".join("%d:%d@%.1fs" % (targets[p]["ayah"], targets[p]["index"], h[1]) for h, p in pairs)
        logger.info(f"Unheard stretch {a:.1f}-{b:.1f}s: Whisper heard {matched or 'nothing of the text'}.")
        # Words the path reads once, across the stretch: their times.
        inside = [(h, p) for h, p in pairs if k0 < p < k1]
        # Runs of consecutive words the path reads elsewhere: another reading.
        runs = []
        for h, p in pairs:
            if (p <= k0 or p >= k1) and runs and runs[-1][-1][1] == p - 1:
                runs[-1].append((h, p))
            elif p <= k0 or p >= k1:
                runs.append([(h, p)])
        extra = [run for run in runs if len(run) >= RETURN_MIN_WORDS and (
            (run[0][1] >= k1 and after and run[-1][0][2] <= after[0][1] - DEAF_GAP_SEC)
            or (run[-1][1] <= k0 and before and run[0][0][1] >= before[-1][2] + DEAF_GAP_SEC))]
        if not inside and not extra:
            # Words of the text heard there that fit nowhere: worth a look.
            # (Nothing of the text heard at all is a long madd, as in every
            # clean recording.)
            if pairs:
                unheard.append((a, b))
            continue
        for h, p in inside:
            here = [o for o in occ if o[0] == p and o[2] > a and o[1] < b]
            if here:
                here[0][1], here[0][2] = h[1], max(h[2], h[1] + FRAME_SEC)
                timed.add(p)
        for run in extra:
            for h, p in run:
                occ.append([p, h[1], max(h[2], h[1] + FRAME_SEC)])
                timed.add(p)
        changed = True
    if not changed:
        return readings, unheard, False

    occ.sort(key=lambda o: o[1])
    for o, nxt in zip(occ, occ[1:]):
        o[2] = max(o[1] + FRAME_SEC, min(o[2], nxt[1]))
    new_readings, prev, seen = [], None, set()
    for p, s, e in occ:
        u = targets[p]
        jump = prev is not None and p <= prev
        prev = p
        cur = new_readings[-1] if new_readings else None
        if cur is None or jump or cur["ayah"] != u["ayah"]:
            cur = {"ayah": u["ayah"], "from": u["index"], "to": u["index"], "jump": jump, "words": []}
            new_readings.append(cur)
        cur["to"] = u["index"]
        cur["words"].append((u["index"], s, e))
        if p not in seen:
            seen.add(p)
            if p in timed:
                f0 = int(s / FRAME_SEC)
                u.update(f0=f0, f1=max(f0, int(e / FRAME_SEC) - 1), spans=[(f0, max(f0, int(e / FRAME_SEC) - 1))])
    for p in timed:
        targets[p]["deaf_checked"] = True
    logger.info("Reading path after the unheard stretches: " + ", ".join(
        f"{'↩' if r['jump'] else ''}{r['ayah']}:{r['from']}-{r['to']}@{r['words'][0][1]:.1f}s" for r in new_readings) + ".")
    return (new_readings if any(r["jump"] for r in new_readings) else None), unheard, True


def _weak_word_reason(units):
    """A review reason for the target word aligned with the least confidence,
    when that is almost none (WORD_MISMATCH_CONF), or None. Words Whisper
    timed inside a stretch the model can't hear (_hear_deaf_stretches) are
    left out -- they were checked another way."""
    weak = [u for u in _aligned(units, target_only=True) if u["conf"] < WORD_MISMATCH_CONF and not u.get("deaf_checked")]
    if not weak:
        return None
    u = min(weak, key=lambda u: u["conf"])
    return _review(
        "word_mismatch",
        "كلمة لم يُتعرَّف عليها بوضوح في الصوت. ربما كرر القارئ شيئاً أو قرأ ما ليس في الآيات المختارة، يرجى التحقق من التوقيت هنا.",
        "Seste net tanınamayan bir kelime var. Kâri bir şeyi tekrarlamış veya seçilen ayetlerde olmayan bir şey okumuş olabilir, lütfen buradaki zamanlamayı kontrol edin.",
        "A word couldn't be clearly recognized in the audio. The reciter may have repeated something or read something outside the selected ayahs; please check the timing here.",
        u.get("start", u["f0"] * FRAME_SEC),
    )


def _find_repeated_ayahs(emission, units, surah_id, words_by_ayah, start_ayah, end_ayah, target_conf):
    """Selected ayahs the region holds a second good recitation of, besides
    the timed one (see REPEAT_MIN_REL_CONF). Returns [(ayah, onset_sec)] on
    the region's timeline."""
    _, _, star = _get_mms()
    masked = emission.clone()
    for u in _aligned(units, target_only=True):
        masked[u["f0"]:u["f1"] + 1, :] = -1e4
        masked[u["f0"]:u["f1"] + 1, 0] = 0.0
        masked[u["f0"]:u["f1"] + 1, star] = 0.0
    found = []
    timed = _aligned(units, target_only=True)
    for ayah in range(start_ayah, end_ayah + 1):
        if len(words_by_ayah[ayah]["clean"]) < REPEAT_MIN_WORDS or _ayah_text_occurs_elsewhere(words_by_ayah, ayah):
            continue
        own_conf = _mean_conf([u for u in timed if u["ayah"] == ayah])
        # Aligned alone, padded by the star token (_ctc_align), so it lands
        # on its best match anywhere outside the masked recitation.
        again = _build_units(surah_id, words_by_ayah, [ayah], {ayah})
        try:
            _ctc_align(masked, again)
        except ExtractionError:
            continue
        hit = _aligned(again)
        conf = _mean_conf(hit)
        logger.info(f"Second-recitation check: ayah {ayah} best other match {conf:.3f} at "
                    f"{hit[0]['f0'] * FRAME_SEC:.1f}s (timed recitation: this ayah {own_conf:.3f}, all {target_conf:.3f}).")
        if conf >= max(REPEAT_MIN_REL_CONF * own_conf, REPEAT_MIN_CONF):
            found.append((ayah, hit[0]["f0"] * FRAME_SEC))
    return found


def _has_second_occurrence(emission, units, surah_id, words_by_ayah, start_ayah, end_ayah, first_conf):
    target = _aligned(units, target_only=True)
    f0, f1 = target[0]["f0"], target[-1]["f1"] + 1
    _, _, star = _get_mms()
    masked = emission.clone()
    masked[f0:f1, :] = -1e4
    masked[f0:f1, 0] = 0.0
    masked[f0:f1, star] = 0.0
    again = _build_units(surah_id, words_by_ayah, range(start_ayah, end_ayah + 1), set(range(start_ayah, end_ayah + 1)))
    try:
        _ctc_align(masked, again)
    except ExtractionError:
        return False
    second = _mean_conf(_aligned(again))
    return second >= max(0.75 * first_conf, MEAN_MIN_CONF)


# ========== PUBLIC API (same signatures as extract_precise_clip) ==========

def _validate_range(words_by_ayah, surah_id, start_ayah, end_ayah):
    if start_ayah not in words_by_ayah or end_ayah not in words_by_ayah or start_ayah > end_ayah:
        _fail(f"Ayah bounds error: surah {surah_id} has no ayah range {start_ayah}-{end_ayah}.")


def extract_clip(reciter_id, surah_id, start_ayah, end_ayah, pad_seconds=0.0):
    if reciter_id not in RECITERS_MP3QURAN:
        _fail(f"Reciter '{reciter_id}' not found.")

    clip_name = f"{reciter_id}_{surah_id:03d}_{start_ayah}-{end_ayah}"
    final_clip_path = OUTPUT_DIR / f"{clip_name}.mp3"
    final_json_path = OUTPUT_DIR / f"{clip_name}.json"
    if final_json_path.exists() and final_clip_path.exists():
        try:
            with open(final_json_path, "r", encoding="utf-8") as f:
                cached = json.load(f)
            if (cached.get("engine") == ENGINE_VERSION and cached.get("pad_seconds") == pad_seconds
                    and final_clip_path.stat().st_size > 1024):
                logger.info(f"Cache hit for {clip_name} ({ENGINE_VERSION}).")
                return str(final_clip_path), str(final_json_path)
        except Exception as e:
            logger.warning(f"Cached extraction for {clip_name} unreadable ({e}) -- re-extracting.")

    words_by_ayah = fetch_surah_words(surah_id)
    _validate_range(words_by_ayah, surah_id, start_ayah, end_ayah)

    full_audio = download_full_surah(reciter_id, surah_id, allow_backup=True)
    backup = is_backup_recording(full_audio)
    approx = None
    if backup:
        # mp3quran's timing describes mp3quran's own recording, not this one.
        logger.info("Using the backup recording; locating ayahs from the audio itself.")
    else:
        try:
            times = _mp3quran_ayah_times(reciter_id, surah_id, _probe_duration(full_audio))
            if times and start_ayah in times and end_ayah in times:
                approx = (times[start_ayah][0], times[end_ayah][1])
        except Exception as e:
            logger.warning(f"mp3quran timing unavailable ({e}); locating ayahs from the audio itself.")

    return _extract_from_long_audio(
        full_audio, surah_id, start_ayah, end_ayah, pad_seconds, words_by_ayah, clip_name,
        {"surah": surah_id, "reciter": reciter_id, "source": "backup" if backup else "mp3quran"},
        approx=approx, use_context=True,
    )


def extract_custom_clip(audio_path_str, surah_id, start_ayah, end_ayah, pad_seconds=0.0, **_ignored):
    audio_path = Path(audio_path_str)
    if not audio_path.exists():
        _fail(f"Custom audio file not found: {audio_path}")
    words_by_ayah = fetch_surah_words(surah_id)
    _validate_range(words_by_ayah, surah_id, start_ayah, end_ayah)

    # Unique per call: two uploads for the same range must never overwrite
    # each other's output before the frontend has downloaded it.
    clip_name = f"custom_{surah_id:03d}_{start_ayah}-{end_ayah}_{uuid.uuid4().hex[:8]}"
    return _extract_from_long_audio(
        audio_path, surah_id, start_ayah, end_ayah, pad_seconds, words_by_ayah, clip_name,
        {"surah": surah_id, "reciter": "custom", "source": "custom"},
        approx=None, use_context=False,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--reciter")
    parser.add_argument("--audio")
    parser.add_argument("--surah", required=True, type=int)
    parser.add_argument("--start", required=True, type=int)
    parser.add_argument("--end", required=True, type=int)
    parser.add_argument("--pad", type=float, default=0.0)
    args = parser.parse_args()
    if args.audio:
        print(extract_custom_clip(args.audio, args.surah, args.start, args.end, pad_seconds=args.pad))
    else:
        print(extract_clip(args.reciter, args.surah, args.start, args.end, pad_seconds=args.pad))
