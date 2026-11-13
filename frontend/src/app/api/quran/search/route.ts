import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { hasWordStartMatch } from "@/lib/arabicSearch";

const BISMILLAH_UTHMANI = "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ ";
const MAX_RESULTS = 20;

interface UthmaniAyah {
  numberInSurah: number;
  text: string;
}
interface UthmaniSurah {
  number: number;
  ayahs: UthmaniAyah[];
}

// Cached across requests in the same server process — this file is ~4.5MB,
// no need to re-read and re-parse it on every keystroke.
let cachedSurahs: UthmaniSurah[] | null = null;
function loadUthmaniSurahs(): UthmaniSurah[] {
  if (!cachedSurahs) {
    const uthmaniPath = path.join(process.cwd(), "src", "data", "quran-uthmani.json");
    const uthmaniData = JSON.parse(fs.readFileSync(uthmaniPath, "utf-8"));
    cachedSurahs = uthmaniData.data.surahs;
  }
  return cachedSurahs!;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q");

  if (!q) {
    return NextResponse.json({ error: "Missing query" }, { status: 400 });
  }

  try {
    const surahs = loadUthmaniSurahs();
    const results: { verse_key: string; text: string }[] = [];

    // Searched locally against the full Uthmani text (rather than proxying
    // an external search API) so matching rules are exactly the same ones
    // used for highlighting: word-start aligned, hamza-lenient only when the
    // query itself omits the hamza. The external alquran.cloud API does a
    // raw literal substring match — it can't tell "احم" mid-word in
    // "الراحمين" from a real match, and has no hamza normalization at all.
    searchLoop: for (const surah of surahs) {
      for (const ayah of surah.ayahs) {
        let text = ayah.text;
        // Every surah-opening ayah except Al-Fatihah's own has the Bismillah
        // prepended to its text — strip it so a query doesn't match purely
        // because of that shared boilerplate, and so the displayed text is
        // just the ayah itself.
        if (surah.number > 1 && ayah.numberInSurah === 1 && text.startsWith(BISMILLAH_UTHMANI)) {
          text = text.slice(BISMILLAH_UTHMANI.length);
        }
        if (hasWordStartMatch(text, q)) {
          results.push({ verse_key: `${surah.number}:${ayah.numberInSurah}`, text });
          if (results.length >= MAX_RESULTS) break searchLoop;
        }
      }
    }

    return NextResponse.json({ search: { results } });
  } catch (error: any) {
    console.error("Quran Search Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
