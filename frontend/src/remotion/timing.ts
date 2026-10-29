// The single rule for WHEN each piece of on-screen text is shown, shared by
// render/route.ts (the real render and the preview's inputProps),
// VideoCreatorForm (re-timing the live preview instantly on every edit, and
// the timing editor's initial boundaries) and QuranVideo.tsx itself -- so the
// three can never disagree about it.
//
// The rule: a chunk of an ayah starts from the moment the reciter starts its
// first voiced word and is timed to end when he finishes its last one, EXCEPT
// at a boundary the user actually moved in the timing editor -- there both
// neighbours meet exactly at the user's point. (On screen, QuranVideo.tsx
// keeps each chunk until the next one fades in, so a pause between two
// chunks never leaves the screen blank.) The timing editor saves every boundary as start_ms/end_ms
// (the user may have moved any of them); normalizeMappingTimes below drops
// the ones that are just the word timing restated, so an untouched boundary
// keeps following the words.
//
// Only relative imports here: Remotion bundles this file too.

export interface TimedWord {
  start: number;
  end: number;
}

// The fields of a VerseMapping this file reads or rewrites.
export interface TimelineMapping {
  word_count: number;
  repeat_of_part?: number;
  start_ms?: number;
  end_ms?: number;
  // Set by buildVerseTimeline on the parts another appearance of the ayah
  // shows (see TimelineVerseOutput).
  hidden?: boolean;
}

// A waqf or Hizb sign is its own "word" in the timing data but has no sound:
// the aligner pins it to a zero-length instant (end === start).
export function isVoicedWord(w: TimedWord | undefined): boolean {
  return !!w && w.end > w.start;
}

// [onset of the first voiced word, end of the last voiced word] among
// words[from..to] (inclusive), or null when that range holds no voiced word.
export function voicedSpan(
  words: TimedWord[] | undefined,
  from: number,
  to: number
): { start: number; end: number } | null {
  if (!words) return null;
  let first = -1;
  let last = -1;
  for (let i = Math.max(0, from); i <= Math.min(words.length - 1, to); i++) {
    if (!isVoicedWord(words[i])) continue;
    if (first < 0) first = i;
    last = i;
  }
  return first < 0 ? null : { start: words[first].start, end: words[last].end };
}

// The aligner's record of the order the reciter read in (only written when he
// went back -- see lib/readingPath.ts's Reading): runs of one ayah's tokens
// from `from`, with [start, end] ms per token.
export interface ReadingRun {
  ayah: number;
  from: number;
  words: [number, number][];
}

// A word the reciter read again before going on past it -- he repeated the
// end of what's on screen -- stays current until that repeat ends. Every
// window derived from the words (the video's, the timing editor's) then
// covers the repeat, instead of the text vanishing when the word's FIRST
// reading ended (79:29: "وَأَخْرَجَ ضُحَاهَا" repeated, ayah gone during it).
// A repeat after he had already gone on (the next word's first reading had
// begun) is another appearance instead, see lib/readingPath.ts. `ayahs` are
// the selection in order; returns each ayah's words (copied where changed).
export function holdWordsThroughRepeats<W extends TimedWord & { w?: string }>(
  ayahs: { id: number; words: W[] }[],
  readings: ReadingRun[] | undefined
): Map<number, W[]> {
  const held = new Map(ayahs.map((a) => [a.id, a.words]));
  if (!readings?.length) return held;
  // First-reading start of the next voiced word after token i of ayah n.
  const nextStart = (n: number, i: number): number => {
    for (let m = n; m < ayahs.length; m++) {
      const words = ayahs[m].words;
      for (let k = m === n ? i + 1 : 0; k < words.length; k++) {
        if (isVoicedWord(words[k])) return words[k].start;
      }
    }
    return Infinity;
  };
  const index = new Map(ayahs.map((a, n) => [a.id, n]));
  const seen = new Set<string>();
  for (const r of readings) {
    const n = index.get(r.ayah);
    if (n === undefined) continue;
    r.words.forEach(([, end], k) => {
      const i = r.from + k;
      const key = `${r.ayah}:${i}`;
      if (!seen.has(key)) {
        seen.add(key);
        return;
      }
      const original = ayahs[n].words[i];
      if (!isVoicedWord(original) || end <= original.end || end > nextStart(n, i)) return;
      let words = held.get(r.ayah)!;
      if (words === ayahs[n].words) {
        words = words.slice();
        held.set(r.ayah, words);
      }
      words[i] = { ...words[i], end: Math.max(words[i].end, end) };
    });
  }
  return held;
}

// Every reading of a word after its first: `i` is the word's index in its
// ayah's words, times on the same timeline as the words. The highlight
// follows the reciter through a repeat with these -- the word he re-reads,
// not the one his first reading left current.
export interface WordRepeat {
  i: number;
  start: number;
  end: number;
}

export function repeatWordWindows(ayahIds: number[], readings: ReadingRun[] | undefined): Map<number, WordRepeat[]> {
  const repeats = new Map<number, WordRepeat[]>();
  if (!readings?.length) return repeats;
  const seen = new Set<string>();
  for (const r of readings) {
    if (!ayahIds.includes(r.ayah)) continue;
    r.words.forEach(([start, end], k) => {
      const i = r.from + k;
      const key = `${r.ayah}:${i}`;
      if (!seen.has(key)) {
        seen.add(key);
        return;
      }
      if (!(end > start)) return; // a pause mark
      if (!repeats.has(r.ayah)) repeats.set(r.ayah, []);
      repeats.get(r.ayah)!.push({ i, start, end });
    });
  }
  return repeats;
}

// Readings on the untrimmed prepared clip, moved onto the played audio's
// timeline like shiftWordsToTrim moves the words -- the two are compared.
export function shiftReadingsToTrim<R extends ReadingRun>(readings: R[] | undefined, trimStartMs: number): R[] | undefined {
  return readings?.map((r) => ({
    ...r,
    words: r.words.map(([s, e]) => [Math.max(0, s - trimStartMs), Math.max(0, e - trimStartMs)] as [number, number]),
  }));
}

// Prepared word timing is on the untrimmed prepared clip; the audio actually
// played starts trimStartMs into it.
export function shiftWordsToTrim<W extends TimedWord>(words: W[], trimStartMs: number): W[] {
  return words.map((w) => ({ ...w, start: Math.max(0, w.start - trimStartMs), end: Math.max(0, w.end - trimStartMs) }));
}

// A saved boundary this close to where the words put it is the words'
// boundary (one frame at 30fps), not a deliberate move.
export const BOUNDARY_SNAP_MS = 35;
// Mixing a moved boundary with a word-derived one must never leave a chunk
// (nearly) invisible -- below this, the chunk keeps both saved edges.
const MIN_VISIBLE_MS = 100;

const isRepeat = (m: TimelineMapping) => typeof m.repeat_of_part === "number";

// The real-word range [from, to] each mapping shows; null for a repeat,
// which re-shows an earlier part's words and consumes none of its own.
export function mappingWordRanges(mappings: TimelineMapping[]): ({ from: number; to: number } | null)[] {
  let cursor = 0;
  return mappings.map((m) => {
    if (isRepeat(m)) return null;
    const range = { from: cursor, to: cursor + m.word_count - 1 };
    cursor += m.word_count;
    return range;
  });
}

// Rescales word counts that don't add up to the ayah's real word count (a
// placeholder, or an AI answer given a guessed count) proportionally, every
// part keeping at least one word -- unless every part carries editor
// timing: those counts came from the editor and are kept even when they
// disagree, since reshuffling them would move text away from the boundaries
// the user timed. Shared by segmentation/apply/route.ts and the client's
// live re-timing, which must agree. Returns `mappings` itself when nothing
// changes.
export function fitWordCounts<M extends TimelineMapping>(mappings: M[], realWordCount: number): M[] {
  const parts = mappings.filter((m) => !isRepeat(m));
  const total = parts.reduce((sum, m) => sum + m.word_count, 0);
  if (realWordCount < 1 || parts.length === 0 || total === realWordCount) return mappings;
  if (mappings.every((m) => typeof m.start_ms === "number")) return mappings;
  const fitted = new Map<M, number>();
  let assigned = 0;
  parts.forEach((m, i) => {
    if (i === parts.length - 1) {
      fitted.set(m, Math.max(1, realWordCount - assigned));
      return;
    }
    const proportional = Math.max(1, Math.round((m.word_count / total) * realWordCount));
    const maxAllowed = realWordCount - assigned - (parts.length - 1 - i);
    const count = Math.max(1, Math.min(proportional, maxAllowed));
    fitted.set(m, count);
    assigned += count;
  });
  return mappings.map((m) => (fitted.has(m) ? { ...m, word_count: fitted.get(m)! } : m));
}

interface FlatItem {
  mapping: TimelineMapping;
  span: { start: number; end: number } | null;
  // Which input verse, and which of its mappings (-1: an unsplit ayah).
  verse: number;
  index: number;
}

// Drops every start_ms/end_ms that only restates the word timing (see the
// rule at the top of this file). `items` is the whole selection's mappings
// in timeline order, all times on one timeline; `span` is the mapping's
// voiced-word span, null when it has none to derive from (a repeat, or no
// word timing), in which case its saved times are always kept. Mutates the
// mapping objects, which must be copies.
function normalizeMappingTimes(items: FlatItem[]): void {
  const saved = items.map(({ mapping }) => ({ start: mapping.start_ms, end: mapping.end_ms }));
  const n = items.length;
  // The selection's outer edges are the audio trim points, not text boundaries.
  if (n > 0 && items[0].span) delete items[0].mapping.start_ms;
  if (n > 0 && items[n - 1].span) delete items[n - 1].mapping.end_ms;

  for (let k = 1; k < n; k++) {
    const cur = items[k];
    const prev = items[k - 1];
    if (!cur.span) continue;
    const at = typeof saved[k].start === "number" ? saved[k].start : saved[k - 1].end;
    if (typeof at !== "number" || Math.abs(at - cur.span.start) > BOUNDARY_SNAP_MS) continue;
    delete cur.mapping.start_ms;
    if (prev.span) delete prev.mapping.end_ms;
  }

  items.forEach(({ mapping, span }, k) => {
    if (!span) return;
    const start = mapping.start_ms ?? span.start;
    const end = mapping.end_ms ?? span.end;
    if (end - start >= MIN_VISIBLE_MS) return;
    if (typeof saved[k].start === "number") mapping.start_ms = saved[k].start;
    if (typeof saved[k].end === "number") mapping.end_ms = saved[k].end;
  });
}

export interface TimelineVerseInput<W extends TimedWord, M extends TimelineMapping> {
  id: number;
  // On the played (trimmed) audio's timeline, in ms -- see shiftWordsToTrim.
  words: W[];
  // As saved: start_ms/end_ms on the untrimmed prepared clip's timeline.
  mappings?: M[];
  // On the same timeline as `words` (see repeatWordWindows).
  repeats?: WordRepeat[];
}

// One stretch of the video showing one ayah. Normally one per ayah, in
// order; when the reciter goes back to an ayah he already left (a repeat
// timed after the next ayah began), that ayah gets another appearance there,
// and each appearance shows only its own chunks -- the rest are `hidden`.
export interface TimelineVerseOutput<W extends TimedWord, M extends TimelineMapping> {
  // Index into the input verses.
  verseIndex: number;
  durationInFrames: number;
  // Relative to this appearance's start, which is what QuranVideo.tsx expects.
  wordTimings: W[];
  wordRepeats?: WordRepeat[];
  mappings?: M[];
}

// Lays the selected ayahs out on the played audio: each appearance's Sequence
// runs from its boundary to the next one's, and every time inside it (word
// timing, remaining start_ms/end_ms) becomes relative to its start. An
// appearance's boundary is a moved start of its first chunk, else the moment
// the reciter starts it; the first starts at 0 (the trim point) and the last
// runs to the end of the audio. Returns null when some ayah has no word
// timing, which this layout can't place.
export function buildVerseTimeline<W extends TimedWord, M extends TimelineMapping>(
  verses: TimelineVerseInput<W, M>[],
  { trimStartMs, fps, totalFrames }: { trimStartMs: number; fps: number; totalFrames: number }
): TimelineVerseOutput<W, M>[] | null {
  if (verses.length === 0 || verses.some((v) => !v.words?.length)) return null;

  const mappingsByVerse = verses.map((v) =>
    v.mappings?.map((m) => {
      const copy: M = { ...m };
      if (typeof m.start_ms === "number") copy.start_ms = m.start_ms - trimStartMs;
      if (typeof m.end_ms === "number") copy.end_ms = m.end_ms - trimStartMs;
      return copy;
    })
  );
  const flat: FlatItem[] = [];
  verses.forEach((v, i) => {
    const mappings = mappingsByVerse[i];
    if (!mappings) {
      // An unsplit ayah is one chunk spanning all its words.
      flat.push({ mapping: { word_count: v.words.length }, span: voicedSpan(v.words, 0, v.words.length - 1), verse: i, index: -1 });
      return;
    }
    const ranges = mappingWordRanges(mappings);
    mappings.forEach((mapping, j) => {
      const range = ranges[j];
      const span = range && range.to < v.words.length ? voicedSpan(v.words, range.from, range.to) : null;
      flat.push({ mapping, span, verse: i, index: j });
    });
  });
  // On the timeline in the order they're heard: a repeat the reciter went
  // back for after the next ayah began sits after that ayah. Stable, and a
  // chunk with no time of its own keeps its place behind the one before it.
  let lastKey = -Infinity;
  const keys = flat.map((item) => {
    const key = item.mapping.start_ms ?? item.span?.start;
    lastKey = typeof key === "number" ? key : lastKey;
    return lastKey;
  });
  const order = flat.map((_, k) => k).sort((x, y) => keys[x] - keys[y] || x - y);
  const timeline = order.map((k) => flat[k]);
  normalizeMappingTimes(timeline);

  // Consecutive chunks of one ayah make one appearance.
  const appearances: FlatItem[][] = [];
  for (const item of timeline) {
    const current = appearances[appearances.length - 1];
    if (current && current[0].verse === item.verse) current.push(item);
    else appearances.push([item]);
  }

  const startMs = appearances.map((items, i) => {
    if (i === 0) return 0;
    const first = items[0];
    if (typeof first.mapping.start_ms === "number") return first.mapping.start_ms;
    const prevItems = appearances[i - 1];
    const prevLast = prevItems[prevItems.length - 1].mapping;
    if (typeof prevLast.end_ms === "number") return prevLast.end_ms;
    const v = verses[first.verse];
    return first.span?.start ?? voicedSpan(v.words, 0, v.words.length - 1)?.start ?? v.words[0].start;
  });
  // Placed on whole frames cumulatively (not rounding each duration on its
  // own), so rounding never drifts the later ayahs; every time inside an
  // appearance is made relative to that exact frame, so QuranVideo's own
  // rounding lands each chunk on the frame nearest its true time.
  const startFrames: number[] = [];
  startMs.forEach((ms, i) => {
    const frame = Math.round((ms / 1000) * fps);
    startFrames.push(i === 0 ? 0 : Math.max(frame, startFrames[i - 1] + 1));
  });

  return appearances.map((items, i) => {
    const verseIndex = items[0].verse;
    const v = verses[verseIndex];
    const isLast = i === appearances.length - 1;
    const durationInFrames = isLast
      ? Math.max(1, totalFrames - startFrames[i])
      : startFrames[i + 1] - startFrames[i];
    const originMs = (startFrames[i] / fps) * 1000;
    const wordTimings = v.words.map((w) => ({ ...w, start: w.start - originMs, end: w.end - originMs }));
    const wordRepeats = v.repeats?.map((r) => ({ ...r, start: r.start - originMs, end: r.end - originMs }));
    // The last word stays current until the audio ends (any trailing
    // recitation the trim kept), as it always has.
    if (isLast) {
      const lastWord = wordTimings[wordTimings.length - 1];
      lastWord.end = Math.max(lastWord.end, (durationInFrames / fps) * 1000);
    }
    const shown = new Set(items.map((item) => item.index));
    const mappings = mappingsByVerse[verseIndex]?.map((m, j) => {
      const rel: M = { ...m };
      if (typeof m.start_ms === "number") rel.start_ms = m.start_ms - originMs;
      if (typeof m.end_ms === "number") rel.end_ms = m.end_ms - originMs;
      if (!shown.has(j)) rel.hidden = true;
      return rel;
    });
    return {
      verseIndex,
      durationInFrames,
      wordTimings,
      ...(wordRepeats?.length ? { wordRepeats } : {}),
      ...(mappings ? { mappings } : {}),
    };
  });
}

// Tokens of the Uthmani text that carry no letter: waqf signs (ۖ ۗ ۚ ۛ ...),
// the Sajdah sign ۩ and the Hizb sign ۞. Same test as the aligner's
// _is_mark_token (backend/scripts/quran_aligner.py).
export function isMarkToken(token: string): boolean {
  for (const ch of token) {
    if ((ch >= "ء" && ch <= "ي") || ch === "ٱ" || ch === "ـ") return false;
  }
  return true;
}

const HIZB_MARK = "۞";

// Moves part boundaries off the marks: a waqf/Sajdah sign belongs to the part
// before it (a part never opens on one), a Hizb sign ۞ to the part after it
// (a part never ends on one). `counts` are consecutive real-word counts over
// `tokens`; a boundary is only moved if both parts keep at least one word.
export function moveBoundariesOffMarks(counts: number[], tokens: string[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total !== tokens.length) return counts;
  const ends: number[] = [];
  counts.forEach((c, i) => ends.push((i === 0 ? 0 : ends[i - 1]) + c));
  for (let i = 0; i < ends.length - 1; i++) {
    const floor = (i === 0 ? 0 : ends[i - 1]) + 1;
    const ceil = ends[i + 1] - 1;
    let end = ends[i];
    while (end < ceil && isMarkToken(tokens[end]) && !tokens[end].includes(HIZB_MARK)) end++;
    while (end > floor && tokens[end - 1].includes(HIZB_MARK)) end--;
    ends[i] = end;
  }
  return ends.map((e, i) => e - (i === 0 ? 0 : ends[i - 1]));
}
