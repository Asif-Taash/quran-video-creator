// The one list of built-in reciters -- every other place derives from it
// (Step3Audio.tsx's dropdown, render/route.ts and prepare-audio/route.ts's
// backend-key mapping and Arabic credit, the gallery's Latin name), so a new
// reciter only ever needs adding here plus its audio source in the backend's
// RECITERS_MP3QURAN (extract_precise_clip.py) under the same `backendKey`.
// No fs/child_process imports, so client components can import it too.
//
// - nameLatin: short credit style, used in the suggested video title and
//   stored per gallery entry as reciterNameLatin.
// - labelLatin: the dropdown's Turkish/English label, when it differs from
//   nameLatin (the original six kept their longer labels).
// - everyAyahDir: per-ayah files on everyayah.com, used only by
//   render/route.ts's last-resort fallback when the backend extraction is
//   unavailable. Omitted for reciters without a matching per-ayah set -- the
//   render then fails with a clear error instead of playing someone else's
//   voice.
export type ReciterInfo = {
  id: string;
  backendKey: string;
  nameAr: string;
  nameLatin: string;
  labelLatin?: string;
  everyAyahDir?: string;
};

export const RECITERS: readonly ReciterInfo[] = [
  { id: "mishary_alafasy", backendKey: "mishary", nameAr: "مشاري راشد العفاسي", nameLatin: "Mishary Al-Afasy", labelLatin: "Mishary Rashed Alafasy", everyAyahDir: "Alafasy_128kbps" },
  { id: "maher_muaiqly", backendKey: "maher", nameAr: "ماهر المعيقلي", nameLatin: "Maher Al-Muaiqly", everyAyahDir: "Maher_AlMuaiqly_64kbps" },
  { id: "ahmed_ajmi", backendKey: "ajmi", nameAr: "أحمد العجمي", nameLatin: "Ahmed Al-Ajmi", everyAyahDir: "Ahmed_ibn_Ali_al-Ajamy_128kbps_ketaballah.net" },
  { id: "yasser_dosari", backendKey: "yasser", nameAr: "ياسر الدوسري", nameLatin: "Yasser Al-Dosari", everyAyahDir: "Yasser_Ad-Dussary_128kbps" },
  { id: "abdullah_mousa", backendKey: "mousa", nameAr: "عبدالله الموسى", nameLatin: "Abdullah Al-Mousa" },
  { id: "raad_alkurdi", backendKey: "raad_alkurdi", nameAr: "رعد محمد الكردي", nameLatin: "Raad Al-Kurdi", labelLatin: "Raad Mohammad Al Kurdi" },
  { id: "abdulrahman_sudais", backendKey: "sudais", nameAr: "عبدالرحمن السديس", nameLatin: "Abdul Rahman Al-Sudais", everyAyahDir: "Abdurrahmaan_As-Sudais_192kbps" },
  { id: "saud_shuraim", backendKey: "shuraim", nameAr: "سعود الشريم", nameLatin: "Saud Al-Shuraim", everyAyahDir: "Saood_ash-Shuraym_128kbps" },
  { id: "saad_ghamdi", backendKey: "ghamdi", nameAr: "سعد الغامدي", nameLatin: "Saad Al-Ghamdi", everyAyahDir: "Ghamadi_40kbps" },
  { id: "abubakr_shatri", backendKey: "shatri", nameAr: "أبو بكر الشاطري", nameLatin: "Abu Bakr Al-Shatri", everyAyahDir: "Abu_Bakr_Ash-Shaatree_128kbps" },
  { id: "mahmoud_husary", backendKey: "husary", nameAr: "محمود خليل الحصري", nameLatin: "Mahmoud Khalil Al-Husary", everyAyahDir: "Husary_128kbps" },
  { id: "muhammad_minshawi", backendKey: "minshawi", nameAr: "محمد صديق المنشاوي", nameLatin: "Muhammad Siddiq Al-Minshawi", everyAyahDir: "Minshawy_Murattal_128kbps" },
  { id: "abdulbasit_abdulsamad", backendKey: "abdulbasit", nameAr: "عبدالباسط عبدالصمد", nameLatin: "Abdul Basit Abdul Samad", everyAyahDir: "Abdul_Basit_Murattal_192kbps" },
  { id: "nasser_qatami", backendKey: "qatami", nameAr: "ناصر القطامي", nameLatin: "Nasser Al-Qatami", everyAyahDir: "Nasser_Alqatami_128kbps" },
  { id: "idrees_abkar", backendKey: "abkar", nameAr: "إدريس أبكر", nameLatin: "Idrees Abkar" },
  { id: "fares_abbad", backendKey: "fares_abbad", nameAr: "فارس عباد", nameLatin: "Fares Abbad", everyAyahDir: "Fares_Abbad_64kbps" },
  { id: "khalid_jalil", backendKey: "jalil", nameAr: "خالد الجليل", nameLatin: "Khalid Al-Jalil" },
  { id: "ali_jaber", backendKey: "ali_jaber", nameAr: "علي جابر", nameLatin: "Ali Jaber", everyAyahDir: "Ali_Jaber_64kbps" },
  { id: "muhammad_ayyub", backendKey: "ayyub", nameAr: "محمد أيوب", nameLatin: "Muhammad Ayyub", everyAyahDir: "Muhammad_Ayyoub_128kbps" },
  { id: "abdullah_juhani", backendKey: "juhani", nameAr: "عبدالله عواد الجهني", nameLatin: "Abdullah Al-Juhani", everyAyahDir: "Abdullaah_3awwaad_Al-Juhaynee_128kbps" },
  { id: "bandar_baleela", backendKey: "baleela", nameAr: "بندر بليله", nameLatin: "Bandar Baleela" },
  { id: "mansour_salimi", backendKey: "salimi", nameAr: "منصور السالمي", nameLatin: "Mansour Al-Salimi" },
  { id: "ahmad_nufais", backendKey: "nufais", nameAr: "أحمد النفيس", nameLatin: "Ahmad Al-Nufais" },
];

export const DEFAULT_RECITER_ID = "mishary_alafasy";

const RECITERS_BY_ID: Record<string, ReciterInfo> = Object.fromEntries(RECITERS.map((r) => [r.id, r]));

export function getReciter(id: string): ReciterInfo | undefined {
  return RECITERS_BY_ID[id];
}

// Latin-script credit names -- shared between the client (VideoCreatorForm's
// suggested video title) and the server (render/route.ts, stored per gallery
// entry as reciterNameLatin) so both use the exact same spelling.
export const RECITER_DISPLAY_NAMES: Record<string, string> = Object.fromEntries(
  RECITERS.map((r) => [r.id, r.nameLatin])
);

// Arabic names -- the credit line of an Arabic-language video, the name
// stored per gallery entry, and the reverse lookup below.
export const RECITER_ARABIC_NAMES: Record<string, string> = Object.fromEntries(
  RECITERS.map((r) => [r.id, r.nameAr])
);

// Recovers a Latin reciter name from an OLD gallery entry that only ever
// stored the Arabic one (reciterNameLatin didn't exist yet) -- so those
// videos show correctly in Turkish too, without needing to touch their
// already-saved JSON.
export function latinNameForArabicReciterName(arabicName: string): string | undefined {
  const reciterId = Object.keys(RECITER_ARABIC_NAMES).find((id) => RECITER_ARABIC_NAMES[id] === arabicName);
  return reciterId ? RECITER_DISPLAY_NAMES[reciterId] : undefined;
}
