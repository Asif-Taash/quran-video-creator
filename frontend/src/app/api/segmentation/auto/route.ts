import { NextResponse } from "next/server";
import quranData from "@/data/quran.json";

export const runtime = "nodejs";
export const maxDuration = 120;

function buildPrompt(surah: number, ayah: number, translation: string, arabicWordCount: number, arabicNumberedText: string): string {
  return `Task: You are an expert linguist aligning a Turkish Quran translation with its exact Arabic text.
Your goal is to split the Turkish text into logical segments by major punctuation marks, and determine EXACTLY how many Arabic tokens correspond to each segment.

INPUT:
Turkish Text: "${translation}"
Arabic Text (Numbered Tokens): "${arabicNumberedText}"
Total Arabic Units: ${arabicWordCount}

CRITICAL KNOWLEDGE ABOUT ARABIC UNITS:
The Arabic text provided above contains exactly ${arabicWordCount} tokens, each numbered in parentheses like "word(1)".
These tokens include actual words, but ALSO Waqf marks (like ۚ), the verse number at the very end, Sajdah marks (۩), and Hizb marks (۞).
When counting the tokens for a Turkish segment, you MUST follow these exact attachment rules for the symbols:
- Waqf marks (ۚ, ۖ, ۗ, etc.): MUST be counted with the sentence BEFORE them.
- Verse number (e.g. ٢٨٥): MUST be counted with the sentence BEFORE it (it is always the last token of the last segment).
- Sajdah sign (۩): MUST be counted with the sentence BEFORE it.
- Hizb / Rub El Hizb sign (۞): MUST be counted with the sentence AFTER it.

For example, if the first Turkish segment translates to Arabic tokens (1) through (8), and token (8) is a Waqf mark, its 'arabic_unit_count' is 8.

RULES:
1. Split the Turkish Text ONLY at period (.), question mark (?), and exclamation mark (!). DO NOT split by commas.
2. Output a valid JSON object with a "mappings" array.
3. Distribute the ${arabicWordCount} Arabic Units EXACTLY across the parts based on the numbered Arabic tokens.
4. The sum of all 'arabic_unit_count' MUST be EXACTLY ${arabicWordCount}.
5. ONLY output the JSON object. No markdown.

Example JSON:
{
  "mappings": [
    {
      "part": 1,
      "translation_text": "First part.",
      "arabic_unit_count": X
    },
    {
      "part": 2,
      "translation_text": "Second part!",
      "arabic_unit_count": Y
    }
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

function validateMappings(mappings: any[], arabicWordCount: number, originalTranslation: string): { valid: boolean; error?: string } {
  if (!Array.isArray(mappings) || mappings.length === 0) {
    return { valid: false, error: "Mappings must be a non-empty array" };
  }

  // If the AI returned only 1 mapping but the text clearly contains punctuation that could be split, reject it to trigger the robust regex fallback
  if (mappings.length === 1) {
    const segments = originalTranslation.split(/(?<=[.?!]["']?)\s+/).filter((s: string) => s.trim().length > 0);
    if (segments.length > 1) {
      return { valid: false, error: "AI returned 1 segment, but text contains punctuation and can be split. Rejecting to use fallback." };
    }
  }

  let totalUnits = 0;
  for (let i = 0; i < mappings.length; i++) {
    const m = mappings[i];
    if (typeof m.part !== "number" || m.part < 1) {
      return { valid: false, error: `Invalid part number at index ${i}` };
    }
    if (typeof m.translation_text !== "string" || m.translation_text.trim() === "") {
      return { valid: false, error: `Empty translation_text at index ${i}` };
    }
    if (typeof m.arabic_unit_count !== "number" || m.arabic_unit_count < 1) {
      return { valid: false, error: `Invalid arabic_unit_count at index ${i}` };
    }
    totalUnits += m.arabic_unit_count;
  }

  if (totalUnits !== arabicWordCount) {
    return { valid: false, error: `Total units ${totalUnits} does not match expected ${arabicWordCount}` };
  }

  return { valid: true };
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

    // Fetch the exact Arabic words from quran.com to give the AI context and to map PUA characters
    let arabicNumberedText = "";
    let quranWords: any[] = [];
    try {
      const qRes = await fetch(`https://api.quran.com/api/v4/verses/by_key/${surah}:${ayah}?words=true&word_fields=text_uthmani,char_type_name,code_v2`);
      if (qRes.ok) {
        const qData = await qRes.json();
        if (qData.verse && qData.verse.words) {
          quranWords = qData.verse.words;
          arabicNumberedText = quranWords.map((w: any, i: number) => {
            const text = w.text_uthmani || w.char_type_name;
            return `${text}(${i + 1})`;
          }).join(" ");
        }
      }
    } catch (e) {
      console.warn("[Auto Segmentation] Failed to fetch Arabic text for AI alignment", e);
    }

    const trueWordCount = quranWords.length > 0 ? quranWords.length : arabicWordCount;

    // Check if translation can be split at all
    const trimmed = translation.trim();
    const innerText = trimmed.replace(/[.?!]\s*$/, "");
    const splittablePunctuation = (innerText.match(/[.?!]/g) || []).length;

    if (splittablePunctuation === 0) {
      console.log(`[Auto Segmentation] Surah ${surah} Ayah ${ayah}: No splittable punctuation, returning single part`);
      return NextResponse.json({
        success: true,
        skipped: true,
        mappings: [
          { part: 1, translation_text: trimmed, arabic_unit_count: arabicWordCount }
        ],
      });
    }

    console.log(`[Auto Segmentation] Surah ${surah} Ayah ${ayah}: Calling AI for segmentation...`);

    // Give the AI the TRUE word count (e.g. 50) instead of the PUA count (e.g. 56)
    const prompt = buildPrompt(surah, ayah, translation, trueWordCount, arabicNumberedText);

    // Retry up to 3 times
    const MAX_RETRIES = 3;
    let lastError = "";

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[Auto Segmentation] Surah ${surah} Ayah ${ayah}: Calling AI for segmentation...`);
        const rawText = await callAI(prompt);
        console.log(`[Auto Segmentation] Attempt ${attempt} raw response (last 500 chars):`, rawText.slice(-500));

        let mappings = extractJsonArray(rawText);
        if (!mappings) {
          lastError = `Failed to parse JSON from response (attempt ${attempt})`;
          console.warn(`[Auto Segmentation] ${lastError}`);
          continue;
        }

        // Robustly map AI properties to the expected schema
        mappings = mappings.map((m, idx) => ({
          part: m.part || idx + 1,
          translation_text: m.translation_text || m.turkish_segment || m.text || m.translation || "",
          arabic_unit_count: m.arabic_unit_count || m.unit_count || m.arabic_units || m.count || 1
        }));

        const validation = validateMappings(mappings, trueWordCount, translation);
        if (!validation.valid) {
          lastError = `Validation failed (attempt ${attempt}): ${validation.error}`;
          console.warn(`[Auto Segmentation] ${lastError}`);
          continue;
        }

        // --- PUA MAPPING LOGIC ---
        // The AI returned normal word counts (e.g. 6, 6, 7). We must map them to PUA counts (e.g. 7, 7, 8).
        if (quranWords.length > 0) {
          // Get the actual PUA word count from quran.json (source of truth for QuranVideo.tsx)
          const localSurahs = quranData as any[];
          const localSurah = localSurahs.find((s: any) => s.id === surah);
          const localVerse = localSurah?.verses?.find((v: any) => v.id === ayah);
          const targetPuaCount = localVerse ? localVerse.text.trim().split(/\s+/).length : arabicWordCount;

          let wordIdx = 0;
          for (let i = 0; i < mappings.length; i++) {
            const count = mappings[i].arabic_unit_count;
            let puaSum = 0;
            for (let j = 0; j < count; j++) {
              if (wordIdx < quranWords.length) {
                const w = quranWords[wordIdx];
                // if code_v2 exists, use its length (number of PUA characters), otherwise default to 1
                const puaLen = w.code_v2 ? w.code_v2.length : 1;
                puaSum += puaLen;
                wordIdx++;
              }
            }
            mappings[i].arabic_unit_count = puaSum;
          }
          // Fallback check: ensure total PUA sum matches the actual PUA word count from quran.json
          const totalPua = mappings.reduce((sum, m) => sum + m.arabic_unit_count, 0);
          if (totalPua !== targetPuaCount) {
             const diff = targetPuaCount - totalPua;
             mappings[mappings.length - 1].arabic_unit_count += diff;
             console.log(`[Auto Segmentation] PUA adjustment: ${totalPua} -> ${targetPuaCount} (diff: ${diff})`);
          }
        }

        // Success!
        console.log(`[Auto Segmentation] Surah ${surah} Ayah ${ayah}: Successfully segmented into ${mappings.length} parts (attempt ${attempt})`);
        return NextResponse.json({
          success: true,
          skipped: false,
          mappings,
        });
      } catch (err) {
        lastError = `API call failed (attempt ${attempt}): ${err instanceof Error ? err.message : String(err)}`;
        console.error(`[Auto Segmentation] ${lastError}`);
      }
    }

    // If all attempts failed, use native JS regex fallback splitting as requested by user
    console.log(`[Auto Segmentation] All ${MAX_RETRIES} attempts failed for Surah ${surah} Ayah ${ayah}. Using native regex split fallback.`);
    
    // Split by punctuation marks (. ? !) optionally followed by quotes
    const segments = translation.split(/(?<=[.?!]["']?)\s+/).filter((s: string) => s.trim().length > 0);

    // Use the PUA word count from quran.json as the source of truth
    // This ensures alignment with QuranVideo.tsx which uses verse.text.split(/\s+/)
    const localSurahs = quranData as any[];
    const localSurah = localSurahs.find((s: any) => s.id === surah);
    const localVerse = localSurah?.verses?.find((v: any) => v.id === ayah);
    const puaWordCount = localVerse ? localVerse.text.trim().split(/\s+/).length : arabicWordCount;
    
    // Calculate total word count of all segments for proportional distribution
    // Word count correlates better with Arabic word count than character length
    const segmentWordCounts = segments.map((seg: string) => seg.trim().split(/\s+/).length);
    const totalTranslationWords = segmentWordCounts.reduce((sum: number, count: number) => sum + count, 0);
    
    // Distribute Arabic units proportionally based on each segment's word count
    const fallbackMappings = [];
    let assignedUnits = 0;
    
    for (let i = 0; i < segments.length; i++) {
      const segmentText = segments[i].trim();
      let count: number;
      
      if (i === segments.length - 1) {
        // Last segment gets all remaining units to ensure exact sum
        count = puaWordCount - assignedUnits;
      } else {
        // Proportional distribution based on word count
        const proportion = segmentWordCounts[i] / totalTranslationWords;
        count = Math.max(1, Math.round(proportion * puaWordCount));
        
        // Safety: ensure we don't assign more than remaining
        const remaining = puaWordCount - assignedUnits - (segments.length - 1 - i); // reserve at least 1 for each remaining segment
        if (count > remaining) {
          count = Math.max(1, remaining);
        }
      }
      
      assignedUnits += count;
      
      fallbackMappings.push({
        part: i + 1,
        translation_text: segmentText,
        arabic_unit_count: count
      });
    }

    console.log(`[Auto Segmentation] Fallback: distributed ${puaWordCount} PUA words across ${segments.length} segments proportionally`);

    return NextResponse.json({ 
      success: true, 
      skipped: true, 
      fallback: true,
      fallbackReason: `AI segmentation failed after ${MAX_RETRIES} attempts`,
      error: lastError,
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
