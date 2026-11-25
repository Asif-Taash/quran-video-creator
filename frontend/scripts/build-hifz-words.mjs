// Builds src/data/hifz-words.json: every word of the Quran as the
// memorization page (/hifz) needs it, one entry per word in mushaf order.
//
// Source: Quran.com's v4 API (verses by chapter, words=true), 114 requests.
// Per word:
// - code_v2: its glyph(s) in the KFGQPC QCF v2 page fonts (public/fonts/2013,
//   the same codes and fonts as src/data/quran.json and the video). A word
//   followed by a pause mark (رَيْبَ ۛ) is ONE entry whose code has two
//   glyphs, so the mark stays with its word when the word is hidden.
// - text_uthmani: the word in Unicode (its first letter is the hint shown
//   on a hidden word).
// - text_imlaei: the word in plain spelling -- what the recitation check
//   compares the reciter's heard words with (backend/scripts/hifz_check.py):
//   Whisper writes "الكتاب", not the Uthmani "ٱلْكِتَـٰبُ".
// - page_number, line_number: where it sits in the 15-line Madinah mushaf,
//   so the page draws its lines exactly as printed.
// The ayah-number glyph (char_type "end") is kept apart as the verse's "e".
//
// Re-run with (as the host user, so the output isn't root-owned):
//   docker compose exec -u 1000:1000 frontend node scripts/build-hifz-words.mjs
// Output (git-ignored like quran.json -- QCF glyph codes):
//   { "verses": { "2:2": { "w": [[code, uthmani, imlaei, page, line], ...],
//                          "e": [code, page, line] } } }
// Checked against quran.json: each verse's glyphs must be the same codes
// in the same order, or the script stops without writing anything.

import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "..", "src", "data");
const OUT_FILE = path.join(DATA, "hifz-words.json");
const FIELDS = "code_v2,text_uthmani,text_imlaei,page_number,line_number,char_type_name";

async function fetchChapter(chapter) {
  const url = `https://api.quran.com/api/v4/verses/by_chapter/${chapter}?words=true&word_fields=${FIELDS}&per_page=300&page=1`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.pagination?.next_page) throw new Error("more than one page of verses");
      return data.verses;
    } catch (err) {
      if (attempt >= 4) throw new Error(`chapter ${chapter}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

const quran = JSON.parse(await readFile(path.join(DATA, "quran.json"), "utf8"));
const verses = {};
let words = 0;
for (const surah of quran) {
  const fetched = await fetchChapter(surah.id);
  if (fetched.length !== surah.verses.length) {
    throw new Error(`surah ${surah.id}: ${fetched.length} verses from Quran.com, ${surah.verses.length} in quran.json`);
  }
  for (const verse of fetched) {
    const [s, a] = verse.verse_key.split(":").map(Number);
    const entry = { w: [], e: null };
    for (const w of verse.words) {
      const code = (w.code_v2 || "").replace(/\s/g, "");
      if (w.char_type_name === "end") {
        entry.e = [code, w.page_number, w.line_number];
      } else {
        entry.w.push([code, (w.text_uthmani || "").trim(), (w.text_imlaei || "").trim(), w.page_number, w.line_number]);
      }
    }
    const local = surah.verses[a - 1].text.replace(/\s/g, "");
    const remote = entry.w.map((w) => w[0]).join("") + (entry.e?.[0] ?? "");
    if (local !== remote) throw new Error(`${s}:${a}: glyph codes differ from quran.json`);
    words += entry.w.length;
    verses[verse.verse_key] = entry;
  }
  process.stdout.write(`\r${surah.id}/114`);
}

const tmp = `${OUT_FILE}.tmp`;
await writeFile(tmp, JSON.stringify({ source: "api.quran.com v4", verses }));
await rename(tmp, OUT_FILE);
console.log(`\n${Object.keys(verses).length} verses, ${words} words -> ${path.relative(process.cwd(), OUT_FILE)}`);
