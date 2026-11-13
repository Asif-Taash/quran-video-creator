// What the video shows while the reciter repeats, against the truth of
// backend/scripts/eval_reading_path.py (--json): for every frame in which a
// word is being recited, is the text on screen the part that holds it, and
// is the highlighted word that word? Runs the real readingPath/timing code
// and mirrors QuranVideo.tsx's chunk and highlight windows (text lead, fades
// and glyph mapping left out). In the frontend container:
//
//   docker cp <backend>:/tmp/eval.json /tmp/eval.json   (via the host)
//   node_modules/.bin/esbuild scripts/check-reading-display.ts --bundle --platform=node --outfile=/tmp/check.js
//   node /tmp/check.js /tmp/eval.json [surah] ['{"2":[3,3]}' = split ayah 2 into 3+3 tokens]
//
// NOAPPLY=1 skips applyReadings (what the screen did before readings were
// re-applied after "clear split").
import * as fs from "fs";
import { applyReadings } from "../src/lib/readingPath";
import { buildVerseTimeline, holdWordsThroughRepeats, repeatWordWindows, voicedSpan } from "../src/remotion/timing";

const FPS = 30;
const HOLD_FRAMES = 9; // QuranVideo's WORD_HIGHLIGHT_HOLD_FRAMES

const [, , file, surahArg, splitsArg] = process.argv;
const cases = JSON.parse(fs.readFileSync(file, "utf8"));
const splits: Record<string, number[]> = splitsArg ? JSON.parse(splitsArg) : {};
let worst = 0;

for (const [name, c] of Object.entries<any>(cases)) {
  const surah = Number(surahArg ?? name.match(/\d+/)?.[0]);
  const ayahIds = Object.keys(c.verses).map(Number).sort((a, b) => a - b);
  const ayahs = ayahIds.map((id) => ({ id, translation: `T${id}`, tokens: c.verses[id].words.map((w: any) => w.w) }));
  let seg: any[] = [];
  for (const id of ayahIds) {
    const counts = splits[String(id)];
    if (counts) seg.push({ surah, ayah: id, mappings: counts.map((n, k) => ({ part: k + 1, word_count: n, translation_text: "" })) });
  }
  if (!process.env.NOAPPLY) seg = applyReadings(seg, c.readings ?? undefined, ayahs, surah);
  const held = holdWordsThroughRepeats(ayahIds.map((id) => ({ id, words: c.verses[id].words })), c.readings ?? undefined);
  const repeats = repeatWordWindows(ayahIds, c.readings ?? undefined);
  const totalFrames = Math.ceil((c.durationMs / 1000) * FPS);
  const timeline = buildVerseTimeline(
    ayahIds.map((id) => ({ id, words: held.get(id)!, mappings: seg.find((s) => s.ayah === id)?.mappings, repeats: repeats.get(id) })),
    { trimStartMs: 0, fps: FPS, totalFrames }
  );
  if (!timeline) {
    console.log(`${name}: no timeline`);
    continue;
  }

  // Per frame: the chunks on screen, and the highlighted word.
  const shown: { ayah: number; from: number; to: number }[][] = Array.from({ length: totalFrames }, () => []);
  const lit: (string | null)[] = Array(totalFrames).fill(null);
  let seqStart = 0;
  for (const app of timeline) {
    const ayah = ayahIds[app.verseIndex];
    const words = app.wordTimings;
    const mappings: any[] = app.mappings ?? [{ part: 1, word_count: words.length }];
    const real = (m: any) => (typeof m.repeat_of_part === "number" ? 0 : m.word_count);
    const window = (i: number) => {
      const m = mappings[i];
      const prev = mappings.slice(0, i).reduce((s, x) => s + real(x), 0);
      const isRepeat = typeof m.repeat_of_part === "number";
      let from = prev;
      let to = prev + m.word_count - 1;
      let startMs: number | undefined;
      let endMs: number | undefined;
      if (isRepeat) {
        const si = mappings.findIndex((x) => x.part === m.repeat_of_part);
        from = mappings.slice(0, si).reduce((s, x) => s + real(x), 0);
        to = from + mappings[si].word_count - 1;
      } else {
        const span = voicedSpan(words, from, to);
        startMs = span?.start;
        endMs = span?.end;
      }
      if (typeof m.start_ms === "number") startMs = m.start_ms;
      if (typeof m.end_ms === "number") endMs = m.end_ms;
      return { s: Math.round(((startMs ?? 0) / 1000) * FPS), e: Math.round(((endMs ?? 0) / 1000) * FPS), from, to };
    };
    const d = app.durationInFrames;
    const isLastAppearance = app === timeline[timeline.length - 1];
    mappings.forEach((m, i) => {
      if (m.hidden) return;
      const w = window(i);
      // As QuranVideo: on screen until the next chunk on screen starts (of
      // this ayah, or the next appearance at d); the very last one until
      // its last word ends.
      const nextShown = mappings.findIndex((x, j) => j > i && !x.hidden);
      const end =
        nextShown >= 0
          ? Math.min(Math.max(w.s + 1, window(nextShown).s), d)
          : isLastAppearance
            ? Math.min(w.e, d)
            : Math.max(w.s + 1, d);
      // Highlight windows of the shown words: first readings + repeats.
      const hw = [
        ...words.map((x: any, k: number) => ({ k, start: x.start, end: x.end })).filter((x) => x.k >= w.from && x.k <= w.to && x.end > x.start),
        ...(app.wordRepeats ?? []).filter((r) => r.i >= w.from && r.i <= w.to).map((r) => ({ k: r.i, start: r.start, end: r.end })),
      ]
        .map((x) => ({ k: x.k, s: Math.round((x.start / 1000) * FPS), e: Math.round((x.end / 1000) * FPS) }))
        .sort((a, b) => a.s - b.s);
      for (let f = Math.max(0, w.s); f < end && seqStart + f < totalFrames; f++) {
        shown[seqStart + f].push({ ayah, from: w.from, to: w.to });
        for (let j = hw.length - 1; j >= 0; j--) {
          if (hw[j].s > f) continue;
          const until = Math.min(j + 1 < hw.length ? hw[j + 1].s : Infinity, hw[j].e + HOLD_FRAMES);
          if (f < until) lit[seqStart + f] = `${ayah}:${hw[j].k}`;
          break;
        }
      }
    });
    seqStart += d;
  }

  let voiced = 0;
  let wrongText = 0;
  let wrongLit = 0;
  const spans: string[] = [];
  let cur: { from: number; to: number; heard: string; saw: string } | null = null;
  const flush = () => {
    if (cur) spans.push(`${(cur.from / FPS).toFixed(1)}-${((cur.to + 1) / FPS).toFixed(1)}s heard ${cur.heard} | screen: ${cur.saw}`);
    cur = null;
  };
  for (let f = 0; f < totalFrames; f++) {
    const ms = (f / FPS) * 1000;
    const t = c.truth.find(([, , s, e]: number[]) => ms >= s && ms < e);
    if (!t) {
      flush();
      continue;
    }
    voiced++;
    const [a, i] = t;
    if (lit[f] !== null && lit[f] !== `${a}:${i}`) wrongLit++;
    if (shown[f].some((r) => r.ayah === a && i >= r.from && i <= r.to)) {
      flush();
      continue;
    }
    wrongText++;
    const heard = `${a}:${i}`;
    const saw = shown[f].map((r) => `${r.ayah}:${r.from}-${r.to}`).join(",") || "nothing";
    if (cur && cur.saw === saw && f === cur.to + 1) {
      cur.to = f;
      if (!cur.heard.endsWith(heard)) cur.heard += " " + heard;
    } else {
      flush();
      cur = { from: f, to: f, heard, saw };
    }
  }
  flush();
  const pct = (100 * wrongText) / Math.max(1, voiced);
  worst = Math.max(worst, pct);
  console.log(`${name}: text wrong ${pct.toFixed(1)}%, highlight wrong ${((100 * wrongLit) / Math.max(1, voiced)).toFixed(1)}% of recited time`);
  for (const s of spans) console.log("    " + s);
}
console.log(`worst: ${worst.toFixed(1)}%`);
