import { NextResponse } from "next/server";
import { getAyahRealWords, getAyahRealWordGlosses } from "@/lib/quranWordMap";
import type { TranslationLanguage } from "@/lib/translationOptions";
import { moveBoundariesOffMarks } from "@/remotion/timing";

export const runtime = "nodejs";
export const maxDuration = 120;

// Sentence-ending punctuation the translation is split at -- Arabic's
// question mark is "؟", not "?".
const SENTENCE_END = "[.?!؟]";
// A piece shorter than this is merged into its neighbour instead of being a
// part of its own: Turkish puts a speech verb after the quote it closes
// ('"... olacak?" diyorlar'), and a lone "diyorlar" part would be shown
// against the ayah's LAST words while it translates its FIRST one (قالوا).
const MIN_SEGMENT_WORDS = 3;

function splitTranslation(translation: string): string[] {
  const pieces = translation
    .split(new RegExp(`(?<=${SENTENCE_END}["'»”]?)\\s+`))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const words = (s: string) => s.split(/\s+/).length;
  const merged: string[] = [];
  for (const piece of pieces) {
    if (merged.length > 0 && words(piece) < MIN_SEGMENT_WORDS) merged[merged.length - 1] += ` ${piece}`;
    else merged.push(piece);
  }
  if (merged.length > 1 && words(merged[0]) < MIN_SEGMENT_WORDS) merged.splice(0, 2, `${merged[0]} ${merged[1]}`);
  return merged;
}

type BoundaryMapping = { part: number; translation_text: string; word_count: number };

// A part never opens on a waqf sign nor ends on a Hizb sign (see
// moveBoundariesOffMarks) -- the backend places them already; this covers
// the gloss-weight fallback, which doesn't know the rule.
function withMarksPlaced(mappings: BoundaryMapping[], realWords: string[]): BoundaryMapping[] {
  const counts = moveBoundariesOffMarks(mappings.map((m) => m.word_count), realWords);
  return mappings.map((m, i) => (counts[i] === m.word_count ? m : { ...m, word_count: counts[i] }));
}

function distributeByGlossWeight(
  segments: string[],
  realWords: string[],
  glosses: string[],
  trueWordCount: number
): BoundaryMapping[] {
  // Content-aware fallback: weight each Arabic real word by how many English
  // gloss words it carries (a word with a longer gloss is treated as
  // "heavier"/more content-bearing than a short one or a bare pause mark),
  // instead of blindly assuming Arabic word count scales with Turkish word
  // count — a strictly better-grounded heuristic when the aligner is
  // unusable, even though it still isn't true cross-lingual alignment.
  const weights = realWords.map((_, i) => {
    const g = (glosses[i] || "").trim();
    return g ? g.split(/\s+/).length : 0.5;
  });
  const totalWeight = weights.reduce((a, b) => a + b, 0) || trueWordCount;

  const segmentWordCounts = segments.map((seg) => seg.trim().split(/\s+/).length);
  const totalTranslationWords = segmentWordCounts.reduce((a, b) => a + b, 0) || 1;

  const mappings: BoundaryMapping[] = [];
  let wordCursor = 0;
  let weightCursor = 0;

  for (let i = 0; i < segments.length; i++) {
    let count: number;
    if (i === segments.length - 1) {
      count = trueWordCount - wordCursor;
    } else {
      const targetWeight = weightCursor + (segmentWordCounts[i] / totalTranslationWords) * totalWeight;
      const maxForThisSegment = trueWordCount - wordCursor - (segments.length - 1 - i);
      let cum = weightCursor;
      let c = 0;
      while (c < maxForThisSegment && cum < targetWeight) {
        cum += weights[wordCursor + c];
        c++;
      }
      count = Math.max(1, Math.min(c, maxForThisSegment));
      weightCursor = cum;
    }
    mappings.push({ part: i + 1, translation_text: segments[i].trim(), word_count: count });
    wordCursor += count;
  }

  return mappings;
}

// The backend's offline aligner (backend/scripts/segment_align.py: word-by-
// word glosses + a local multilingual model) -- it replaced free online
// chatbots that were often down. null when it can't run.
async function alignWithBackend(
  surah: number,
  ayah: number,
  tokens: string[],
  segments: string[],
  language: TranslationLanguage
): Promise<{ word_counts: number[]; low_confidence: boolean } | null> {
  const baseUrl = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:8000";
  try {
    const res = await fetch(`${baseUrl}/api/segmentation/align`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ surah, ayah, tokens, segments, language }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      console.warn(`[Auto Segmentation] Surah ${surah} Ayah ${ayah}: aligner unavailable (${res.status}): ${await res.text().catch(() => "")}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn(`[Auto Segmentation] Surah ${surah} Ayah ${ayah}: aligner unreachable`, e);
    return null;
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { surah, ayah, translation, arabicWordCount } = body;
    const language: TranslationLanguage = body.language === "en" || body.language === "ar" ? body.language : "tr";

    if (!surah || !ayah || !translation || !arabicWordCount) {
      return NextResponse.json(
        { error: "Missing required fields: surah, ayah, translation, arabicWordCount" },
        { status: 400 }
      );
    }

    // The exact REAL Uthmani words (same tokenization wordTimings and
    // apply/route.ts's validation use — see frontend/src/lib/quranWordMap.ts).
    let realWords: string[] = [];
    try {
      realWords = await getAyahRealWords(surah, ayah);
    } catch (e) {
      console.warn("[Auto Segmentation] Failed to fetch the Arabic words", e);
    }
    const trueWordCount = realWords.length > 0 ? realWords.length : arabicWordCount;

    const segments = splitTranslation(translation);
    if (segments.length < 2) {
      return NextResponse.json({
        success: true,
        skipped: true,
        lowConfidence: false,
        mappings: [{ part: 1, translation_text: translation.trim(), word_count: trueWordCount }],
      });
    }

    const aligned = realWords.length > 0 ? await alignWithBackend(surah, ayah, realWords, segments, language) : null;
    if (aligned && aligned.word_counts.length === segments.length) {
      const mappings = segments.map((text, i) => ({ part: i + 1, translation_text: text, word_count: aligned.word_counts[i] }));
      console.log(`[Auto Segmentation] Surah ${surah} Ayah ${ayah}: aligned ${aligned.word_counts.join("/")}${aligned.low_confidence ? " (uncertain cut)" : ""}`);
      return NextResponse.json({ success: true, skipped: false, lowConfidence: aligned.low_confidence, mappings });
    }

    // The aligner couldn't run: fall back to the content-aware proportional
    // split, flagged as low-confidence so the UI points the user at this
    // ayah for a quick manual check instead of silently trusting a guess.
    const glosses = realWords.length > 0 ? await getAyahRealWordGlosses(surah, ayah, realWords.length).catch(() => []) : [];
    const fallbackMappings = withMarksPlaced(distributeByGlossWeight(segments, realWords, glosses, trueWordCount), realWords);
    return NextResponse.json({
      success: true,
      skipped: true,
      fallback: true,
      lowConfidence: true,
      fallbackReason: "Offline aligner unavailable",
      mappings: fallbackMappings,
    });
  } catch (error) {
    console.error("[Auto Segmentation] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Auto segmentation failed" },
      { status: 500 }
    );
  }
}
