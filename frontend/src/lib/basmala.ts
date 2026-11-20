// The basmala a video may start with, before ayah 1 (the user, 2026-11-15):
// pseudo-verse BASMALA_VERSE_ID, drawn with Al-Fatiha's own basmala -- its
// ayah 1 in each QCF script, without the ayah-number glyph -- and timed by
// the backend from the recitation itself (quran_aligner.BASMALA_AYAH).
// Al-Fatiha's basmala IS its ayah 1, and At-Tawbah has none.
import quranData from "@/data/quran.json";
import quranQcfV1Data from "@/data/quran-qcf-v1.json";
import { BASMALA_VERSE_ID } from "@/remotion/types";

export { BASMALA_VERSE_ID };

const NO_BASMALA_SURAHS = new Set([1, 9]);

/** Can a video of this surah start with the basmala? */
export function surahHasBasmala(surahId: number | null | undefined): boolean {
  return typeof surahId === "number" && surahId >= 1 && surahId <= 114 && !NO_BASMALA_SURAHS.has(surahId);
}

/** Only a selection starting at ayah 1 can. */
export function canStartWithBasmala(surahId: number | null | undefined, startVerse: number | null | undefined): boolean {
  return surahHasBasmala(surahId) && startVerse === 1;
}

// بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ: one glyph token per word in both scripts.
export const BASMALA_WORD_COUNT = 4;
export const BASMALA_GLYPH_COUNTS = [1, 1, 1, 1];

type GlyphVerse = { id: number; text: string; page: number };
const fatihaAyah1 = (data: unknown) =>
  (data as { id: number; verses: GlyphVerse[] }[]).find((s) => s.id === 1)!.verses.find((v) => v.id === 1)!;
const withoutAyahNumber = (text: string) => text.trim().split(/\s+/).slice(0, BASMALA_WORD_COUNT).join(" ");

const v2 = fatihaAyah1(quranData);
const v1 = fatihaAyah1(quranQcfV1Data);

/** Its glyph text and page in the new (v2) and old (v1) QCF scripts. */
export const BASMALA_GLYPHS = {
  text: withoutAyahNumber(v2.text),
  page: v2.page,
  textV1: withoutAyahNumber(v1.text),
  pageV1: v1.page,
};

// Its meaning under the video, from the chosen edition's Al-Fatiha ayah 1
// -- which is the basmala, but several editions don't give its meaning
// there (checked 2026-11-15 for every edition in translationOptions.ts):
// Diyanet's new meal and Diyanet Vakfı's only spell it out in Turkish
// letters ("Bismillahirrahmanirrahim."), al-Muyassar first says why the
// surah is called al-Fatiha, and al-Jalalayn just quotes it. The user wants
// its meaning, in the chosen language.
const TRANSLITERATED = /^\s*bismill/i;
// Diyanet's own wording of it (its old meal has it at Al-Fatiha 1).
const BASMALA_MEANING_TR = "Rahmân ve Rahîm olan Allah'ın adıyla.";
// al-Muyassar's explanation of the basmala starts here, after its words on
// the surah's names.
const MUYASSAR_BASMALA_START = "أبتدئ";
// al-Jalalayn has none: al-Muyassar's opening sentence of it.
const BASMALA_MEANING_AR = "أبتدئ قراءة القرآن باسم الله مستعينًا به.";

export function basmalaMeaning(fatihaAyah1: string, language: string | null | undefined): string {
  const text = fatihaAyah1.trim();
  if (!text) return "";
  if (TRANSLITERATED.test(text)) return language === "tr" ? BASMALA_MEANING_TR : "";
  if (language === "ar") {
    const start = text.indexOf(MUYASSAR_BASMALA_START);
    if (start > 0) return text.slice(start);
    // Only the basmala itself, quoted.
    if (/^[«"(]?\s*بسم الله الرحمن الرحيم\s*[»")]?$/.test(text)) return BASMALA_MEANING_AR;
  }
  return text;
}
