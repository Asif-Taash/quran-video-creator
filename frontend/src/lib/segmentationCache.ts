import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

// Persists AI auto-segmentation results that reached consensus (see
// segmentation/auto/route.ts), keyed by surah + ayah + a hash of the exact
// translation text used. The Quran's Arabic text and any given translation's
// wording never change, so a verified split for a given (surah, ayah,
// translation) combination is valid forever -- caching it means every
// FUTURE request for that ayah (from any user) skips the free/unreliable
// g4f AI call entirely and returns an already-proven-correct result
// instantly. Low-confidence fallback results are deliberately never cached
// here (see auto/route.ts) so a future request still gets a fresh chance at
// AI consensus instead of being permanently stuck with a guess.

export type CachedMapping = {
  part: number;
  translation_text: string;
  word_count: number;
};

type CacheShape = Record<string, CachedMapping[]>;

const CACHE_PATH = path.join(process.cwd(), "src", "data", "quran-segmentation-cache.json");

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
    console.warn("[segmentationCache] Failed to persist cache:", e);
  }
}

function translationHash(translation: string): string {
  return crypto.createHash("sha1").update(translation.trim()).digest("hex").slice(0, 16);
}

function cacheKey(surah: number, ayah: number, translation: string): string {
  return `${surah}:${ayah}:${translationHash(translation)}`;
}

export async function getCachedSegmentation(
  surah: number,
  ayah: number,
  translation: string
): Promise<CachedMapping[] | null> {
  const cache = await loadCache();
  return cache[cacheKey(surah, ayah, translation)] || null;
}

export async function setCachedSegmentation(
  surah: number,
  ayah: number,
  translation: string,
  mappings: CachedMapping[]
): Promise<void> {
  const cache = await loadCache();
  cache[cacheKey(surah, ayah, translation)] = mappings;
  await persistCache();
}
