"""Word-by-word judgment of a recitation heard by the Quran ear
(scripts/quran_ear.py): the ear writes down what was said sound by sound in
the Quran phonetic script, without looking at the expected text; this
compares it with the expected ayahs' phonetic script (quran-transcript's
phonetizer) and says, per word of the mushaf: ok, wrong (another letter or
word), tashkeel (a vowel differs, the letters are right), missing, or
unread -- and what was said between words that isn't there (an added word,
or a restart, which isn't a mistake).

What isn't a memorization mistake is ignored:
- madd and ghunna length (each reader has his own);
- qalqala and sakt marks.

A word's ending depends on whether the reader stopped after it (2026-11-24,
the user: every letter and haraka must count). Where the reader stopped --
a real pause in the audio (PAUSE_SEC of the ear hearing nothing), or the
ayah's end -- the ending may be read as at a stop (حَدْ for حَدُنْ, a taa
marbuta as haa, fath tanween as alif). Where they ran on, the ending's
haraka and tanween must be said as written, and a hamzat al-wasl must not
be said. A wrong vowel said aloud at a word's end is wrong either way.

Before comparing, restarts are taken out of what was heard (a stretch said
again right after, maybe with a slip between), unless the range itself has
that text twice; the reading's end is found (the rest wasn't reached, not
forgotten). Each flagged word is then put to the ear's own frame
probabilities (verify): does the text as written explain that stretch as
well as what the greedy decoding wrote? Only a clear no keeps the flag.

On real learners -- Iqra'Eval QuranMB.v2 (2025 shared task: 1642 readings
by 18 speakers, every sound checked by linguists; scorer and data in
~/.cache/qvc-iqraeval, outside the repo), 8007 words, 2026-11-25:
correct words flagged 24.2% -> 11.8%, words with a real letter / haraka /
shadda / added or dropped sound flagged 59.3% -> 54.4%, after making soft:
a noon's nasal said plainly (ikhfa, idgham, iqlab: tajweed, not memory), a
madd said short or a shadda light, and a short haraka the ear missed
mid-word (all three the ear can't time in a quick reading). The pro set
below didn't move (false flags 110 -> 104, slips found the same).

Measured 2026-11-24 on 97 recitations (backend/data/extracted_clips, 3555
words) with one mistake planted at a time in the expected text: a vowel
inside a word found 373/377 (before the stop rule 301), a word-end vowel
where the reader ran on 354/375 (4), a letter for a close one (س/ص, ذ/ز,
ح/ه, ت/ط, ك/ق ...) 373/377; vowel flags on the clean readings 15 (12),
wrong-word flags unchanged.

Measured 2026-11-21 on 17 reciters' recitations with planted mistakes
(backend/data/hifz_eval, scratchpad eval_muaalem.py): left-out words found
15/17, swapped 16/17, added 15/17 (Whisper + MMS: 13, 12, 13); false alarms
on clean readings 7 in 700 words (5), phone-like audio 8 (14).
"""
import functools
import re
from dataclasses import dataclass, field

import numpy as np

HARAKAT = set("َُِ")
# A letter of the written text (the rest are its marks); not the tatweel,
# which one spelling has and another hasn't.
LETTER = re.compile(r"[ء-غف-يٱ]")


def default_moshaf():
    from quran_transcript import MoshafAttributes

    # Madd lengths don't matter here (normalize collapses them).
    return MoshafAttributes(rewaya="hafs", madd_monfasel_len=4, madd_mottasel_len=4,
                            madd_mottasel_waqf=4, madd_aared_len=4)

MADD = set("اۥۦ")
DROP = set("ڇۜ")
MAP = {"ؙ": "ُ", "۪": "َ", "ـ": "ا"}
# A word's ending that differs between a stop and running on.
END_SOFT = HARAKAT | {"ن", "ا", "ں", "۾", "ۥ", "ۦ"}
END_ZONE = 3
# A stop: this long with the ear hearing nothing (blank above PAUSE_BLANK).
# Measured on 97 recitations (3285 word joins): 84% of ayah ends have one,
# 12% of joins inside an ayah (mostly the waqf marks).
PAUSE_SEC = 0.3
PAUSE_BLANK = 0.95
# Extra speech between words: a restart when it says again a stretch of the
# text near where it was said (this share of its letters may differ).
RESTART_DIST = 0.35
# A restart taken out before comparing: at least REPEAT_MIN sounds (about
# two words) said again within REPEAT_GAP sounds (a slip between), nearly
# the same.
REPEAT_MIN = 10
REPEAT_GAP = 6
REPEAT_DIST = 0.15
# A word counts as left out when this share of its sounds is missing.
MISSING_SHARE = 0.6


def normalize(ph, owners=None, kept=None):
    """(text, owners): the phonetic script without what doesn't matter for
    memorizing, and each kept char's owner (word index) when given. `kept`
    (a list) gets each kept char's index in `ph`."""
    out, own = [], []
    for k, c in enumerate(ph):
        if c in DROP:
            continue
        c = MAP.get(c, c)
        if c in MADD and out and out[-1] == c and (owners is None or own[-1] == owners[k]):
            continue
        # A ghunna or merged letters held long (نننن, مممم) is two, like a shadda.
        if c not in MADD and c not in HARAKAT and len(out) >= 2 and out[-1] == c and out[-2] == c:
            continue
        out.append(c)
        own.append(owners[k] if owners is not None else -1)
        if kept is not None:
            kept.append(k)
    return "".join(out), own


@dataclass
class Reference:
    chars: str
    owner: list            # word index (over the range) per char
    words: int
    wasl_start: set = field(default_factory=set)   # words starting with hamzat al-wasl
    starts: dict = field(default_factory=dict)     # word -> first char index
    ends: dict = field(default_factory=dict)       # word -> last char index + 1
    ayah_last: set = field(default_factory=set)    # each ayah's last word
    ayah_first: set = field(default_factory=set)   # each ayah's first word
    taa_end: set = field(default_factory=set)      # words ending in taa marbuta
    tail: dict = field(default_factory=dict)       # word -> first char of its ending
    letter: list = field(default_factory=list)     # per char: its letter's index in its word (as shown)

    def finish(self):
        """Word starts and ends, and where each word's ending begins: the
        last sounds a stop changes (a final haraka, tanween, a madd), and a
        taa marbuta before them."""
        self.starts, self.ends = {}, {}
        for i, w in enumerate(self.owner):
            self.starts.setdefault(w, i)
            self.ends[w] = i + 1
        for w, e in self.ends.items():
            i = e
            while i > self.starts[w] and e - i < END_ZONE and self.chars[i - 1] in END_SOFT:
                i -= 1
            # (as written for running on, or «ه» as the ayah's end is written: at a stop)
            if w in self.taa_end and i > self.starts[w] and self.chars[i - 1] in "تةه":
                i -= 1
            self.tail[w] = i
        return self


def _bare(text):
    return re.sub(r"[^ء-يٱ]", "", text).replace("ٱ", "ا")


@functools.lru_cache(maxsize=800)
def _phonetized(surah, n):
    """An ayah in the phonetic script, with its words' bounds (default moshaf).
    Kept: phonetizing a whole surah took 2.2 s at the start of each
    recitation (1050 words of Al-Mu'minun), the first words waiting on it."""
    from quran_transcript import Aya, quran_phonetizer
    from quran_transcript.phonetics.search import clean_uthmani_spaces, get_uth_word_boundaries_in_ph

    f = Aya(surah, n).get()
    out = quran_phonetizer(f.uthmani, default_moshaf(), remove_spaces=True, sura_idx=surah)
    bounds = get_uth_word_boundaries_in_ph(clean_uthmani_spaces(f.uthmani), out.mappings) + [len(out.phonemes)]
    return f, out, bounds


def build_reference(surah, ayahs, our_words, moshaf=None):
    """ayahs: [ayah numbers]; our_words: {ayah: [uthmani words as shown]}.
    The reference is phonetized ayah by ayah (each read as from a stop to
    a stop), and every phonetic char is owned by one shown word."""
    from quran_transcript import Aya, quran_phonetizer
    from quran_transcript.phonetics.search import clean_uthmani_spaces, get_uth_word_boundaries_in_ph

    default = moshaf is None  # (before it is filled in: the kept ayahs are the default moshaf's)
    moshaf = moshaf or default_moshaf()
    chars, owner = [], []
    wasl_start, taa_end, ayah_first, ayah_last = set(), set(), set(), set()
    letters = []
    base = 0
    for n in ayahs:
        if default:
            f, out, bounds = _phonetized(surah, n)
        else:
            f = Aya(surah, n).get()
            uth = clean_uthmani_spaces(f.uthmani)
            out = quran_phonetizer(f.uthmani, moshaf, remove_spaces=True, sura_idx=surah)
            bounds = get_uth_word_boundaries_in_ph(uth, out.mappings) + [len(out.phonemes)]
        their = f.uthmani_words
        # their word k -> our word index (by letters; 4 ayahs split words differently)
        ours = our_words[n]
        our_starts, pos = [], 0
        for w in ours:
            our_starts.append(pos)
            pos += len(_bare(w))
        to_ours, pos = [], 0
        for w in their:
            b = len(_bare(w))
            k = max(i for i, s in enumerate(our_starts) if s <= pos) if b else (to_ours[-1] if to_ours else 0)
            to_ours.append(k)
            pos += b
        word_of_ph, start = [], 0
        for k, end in enumerate(bounds[: len(their)]):
            word_of_ph.extend([base + to_ours[k]] * (end - start))
            start = end
        word_of_ph.extend([base + to_ours[-1]] * (len(out.phonemes) - len(word_of_ph)))
        # Each sound's letter in the shown word (a haraka belongs to the
        # letter it is on), so a slip can be shown on the very letter: the
        # phonetizer maps each char of the Uthmani text to its sounds.
        their_word, their_letter, w_i, n_l = [], [], 0, -1
        for c in f.uthmani:
            if c == " ":
                w_i, n_l = w_i + 1, -1
            elif LETTER.match(c):
                n_l += 1
            their_word.append(w_i)
            their_letter.append(max(0, n_l))
        # A shown word made of two of theirs: the second's letters follow on.
        before = [0] * len(their)
        for k in range(1, len(their)):
            if to_ours[k] == to_ours[k - 1]:
                before[k] = before[k - 1] + len(LETTER.findall(their[k - 1]))
        sizes = [max(1, len(LETTER.findall(w))) for w in ours]
        letter_of_ph = [0] * len(out.phonemes)
        for i, m in enumerate(out.mappings):
            a, b = m.pos
            tw = min(their_word[i], len(their) - 1)
            for q in range(a, min(b, len(letter_of_ph))):
                letter_of_ph[q] = min(before[tw] + their_letter[i], sizes[to_ours[tw]] - 1)
        for k, w in enumerate(ours):
            if w.startswith("ٱ"):
                wasl_start.add(base + k)
            if _bare(w).endswith("ة"):
                taa_end.add(base + k)
        ayah_first.add(base)
        ayah_last.add(base + len(ours) - 1)
        kept = []
        text, own = normalize(out.phonemes, word_of_ph, kept=kept)
        chars.append(text)
        owner.extend(own)
        letters.extend(letter_of_ph[k] for k in kept)
        base += len(ours)
    ref = Reference("".join(chars), owner, base, wasl_start, ayah_last=ayah_last, ayah_first=ayah_first, taa_end=taa_end,
                    letter=letters)
    return ref.finish()


def _semi_global(query, text):
    """Fewest edits turning all of `query` into some stretch of `text`."""
    if not query:
        return 0
    if not text:
        return len(query)
    q = np.frombuffer(query.encode("utf-32-le"), dtype=np.uint32)
    t = np.frombuffer(text.encode("utf-32-le"), dtype=np.uint32)
    steps = np.arange(len(t) + 1, dtype=np.int32)
    row = np.zeros(len(t) + 1, dtype=np.int32)
    best = np.empty(len(t) + 1, dtype=np.int32)
    for i, c in enumerate(q):
        best[0] = i + 1
        np.minimum(row[:-1] + (t != c), row[1:] + 1, out=best[1:])
        row = np.minimum.accumulate(best - steps) + steps
    return int(row.min())


def _says_again(ref, t, before, after):
    """Does t say again the words just before it (a restart), or the next
    words early (then said again in their place)?"""
    import Levenshtein as lv

    n = ref.words
    R = ref.chars
    stretches = []
    if before is not None and before >= 0:
        for last in (before, before - 1):
            if last < 0:
                continue
            for k in range(0, 26):
                first = last - k
                if first < 0:
                    break
                stretches.append(R[ref.starts[first]: ref.ends[last]])
    if after is not None:
        for first in (after, after + 1):
            if first >= n:
                continue
            for k in range(0, 8):
                last = first + k
                if last >= n:
                    break
                stretches.append(R[ref.starts[first]: ref.ends[last]])
    for st in stretches:
        if abs(len(st) - len(t)) <= RESTART_DIST * len(t) + 2 and lv.distance(t, st) <= RESTART_DIST * max(len(t), len(st)):
            return True
    return False


def collapse_repeats(h, ref_chars):
    """The heard text with restarts taken out: a stretch said and then said
    again right after (X X), or with a slip between (X slip X). The later
    reading stays; the earlier one is returned as (position in the result,
    text). A doubling the text itself has (إن مع العسر يسرا twice) stays.
    Also returns each kept char's index in h."""
    import Levenshtein as lv

    out, kept, removed = [], [], []
    p, n = 0, len(h)
    while p < n:
        found = None
        for L in range(min(90, (n - p) // 2), REPEAT_MIN - 1, -1):
            x = h[p:p + L]
            for gap in range(0, REPEAT_GAP + 1):
                y = h[p + L + gap: p + 2 * L + gap]
                if len(y) < L:
                    break
                if lv.distance(x, y) > REPEAT_DIST * L:
                    continue
                doubled = x + h[p + L: p + L + gap] + y
                # Text the range itself has twice (الله أحد الله) is no restart;
                # a restart says text of the range, once.
                if _semi_global(doubled, ref_chars) <= 0.2 * len(doubled):
                    continue
                if _semi_global(y, ref_chars) > 0.2 * L:
                    continue
                found = (L, gap)
                break
            if found:
                break
        if found:
            # Scanning from the left finds a restart a few sounds early
            # («ـمَد لم يلد…» for «لم يلد…»): slide it to where the two
            # readings match best.
            L0, gap = found
            options = []
            for k in range(0, 7):
                for L in range(L0, max(REPEAT_MIN, L0 - 4) - 1, -1):
                    if p + k + 2 * L + gap > n:
                        continue
                    d = lv.distance(h[p + k: p + k + L], h[p + k + L + gap: p + k + 2 * L + gap])
                    options.append((d, -L, -k, k, L))
            _, _, _, shift, L = min(options) if options else (0, 0, 0, 0, L0)
            for i in range(p, p + shift):
                out.append(h[i])
                kept.append(i)
            p += shift
            removed.append((len(out), h[p: p + L + gap]))
            p += L + gap
        else:
            out.append(h[p])
            kept.append(p)
            p += 1
    return "".join(out), kept, removed


def read_prefix(ref_chars, hyp):
    """How much of the expected text the reading covers: the end k of the
    prefix ref_chars[:k] that hyp matches best (the rest wasn't read)."""
    if not hyp:
        return 0
    r = np.frombuffer(ref_chars.encode("utf-32-le"), dtype=np.uint32)
    q = np.frombuffer(hyp.encode("utf-32-le"), dtype=np.uint32)
    steps = np.arange(len(r) + 1, dtype=np.int32)
    row = steps.copy()
    best = np.empty(len(r) + 1, dtype=np.int32)
    for i, c in enumerate(q):
        best[0] = i + 1
        np.minimum(row[:-1] + (r != c), row[1:] + 1, out=best[1:])
        row = np.minimum.accumulate(best - steps) + steps
    return int(np.argmin(row))


# A repeat still being said (live): the end of what was heard says again
# text already read, and the text that comes next not as well. Found at
# once -- an ayah read again was only seen as a restart once the second
# reading covered the first (3-4 s in).
TAIL_MIN = 8
TAIL_MAX = 80


def prefix_ends(ref_chars, hyp):
    """read_prefix for every prefix of hyp at once: ends[i] for hyp[:i]."""
    r = np.frombuffer(ref_chars.encode("utf-32-le"), dtype=np.uint32)
    steps = np.arange(len(r) + 1, dtype=np.int32)
    row = steps.copy()
    best = np.empty(len(r) + 1, dtype=np.int32)
    ends = [0]
    for i, c in enumerate(hyp):
        best[0] = i + 1
        np.minimum(row[:-1] + (r != ord(c)), row[1:] + 1, out=best[1:])
        row = np.minimum.accumulate(best - steps) + steps
        ends.append(int(np.argmin(row)))
    return ends


def tail_restart(ref_chars, hyp):
    """Where a repeat being said at the end of hyp starts, or None."""
    n = len(hyp)
    if n < 2 * TAIL_MIN:
        return None
    ends = prefix_ends(ref_chars, hyp)
    for j in range(max(TAIL_MIN, n - TAIL_MAX), n - TAIL_MIN + 1):
        tail = hyp[j:]
        k = ends[j]
        if k < len(tail):
            continue
        earlier = _semi_global(tail, ref_chars[max(0, k - 400):k])
        if earlier > 0.15 * len(tail):
            continue
        onward = _semi_global(tail, ref_chars[k:k + len(tail) + 8])
        if onward >= earlier + max(2, 0.2 * len(tail)):
            return j
    return None


# ---------- The reading's path through the text ----------
# 2026-11-25: restarts were found by text rules with length limits
# (collapse_repeats: a stretch said twice, up to 90 sounds; tail_restart: a
# repeat in progress, up to 80). Two ayahs read again (about 150 sounds) fit
# neither: for 15 s the page kept the old slip red and the reading place
# jumping, the repeated words were laid over the next ones as false slips,
# and those became false «corrected» notes. Instead, one search finds the
# reading's path through the text: an edit-distance alignment that may also
# go back to any word's start (a restart, PATH_BACK) or jump ahead
# (skipped words, PATH_SKIP). Each word is then judged on its latest
# saying; an earlier saying of words said again is a restart. The same
# path serves live (rows cached: each pass only adds the new sounds) and
# the final check.
READING_PATH = True
PATH_BACK = 4          # going back to a word's start: about a short word's sounds
PATH_SKIP = 15         # jumping ahead, beyond leaving the words out one by one
PATH_BACK_WIN = 1200   # sounds back a restart may reach (about 10 ayahs)
PATH_FWD_WIN = 600     # sounds ahead a jump may reach
PATH_KEEP_VALS = 400   # rows whose costs are kept (to take up again live)
PATH_GOOD = 0.6        # a saying said again counts when this share of it matches the text
PATH_TAIL_MIN = 8      # the saying being said now counts once this many sounds match
PATH_FIRST_MIN = 40    # a first saying this long stands even if it hardly matches
_INF = 1 << 28


class _PathRow:
    __slots__ = ("lo", "vals", "ops", "src", "hi")

    def __init__(self, lo, vals, ops, src):
        self.lo, self.vals, self.ops, self.src = lo, vals, ops, src
        self.hi = lo + len(vals) - 1


def _path_starts(ref):
    s = getattr(ref, "_path_starts", None)
    if s is None:
        s = np.array(sorted(set(ref.starts.values())), dtype=np.int64)
        ref._path_starts = s
        ref._path_R = np.frombuffer(ref.chars.encode("utf-32-le"), dtype=np.uint32)
    return s


def _path_jumps(lo, new, ops, starts):
    """Jumps from the row's best place to word starts in the window."""
    k = int(np.argmin(new))
    best, b = int(new[k]), lo + k
    a0, a1 = np.searchsorted(starts, lo), np.searchsorted(starts, lo + len(new))
    qs = starts[a0:a1]
    if len(qs):
        cost = best + np.where(qs <= b, PATH_BACK, PATH_SKIP)
        at = qs - lo
        better = cost < new[at]
        new[at[better]] = cost[better]
        ops[at[better]] = 4
    return b


def _path_row0(ref):
    starts = _path_starts(ref)
    L = len(ref.chars)
    hi = min(L, PATH_FWD_WIN)
    new = np.arange(hi + 1, dtype=np.int32)
    ops = np.full(hi + 1, 3, dtype=np.int8)
    ops[0] = 0
    b = _path_jumps(0, new, ops, starts)
    return _PathRow(0, new, ops, b)


def _path_step(ref, prev, c):
    starts = _path_starts(ref)
    R = ref._path_R
    L = len(R)
    plo, pv = prev.lo, prev.vals
    phi = plo + len(pv) - 1
    b = plo + int(np.argmin(pv))
    # The far end never moves back: the best place wandering back over
    # unclear speech mustn't lose the place the reading had reached.
    lo, hi = max(0, b - PATH_BACK_WIN), min(L, max(prev.hi, b + PATH_FWD_WIN))
    ext = np.full(hi - lo + 2, _INF, dtype=np.int32)  # prev at lo-1 .. hi
    a0, a1 = max(plo, lo - 1), min(phi, hi)
    if a0 <= a1:
        ext[a0 - (lo - 1): a1 - (lo - 1) + 1] = pv[a0 - plo: a1 - plo + 1]
    idx = np.arange(lo, hi + 1)
    differ = (R[np.maximum(idx - 1, 0)] != ord(c)).astype(np.int32)
    sub = ext[:-1] + differ
    ins = ext[1:] + 1
    new = np.minimum(sub, ins)
    ops = np.where(sub <= ins, 1, 2).astype(np.int8)
    if lo == 0:
        new[0], ops[0] = ins[0], 2
    steps = np.arange(len(new), dtype=np.int32)
    acc = np.minimum.accumulate(new - steps) + steps
    ops[acc < new] = 3
    new = acc
    src = _path_jumps(lo, new, ops, starts)
    return _PathRow(lo, new, ops, src)


def _path_rows(ref, hyp):
    """The path's rows for hyp, taking up the rows of the last call where
    hyp begins the same (live: only the re-heard tail is new)."""
    import os

    cache = getattr(ref, "_path_cache", None)
    if cache:
        m = len(os.path.commonprefix([cache[0], hyp]))
        rows = cache[1][: m + 1]
        if rows[-1].vals is None:
            rows = None
    else:
        rows = None
    if not rows:
        rows = [_path_row0(ref)]
    for i in range(len(rows) - 1, len(hyp)):
        rows.append(_path_step(ref, rows[-1], hyp[i]))
        old = len(rows) - 1 - PATH_KEEP_VALS
        if old > 0:
            rows[old].vals = None
    ref._path_cache = (hyp, rows)
    return rows


def reading_path(hyp0, ref, live=False):
    """The heard text with earlier sayings of words said again taken out,
    like collapse_repeats: (text, kept, removed). kept: each kept char's
    index in hyp0. removed: (position in the text, the earlier saying,
    its first word, its last word)."""
    n = len(hyp0)
    reading_path.repeating = False
    if n == 0:
        return "", [], []
    rows = _path_rows(ref, hyp0)
    last = rows[n]
    i, j = n, last.lo + int(np.argmin(last.vals))
    pos = [0.0] * n        # where in the text each heard char sits
    matched = [False] * n
    same = [False] * n     # matched to the very sound
    R = ref.chars
    jumps = []             # heard index where a new saying begins
    while i > 0 or j > 0:
        row = rows[i]
        op = int(row.ops[j - row.lo])
        if op == 1:
            pos[i - 1], matched[i - 1] = j - 1, True
            same[i - 1] = hyp0[i - 1] == R[j - 1]
            i, j = i - 1, j - 1
        elif op == 2:
            pos[i - 1] = j - 0.5
            i -= 1
        elif op == 3:
            j -= 1
        elif op == 4:
            jumps.append(i)
            j = row.src
        else:
            break
    jumps.sort()
    saying = [0] * n
    s, q = 0, 0
    for k in range(n):
        while q < len(jumps) and jumps[q] <= k:
            s, q = s + 1, q + 1
        saying[k] = s
    owner = ref.owner
    L = len(owner)

    def word_of(k):
        p = pos[k]
        return owner[min(L - 1, max(0, int(p) if matched[k] else int(p - 0.5)))] if L else 0

    # A later saying that hardly matches the text isn't the text said
    # again (unclear speech, words from elsewhere): its sounds stay where
    # they were said, after the sound before them, as speech added there.
    size, good = {}, {}
    for k in range(n):
        size[saying[k]] = size.get(saying[k], 0) + 1
        good[saying[k]] = good.get(saying[k], 0) + same[k]
    ok_saying = {t: good[t] >= PATH_GOOD * size[t] for t in size}
    # The first saying stands -- unless it is a few seconds that hardly match
    # (the ayah before the range read first, as a run-up): then nothing is
    # judged until the range's own words are heard.
    # Stopped with only that said: it is judged (a short passage read wrong).
    if 0 in size and (size[0] >= PATH_FIRST_MIN or not (live or any(ok_saying[t] for t in size if t > 0))):
        ok_saying[0] = True
    # The saying being said now: a few sounds at the edge (a word only
    # begun, heard loosely) may look like an earlier word's start; it
    # counts as said again once it has matched enough.
    last_s = saying[n - 1]
    if last_s > 0 and good.get(last_s, 0) < PATH_TAIL_MIN:
        ok_saying[last_s] = False
    anchor = None
    for k in range(n):
        if ok_saying[saying[k]]:
            anchor = k
        else:
            matched[k] = False
            if anchor is not None:
                pos[k], saying[k] = pos[anchor] + 0.4, saying[anchor]
            else:
                pos[k], saying[k] = -0.5, -1  # before any saying that counts: a run-up, left out
    # The words each saying covers (from its matched sounds).
    span = {}
    for k in range(n):
        if matched[k]:
            w = owner[int(pos[k])]
            a, b = span.get(saying[k], (w, w))
            span[saying[k]] = (min(a, w), max(b, w))
    sayings = sorted(span)
    later_cover = {}
    for s in sayings:
        later_cover[s] = [span[t] for t in sayings if t > s]
    superseded = [False] * n
    for k in range(n):
        if saying[k] < 0:
            superseded[k] = True
            continue
        w = word_of(k)
        if any(a <= w <= b for a, b in later_cover.get(saying[k], [])):
            superseded[k] = True
    # Saying again what was already read: the place now is before the
    # furthest place an earlier saying reached (the page shows «تكرار»).
    last_k = next((k for k in range(n - 1, -1, -1) if matched[k]), None)
    reading_path.repeating = False
    if last_k is not None and saying[last_k] > 0:
        cur = owner[int(pos[last_k])]
        before = [owner[int(pos[k])] for k in range(n) if matched[k] and saying[k] < saying[last_k]]
        reading_path.repeating = bool(before) and cur < max(before)
    keep = [k for k in range(n) if not superseded[k]]
    keep.sort(key=lambda k: (pos[k], saying[k], k))
    text = "".join(hyp0[k] for k in keep)
    removed = []
    k = 0
    while k < n:
        if not superseded[k]:
            k += 1
            continue
        e = k
        while e + 1 < n and superseded[e + 1] and saying[e + 1] == saying[k]:
            e += 1
        ws = [owner[int(pos[x])] for x in range(k, e + 1) if matched[x]]
        if ws:
            first_pos = min(pos[x] for x in range(k, e + 1))
            at = sum(1 for x in keep if pos[x] < first_pos)
            # Only a first saying that is these words said (not the ayah
            # before the range read first, or other words) can give notes.
            good_run = sum(same[x] for x in range(k, e + 1)) >= PATH_GOOD * (e + 1 - k)
            removed.append((at, hyp0[k:e + 1], min(ws), max(ws), k if good_run else None))
        k = e + 1
    removed.sort(key=lambda r: r[0])
    return text, keep, removed


def _sub_reference(ref, wa, we):
    """Words wa..we of the reference, as a reference of their own."""
    a, b = ref.starts[wa], ref.ends[we]

    def pick(group):
        return {w - wa for w in group if wa <= w <= we}

    sub = Reference(ref.chars[a:b], [w - wa for w in ref.owner[a:b]], we - wa + 1, pick(ref.wasl_start),
                    ayah_last=pick(ref.ayah_last), ayah_first=pick(ref.ayah_first), taa_end=pick(ref.taa_end),
                    letter=ref.letter[a:b] if ref.letter else [])
    return sub.finish()


def _best_stretch(ref, text, firsts, most=15):
    """The run of words (wa, we) a said-again stretch says, or None."""
    import Levenshtein as lv

    best = None
    for wa in firsts:
        for we in range(wa, min(ref.words, wa + most)):
            seg = ref.chars[ref.starts[wa]:ref.ends[we]]
            if len(seg) > 1.6 * len(text) + 4:
                break
            d = lv.distance(text, seg) / max(len(text), len(seg), 1)
            if best is None or d < best[0]:
                best = (d, wa, we)
    # Only a clear match: a first saying that isn't one run of the text (a
    # word left out, then the reading taken up again) isn't guessed at.
    return best if best and best[0] <= 0.15 else None


def judge(ref, heard, pauses=None, live=False, nested=False):
    """heard: the model's phonetic script of the reading (raw). pauses: the
    places in `heard` (index of the char after) where the reader stopped;
    None = not known, every word's ending is then taken as at a stop.
    Returns (words, extras, stop) like hifz_check.grade: words[k] = {"s": ok
    | wrong | tashkeel | missing | unread, "h"?}; extras = [{"after",
    "kind", "h"}]."""
    import Levenshtein as lv

    hyp0, _ = normalize(heard)
    tail_item = None
    if not nested:
        # (a nested call -- a first saying judged for the notes -- must not
        # reset it: «تكرار» never reached the page)
        judge.repeating = False
    if READING_PATH and not nested:
        hyp, kept, restarts = reading_path(hyp0, ref, live=live)
        judge.repeating = reading_path.repeating
    else:
        hyp, kept, restarts = collapse_repeats(hyp0, ref.chars)
    if live and not (READING_PATH and not nested):
        j = tail_restart(ref.chars, hyp)
        if j is not None:
            tail_item = (j, hyp[j:])
            restarts.append(tail_item)
            hyp, kept = hyp[:j], kept[:j]
    judge.kept = kept
    # A stop before hyp[k]: one in the heard text between it and the char before.
    pause_at = [pauses is None] * (len(hyp) + 1)
    if pauses:
        for k in range(1, len(hyp)):
            pause_at[k] = any(kept[k - 1] < p <= kept[k] for p in pauses)
    R_full = ref.chars
    # The reading may stop before the end of the range: compare with the
    # part it covers (through the end of that word), the rest is unread.
    k = read_prefix(R_full, hyp)
    if k < len(R_full):
        k = ref.ends[ref.owner[max(0, k - 1)]]
    R = R_full[:k]
    n = ref.words
    letter = [0] * n
    vowel = [0] * n
    deleted = [0] * n
    size = [0] * n
    matched = [0] * n
    said = [[] for _ in range(n)]
    for w in ref.owner:
        size[w] += 1
    inserts = []
    # Where in each word it went wrong (char indices of R), and how: what
    # should have been said there and what was (kind, want, said, index).
    where_bad = [set() for _ in range(n)]
    how = [[] for _ in range(n)]

    def bad(w, i, kind, want="", got=""):
        where_bad[w].add(i)
        how[w].append((kind, want, got, i))

    def end_zone(i):
        return i >= ref.tail[ref.owner[i]]

    def start_zone(i):
        w = ref.owner[i]
        return w in ref.wasl_start and i - ref.starts[w] < 2

    def soft_delete(i):
        c = R[i]
        return (end_zone(i) and c in END_SOFT) or (start_zone(i) and (c == "ء" or c in HARAKAT))

    def nasal(i, h):
        """A noon's nasal said another acceptable way -- tajweed, not a
        memorization or haraka slip: a hidden noon or iqlab meem (ں ۾) said
        as a plain ن / م (or not heard), and a tanween or noon merged into
        the next word's first letter said as a plain ن (فَرِيقًا يَلْوُۥنَ)."""
        c = R[i]
        if c in "ں۾":
            return h is None or h in "نمں۾"
        w = ref.owner[i]
        if h in ("ن", "ں") and w + 1 < n and i >= ref.ends[w] - 2 and (w + 1) in ref.starts and c == ref.chars[ref.starts[w + 1]]:
            return True
        # A word's last letter merged into the next word's first one (قَد تَّابَ
        # said «قَتتَابَ»: idgham of near letters).
        if w + 1 < n and (w + 1) in ref.starts and i >= ref.ends[w] - 2:
            j = ref.starts[w + 1]
            if j + 1 < len(ref.chars) and ref.chars[j] == ref.chars[j + 1] == h and c not in HARAKAT:
                return True
        # A merge's doubled letter at a word's edge, whichever word owns it
        # (بَاغٍ وَلَا: «بَاغِوو | َلَا»), said with a plain ن.
        if h in ("ن", "ں") and c in "يومنلر" and (i >= ref.ends[w] - 2 or i <= ref.starts[w] + 1) and (
                (i > 0 and ref.chars[i - 1] == c) or (i + 1 < len(ref.chars) and ref.chars[i + 1] == c)):
            return True
        return False

    ops = lv.opcodes(R, hyp)
    # Where each word was heard, first: whether the reader stopped after a
    # word decides how its ending is judged.
    pre = {}
    for tag, i1, i2, j1, j2 in ops:
        if tag in ("equal", "replace"):
            for k in range(min(i2 - i1, j2 - j1)):
                w = ref.owner[i1 + k]
                lo, hi = pre.get(w, (j1 + k, j1 + k))
                pre[w] = (min(lo, j1 + k), max(hi, j1 + k))

    def stopped_after(w):
        if pauses is None or w in ref.ayah_last or w not in pre or (w + 1) not in pre:
            return True
        a, b = pre[w][1], pre[w + 1][0]
        return any(pause_at[k] for k in range(a + 1, max(a + 1, b) + 1))

    def stopped_before(w):
        return w == 0 or w in ref.ayah_first or stopped_after(w - 1)

    last_match = -1
    first_match = None
    spans = {}

    def heard_at(w, j):
        lo, hi = spans.get(w, (j, j))
        spans[w] = (min(lo, j), max(hi, j))

    for tag, i1, i2, j1, j2 in ops:
        if tag == "equal":
            for i in range(i1, i2):
                matched[ref.owner[i]] += 1
                said[ref.owner[i]].append(R[i])
                heard_at(ref.owner[i], j1 + i - i1)
            last_match = i2 - 1
            if first_match is None:
                first_match = i1
            continue
        if tag == "insert":
            inserts.append((i1, hyp[j1:j2], j1))
            continue
        span = max(i2 - i1, j2 - j1)
        for k in range(span):
            i = i1 + k if k < i2 - i1 else None
            h = hyp[j1 + k] if k < j2 - j1 else None
            if i is not None and h is not None:
                w = ref.owner[i]
                heard_at(w, j1 + k)
                # A word's edge read the other way (running on, or starting
                # after a stop): «أَحَدُنِ لَّاه» for «أَحَدْ | ءَللَاه».
                at_start = start_zone(i) and (R[i] == "ء" or R[i] in HARAKAT)
                at_end = end_zone(i) and R[i] in END_SOFT and not (R[i] in HARAKAT and h in HARAKAT)
                if (at_start or at_end) and (h in END_SOFT or h == "ء"):
                    if at_end and not stopped_after(w) and h not in HARAKAT and not nasal(i, h):
                        vowel[w] += 1  # ran on, but the ending as at a stop
                        bad(w, i, "stop", R[i], h)
                    inserts.append((ref.starts[w] if at_start else ref.ends[w], h, j1 + k))
                    continue
                said[w].append(h)
                if R[i] in HARAKAT and h in HARAKAT:
                    # A wrong vowel said aloud: wrong at a word's end too.
                    vowel[w] += 1
                    bad(w, i, "vowel", R[i], h)
                elif end_zone(i) and R[i] in END_SOFT and h in END_SOFT:
                    if not stopped_after(w):
                        vowel[w] += 1
                        bad(w, i, "stop", R[i], h)
                elif end_zone(i) and R[i] == "ت" and h == "ه":
                    if not stopped_after(w):
                        vowel[w] += 1  # a taa marbuta said as at a stop, running on
                        bad(w, i, "stop", "ت", "ه")
                elif end_zone(i) and R[i] == "ه" and (h == "ت" or h in END_SOFT) and w in ref.taa_end:
                    pass  # an ayah's end read on into the next: «حَامِيَتَن تُسْقَىٰ»
                elif nasal(i, h):
                    pass
                elif R[i] in MADD and h == {"ا": "َ", "ۥ": "ُ", "ۦ": "ِ"}[R[i]]:
                    pass  # a long vowel heard as its short one
                else:
                    letter[w] += 1
                    bad(w, i, "letter", R[i], h)
            elif i is not None:
                w = ref.owner[i]
                if nasal(i, None):
                    pass
                elif R[i] in HARAKAT and not end_zone(i):
                    pass  # a short haraka the ear didn't catch (a quick reading)
                elif R[i] in MADD or (i > 0 and R[i - 1] == R[i]) or (i + 1 < len(R) and R[i + 1] == R[i]):
                    # A long vowel said short, a shadda said light: length,
                    # which the ear can't time in a quick reading.
                    pass
                elif not soft_delete(i):
                    deleted[w] += 1
                    bad(w, i, "drop", R[i])
                elif end_zone(i) and not stopped_after(w):
                    # Ran on without the ending's haraka or tanween.
                    vowel[w] += 1
                    bad(w, i, "stop", R[i])
            else:
                inserts.append((i2, h, j1 + k))

    # Merge inserts at the same place, then sort out the soft ones.
    merged, where = {}, {}
    for p, t, j in inserts:
        merged[p] = merged.get(p, "") + t
        where[p] = min(where.get(p, j), j)
    extras = []
    # Stretches said twice: the first saying, and where it may start.
    said_again = []
    for p, t in sorted(merged.items()):
        before = ref.owner[p - 1] if p > 0 else None
        after = ref.owner[p] if p < len(R) else None
        if before is not None and after is not None and before == after:
            core = [c for c in t if c not in HARAKAT]
            w = after
            if w in ref.taa_end and w in ref.ayah_last and p >= ref.tail[w] and all(c == "ت" or c in END_SOFT for c in t):
                continue  # the ayah's taa marbuta read on: «حَامِيَ(تَن)»
            if len(core) >= 2 and len(t) >= 4:
                # Not a slip inside the word: speech the alignment happened
                # to put there (a restart). Taken to the nearer edge.
                if p - ref.starts[w] <= ref.ends[w] - p:
                    before, after = (w - 1 if w > 0 else None), w
                else:
                    before, after = w, (w + 1 if w + 1 < n else None)
            elif len(t) == 1 and (R[p - 1] == t or (p < len(R) and R[p] == t)):
                continue  # a sound held a little longer
            elif core:
                letter[w] += 1
                bad(w, p - 1, "add", "", t)
                continue
            else:
                if not end_zone(p):
                    vowel[w] += 1
                    bad(w, p - 1, "add", "", t)
                continue
        # Between words: a running-on ending of the word before, a hamzat
        # al-wasl said at the start of the next.
        k = 0
        while k < len(t) and k < END_ZONE and t[k] in END_SOFT:
            k += 1
        t = t[k:]
        if after is not None and after in ref.wasl_start:
            if re.search(r"ء[َُِ]?$", t) and not stopped_before(after):
                vowel[after] += 1  # a hamzat al-wasl said, running on
                bad(after, ref.starts[after], "hamza", "", "ء")
            t = re.sub(r"ء[َُِ]?$", "", t)
        if len([c for c in t if c not in HARAKAT]) < 2:
            continue
        if before is None and first_match is not None and p <= first_match:
            continue  # before the reading started (an isti'adha heard loosely)
        if after is None:
            continue  # after the range: read on past it
        kind = "restart" if _says_again(ref, t, before, after) else "added"
        extras.append({"after": before if before is not None else -1, "kind": kind, "h": t, "j": where[p]})
        if kind == "restart":
            said_again.append((t, range(max(0, (before if before is not None else 0) - 25), min(n, after + 2))))

    if restarts:
        # where each heard index sits in the text (the ref index it pairs with)
        at = [0] * (len(hyp) + 1)
        for tag, i1, i2, j1, j2 in lv.opcodes(R, hyp):
            for j in range(j1, j2 + 1):
                if j <= len(hyp):
                    at[j] = i1 if tag == "insert" else min(i1 + (j - j1), max(i1, i2 - 1)) if tag != "delete" else i1
        for item in restarts:
            pos, text = item[0], item[1]
            i = at[min(pos, len(hyp))]
            before = ref.owner[i - 1] if i > 0 else -1
            extras.append({"after": before, "kind": "restart", "h": text, "j": pos})
            if len(item) >= 4:
                # From the reading's path: the words it said are known.
                if item[4] is not None:
                    said_again.append((text, (item[2], item[3], item[4])))
            elif item is not tail_item:
                w0 = ref.owner[min(i, len(ref.owner) - 1)] if ref.owner else 0
                said_again.append((text, range(max(0, w0 - 1), min(n, w0 + 2))))
    stop_word = ref.owner[last_match] if last_match >= 0 else -1
    words = []
    for w in range(n):
        if w > stop_word:
            words.append({"s": "unread"})
            continue
        # The letters (of the word as shown) where it went wrong.
        x = sorted({ref.letter[i] for i in where_bad[w] if 0 <= i < len(ref.letter)}) if ref.letter else []
        # How, sound by sound: {"k": letter | vowel | drop | add | stop |
        # hamza, "w": what should be said, "s": what was, "x": the letter}.
        d, seen = [], set()
        for kind, want, got, i in how[w]:
            key = (kind, want, got, ref.letter[i] if 0 <= i < len(ref.letter) else -1)
            if key not in seen and len(d) < 4:
                seen.add(key)
                d.append({"k": kind, "w": want, "s": got, "x": key[3]})
        if deleted[w] >= max(1, MISSING_SHARE * size[w]):
            words.append({"s": "missing"})
        elif letter[w] or deleted[w] >= 2:
            # Most of the word not as written: another word was said (the
            # page showed four letter slips for «وَشَجَرَةً» said «وَعَلَيهَا»).
            core = sum(1 for i in range(ref.starts.get(w, 0), ref.ends.get(w, 0)) if ref.chars[i] not in HARAKAT)
            if letter[w] >= 3 or (letter[w] >= 2 and letter[w] + deleted[w] >= 0.5 * max(1, core)):
                whole = ref.chars[ref.starts[w]:ref.ends[w]] if w in ref.starts else ""
                words.append({"s": "wrong", "h": "".join(said[w]), "x": [], "d": [{"k": "word", "w": whole, "s": "".join(said[w]), "x": -1}]})
            else:
                words.append({"s": "wrong", "h": "".join(said[w]), "x": x, "d": d})
        elif vowel[w] or deleted[w]:
            words.append({"s": "tashkeel", "h": "".join(said[w]), "x": x, "d": d})
        else:
            words.append({"s": "ok"})

    # Slips put right: a stretch the reader said, then said again -- the
    # first saying is judged on its own; a slip in it, on a word the second
    # saying got right, is noted as corrected (2026-11-24, the user: a word
    # read again rightly is right, but the slip should stay in the notes).
    cands = []
    if not nested:
        kept_main = judge.kept
        for text, firsts in said_again:
            at0 = None
            if isinstance(firsts, tuple):
                wa, we, at0 = firsts  # from the reading's path: known
            else:
                best = _best_stretch(ref, text, firsts)
                if not best:
                    continue
                _, wa, we = best
            # One word more: a first saying often broke off on a wrong word
            # (that word is why it was said again); one only begun is passed over below.
            we = min(n - 1, we + 1)
            sub = _sub_reference(ref, wa, we)
            sub_words, _, _ = judge(sub, text, nested=True)
            # Kept to check the first saying's sounds too (check_frames):
            # its own spans and where its sounds are in the heard text.
            cand = {"wa": wa, "sub": sub, "words": sub_words, "text": "".join(text[i] for i in judge.kept),
                    "spans": judge.spans, "edits": judge.edits,
                    "at": None if at0 is None else [at0 + i for i in judge.kept]}
            # The word it broke off on, said as another: what was said past
            # the matched words, when it isn't the next word's beginning.
            import Levenshtein as lv

            seg = ref.chars[ref.starts[wa]:ref.starts[we]] if we > wa else ""
            ops = lv.opcodes(seg, text) if seg else []
            rest = text[ops[-1][3]:] if ops and ops[-1][0] == "insert" and ops[-1][1] == len(seg) else ""
            nxt = ref.chars[ref.starts[we]:ref.ends[we]]
            core = [c for c in rest if c not in HARAKAT]
            if (len(core) >= 1 and we <= stop_word and words[we]["s"] == "ok" and core != [c for c in nxt if c not in HARAKAT][:len(core)]
                    and sub_words[-1]["s"] == "missing"):
                sub_words[-1] = {"s": "wrong", "h": rest, "x": [], "d": [{"k": "word", "w": nxt, "s": rest, "x": -1}]}
                cand["word_end"] = True
            cands.append(cand)
        judge.kept = kept_main
    judge.fixed_cands = cands
    judge.edits = how
    judge.fixed = fixed_notes(cands, words, stop_word)
    judge.spans = spans
    return words, extras, stop_word + 1


def fixed_notes(cands, words, stop_word):
    """Slips put right: a slip in a first saying on a word now right."""
    fixed = []
    for cand in cands:
        wa, sub_words = cand["wa"], cand["words"]
        for j, st in enumerate(sub_words):
            w = wa + j
            if st["s"] not in ("wrong", "tashkeel", "missing") or w > stop_word or w >= len(words) or words[w]["s"] != "ok":
                continue
            # The last word of a first saying is often only begun.
            if j == len(sub_words) - 1 and (st["s"] == "missing" or all(x["k"] == "drop" for x in st.get("d", []))):
                continue
            if not any(f["w"] == w for f in fixed):
                fixed.append({"w": w, **{k: v for k, v in st.items() if k not in ("delta", "checked")}})
    return sorted(fixed, key=lambda f: f["w"])


# ---------- Each sound on its own ----------
# 2026-11-25: verify weighed a word's differing sounds together, so one
# sound the ear got wrong («ص» for a clear «س») stayed in a note beside a
# real slip (a fatha for a kasra), and a word with one real slip and one
# ear slip was judged on their average. Now each differing sound left after
# the word's check is tried alone: the text as written with only that
# change, against the text as written. A change the audio doesn't clearly
# support (by `margin`) is dropped; the word is then re-stated from the
# changes that remain (none left: right).
PER_SOUND = True
VERIFY_ANY_CONTEXT = True
DEBUG_EDITS = False   # evaluation: keep each edit's acoustic support on the word ("ed")
# Changes the ear makes up more often than readers make them: on Iqra'Eval
# (1642 learners' readings, 18 speakers) an edit of these kinds that passed
# the check was in a word the experts call right more often than not (under
# 45% in a wrong word, 3+ times). They need far stronger support. Chosen on
# half the speakers and tried on the other half (both ways): false flags
# 11.7% -> 10.9%, slips found 52.9% -> 52.2% -- three false flags gone per
# slip lost, where a stronger margin for all sounds loses one per one.
WEAK_PAIRS = {
    ('drop', 'ف', ''),
    ('drop', 'ء', ''),
    ('stop', 'َ', ''),
    ('drop', 'و', ''),
    ('add', '', 'ا'),
    ('drop', 'ه', ''),
    ('letter', 'ء', 'ا'),
    ('letter', 'ط', 'ت'),
    ('letter', 'ل', 'د'),
    ('letter', 'ي', 'ۦ'),
    ('letter', 'ف', 'و'),
    ('drop', 'ط', ''),
    ('letter', 'و', 'ۥ'),
    ('drop', 'ب', ''),
    ('letter', 'د', 'ج'),
    ('letter', 'ه', 'ح'),
    ('letter', 'غ', 'ق'),
    ('letter', 'ف', 'ن'),
}
WEAK_MARGIN = 10.0


def _apply_edit(word, base, e):
    """The word's sounds with one edit (kind, want, got, text index) made,
    or None if it can't be."""
    kind, want, got, i = e
    j = i - base
    if kind in ("letter", "vowel") or (kind == "stop" and got):
        return word[:j] + got + word[j + 1:] if 0 <= j < len(word) and got else None
    if kind in ("drop", "stop"):
        return word[:j] + word[j + 1:] if 0 <= j < len(word) else None
    if kind == "add":
        return word[:j + 1] + got + word[j + 1:] if -1 <= j < len(word) and got else None
    if kind == "hamza":
        return got + word
    return None


def _restate(ref, w, st, edits):
    """A flagged word from the edits that remain."""
    letter = vowel = deleted = 0
    for kind, want, got, i in edits:
        if kind == "letter" or (kind == "add" and any(c not in HARAKAT for c in got)):
            letter += 1
        elif kind == "drop":
            deleted += 1
        else:
            vowel += 1
    x = sorted({ref.letter[i] for _, _, _, i in edits if 0 <= i < len(ref.letter)}) if ref.letter else []
    d, seen = [], set()
    for kind, want, got, i in edits:
        key = (kind, want, got, ref.letter[i] if 0 <= i < len(ref.letter) else -1)
        if key not in seen and len(d) < 4:
            seen.add(key)
            d.append({"k": kind, "w": want, "s": got, "x": key[3]})
    status = "wrong" if letter or deleted >= 2 else "tashkeel"
    core = sum(1 for i in range(ref.starts.get(w, 0), ref.ends.get(w, 0)) if ref.chars[i] not in HARAKAT)
    if letter >= 3 or (letter >= 2 and letter + deleted >= 0.5 * max(1, core)):
        whole = ref.chars[ref.starts[w]:ref.ends[w]] if w in ref.starts else ""
        return {"s": "wrong", "h": st.get("h", ""), "x": [], "d": [{"k": "word", "w": whole, "s": st.get("h", ""), "x": -1}]}
    return {"s": status, "h": st.get("h", ""), "x": x, "d": d}


def verify(ref, hyp, places, logprobs, words, vocab, margin=1.0, edits=None):
    """The acoustic check of each flagged word, with the Muaalem model's own
    frame probabilities: on the stretch of audio from the word before to the
    word after, does the text as written explain the sound as well as what
    the greedy decoding wrote? If so the word was said right (a decoding
    slip), and it is cleared. hyp: normalized heard text; places: (chunk,
    frame) of each of its chars; logprobs: per chunk [T, V] log
    probabilities; vocab: char -> id. Returns how many were cleared."""
    import torch
    import torchaudio.functional as F
    import Levenshtein as lv

    spans = judge.spans
    cleared = 0

    def ids(text):
        out = []
        for c in text:
            if c not in vocab:
                return None
            out.append(vocab[c])
        return out

    def score(lp, targets):
        repeats = sum(1 for a, b in zip(targets, targets[1:]) if a == b)
        if not targets or lp.shape[0] < len(targets) + repeats:
            return None
        _, sc = F.forced_align(lp.unsqueeze(0), torch.tensor([targets], dtype=torch.int32), blank=0)
        return float(sc[0].sum())

    def ref_text(w):
        return ref.chars[ref.starts[w]: ref.ends[w]] if w in ref.starts else ""

    # 2026-11-25: the context had to be right words, so a flagged word next
    # to another flagged word, or at the reading's first or last word, was
    # never checked -- on Iqra'Eval that was 327 of the 625 right words
    # still flagged. The context is now what was heard there when the word
    # beside it is flagged (it is the same in both texts compared, so it only
    # places the word), and a word with one side or none is checked too.
    was_ok = [st["s"] == "ok" for st in words]

    def ctx_text(k):
        return ref_text(k) if was_ok[k] else hyp[spans[k][0]: spans[k][1] + 1]

    for w, st in enumerate(words):
        if st["s"] not in ("wrong", "missing", "tashkeel"):
            continue
        if VERIFY_ANY_CONTEXT:
            context = [k for k in (w - 1, w + 1) if k in spans and 0 <= k < ref.words]
            if w not in spans and len(context) < 2:
                continue  # a word left out needs both sides to place it
        else:
            context = [k for k in (w - 1, w + 1) if k in spans and 0 <= k < ref.words and words[k]["s"] == "ok"]
            if len(context) < 2 and not (w in spans and context):
                continue
        idx = [i for k in context + ([w] if w in spans else []) for i in range(spans[k][0], spans[k][1] + 1)]
        lo, hi = min(idx), max(idx)
        chunk_set = {places[i][0] for i in range(lo, hi + 1)}
        if len(chunk_set) != 1:
            continue
        c = chunk_set.pop()
        lp = logprobs[c]
        f0 = max(0, places[lo][1] - 6)
        f1 = min(lp.shape[0], places[hi][1] + 10)
        before = ctx_text(w - 1) if (w - 1) in context else ""
        after = ctx_text(w + 1) if (w + 1) in context else ""
        written = before + ref_text(w) + after
        said = hyp[spans[w][0]: spans[w][1] + 1] if w in spans else ""
        heard = before + said + after
        a, b = ids(written), ids(heard)
        if a is None or b is None:
            continue
        sa, sb = score(lp[f0:f1], a), score(lp[f0:f1], b)
        if sa is None or sb is None:
            continue
        delta = (sa - sb) / max(1, lv.distance(written, heard))
        st["delta"] = round(delta, 2)
        if delta >= -margin:
            words[w] = {"s": "ok", "checked": True, "delta": round(delta, 2)}
            cleared += 1
        elif PER_SOUND and edits is not None and w < len(edits) and edits[w] and w in ref.starts and st["s"] != "missing":
            word = ref_text(w)
            base = ref.starts[w]
            keep, ed = [], []
            for e in edits[w]:
                alt = _apply_edit(word, base, e)
                c = ids(before + alt + after) if alt is not None else None
                sk = score(lp[f0:f1], c) if c else None
                ed.append([e[0], e[1], e[2], None if sk is None else round(sa - sk, 2)]
                          + ([written, before + alt + after if alt is not None else None, f0, f1] if DEBUG_EDITS else []))
                need = WEAK_MARGIN if (e[0], e[1], e[2]) in WEAK_PAIRS else margin
                if sk is None or sa - sk < -need:
                    keep.append(e)  # the audio says it (or it can't be tried)
            if not keep:
                words[w] = {"s": "ok", "checked": True}
                cleared += 1
            elif len(keep) < len(edits[w]):
                words[w] = _restate(ref, w, st, keep)
            if DEBUG_EDITS:
                words[w]["ed"], words[w]["wd"] = ed, round(delta, 2)
    return cleared


def strip_formulas(heard, surah, first_ayah, moshaf=None):
    """The heard script without a leading isti'adha / basmala (unless the
    range starts with the basmala: Al-Fatiha 1)."""
    from quran_transcript import Aya, quran_phonetizer

    moshaf = moshaf or default_moshaf()
    strip_formulas.cut = 0
    f = Aya(surah, first_ayah).get()
    phrases = [f.istiaatha_uthmani]
    if not (surah == 1 and first_ayah == 1):
        phrases.append("بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ")
    h, _ = normalize(heard)
    for phrase in phrases:
        p, _ = normalize(quran_phonetizer(phrase, moshaf, remove_spaces=True).phonemes)
        best, cut = 1.0, 0
        for k in range(max(1, len(p) - 6), min(len(h), len(p) + 6) + 1):
            import Levenshtein as lv
            r = lv.distance(h[:k], p) / max(len(p), 1)
            if r < best:
                best, cut = r, k
        if best <= 0.3:
            h = h[cut:]
            strip_formulas.cut += cut
    return h


def pauses(lp, fps, hframes):
    """Where the reader stopped: the indices k of the heard text with a
    stretch of PAUSE_SEC or more between hframes[k-1] and hframes[k] where
    the ear hears nothing (a long madd isn't one: the ear keeps writing it)."""
    blank = (lp[:, 0].exp() > PAUSE_BLANK).tolist()
    need = max(1, int(round(PAUSE_SEC * fps)))
    out = set()
    for k in range(1, len(hframes)):
        run = 0
        for f in range(hframes[k - 1] + 1, hframes[k]):
            run = run + 1 if blank[f] else 0
            if run >= need:
                out.add(k)
                break
    return out


# The acoustic check clears a flagged word unless the text as written
# explains its audio worse than what was heard by more than this, per
# differing sound (log-probability; 3 = about 20 times less likely).
# 2026-11-24, the user found right words flagged: «تَصْلَىٰ» was called
# wrong on «س» 0.72 against «ص» 0.22. On 97 recitations (3555 words) going
# from 1 to 3 took false flags 126 -> 113, while planted slips found went
# 280 -> 279 /284 (vowels), 272 -> 271 /282 (word ends), 283 -> 280 /284 (letters).
VERIFY_MARGIN = 3.0


def check_frames(lp, fps, ref, surah, first_ayah, margin=VERIFY_MARGIN, strict=True, live=False):
    """The whole check on the ear's frames: what was heard, judged and
    verified, with times. Returns {"words", "extras", "stop", "heard"}:
    words[k] = {"s", "h"?, "t0"?, "t1"?, "checked"?}; extras with t0/t1."""
    import quran_ear

    heard_raw, frames = quran_ear.greedy(lp)
    kept = []
    normalize(heard_raw, kept=kept)
    h = strip_formulas(heard_raw, surah, first_ayah)
    hframes = [frames[k] for k in kept][strip_formulas.cut:]
    words, extras, stop = judge(ref, h, pauses(lp, fps, hframes) if strict else None, live=live)
    fixed = judge.fixed
    edits = judge.edits
    repeating = judge.repeating
    hc = "".join(h[i] for i in judge.kept)
    cframes = [hframes[i] for i in judge.kept]
    spans = judge.spans
    verify(ref, hc, [(0, f) for f in cframes], [lp], words, quran_ear.vocab(), margin, edits)
    # A first saying's slips get the same acoustic check (one heard «ص»
    # for «س» in both sayings, cleared in the second, stayed in the note).
    cands = getattr(judge, "fixed_cands", [])
    for cand in cands:
        if cand["at"] and all(0 <= i < len(hframes) for i in cand["at"]):
            judge.spans = cand["spans"]
            verify(cand["sub"], cand["text"], [(0, hframes[i]) for i in cand["at"]], [lp], cand["words"],
                   quran_ear.vocab(), margin, cand.get("edits"))
    judge.spans = spans
    if cands:
        fixed = fixed_notes(cands, words, stop - 1)

    def sec(f):
        return round(f / fps, 2)

    for w, st in enumerate(words):
        st.pop("delta", None)
        if w in spans and cframes:
            a, b = spans[w]
            st["t0"] = sec(cframes[min(a, len(cframes) - 1)])
            st["t1"] = sec(cframes[min(b, len(cframes) - 1)] + 3)
    for x in extras:
        j = x.pop("j", None)
        if j is not None and cframes:
            f0 = cframes[max(0, min(j - 1, len(cframes) - 1))]
            f1 = cframes[min(j, len(cframes) - 1)]
            x["t0"], x["t1"] = sec(min(f0, f1)), sec(max(f0, f1) + 3)
        else:
            x["t0"] = x["t1"] = 0.0
    return {"words": words, "extras": extras, "stop": stop, "heard": heard_raw, "fixed": fixed, "repeating": repeating}
