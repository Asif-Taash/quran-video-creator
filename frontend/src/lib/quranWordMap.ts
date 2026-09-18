import fs from "fs/promises";
import path from "path";

// Maps each ayah to (a) how many REAL Uthmani words it has — matching the
// same alquran.cloud `quran-uthmani` tokenization the backend's forced
// alignment (`extract_precise_clip.py`) indexes `wordTimings` by — and
// (b) how many QCF page-glyph tokens (from local quran.json's `text`
// field, split on whitespace) each of those real words renders as. The
// two counts diverge because QCF glyph tokens are page-justified render
// units, not real words (e.g. an ayah-end marker is its own glyph token).
// This is the single source of truth used to convert between
// "real word index" (what mappings/timings are indexed by) and "PUA glyph
// token index" (what verse.text/allWords is sliced by for display).
export type VerseWordMap = {
  realWordCount: number;
  puaTokenCounts: number[]; // length === realWordCount
};

type CacheShape = Record<string, VerseWordMap>;

const CACHE_PATH = path.join(process.cwd(), "src", "data", "quran-word-map-cache.json");

let memoryCache: CacheShape | null = null;

async function loadCache(): Promise<CacheShape> {
  if (memoryCache) return memoryCache;
  try {
    const raw = await fs.readFile(CACHE_PATH, "utf8");
    memoryCache = JSON.parse(raw);
  } catch {
    memoryCache = {};
  }
  return memoryCache!;
}

async function persistCache() {
  if (!memoryCache) return;
  try {
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
    await fs.writeFile(CACHE_PATH, JSON.stringify(memoryCache, null, 2));
  } catch (e) {
    console.warn("[quranWordMap] Failed to persist cache:", e);
  }
}

function cacheKey(surah: number, ayah: number): string {
  return `${surah}:${ayah}`;
}

// Fetches the actual real-word tokens (not just counts) for every ayah in a
// surah, from the exact same source/tokenization the backend uses to
// produce wordTimings (see extract_precise_clip.py::fetch_surah_texts).
// segmentation/auto/route.ts uses these words directly to build the AI's
// numbered prompt, so its word count is guaranteed — by construction, not
// by coincidence — to match what apply/route.ts validates against and what
// wordTimings.length will be at render time.
async function fetchRealWords(surah: number): Promise<Map<number, string[]>> {
  const res = await fetch(`http://api.alquran.cloud/v1/surah/${surah}/quran-uthmani`);
  if (!res.ok) throw new Error(`alquran.cloud request failed: ${res.status}`);
  const data = await res.json();
  const ayahs: any[] = data?.data?.ayahs || [];
  const map = new Map<number, string[]>();
  // NFC-normalize before comparing: alquran.cloud has been observed to return
  // the same Bismillah text with a different (but canonically equivalent)
  // combining-mark order across surahs, which makes a raw startsWith() on
  // the literal silently fail to strip it for some surahs' ayah 1.
  const bismillah = "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ ".normalize("NFC");
  for (const ayah of ayahs) {
    let text: string = (ayah.text as string).normalize("NFC");
    // Mirror the backend's Bismillah-stripping for ayah 1 of non-Fatiha surahs
    // so word counts here match what extract_precise_clip.py aligns against.
    if (ayah.numberInSurah === 1 && surah !== 1 && text.startsWith(bismillah)) {
      text = text.slice(bismillah.length);
    }
    map.set(ayah.numberInSurah, text.trim().split(/\s+/).filter(Boolean));
  }
  return map;
}

async function fetchRealWordCounts(surah: number): Promise<Map<number, number>> {
  const words = await fetchRealWords(surah);
  const map = new Map<number, number>();
  for (const [ayah, w] of words) map.set(ayah, w.length);
  return map;
}

/**
 * Real Uthmani word tokens for a single ayah — same tokenization
 * wordTimings/realWordCount use. Used to build AI segmentation prompts so
 * the count the AI is given can never drift from what apply/render expect.
 */
export async function getAyahRealWords(surah: number, ayah: number): Promise<string[]> {
  const words = await fetchRealWords(surah);
  return words.get(ayah) || [];
}

type ReconciledWordData = {
  puaTokenCounts: number[];
  glosses: string[]; // English word-by-word gloss, "" for waqf/sajda/hizb marks
};

let reconciledCache: Map<string, ReconciledWordData | null> | null = null;

// quran.com's per-word list doesn't line up 1:1 with alquran.cloud's
// whitespace-split uthmani text (what realWordCount/wordTimings/
// getAyahRealWords are indexed by): (a) it fuses a trailing waqf/pause/sajda
// mark into the SAME "word" entry as the preceding word (e.g. text_uthmani
// "رَيْبَ ۛ"), where alquran.cloud gives the mark its own separate token,
// and (b) it appends one extra "end" entry for the ayah-number marker,
// which alquran.cloud doesn't tokenize at all. This reconciles both the PUA
// glyph-token counts AND the English word-by-word gloss (used to ground the
// AI segmentation prompt) in a single pass/fetch, so both line up
// index-for-index with realWordCount.
async function fetchReconciledWordData(surah: number, ayah: number): Promise<ReconciledWordData | null> {
  if (!reconciledCache) reconciledCache = new Map();
  const key = cacheKey(surah, ayah);
  if (reconciledCache.has(key)) return reconciledCache.get(key)!;

  let result: ReconciledWordData | null;
  try {
    const res = await fetch(
      `https://api.quran.com/api/v4/verses/by_key/${surah}:${ayah}?words=true&word_fields=code_v2,text_uthmani,char_type_name`
    );
    if (!res.ok) {
      result = null;
    } else {
      const data = await res.json();
      const words: any[] = data?.verse?.words || [];
      if (words.length === 0) {
        result = null;
      } else {
        const puaTokenCounts: number[] = [];
        const glosses: string[] = [];

        for (const w of words) {
          const puaLen = w.code_v2 ? w.code_v2.length : 1;
          const gloss: string = (w.translation?.text || "").trim();

          if (w.char_type_name === "end") {
            // Ayah-number marker: fold its glyph token(s) into the preceding
            // real word instead of appending a new index slot. It has no
            // translatable meaning, so it never contributes a gloss.
            if (puaTokenCounts.length > 0) {
              puaTokenCounts[puaTokenCounts.length - 1] += puaLen;
            } else {
              puaTokenCounts.push(puaLen);
              glosses.push("");
            }
            continue;
          }

          const subParts: string[] = (w.text_uthmani || "").trim().split(/\s+/).filter(Boolean);
          const subCount = Math.max(1, subParts.length);
          if (subCount === 1) {
            puaTokenCounts.push(puaLen);
            glosses.push(gloss);
          } else if (puaLen >= subCount) {
            // A fused waqf/sajda mark has no meaning of its own — the whole
            // entry's gloss belongs to the real word (first sub-part), the
            // mark's own slot(s) get an empty gloss.
            const base = Math.floor(puaLen / subCount);
            const remainder = puaLen - base * subCount;
            for (let i = 0; i < subCount; i++) {
              puaTokenCounts.push(base + (i < remainder ? 1 : 0));
              glosses.push(i === 0 ? gloss : "");
            }
          } else {
            puaTokenCounts.push(puaLen);
            glosses.push(gloss);
            for (let i = 1; i < subCount; i++) {
              puaTokenCounts.push(0);
              glosses.push("");
            }
          }
        }
        result = { puaTokenCounts, glosses };
      }
    }
  } catch {
    result = null;
  }

  reconciledCache.set(key, result);
  return result;
}

async function fetchPuaTokenCounts(surah: number, ayah: number): Promise<number[] | null> {
  const data = await fetchReconciledWordData(surah, ayah);
  return data?.puaTokenCounts ?? null;
}

/**
 * English word-by-word gloss per real Uthmani word (same index/order as
 * getAyahRealWords) — the only free, reliable word-level translation data
 * available (quran.com has no Turkish word-by-word resource). Used as a
 * "bridge language" to ground the AI segmentation prompt in a concrete
 * meaning per word instead of relying on the model's raw Arabic reading.
 * Empty string for waqf/sajda/hizb mark positions (no meaning to gloss).
 */
export async function getAyahRealWordGlosses(surah: number, ayah: number, realWordCount: number): Promise<string[]> {
  const data = await fetchReconciledWordData(surah, ayah);
  if (!data || data.glosses.length !== realWordCount) return Array(realWordCount).fill("");
  return data.glosses;
}

function safeFallback(realWordCount: number, targetPuaTotal?: number): number[] {
  if (realWordCount <= 0) return [];
  if (!targetPuaTotal || targetPuaTotal <= 0) return Array(realWordCount).fill(1);
  // Distribute the known total PUA token count evenly across real words so
  // the sum still matches quran.json's actual token count for this verse.
  // Remainder tokens go to the LAST word(s), not the first -- they're
  // almost always the trailing waqf/ayah-number marker's extra glyph
  // token(s) (see fetchReconciledWordData's "end" handling above), so
  // biasing toward the front would misattribute them to an early word and
  // starve the actual last word/segment of its marker.
  const base = Math.floor(targetPuaTotal / realWordCount);
  const remainder = targetPuaTotal - base * realWordCount;
  return Array.from({ length: realWordCount }, (_, i) => base + (i >= realWordCount - remainder ? 1 : 0));
}

/**
 * Fetch (with on-disk caching) the real-word-count and per-real-word PUA
 * glyph token counts for a single ayah.
 */
export async function getVerseWordMap(
  surah: number,
  ayah: number,
  targetPuaTotal?: number
): Promise<VerseWordMap> {
  const cache = await loadCache();
  const key = cacheKey(surah, ayah);
  const cached = cache[key];
  if (cached) return cached;

  let realWordCount: number;
  try {
    const counts = await fetchRealWordCounts(surah);
    realWordCount = counts.get(ayah) ?? (targetPuaTotal || 1);
  } catch (e) {
    console.warn(`[quranWordMap] Failed to fetch real word count for ${surah}:${ayah}:`, e);
    realWordCount = targetPuaTotal || 1;
  }

  let puaTokenCounts = await fetchPuaTokenCounts(surah, ayah);
  if (!puaTokenCounts || puaTokenCounts.length !== realWordCount) {
    if (puaTokenCounts && puaTokenCounts.length !== realWordCount) {
      console.warn(
        `[quranWordMap] PUA word count (${puaTokenCounts.length}) mismatched real word count (${realWordCount}) for ${surah}:${ayah}; falling back to even distribution.`
      );
    }
    const puaSum = puaTokenCounts?.reduce((a, b) => a + b, 0) ?? targetPuaTotal;
    puaTokenCounts = safeFallback(realWordCount, puaSum);
  }

  const result: VerseWordMap = { realWordCount, puaTokenCounts };
  cache[key] = result;
  await persistCache();
  return result;
}

/**
 * Batch version: fetches real-word counts for a whole surah in one request
 * and per-verse PUA counts for just the requested ayahs, to avoid N+1
 * alquran.cloud calls when preparing/rendering a multi-verse range.
 */
export async function getSurahWordMap(
  surah: number,
  ayahs: number[],
  targetPuaTotals?: Record<number, number>
): Promise<Record<number, VerseWordMap>> {
  const cache = await loadCache();
  const result: Record<number, VerseWordMap> = {};
  const missing: number[] = [];

  for (const ayah of ayahs) {
    const cached = cache[cacheKey(surah, ayah)];
    if (cached) {
      result[ayah] = cached;
    } else {
      missing.push(ayah);
    }
  }

  if (missing.length === 0) return result;

  let realWordCounts = new Map<number, number>();
  try {
    realWordCounts = await fetchRealWordCounts(surah);
  } catch (e) {
    console.warn(`[quranWordMap] Failed to fetch real word counts for surah ${surah}:`, e);
  }

  await Promise.all(
    missing.map(async (ayah) => {
      const targetPuaTotal = targetPuaTotals?.[ayah];
      const realWordCount = realWordCounts.get(ayah) ?? targetPuaTotal ?? 1;
      let puaTokenCounts = await fetchPuaTokenCounts(surah, ayah);
      if (!puaTokenCounts || puaTokenCounts.length !== realWordCount) {
        const puaSum = puaTokenCounts?.reduce((a, b) => a + b, 0) ?? targetPuaTotal;
        puaTokenCounts = safeFallback(realWordCount, puaSum);
      }
      const entry: VerseWordMap = { realWordCount, puaTokenCounts };
      cache[cacheKey(surah, ayah)] = entry;
      result[ayah] = entry;
    })
  );

  await persistCache();
  return result;
}
