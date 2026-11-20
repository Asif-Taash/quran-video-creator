// The text of the post a video goes out with (2026-11-20): the surah, the
// reciter, the ayahs in Uthmani script with their numbers, their meaning in
// the video's translation, and hashtags -- copied in one tap under the
// video (Step5Generate) instead of being typed for every reel. Written in
// the video's language (its translation's; the page's when it has none).

export type CaptionLanguage = "ar" | "tr" | "en";

export interface PostCaptionInput {
  language: CaptionLanguage;
  surahId: number;
  surahNameAr: string;
  surahNameTr: string;
  surahNameEn: string;
  startVerse: number;
  endVerse: number;
  totalVerses: number;
  basmala: boolean;
  // Display names, empty when unknown (an uploaded recording without a name).
  reciterAr: string;
  reciterLatin: string;
  // In order; translation empty when the video has none (or an Arabic tafsir).
  ayahs: { n: number; arabic: string; translation: string }[];
}

const BASMALA = "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

function arabicNumber(n: number): string {
  return String(n).replace(/\d/g, (d) => ARABIC_DIGITS[Number(d)]);
}

// A hashtag body: letters and digits only, lower case in the language's own
// rules (Turkish İ/ı), circumflexes dropped (Âl-i İmrân -> aliimran).
function tagWord(text: string, language: CaptionLanguage): string {
  const lower = language === "tr" ? text.toLocaleLowerCase("tr") : text.toLowerCase();
  return lower
    .replace(/[âÂ]/g, "a")
    .replace(/[îÎ]/g, "i")
    .replace(/[ûÛ]/g, "u")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function arabicTag(text: string): string {
  return text
    .replace(/[ً-ٰٟـ]/g, "")
    .trim()
    .replace(/\s+/g, "_");
}

// Some translations open an ayah with the numbers of the ayahs it was
// translated together with ("2,3,4. Hamd..."): the same text then comes for
// each of them, so it is given once.
function cleanTranslation(text: string): string {
  return text.replace(/^\s*\d+(?:\s*[,-]\s*\d+)*\.\s*/, "").trim();
}

export function buildPostCaption(input: PostCaptionInput): string {
  const { language, startVerse, endVerse, totalVerses } = input;
  const whole = startVerse === 1 && endVerse === totalVerses;
  const single = startVerse === endVerse;
  const lines: string[] = [];

  if (language === "ar") {
    const range = whole ? "" : single ? ` - الآية ${startVerse}` : ` - الآيات ${startVerse}-${endVerse}`;
    lines.push(`سورة ${input.surahNameAr}${range}${input.reciterAr ? ` | بصوت القارئ ${input.reciterAr}` : ""}`);
  } else if (language === "en") {
    const range = whole ? "" : single ? `, Ayah ${startVerse}` : `, Ayahs ${startVerse}-${endVerse}`;
    lines.push(`Surah ${input.surahNameEn}${range}${input.reciterLatin ? ` | Recited by ${input.reciterLatin}` : ""}`);
  } else {
    const range = whole ? "" : single ? ` ${startVerse}. Ayet` : ` ${startVerse}-${endVerse}. Ayetler`;
    lines.push(`${input.surahNameTr} Suresi${range}${input.reciterLatin ? ` | Okuyan: ${input.reciterLatin}` : ""}`);
  }

  const arabic = input.ayahs.map((a) => `${a.arabic} ﴿${arabicNumber(a.n)}﴾`).join(" ");
  if (arabic) lines.push("", input.basmala ? `${BASMALA}\n${arabic}` : arabic);

  const meanings: string[] = [];
  let previous = "";
  for (const a of input.ayahs) {
    const text = cleanTranslation(a.translation);
    if (!text || text === previous) continue;
    previous = text;
    meanings.push(`${text} (${a.n})`);
  }
  if (meanings.length > 0) lines.push("", meanings.join(" "));

  const tags =
    language === "ar"
      ? ["#قرآن", "#القرآن_الكريم", `#سورة_${arabicTag(input.surahNameAr)}`, input.reciterAr && `#${arabicTag(input.reciterAr)}`, "#تلاوة", "#تلاوة_خاشعة"]
      : language === "en"
        ? ["#quran", "#islam", "#quranrecitation", `#surah${tagWord(input.surahNameEn, "en")}`, input.reciterLatin && `#${tagWord(input.reciterLatin, "en")}`]
        : ["#kuran", "#kuranıkerim", "#ayet", `#${tagWord(input.surahNameTr, "tr")}suresi`, input.reciterLatin && `#${tagWord(input.reciterLatin, "tr")}`, "#tilavet", "#islam"];
  lines.push("", tags.filter(Boolean).join(" "));
  return lines.join("\n");
}
