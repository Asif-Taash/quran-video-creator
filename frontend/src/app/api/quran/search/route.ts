import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { hasWordStartMatch } from "@/lib/arabicSearch";
import { withoutBasmala } from "@/lib/uthmaniText";

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

function backendUrl(): string {
  return process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:8000";
}

function uthmaniText(surahNumber: number, ayahNumber: number): string | null {
  const surah = loadUthmaniSurahs().find((s) => s.number === surahNumber);
  const ayah = surah?.ayahs.find((a) => a.numberInSurah === ayahNumber);
  if (!ayah) return null;
  return withoutBasmala(surahNumber, ayahNumber, ayah.text);
}

// mode=meaning (2026-11-20): ayahs ABOUT the query in any language --
// "الصبر", "sabır", "patience" -- by the backend's meaning search
// (backend/scripts/ayah_search.py), each with its translation in the UI
// language (Turkish/English) when there is one.
async function meaningSearch(q: string, lang: string) {
  const params = new URLSearchParams({ q, lang, limit: "30" });
  const res = await fetch(`${backendUrl()}/api/search/ayahs?${params}`, { cache: "no-store", signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    return NextResponse.json({ error: res.status === 503 ? "unavailable" : "failed" }, { status: res.status === 503 ? 503 : 502 });
  }
  const data = await res.json();
  const results = (data.results ?? [])
    .map((r: { surah: number; ayah: number; translation?: string | null }) => {
      const text = uthmaniText(r.surah, r.ayah);
      return text ? { verse_key: `${r.surah}:${r.ayah}`, text, translation: r.translation ?? null } : null;
    })
    .filter(Boolean);
  return NextResponse.json({ search: { results } });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q");

  if (!q) {
    return NextResponse.json({ error: "Missing query" }, { status: 400 });
  }

  if (searchParams.get("mode") === "meaning") {
    try {
      return await meaningSearch(q.trim().slice(0, 200), searchParams.get("lang") ?? "");
    } catch {
      return NextResponse.json({ error: "unavailable" }, { status: 503 });
    }
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
        // Every surah-opening ayah except Al-Fatihah's own has the Bismillah
        // prepended to its text — strip it so a query doesn't match purely
        // because of that shared boilerplate, and so the displayed text is
        // just the ayah itself.
        const text = withoutBasmala(surah.number, ayah.numberInSurah, ayah.text);
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
