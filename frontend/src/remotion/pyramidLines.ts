// Line breaking for the Arabic verse and the translation (see
// formatArabicVerse/formatInvertedPyramid in QuranVideo.tsx), by measured
// token widths. The look it aims for: no line wider than the line above it
// (a descending "pyramid"); lines of equal width are fine.
//
// Common path: fill each line, left to right, with as many tokens as fit
// under ONE shared width cap -- ordinary CSS-style wrapping. That keeps
// narrowing the box gradual (VideoPreviewPlayer's width handles move one
// word at a time), and for ordinary text it already satisfies the rule.
//
// Repair path, only when that fill breaks the rule (a later line wider) or
// gives fewer lines than `minLines`: search every way to cut the text into
// a given number of lines and take the most even one that keeps the rule,
// trying up to MAX_EXTRA_PYRAMID_LINES more lines than the plain fill
// needs. In a narrow box the rule is often impossible however the text is
// cut (one long word late in the sentence is enough), and then the most
// even cut with the plain fill's line count wins, bending the rule as
// little as possible. The previous repair capped every line at the actual
// width of the line before it: one short line made every later line just
// as short, collapsing the text into one word per line -- 13.7% of all
// ayah/width combinations measured over the whole Quran.

const MAX_EXTRA_PYRAMID_LINES = 2;
// Measured widths are floats; differences below this are equal widths.
const WIDTH_EPSILON_PX = 0.5;

// The repair search can take tens of milliseconds for a long ayah in a
// narrow box, and this runs on every frame of the preview and the export,
// so its results are kept: they depend only on the arguments.
const repairCache = new Map<string, string[]>();
const REPAIR_CACHE_LIMIT = 500;


export function buildPyramidLines(
  tokens: string[],
  widths: number[],
  spaceWidth: number,
  maxLineWidthPx: number,
  // Charged against the FIRST line only -- the ayah-number prefix ("26. ")
  // rendered inline before a translation's first line.
  firstLineExtraWidthPx: number,
  minLines: number
): string[] {
  if (tokens.length === 0) return [""];
  const n = tokens.length;

  const prefixSums = [0];
  for (let i = 0; i < n; i++) prefixSums.push(prefixSums[i] + widths[i]);
  const lineWidth = (start: number, end: number) =>
    prefixSums[end] - prefixSums[start] + spaceWidth * (end - start - 1) + (start === 0 ? firstLineExtraWidthPx : 0);
  const toLines = (ends: number[]) => ends.map((end, i) => tokens.slice(i === 0 ? 0 : ends[i - 1], end).join(" "));

  // Line ends of the plain fill. Every line takes at least one token, even
  // one too wide for the box on its own.
  const flatEnds: number[] = [];
  for (let start = 0; start < n; ) {
    let end = start + 1;
    while (end < n && lineWidth(start, end + 1) <= maxLineWidthPx) end++;
    flatEnds.push(end);
    start = end;
  }

  const target = Math.min(Math.max(minLines, 1), n);
  const keepsRule = (ends: number[]) => {
    let previous = Infinity;
    for (let i = 0; i < ends.length; i++) {
      const w = lineWidth(i === 0 ? 0 : ends[i - 1], ends[i]);
      if (w > maxLineWidthPx || w > previous) return false;
      previous = w;
    }
    return true;
  };
  if (flatEnds.length >= target && keepsRule(flatEnds)) return toLines(flatEnds);

  const cacheKey = [tokens.join("\u0001"), widths.join(","), spaceWidth, maxLineWidthPx, firstLineExtraWidthPx, target].join("\u0002");
  const cached = repairCache.get(cacheKey);
  if (cached) return cached;

  // Most tokens one line can hold: the previous line can only start that
  // far back, which keeps the search tables below small (they're indexed by
  // that distance, not by the previous start itself).
  let maxPerLine = 1;
  for (let start = 0, end = 1; start < n; start++) {
    if (end <= start) end = start + 1;
    while (end < n && lineWidth(start, end + 1) <= maxLineWidthPx) end++;
    maxPerLine = Math.max(maxPerLine, end - start);
  }
  const backOffset = (start: number, prevStart: number) => (prevStart < 0 ? 0 : start - prevStart);

  // The best cut into exactly `lineCount` lines, each within the box (a
  // lone token too wide for it can't be helped). With `strict`, no line may
  // be wider than the one above it. Ranked by the total widening between
  // consecutive lines (always 0 when strict), then by the widest line --
  // the most even cut. A lone over-wide token counts as box-wide.
  function bestCut(lineCount: number, strict: boolean): number[] | null {
    if (lineCount > n) return null;
    const size = (n + 1) * (maxPerLine + 1) * (lineCount + 1);
    const state = new Uint8Array(size); // 0 not searched yet, 1 no cut, 2 solved
    const widening = new Float64Array(size);
    const widest = new Float64Array(size);
    const next = new Int32Array(size);
    const at = (start: number, prevStart: number, left: number) =>
      (start * (maxPerLine + 1) + backOffset(start, prevStart)) * (lineCount + 1) + left;

    const solve = (start: number, prevStart: number, left: number): boolean => {
      const here = at(start, prevStart, left);
      if (state[here] !== 0) return state[here] === 2;
      const previousWidth = prevStart < 0 ? Infinity : Math.min(lineWidth(prevStart, start), maxLineWidthPx);
      let found = false;
      for (let end = start + 1; end <= n - (left - 1); end++) {
        const raw = lineWidth(start, end);
        if (raw > maxLineWidthPx && end > start + 1) break;
        const w = Math.min(raw, maxLineWidthPx);
        // Lines only get wider as they take more tokens.
        if (strict && w > previousWidth + WIDTH_EPSILON_PX) break;
        let restWidening = 0;
        let restWidest = 0;
        if (end < n) {
          if (left === 1 || !solve(end, start, left - 1)) continue;
          const rest = at(end, start, left - 1);
          restWidening = widening[rest];
          restWidest = widest[rest];
        } else if (left !== 1) {
          continue;
        }
        const totalWidening = restWidening + (prevStart < 0 ? 0 : Math.max(0, w - previousWidth));
        const top = Math.max(w, restWidest);
        if (
          !found ||
          totalWidening < widening[here] - WIDTH_EPSILON_PX ||
          (totalWidening <= widening[here] + WIDTH_EPSILON_PX && top < widest[here] - WIDTH_EPSILON_PX)
        ) {
          widening[here] = totalWidening;
          widest[here] = top;
          next[here] = end;
          found = true;
        }
      }
      state[here] = found ? 2 : 1;
      return found;
    };

    if (!solve(0, -1, lineCount)) return null;
    const ends: number[] = [];
    for (let start = 0, prevStart = -1, left = lineCount; start < n; left--) {
      const end = next[at(start, prevStart, left)];
      ends.push(end);
      prevStart = start;
      start = end;
    }
    return ends;
  }

  // The fewest lines that keep the rule, the most even cut among those --
  // one search, where bestCut would need one per line count.
  function fewestStrictCut(): number[] | null {
    const size = (n + 1) * (maxPerLine + 1);
    const state = new Uint8Array(size); // 0 not searched yet, 1 no cut, 2 solved
    const count = new Int32Array(size);
    const widest = new Float64Array(size);
    const next = new Int32Array(size);
    const at = (start: number, prevStart: number) => start * (maxPerLine + 1) + backOffset(start, prevStart);

    const solve = (start: number, prevStart: number): boolean => {
      const here = at(start, prevStart);
      if (state[here] !== 0) return state[here] === 2;
      const previousWidth = prevStart < 0 ? Infinity : Math.min(lineWidth(prevStart, start), maxLineWidthPx);
      let found = false;
      for (let end = start + 1; end <= n; end++) {
        const raw = lineWidth(start, end);
        if (raw > maxLineWidthPx && end > start + 1) break;
        const w = Math.min(raw, maxLineWidthPx);
        if (w > previousWidth + WIDTH_EPSILON_PX) break;
        let restCount = 0;
        let restWidest = 0;
        if (end < n) {
          if (!solve(end, start)) continue;
          const rest = at(end, start);
          restCount = count[rest];
          restWidest = widest[rest];
        }
        const lines = restCount + 1;
        const top = Math.max(w, restWidest);
        if (!found || lines < count[here] || (lines === count[here] && top < widest[here] - WIDTH_EPSILON_PX)) {
          count[here] = lines;
          widest[here] = top;
          next[here] = end;
          found = true;
        }
      }
      state[here] = found ? 2 : 1;
      return found;
    };

    if (!solve(0, -1)) return null;
    const ends: number[] = [];
    for (let start = 0, prevStart = -1; start < n; ) {
      const end = next[at(start, prevStart)];
      ends.push(end);
      prevStart = start;
      start = end;
    }
    return ends;
  }

  // The plain fill's line count is the fewest that fit the box at all.
  const fewest = Math.min(n, Math.max(target, flatEnds.length));
  const mostLines = Math.min(n, fewest + MAX_EXTRA_PYRAMID_LINES);
  const strict = fewestStrictCut();
  let ends: number[] | null = null;
  if (strict && strict.length >= target) {
    if (strict.length <= mostLines) ends = strict;
  } else if (strict) {
    // Fits on fewer lines than `minLines` asks for (short text kept off a
    // single line): the most even cut into exactly that many -- unless that
    // many can't keep the rule, which outranks the line count.
    for (let lineCount = fewest; !ends && lineCount <= mostLines; lineCount++) ends = bestCut(lineCount, true);
    ends ??= strict;
  }
  const lines = toLines(ends ?? bestCut(fewest, false) ?? flatEnds);
  if (repairCache.size >= REPAIR_CACHE_LIMIT) repairCache.clear();
  repairCache.set(cacheKey, lines);
  return lines;
}
