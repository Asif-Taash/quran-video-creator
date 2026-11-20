import fs from "fs";
import path from "path";
import { withoutBasmala } from "@/lib/uthmaniText";

// The Quran in readable Uthmani script (src/data/quran-uthmani.json) for
// server routes -- the page itself only has the font's glyph codes. Read
// once per server process.

interface UthmaniSurah {
  number: number;
  ayahs: { numberInSurah: number; text: string }[];
}

let surahs: UthmaniSurah[] | null = null;

function load(): UthmaniSurah[] {
  if (!surahs) {
    const raw = fs.readFileSync(path.join(process.cwd(), "src", "data", "quran-uthmani.json"), "utf-8");
    surahs = JSON.parse(raw).data.surahs;
  }
  return surahs!;
}

/** Ayahs from..to of a surah ([] for a surah that doesn't exist), the
 *  basmala taken off ayah 1 (it isn't part of it, except in Al-Fatiha). */
export function uthmaniAyahs(surah: number, from: number, to: number): { n: number; text: string }[] {
  const s = load().find((x) => x.number === surah);
  if (!s) return [];
  return s.ayahs
    .filter((a) => a.numberInSurah >= from && a.numberInSurah <= to)
    .map((a) => ({ n: a.numberInSurah, text: withoutBasmala(surah, a.numberInSurah, a.text) }));
}
