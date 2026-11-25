import fs from "fs";
import path from "path";

// The words of the Quran for the memorization page (/hifz), from
// src/data/hifz-words.json (scripts/build-hifz-words.mjs): per word its QCF
// v2 glyph code, Uthmani text, plain (imla'i) spelling, mushaf page and
// line. Server-only (fs); read once per server process.

type RawWord = [code: string, uthmani: string, imlaei: string, page: number, line: number];
type RawVerse = { w: RawWord[]; e: [code: string, page: number, line: number] | null };

export interface HifzWord {
  // Glyph code in the page font p{page}, the Uthmani text, the plain
  // spelling the recitation check compares with.
  g: string;
  u: string;
  t: string;
  p: number;
  l: number;
}

export interface HifzVerse {
  // Surah (a mushaf page can hold the end of one and the start of the next).
  s: number;
  n: number;
  words: HifzWord[];
  // The ayah-number rosette.
  end: { g: string; p: number; l: number } | null;
}

let verses: Record<string, RawVerse> | null = null;
// "page:line" -> how many glyph units the printed line holds (words and
// ayah numbers), to tell a full line (justified edge to edge, as printed)
// from one the chosen range only partly covers.
let lineSizes: Map<string, number> | null = null;

function load() {
  if (!verses) {
    const file = path.join(process.cwd(), "src", "data", "hifz-words.json");
    verses = (JSON.parse(fs.readFileSync(file, "utf-8")) as { verses: Record<string, RawVerse> }).verses;
    lineSizes = new Map();
    for (const v of Object.values(verses)) {
      for (const w of v.w) {
        const key = `${w[3]}:${w[4]}`;
        lineSizes.set(key, (lineSizes.get(key) ?? 0) + 1);
      }
      if (v.e) {
        const key = `${v.e[1]}:${v.e[2]}`;
        lineSizes.set(key, (lineSizes.get(key) ?? 0) + 1);
      }
    }
  }
  return { verses: verses!, lineSizes: lineSizes! };
}

export function hifzAvailable(): boolean {
  return fs.existsSync(path.join(process.cwd(), "src", "data", "hifz-words.json"));
}

/** Ayahs from..to of a surah, and the size of every printed line they touch. */
export function hifzRange(surah: number, from: number, to: number): { verses: HifzVerse[]; lines: Record<string, number> } {
  const data = load();
  const out: HifzVerse[] = [];
  const lines: Record<string, number> = {};
  for (let n = from; n <= to; n++) {
    const raw = data.verses[`${surah}:${n}`];
    if (!raw) break;
    const verse: HifzVerse = {
      s: surah,
      n,
      words: raw.w.map(([g, u, t, p, l]) => ({ g, u, t, p, l })),
      end: raw.e ? { g: raw.e[0], p: raw.e[1], l: raw.e[2] } : null,
    };
    for (const w of verse.words) lines[`${w.p}:${w.l}`] = data.lineSizes.get(`${w.p}:${w.l}`) ?? 0;
    if (verse.end) lines[`${verse.end.p}:${verse.end.l}`] = data.lineSizes.get(`${verse.end.p}:${verse.end.l}`) ?? 0;
    out.push(verse);
  }
  return { verses: out, lines };
}

/** Whole mushaf pages (2026-11-24, the user: a passage's own lines alone
 *  left a word by itself on a line): every ayah, of any surah, printed on
 *  the pages from the one surah:from starts on to the one surah:to ends on,
 *  in reading order. */
export function hifzPages(surah: number, from: number, to: number): { verses: HifzVerse[]; lines: Record<string, number>; pages: number[] } {
  const data = load();
  const first = data.verses[`${surah}:${from}`];
  const last = data.verses[`${surah}:${to}`];
  if (!first || !last) return { verses: [], lines: {}, pages: [] };
  const p1 = first.w[0]?.[3] ?? first.e?.[1] ?? 1;
  const p2 = last.e?.[1] ?? last.w[last.w.length - 1]?.[3] ?? p1;
  const out: HifzVerse[] = [];
  const lines: Record<string, number> = {};
  for (const [key, raw] of Object.entries(data.verses)) {
    const pages = raw.w.map((w) => w[3]);
    if (raw.e) pages.push(raw.e[1]);
    if (!pages.some((p) => p >= p1 && p <= p2)) {
      if (out.length) break; // past the last page (the file is in mushaf order)
      continue;
    }
    const [s, n] = key.split(":").map(Number);
    const verse: HifzVerse = {
      s,
      n,
      words: raw.w.map(([g, u, t, p, l]) => ({ g, u, t, p, l })),
      end: raw.e ? { g: raw.e[0], p: raw.e[1], l: raw.e[2] } : null,
    };
    for (const w of verse.words) lines[`${w.p}:${w.l}`] = data.lineSizes.get(`${w.p}:${w.l}`) ?? 0;
    if (verse.end) lines[`${verse.end.p}:${verse.end.l}`] = data.lineSizes.get(`${verse.end.p}:${verse.end.l}`) ?? 0;
    out.push(verse);
  }
  const pages: number[] = [];
  for (let p = p1; p <= p2; p++) pages.push(p);
  return { verses: out, lines, pages };
}

/** How far one recitation from surah:from can go: to the surah's end, or
 *  as many ayahs as fit in maxWords (the check's limit). */
export function hifzSessionEnd(surah: number, from: number, maxWords: number): number {
  const data = load();
  let words = 0;
  let n = from;
  for (;;) {
    const raw = data.verses[`${surah}:${n}`];
    if (!raw) return Math.max(from, n - 1);
    words += raw.w.length;
    if (words > maxWords) return Math.max(from, n - 1);
    n++;
  }
}

/** The words the recitation check expects, in reading order, as the mushaf
 *  shows them (Uthmani): the Quran ear's judge phonetizes the ayahs itself. */
export function hifzExpected(surah: number, from: number, to: number): { a: number; i: number; u: string }[] {
  const data = load();
  const out: { a: number; i: number; u: string }[] = [];
  for (let n = from; n <= to; n++) {
    const raw = data.verses[`${surah}:${n}`];
    if (!raw) break;
    raw.w.forEach((w, i) => out.push({ a: n, i, u: w[1] }));
  }
  return out;
}
