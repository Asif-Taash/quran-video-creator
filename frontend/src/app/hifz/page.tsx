import type { Metadata } from "next";
import Navbar from "@/components/layout/Navbar";
import HifzPage, { type HifzSurah } from "@/components/hifz/HifzPage";
import quranData from "@/data/quran.json";
import { fixMojibake } from "@/lib/textEncoding";

export const metadata: Metadata = {
  title: "Hıfz",
  description: "Kuran ezberi: dinle ve tekrarla, ezberden oku, kelime kelime düzeltilsin.",
};

// Only the surah list goes to the browser (quran.json itself is the whole
// text in glyph codes): the page fetches the words of the chosen ayahs.
const surahs: HifzSurah[] = (quranData as { id: number; name: string; transliteration: string; total_verses: number }[]).map(
  (s) => ({ id: s.id, name: fixMojibake(s.name), transliteration: fixMojibake(s.transliteration), total: s.total_verses })
);

export default function HifzRoute() {
  return (
    <div className="min-h-screen bg-background transition-colors duration-300">
      <Navbar />
      <main className="px-4">
        <HifzPage surahs={surahs} />
      </main>
    </div>
  );
}
