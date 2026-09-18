import { NextResponse } from "next/server";
import { getAyahRealWords, getAyahRealWordGlosses } from "@/lib/quranWordMap";
import { getCachedSegmentation, setCachedSegmentation } from "@/lib/segmentationCache";

export const runtime = "nodejs";
export const maxDuration = 120;

function buildPrompt(translation: string, arabicWordCount: number, arabicNumberedText: string): string {
  return `Task: You are an expert linguist aligning a Turkish Quran translation with its exact Arabic text, word by word.

INPUT:
Turkish Text: "${translation}"
Arabic Text (numbered tokens; real words have an English gloss in [brackets], pause/Sajdah/Hizb marks have none): "${arabicNumberedText}"
Total Arabic Tokens: ${arabicWordCount}

TASK:
1. Split the Turkish Text ONLY at period (.), question mark (?), and exclamation mark (!). DO NOT split by commas.
2. For each resulting Turkish segment, find the LAST Arabic token NUMBER whose meaning is covered by that segment — identify the boundary, do NOT count or sum tokens yourself.
3. Boundary numbers MUST strictly increase from one segment to the next. The LAST segment's boundary MUST be token ${arabicWordCount} (the final token) — it always covers everything remaining.
4. Waqf/pause marks (ۖۗۘۚۛ etc.) and the Sajdah sign (۩) have no gloss and no meaning of their own — they belong with the segment BEFORE them. A Hizb sign (۞) belongs with the segment AFTER it.
5. For each segment, report the boundary token's NUMBER and its exact ARABIC TEXT (copy it exactly as shown, with diacritics) so your answer can be verified against the source.
6. Output ONLY a valid JSON object — no markdown, no explanation, no calculation shown.

Example JSON:
{
  "mappings": [
    { "part": 1, "translation_text": "First part.", "last_word_index": 8, "last_word_text": "رَيْبَ" },
    { "part": 2, "translation_text": "Second part!", "last_word_index": ${arabicWordCount}, "last_word_text": "..." }
  ]
}`;
}

function extractJsonArray(text: string): any[] | null {
  // Parse the text directly
  try {
    const parsed = JSON.parse(text.trim());

    // Most direct case: Pollinations jsonMode returned the object natively!
    if (parsed.mappings && Array.isArray(parsed.mappings)) {
      return parsed.mappings;
    }

    // Pollinations wrapped string fallback (when jsonMode fails or model acts as chatbot)
    if (parsed.message && typeof parsed.message === 'string') {
        const innerParsed = JSON.parse(parsed.message);
        if (innerParsed.mappings && Array.isArray(innerParsed.mappings)) return innerParsed.mappings;
    }

    // Pollinations object with content fallback
    if (parsed.message && parsed.message.content) {
        const innerParsed = JSON.parse(parsed.message.content);
        if (innerParsed.mappings && Array.isArray(innerParsed.mappings)) return innerParsed.mappings;
    }
  } catch (e) {
      console.log("[Auto Segmentation] Direct parse failed, trying regex");
  }

  // Regex fallback: find "mappings": [ ... ]
  try {
    const mappingsMatch = text.match(/"mappings"\s*:\s*(\[[\s\S]*?\])/);
    if (mappingsMatch) {
        // We need to carefully parse the array string
        // Since it might be inside an escaped JSON string, we can try to parse it directly
        // However, if it's escaped (e.g. `\"part\"`), we should unescape it first.
        let arrayStr = mappingsMatch[1];
        if (arrayStr.includes('\\"')) {
           arrayStr = arrayStr.replace(/\\"/g, '"');
        }
        if (arrayStr.includes('\\n')) {
           arrayStr = arrayStr.replace(/\\n/g, '');
        }

        const parsedArray = JSON.parse(arrayStr);
        if (Array.isArray(parsedArray)) return parsedArray;
    }
  } catch (e) {
      console.log("[Auto Segmentation] Regex extraction failed");
  }

  // Last resort regex for simple array
  try {
    const arrayMatch = text.match(/\[\s*\{[\s\S]*?\}\s*\]/);
    if (arrayMatch) {
       let arrayStr = arrayMatch[0];
       if (arrayStr.includes('\\"')) {
           arrayStr = arrayStr.replace(/\\"/g, '"');
       }
       if (arrayStr.includes('\\n')) {
           arrayStr = arrayStr.replace(/\\n/g, '');
       }
       const parsedArray = JSON.parse(arrayStr);
       if (Array.isArray(parsedArray)) return parsedArray;
    }
  } catch {}

  return null;
}

function normalizeArabic(text: string): string {
  return (text || "")
    .normalize("NFC")
    // Strip tashkeel/diacritics for comparison. Explicit \uXXXX escapes
    // only, never raw Arabic diacritic characters typed into a regex
    // character class -- a prior bug here did that and ended up matching
    // almost the entire core Arabic letter block by accident.
    .replace(/[\u0617-\u061A\u064B-\u0652\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

async function callAI(prompt: string): Promise<string> {
  const baseUrl = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:8000";
  const url = `${baseUrl}/api/ai/chat`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_prompt: "You are a JSON-only API. You MUST return ONLY valid JSON. NO markdown formatting. NO conversational text. DO NOT EXPLAIN. DO NOT CALCULATE OUT LOUD. Return EXACTLY the requested JSON structure.",
      user_message: prompt
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Backend AI error (${response.status}): ${text}`);
  }

  const data = await response.json();
  return data.result || "";
}

type BoundaryMapping = { part: number; translation_text: string; word_count: number };
type AttemptResult = { mappings: BoundaryMapping[]; boundaries: number[] } | null;

/**
 * Runs ONE AI call and turns its boundary-index answer into word_count
 * mappings via plain subtraction (never trusts the model's own arithmetic),
 * then self-verifies every claimed boundary word's text against the real
 * word at that index — rejecting the whole attempt on any mismatch instead
 * of silently accepting a wrong split. Returns null on any failure so the
 * caller can try again / fall through to consensus with other attempts.
 */
async function runSingleAttempt(
  prompt: string,
  translation: string,
  realWords: string[],
  trueWordCount: number,
  label: string
): Promise<AttemptResult> {
  try {
    const rawText = await callAI(prompt);
    let raw = extractJsonArray(rawText);
    if (!raw) {
      console.warn(`[Auto Segmentation] ${label}: failed to parse JSON`);
      return null;
    }

    if (raw.length === 0) {
      console.warn(`[Auto Segmentation] ${label}: empty mappings array`);
      return null;
    }

    // The AI is only ever trusted to locate the ARABIC word boundary for
    // each Turkish sentence — never to reproduce the Turkish text itself.
    // An LLM completion can silently drop or alter punctuation (a period,
    // a quotation mark, ...) when asked to "write out" a segment, even
    // though it's the same free-form text every time. Splitting the
    // ORIGINAL, untouched translation string at the exact same
    // punctuation-based regex used everywhere else in this file (the
    // "splittable" check above and the fallback below) gives byte-perfect
    // segments straight from the source, with nothing ever regenerated.
    const regexSegments = translation.split(/(?<=[.?!]["']?)\s+/).filter((s: string) => s.trim().length > 0);

    // Reject a lone 1-segment answer when the text clearly has splittable
    // punctuation — forces retry/consensus instead of a lazy non-split.
    if (raw.length === 1 && regexSegments.length > 1) {
      console.warn(`[Auto Segmentation] ${label}: returned 1 segment but text is splittable`);
      return null;
    }

    const normalized = raw.map((m: any, idx: number) => ({
      part: m.part || idx + 1,
      translation_text: m.translation_text || m.turkish_segment || m.text || m.translation || "",
      last_word_index: m.last_word_index ?? m.boundary ?? m.end_index ?? m.word_index,
      last_word_text: m.last_word_text ?? m.boundary_word ?? m.word ?? "",
    }));

    // The model's segment count must match the deterministic regex split of
    // the SAME original text -- if they disagree, the model split the
    // sentence differently than we're about to slice it, and mapping its
    // word boundaries onto our verbatim segments would misalign part N's
    // text with part N's Arabic words. Reject and let the caller retry.
    if (normalized.length !== regexSegments.length) {
      console.warn(
        `[Auto Segmentation] ${label}: model returned ${normalized.length} segments but the source text splits into ${regexSegments.length} — rejecting`
      );
      return null;
    }

    let prevBoundary = 0;
    const boundaries: number[] = [];
    for (let i = 0; i < normalized.length; i++) {
      const m = normalized[i];
      if (typeof m.translation_text !== "string" || m.translation_text.trim() === "") {
        console.warn(`[Auto Segmentation] ${label}: empty translation_text at index ${i}`);
        return null;
      }
      let boundary = Number(m.last_word_index);
      const isLast = i === normalized.length - 1;
      if (isLast) {
        // The last segment always covers everything remaining — forcing
        // this guarantees full coverage regardless of what the model said,
        // so the tail of the ayah can never be silently dropped.
        boundary = trueWordCount;
      }
      if (!Number.isInteger(boundary) || boundary <= prevBoundary || boundary > trueWordCount) {
        console.warn(`[Auto Segmentation] ${label}: invalid/non-increasing boundary at index ${i} (${boundary}, prev ${prevBoundary})`);
        return null;
      }

      // Self-verification: the claimed boundary word's text must match the
      // real word at that index — catches the model pointing at the wrong
      // word even when the index arithmetic looks structurally fine.
      const expectedWord = realWords[boundary - 1];
      if (expectedWord && normalizeArabic(m.last_word_text) !== normalizeArabic(expectedWord)) {
        console.warn(
          `[Auto Segmentation] ${label}: boundary word mismatch at index ${i} — claimed "${m.last_word_text}", expected "${expectedWord}" (token ${boundary})`
        );
        return null;
      }

      boundaries.push(boundary);
      prevBoundary = boundary;
    }

    // translation_text comes from the verbatim regex split of the original
    // string, NOT from the model's own (re-generated) text -- see the
    // comment above regexSegments. The model's text was only used for the
    // empty-check and boundary reasoning above.
    const mappings: BoundaryMapping[] = normalized.map((m: any, i: number) => ({
      part: i + 1,
      translation_text: regexSegments[i].trim(),
      word_count: boundaries[i] - (i === 0 ? 0 : boundaries[i - 1]),
    }));

    return { mappings, boundaries };
  } catch (err) {
    console.error(`[Auto Segmentation] ${label}: API call failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

function boundariesEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
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
  // count — a strictly better-grounded heuristic when the AI is unusable,
  // even though it still isn't true cross-lingual alignment.
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

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { surah, ayah, translation, arabicWordCount } = body;

    console.log(`[Auto Segmentation Debug] Received request for Surah ${surah} Ayah ${ayah} with arabicWordCount: ${arabicWordCount}`);

    if (!surah || !ayah || !translation || !arabicWordCount) {
      return NextResponse.json(
        { error: "Missing required fields: surah, ayah, translation, arabicWordCount" },
        { status: 400 }
      );
    }

    // The Arabic text and this exact translation string never change once
    // written, so a previously-verified (AI-consensus) split for this exact
    // (surah, ayah, translation) combination is valid forever. Checking this
    // BEFORE any external fetch or AI call means every repeat request for an
    // already-solved ayah (inevitable across users, since the Quran is a
    // fixed, popular corpus) returns instantly with a result already proven
    // correct, instead of re-rolling the free/unreliable AI each time.
    const cachedMappings = await getCachedSegmentation(surah, ayah, translation);
    if (cachedMappings) {
      console.log(`[Auto Segmentation] Surah ${surah} Ayah ${ayah}: cache hit, skipping AI`);
      return NextResponse.json({ success: true, skipped: false, lowConfidence: false, cached: true, mappings: cachedMappings });
    }

    // Fetch the exact REAL Uthmani words (same tokenization wordTimings and
    // apply/route.ts's validation use — see frontend/src/lib/quranWordMap.ts),
    // plus a free English word-by-word gloss per word to ground the AI in a
    // concrete literal meaning instead of relying on its raw Arabic reading
    // (no Turkish word-by-word data exists anywhere, free or paid, that we
    // could use instead — verified against quran.com/acikkuran/tanzil).
    let realWords: string[] = [];
    let glosses: string[] = [];
    try {
      realWords = await getAyahRealWords(surah, ayah);
      glosses = await getAyahRealWordGlosses(surah, ayah, realWords.length);
    } catch (e) {
      console.warn("[Auto Segmentation] Failed to fetch Arabic text for AI alignment", e);
    }

    const trueWordCount = realWords.length > 0 ? realWords.length : arabicWordCount;
    const arabicNumberedText = realWords
      .map((w, i) => (glosses[i] ? `${w}(${i + 1})[${glosses[i]}]` : `${w}(${i + 1})`))
      .join(" ");

    // Check if translation can be split at all
    const trimmed = translation.trim();
    const innerText = trimmed.replace(/[.?!]\s*$/, "");
    const splittablePunctuation = (innerText.match(/[.?!]/g) || []).length;

    if (splittablePunctuation === 0) {
      console.log(`[Auto Segmentation] Surah ${surah} Ayah ${ayah}: No splittable punctuation, returning single part`);
      return NextResponse.json({
        success: true,
        skipped: true,
        lowConfidence: false,
        mappings: [
          { part: 1, translation_text: trimmed, word_count: trueWordCount }
        ],
      });
    }

    console.log(`[Auto Segmentation] Surah ${surah} Ayah ${ayah}: Calling AI for segmentation...`);
    const prompt = buildPrompt(translation, trueWordCount, arabicNumberedText);

    // g4f (the free AI backend, see backend/app/routers/ai.py) routes each
    // request to an unpredictable free provider with no quality guarantee —
    // so instead of trusting a single call, run up to 3 independent attempts
    // and only accept a result when at least two of them AGREE on the exact
    // same boundaries (after each has already passed self-verification on
    // its own). Two independent models/providers converging on the same
    // split is a much stronger accuracy signal than any single call.
    const [attemptA, attemptB] = await Promise.all([
      runSingleAttempt(prompt, translation, realWords, trueWordCount, `Surah ${surah} Ayah ${ayah} attempt A`),
      runSingleAttempt(prompt, translation, realWords, trueWordCount, `Surah ${surah} Ayah ${ayah} attempt B`),
    ]);

    if (attemptA && attemptB && boundariesEqual(attemptA.boundaries, attemptB.boundaries)) {
      console.log(`[Auto Segmentation] Surah ${surah} Ayah ${ayah}: consensus reached on first 2 attempts`);
      await setCachedSegmentation(surah, ayah, translation, attemptA.mappings);
      return NextResponse.json({ success: true, skipped: false, lowConfidence: false, mappings: attemptA.mappings });
    }

    const attemptC = await runSingleAttempt(prompt, translation, realWords, trueWordCount, `Surah ${surah} Ayah ${ayah} attempt C (tie-break)`);

    const attempts = [attemptA, attemptB, attemptC].filter((a): a is NonNullable<AttemptResult> => a !== null);
    for (let i = 0; i < attempts.length; i++) {
      for (let j = i + 1; j < attempts.length; j++) {
        if (boundariesEqual(attempts[i].boundaries, attempts[j].boundaries)) {
          console.log(`[Auto Segmentation] Surah ${surah} Ayah ${ayah}: consensus reached after tie-break`);
          await setCachedSegmentation(surah, ayah, translation, attempts[i].mappings);
          return NextResponse.json({ success: true, skipped: false, lowConfidence: false, mappings: attempts[i].mappings });
        }
      }
    }

    // No two attempts agreed (or all failed) — fall back to the content-aware
    // proportional splitter and flag the result as low-confidence so the UI
    // can point the user at this ayah for a quick manual check instead of
    // silently trusting a guess.
    console.log(`[Auto Segmentation] Surah ${surah} Ayah ${ayah}: no consensus after 3 attempts, using fallback (low confidence)`);
    const segments = translation.split(/(?<=[.?!]["']?)\s+/).filter((s: string) => s.trim().length > 0);
    const fallbackMappings = distributeByGlossWeight(segments, realWords, glosses, trueWordCount);

    return NextResponse.json({
      success: true,
      skipped: true,
      fallback: true,
      lowConfidence: true,
      fallbackReason: "AI attempts did not reach consensus after 3 tries",
      mappings: fallbackMappings
    });
  } catch (error) {
    console.error("[Auto Segmentation] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Auto segmentation failed" },
      { status: 500 }
    );
  }
}
