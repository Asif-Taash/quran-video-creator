// Bundles the Diyanet İşleri Meali (Yeni) and Süleyman Ateş Meali translations
// (Açık Kuran author ids 11 and 27) as static local JSON files, so the app no
// longer depends on api.acikkuran.com at runtime -- that subdomain has been
// down (DNS NXDOMAIN) since at least Aug 2026, see
// https://github.com/acik-kuran/acikkuran-api/issues/20. The main
// acikkuran.com site still serves the same verified text via per-surah
// Markdown pages, so we scrape those once here instead.
//
// Re-run with: node frontend/scripts/build-acikkuran-translations.mjs
// Output: frontend/src/data/translations/{diyanet_yeni,ahmet_varol}.json
// Each file is a flat { "surah:ayah": "text" } map, same shape the runtime
// code previously built from the live JSON API response.
//
// Verse-grouping prefix ("(2-4) ..." for a translation shared across several
// verses) is reformatted here at build time exactly like the old runtime
// formatVerseGroupPrefix() did, so the output needs no further processing.

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "src", "data", "translations");

const AUTHORS = {
  diyanet_yeni: "11",
  ahmet_varol: "27",
};

const TOTAL_SURAHS = 114;
const DELAY_MS = 120; // be polite to acikkuran.com's main site
const MAX_RETRIES = 4;

function formatVerseGroupPrefix(text) {
  return text.replace(/^\((\d+)-(\d+)\)\s*/, (match, start, end) => {
    const from = parseInt(start, 10);
    const to = parseInt(end, 10);
    if (Number.isNaN(from) || Number.isNaN(to) || to < from) return match;
    const numbers = [];
    for (let n = from; n <= to; n++) numbers.push(n);
    return `${numbers.join(",")}. `;
  });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchSurahMarkdown(surahId, authorRef) {
  const url = `https://acikkuran.com/${surahId}.md?author=${authorRef}`;
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; KuranNuru-build-script/1.0)" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastError = err;
      await sleep(500 * attempt);
    }
  }
  throw new Error(`Failed to fetch surah ${surahId} (author ${authorRef}) after ${MAX_RETRIES} attempts: ${lastError}`);
}

// Each verse block looks like:
//   ## 3. ayet
//   <blank>
//   <Arabic text>
//   <blank>
//   <transliteration>
//   <blank>
//   <translation, sometimes prefixed with "(a-b) ">
//   <blank>
//   _https://acikkuran.com/.../3-ayet-meali.md_
// For a few verses (Besmele as verse 1, disconnected letters like "Elif Lam
// Mim") there's no separate translation sentence -- the site repeats the
// transliteration once more instead. We don't special-case that: the last
// non-empty content line before the "_..._" footer is always the field the
// live JSON API used to expose as `translation.text`, whatever it contains.
function parseSurahMarkdown(markdown) {
  const map = {};
  const blockRe = /^## (\d+)\. ayet\r?\n([\s\S]*?)(?=^## \d+\. ayet|^---\r?\n|$(?![\s\S]))/gm;
  let match;
  while ((match = blockRe.exec(markdown)) !== null) {
    const verseNumber = parseInt(match[1], 10);
    const body = match[2];
    const lines = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("_http"));
    if (lines.length === 0) continue;
    const translationLine = lines[lines.length - 1];
    map[verseNumber] = formatVerseGroupPrefix(translationLine);
  }
  return map;
}

async function buildTranslation(id, authorRef) {
  console.log(`\n=== ${id} (author=${authorRef}) ===`);
  const result = {};
  for (let surahId = 1; surahId <= TOTAL_SURAHS; surahId++) {
    const markdown = await fetchSurahMarkdown(surahId, authorRef);
    const verseMap = parseSurahMarkdown(markdown);
    const verseCount = Object.keys(verseMap).length;
    if (verseCount === 0) {
      throw new Error(`Surah ${surahId}: parsed 0 verses -- markdown format probably changed, aborting`);
    }
    for (const [verseNumber, text] of Object.entries(verseMap)) {
      result[`${surahId}:${verseNumber}`] = text;
    }
    process.stdout.write(`  surah ${surahId}/${TOTAL_SURAHS}: ${verseCount} verses\r`);
    await sleep(DELAY_MS);
  }
  console.log(`\n  total verses: ${Object.keys(result).length}`);
  return result;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  for (const [id, authorRef] of Object.entries(AUTHORS)) {
    const data = await buildTranslation(id, authorRef);
    const outPath = path.join(OUT_DIR, `${id}.json`);
    await writeFile(outPath, JSON.stringify(data, null, 0), "utf-8");
    console.log(`  wrote ${outPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
