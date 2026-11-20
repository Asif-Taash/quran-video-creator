import { NextResponse } from "next/server";
import { getAyahRealWords } from "@/lib/quranWordMap";
import type { TranslationLanguage } from "@/lib/translationOptions";

export const runtime = "nodejs";
export const maxDuration = 120;

// Another translation picked for an ayah already split into parts: its text
// cut into one piece per part, the parts themselves unchanged (the backend's
// split_translation, scripts/segment_align.py). Before, only the first part
// took the new translation -- the whole of it -- and the other parts kept
// the old one's pieces (the user, 2026-11-16).
//
// Body: { surah, ayah, translation, wordCounts, language } -- wordCounts is
// each part's word count (pause marks included), in order, repeats left out.
// Answer: { pieces, lowConfidence, fallback? }.

const SENTENCE_END = /[.!?؟…]["'“”‘’»)\]]*$/;
const CLAUSE_END = /[,;:،؛]["'“”‘’»)\]]*$/;

// The backend can't run: cut where each part's share of the words says,
// moved to the nearest punctuation close by. Always flagged for review.
function cutByLength(translation: string, wordCounts: number[]): string[] {
  const words = translation.split(/\s+/).filter(Boolean);
  const total = wordCounts.reduce((a, b) => a + b, 0) || 1;
  const cuts: number[] = [];
  let share = 0;
  for (let i = 0; i < wordCounts.length - 1; i++) {
    share += wordCounts[i];
    const min = (cuts[i - 1] ?? 0) + 1;
    const max = words.length - (wordCounts.length - 1 - i);
    const target = Math.min(max, Math.max(min, Math.round((words.length * share) / total)));
    const reach = Math.max(2, Math.round(words.length / wordCounts.length / 3));
    let best = target;
    let bestScore = -Infinity;
    for (let b = Math.max(min, target - reach); b <= Math.min(max, target + reach); b++) {
      const prev = words[b - 1] ?? "";
      const score = (SENTENCE_END.test(prev) ? 2 : CLAUSE_END.test(prev) ? 1 : 0) - Math.abs(b - target) / (reach + 1);
      if (score > bestScore) {
        bestScore = score;
        best = b;
      }
    }
    cuts.push(best);
  }
  const bounds = [0, ...cuts, words.length];
  return wordCounts.map((_, i) => words.slice(bounds[i], bounds[i + 1]).join(" "));
}

async function splitWithBackend(
  surah: number,
  ayah: number,
  tokens: string[],
  wordCounts: number[],
  translation: string,
  language: TranslationLanguage
): Promise<{ pieces: string[]; low_confidence: boolean } | null> {
  const baseUrl = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:8000";
  try {
    const res = await fetch(`${baseUrl}/api/segmentation/split-translation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ surah, ayah, tokens, word_counts: wordCounts, translation, language }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      console.warn(`[Split Translation] ${surah}:${ayah}: backend unavailable (${res.status}): ${await res.text().catch(() => "")}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn(`[Split Translation] ${surah}:${ayah}: backend unreachable`, e);
    return null;
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const surah = Number(body.surah);
    const ayah = Number(body.ayah);
    const translation = typeof body.translation === "string" ? body.translation.trim() : "";
    const wordCounts: number[] = Array.isArray(body.wordCounts) ? body.wordCounts.map(Number) : [];
    const language: TranslationLanguage = body.language === "en" || body.language === "ar" ? body.language : "tr";
    if (!surah || !ayah || !translation || wordCounts.length < 2 || wordCounts.some((c) => !Number.isInteger(c) || c < 1)) {
      return NextResponse.json({ error: "Missing or invalid fields: surah, ayah, translation, wordCounts" }, { status: 400 });
    }

    const tokens = await getAyahRealWords(surah, ayah).catch(() => [] as string[]);
    const sum = wordCounts.reduce((a, b) => a + b, 0);
    const split = tokens.length === sum ? await splitWithBackend(surah, ayah, tokens, wordCounts, translation, language) : null;
    if (split && split.pieces.length === wordCounts.length) {
      return NextResponse.json({ pieces: split.pieces, lowConfidence: split.low_confidence });
    }
    if (tokens.length !== sum) {
      console.warn(`[Split Translation] ${surah}:${ayah}: parts hold ${sum} words, the ayah ${tokens.length}`);
    }
    return NextResponse.json({ pieces: cutByLength(translation, wordCounts), lowConfidence: true, fallback: true });
  } catch (error) {
    console.error("[Split Translation] Error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Split failed" }, { status: 500 });
  }
}
