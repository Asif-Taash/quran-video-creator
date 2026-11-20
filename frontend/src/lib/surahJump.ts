// Going straight to an ayah from the search box (2026-11-20): "البقرة 255",
// "2:255", "Bakara 255", "yasin", "سورة الملك" -- the surah by any of its
// names (Arabic, Turkish, English, transliteration) and an optional ayah.

export interface JumpSurah {
  id: number;
  totalVerses: number;
  names: string[];
}

export interface Jump {
  surah: number;
  ayah: number;
  // Whether the query named an ayah (else the surah's first is meant).
  hasAyah: boolean;
}

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";

function westernDigits(text: string): string {
  return text.replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d)));
}

// Letters only, one spelling: no marks or hamza seats, no "سورة"/"suresi"/
// "surah", no leading ال / al- / el-, Turkish ı/İ and circumflexes folded.
export function foldSurahName(text: string): string {
  return text
    .toLocaleLowerCase("tr")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[âáà]/g, "a")
    .replace(/[îíı]/g, "i")
    .replace(/[ûú]/g, "u")
    .replace(/(^|\s)(سوره|suresi|sure|surah|surat|sura)(?=\s|$)/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .replace(/^(ال|ash|esh|ech|al|el|an|en|ar|er|as|es|at|et|ad|ed|az|ez)(?=\p{L}{3,})/u, "");
}

export function findSurahJump(query: string, surahs: JumpSurah[]): Jump | null {
  const text = westernDigits(query).trim();
  const numeric = text.match(/^(\d{1,3})\s*[:.\s/-]\s*(\d{1,3})$/);
  if (numeric) {
    const surah = surahs.find((s) => s.id === Number(numeric[1]));
    const ayah = Number(numeric[2]);
    return surah && ayah >= 1 && ayah <= surah.totalVerses ? { surah: surah.id, ayah, hasAyah: true } : null;
  }
  const named = text.match(/^(.*?)[\s:.\-]*(\d{1,3})?$/);
  const name = foldSurahName(named?.[1] ?? "");
  if (name.length < 2) return null;
  const ayah = named?.[2] ? Number(named[2]) : null;
  const exact = surahs.find((s) => s.names.some((n) => foldSurahName(n) === name));
  // A beginning is enough once it's long enough to mean one surah.
  const partial = exact ?? (name.length >= 4 ? surahs.find((s) => s.names.some((n) => foldSurahName(n).startsWith(name))) : undefined);
  if (!partial) return null;
  if (ayah !== null && (ayah < 1 || ayah > partial.totalVerses)) return null;
  return { surah: partial.id, ayah: ayah ?? 1, hasAyah: ayah !== null };
}
