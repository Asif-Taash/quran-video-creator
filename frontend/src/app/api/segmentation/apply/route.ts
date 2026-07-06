import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import quranData from "@/data/quran.json";

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
      for (const mapping of item.mappings) {
        if (typeof mapping.part !== "number" || mapping.part < 1) {
          return NextResponse.json({ error: `Invalid part number in Surah ${item.surah} Ayah ${item.ayah}.` }, { status: 400 });
        }
        if (typeof mapping.translation_text !== "string" || mapping.translation_text.trim() === "") {
          return NextResponse.json({ error: `Translation text cannot be empty in Surah ${item.surah} Ayah ${item.ayah}.` }, { status: 400 });
        }
        if (typeof mapping.arabic_unit_count !== "number" || mapping.arabic_unit_count < 1) {
          return NextResponse.json({ error: `Arabic unit count must be a positive integer in Surah ${item.surah} Ayah ${item.ayah}.` }, { status: 400 });
        }
        totalUnits += mapping.arabic_unit_count;
      }

      const verseData = surahData.verses.find((v: any) => v.id === item.ayah);
      if (!verseData) {
        return NextResponse.json({ error: `Verse ${item.ayah} not found in Surah ${item.surah}.` }, { status: 400 });
      }

      const actualWordCount = verseData.text.trim().split(/\s+/).length;
      if (totalUnits !== actualWordCount) {
        console.warn(`[Segmentation Apply] Auto-correcting word count mismatch for Surah ${item.surah} Ayah ${item.ayah}. Expected ${actualWordCount}, got ${totalUnits}`);
        // Proportionately adjust the mappings
        let newTotal = 0;
        for (let i = 0; i < item.mappings.length; i++) {
          if (i === item.mappings.length - 1) {
            item.mappings[i].arabic_unit_count = actualWordCount - newTotal;
          } else {
            const adjusted = Math.max(1, Math.round((item.mappings[i].arabic_unit_count / totalUnits) * actualWordCount));
            item.mappings[i].arabic_unit_count = adjusted;
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
