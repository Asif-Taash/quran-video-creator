import { NextResponse } from "next/server";
import quranData from "@/data/quran.json";
import { getSurahWordMap } from "@/lib/quranWordMap";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { surah, ayahs } = body;

    if (typeof surah !== "number" || !Array.isArray(ayahs) || ayahs.length === 0) {
      return NextResponse.json(
        { error: "Missing required fields: surah (number), ayahs (non-empty number[])" },
        { status: 400 }
      );
    }

    const localSurahs = quranData as any[];
    const localSurah = localSurahs.find((s) => s.id === surah);

    const targetPuaTotals: Record<number, number> = {};
    for (const ayah of ayahs) {
      const verse = localSurah?.verses?.find((v: any) => v.id === ayah);
      if (verse) {
        targetPuaTotals[ayah] = verse.text.trim().split(/\s+/).length;
      }
    }

    const wordMap = await getSurahWordMap(surah, ayahs, targetPuaTotals);

    return NextResponse.json({ success: true, wordMap });
  } catch (error) {
    console.error("[Word Map] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to resolve word map" },
      { status: 500 }
    );
  }
}
