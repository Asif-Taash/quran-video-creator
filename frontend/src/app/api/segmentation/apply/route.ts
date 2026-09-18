import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import quranData from "@/data/quran.json";
import { getVerseWordMap } from "@/lib/quranWordMap";

export async function POST(req: Request) {
  try {
    console.log("[Segmentation Apply] Request received");
    const data = await req.json();
    console.log("[Segmentation Apply] Parsed JSON:", JSON.stringify(data, null, 2));

    if (!Array.isArray(data)) {
      return NextResponse.json({ error: "Invalid format: Expected an array of segmentation objects." }, { status: 400 });
    }

    if (data.length === 0) {
      return NextResponse.json({ error: "Invalid format: Array cannot be empty." }, { status: 400 });
    }

    const localSurahs = quranData as any[];

    for (const item of data) {
      if (typeof item.surah !== "number" || item.surah < 1 || item.surah > 114) {
        return NextResponse.json({ error: `Invalid surah number: ${item.surah}. Must be between 1 and 114.` }, { status: 400 });
      }

      const surahData = localSurahs.find((s) => s.id === item.surah);
      if (!surahData) {
        return NextResponse.json({ error: `Surah ${item.surah} not found in database.` }, { status: 400 });
      }

      if (typeof item.ayah !== "number" || item.ayah < 1 || item.ayah > surahData.total_verses) {
        return NextResponse.json({ error: `Invalid ayah number: ${item.ayah} for surah ${item.surah}.` }, { status: 400 });
      }

      if (!Array.isArray(item.mappings) || item.mappings.length < 1) {
        return NextResponse.json({ error: `Surah ${item.surah} Ayah ${item.ayah} must have a mappings array with at least 1 item.` }, { status: 400 });
      }

      let totalUnits = 0;
      let allMappingsHaveManualTiming = true;
      for (const mapping of item.mappings) {
        if (typeof mapping.part !== "number" || mapping.part < 1) {
          return NextResponse.json({ error: `Invalid part number in Surah ${item.surah} Ayah ${item.ayah}.` }, { status: 400 });
        }
        // Empty is allowed deliberately: a segment can legitimately show just
        // its Arabic text with no translation line (VerseScene/QuranVideo.tsx
        // already renders that fine -- the translation div is only rendered
        // `{translation ? (...) : null}`), e.g. a manually-split leftover
        // word, or simply because the user hasn't finished typing it yet.
        // Rejecting the WHOLE request here used to make applyPendingSegmentation
        // (VideoCreatorForm.tsx) fall back to clearing ALL segmentation for
        // every ayah, not just this one -- so a still-in-progress segment
        // was silently discarding a user's finished work on every other
        // segment/ayah too, showing the whole ayah unsplit in the preview
        // and final render alike.
        if (typeof mapping.translation_text !== "string") {
          return NextResponse.json({ error: `translation_text must be a string in Surah ${item.surah} Ayah ${item.ayah}.` }, { status: 400 });
        }
        if (typeof mapping.word_count !== "number" || mapping.word_count < 1) {
          return NextResponse.json({ error: `word_count must be a positive integer in Surah ${item.surah} Ayah ${item.ayah}.` }, { status: 400 });
        }
        // Manual timing override from SegmentTimingEditor — optional, but if
        // present must be a sane (start < end, both non-negative) raw
        // prepared-audio-clip-relative millisecond pair.
        const hasStart = mapping.start_ms !== undefined;
        const hasEnd = mapping.end_ms !== undefined;
        if (hasStart !== hasEnd) {
          return NextResponse.json({ error: `start_ms and end_ms must be set together in Surah ${item.surah} Ayah ${item.ayah}.` }, { status: 400 });
        }
        if (hasStart && (typeof mapping.start_ms !== "number" || typeof mapping.end_ms !== "number" || mapping.start_ms < 0 || mapping.end_ms <= mapping.start_ms)) {
          return NextResponse.json({ error: `Invalid start_ms/end_ms in Surah ${item.surah} Ayah ${item.ayah}.` }, { status: 400 });
        }
        if (!hasStart) allMappingsHaveManualTiming = false;
        totalUnits += mapping.word_count;
      }

      const verseData = surahData.verses.find((v: any) => v.id === item.ayah);
      if (!verseData) {
        return NextResponse.json({ error: `Verse ${item.ayah} not found in Surah ${item.surah}.` }, { status: 400 });
      }

      // Validate against the REAL Uthmani word count (same basis wordTimings
      // is indexed by at render time), not the QCF glyph-token count.
      const puaWordCount = verseData.text.trim().split(/\s+/).length;
      let actualWordCount: number;
      try {
        const wordMap = await getVerseWordMap(item.surah, item.ayah, puaWordCount);
        actualWordCount = wordMap.realWordCount;
      } catch (e) {
        console.warn(`[Segmentation Apply] Failed to resolve real word count for Surah ${item.surah} Ayah ${item.ayah}, falling back to PUA count:`, e);
        actualWordCount = puaWordCount;
      }

      // Never silently reshuffle word_count when every mapping already
      // carries a manually-dragged start_ms/end_ms (i.e. it went through
      // SegmentTimingEditor) -- the editor keeps word_count and the
      // displayed Arabic text on the same real-word basis this route
      // validates against (see VideoCreatorForm.tsx's
      // buildTimingEditorSegments/ensureWordMapForAyahs), so a mismatch here
      // would mean something upstream is already wrong. Proportionally
      // rewriting word_count in that case would desync it from the
      // boundaries the user actually dragged -- text would shift to
      // different segments than the ones they timed -- which is strictly
      // worse than rendering with whatever the user explicitly set.
      if (totalUnits !== actualWordCount && !allMappingsHaveManualTiming) {
        console.warn(`[Segmentation Apply] Auto-correcting word count mismatch for Surah ${item.surah} Ayah ${item.ayah}. Expected ${actualWordCount}, got ${totalUnits}`);
        // Proportionately adjust the mappings. Reserve at least 1 word for
        // every remaining mapping (including the current one) so earlier
        // mappings rounding up can never push the total past
        // actualWordCount and starve the LAST mapping down to 0/negative —
        // which would silently drop the tail of the ayah from every segment.
        let newTotal = 0;
        for (let i = 0; i < item.mappings.length; i++) {
          const remainingMappings = item.mappings.length - i;
          if (i === item.mappings.length - 1) {
            item.mappings[i].word_count = Math.max(1, actualWordCount - newTotal);
          } else {
            const proportional = Math.max(1, Math.round((item.mappings[i].word_count / totalUnits) * actualWordCount));
            const maxAllowed = actualWordCount - newTotal - (remainingMappings - 1);
            const adjusted = Math.max(1, Math.min(proportional, maxAllowed));
            item.mappings[i].word_count = adjusted;
            newTotal += adjusted;
          }
        }
      }
    }

    console.log("[Segmentation Apply] Validation passed");

    const tempFilePath = path.join(process.cwd(), "src", "data", "temp_segmentation.json");
    
    await fs.mkdir(path.dirname(tempFilePath), { recursive: true });
    await fs.writeFile(tempFilePath, JSON.stringify(data, null, 2));

    console.log(`[Segmentation Apply] File written to: ${tempFilePath}`);

    return NextResponse.json({ success: true, message: "Segmentation data saved successfully." });
  } catch (error) {
    console.error("[Segmentation Apply] Validation failed with error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save segmentation data" },
      { status: 500 }
    );
  }
}
