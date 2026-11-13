// Bundles the Diyanet Vakfı Meali (Türkiye Diyanet Vakfı; Halil Altuntaş and
// Muzaffer Şahin) as a static local JSON file, like the acikkuran ones.
//
// Source: Quran.com's v4 API, translation 124, listed there as "Muslim
// Shahin" (Muzaffer Şahin). It is the same translation as tanzil's
// "tr.vakfi" (median similarity 0.99 over all 6236 verses), in a newer and
// cleaner revision: tanzil's copy merges 10 verse pairs into one shared
// text and carries passages from other translators (e.g. 85:5, 109:3),
// while Quran.com's has one text per verse. Checked 2026-11-13.
//
// Chosen because it reads like the Diyanet İşleri Meali (Yeni) -- same
// institution, often word-for-word the same phrasing -- but translates each
// verse on its own, where Diyanet Yeni shares one sentence across several
// verses (44:2-3, 44:4-7), which can't be shown verse by verse in a video.
//
// Re-run with (as the host user, so the output isn't root-owned):
//   docker compose exec -u 1000:1000 frontend node scripts/build-diyanet-vakfi-translation.mjs
// Output: src/data/translations/diyanet_vakfi.json, a flat
// { "surah:ayah": "text" } map like the other bundled translations.
//
// Cleanup, wording untouched:
// - Quran.com's text has stray spacing: no-break and em spaces, line
//   breaks, "De ki :", "( yazılıp )". Normalized.
// - 289 verses that continue the previous verse's sentence start in
//   lowercase ("biz onu ..."), which looks wrong when a video shows the
//   verse on its own. The first letter is capitalized (Turkish rules, so
//   i -> İ), as in the other bundled translations.

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(__dirname, "..", "src", "data", "translations", "diyanet_vakfi.json");
const SOURCE_URL = "https://api.quran.com/api/v4/quran/translations/124?fields=verse_key";
const TOTAL_VERSES = 6236;

function clean(text) {
  let out = text
    .replace(/<[^>]+>/g, "") // footnote markup, if Quran.com ever adds any
    .replace(/[\s  ]+/g, " ")
    .replace(/\s+([.,;:!?»)…])/g, "$1")
    .replace(/([(«])\s+/g, "$1")
    .trim();
  if (/^\p{Ll}/u.test(out)) out = out[0].toLocaleUpperCase("tr") + out.slice(1);
  return out;
}

const res = await fetch(SOURCE_URL);
if (!res.ok) throw new Error(`Quran.com answered ${res.status}`);
const { translations } = await res.json();

const map = {};
for (const { verse_key: key, text } of translations) {
  if (!/^\d+:\d+$/.test(key)) throw new Error(`Unexpected verse key ${key}`);
  const cleaned = clean(text);
  if (!cleaned) throw new Error(`Empty translation for ${key}`);
  map[key] = cleaned;
}
if (Object.keys(map).length !== TOTAL_VERSES) {
  throw new Error(`Expected ${TOTAL_VERSES} verses, got ${Object.keys(map).length}`);
}

await mkdir(path.dirname(OUT_FILE), { recursive: true });
await writeFile(OUT_FILE, JSON.stringify(map, null, 2) + "\n");
console.log(`Wrote ${Object.keys(map).length} verses to ${OUT_FILE}`);
