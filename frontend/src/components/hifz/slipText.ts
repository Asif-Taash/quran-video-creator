import type { SlipDetail } from "./types";
import { letterClusters } from "./WordWithSlip";

// A slip put in words (2026-11-24, the user: say how it was said and how it
// should be): «قلتَ «س» بدل «ص»», «فتحة بدل ضمة على «هـ»», «لم تنطق التنوين».
// The ear writes in the Quran phonetic script (quran-transcript); its signs
// are turned back into plain letters here.

type Tx = (ar: string, tr: string, en: string) => string;

const PLAIN: Record<string, string> = { "ۥ": "و", "ۦ": "ي", "ں": "ن", "۾": "ن", "ڇ": "", "ۜ": "" };

/** The ear's phonetic script as plain Arabic letters and harakat (a
 *  doubled letter -- how the script writes a shadda -- as one with a shadda). */
export function plainHeard(h: string): string {
  return Array.from(h)
    .map((c) => (c in PLAIN ? PLAIN[c] : c))
    .join("")
    .replace(/([\u0621-\u063A\u0641-\u064A])\1/g, "$1\u0651");
}

function vowelName(c: string, tx: Tx): string {
  if (c === "َ") return tx("فتحة", "üstün", "fatha");
  if (c === "ُ") return tx("ضمة", "ötre", "damma");
  if (c === "ِ") return tx("كسرة", "esre", "kasra");
  return "";
}

const isVowel = (c: string) => c === "َ" || c === "ُ" || c === "ِ";

/** One sentence per differing sound. `word` is the word as shown. */
export function describeSlip(d: SlipDetail, word: string, tx: Tx): string {
  const clusters = letterClusters(word);
  const on = d.x >= 0 && d.x < clusters.length ? clusters[d.x] : "";
  const onLetter = on ? Array.from(on)[0] : "";
  const w = plainHeard(d.w);
  const s = plainHeard(d.s);
  switch (d.k) {
    case "letter":
      return tx(`قلتَ «${s}» بدل «${w}»`, `«${w}» yerine «${s}» dediniz`, `You said «${s}» for «${w}»`);
    case "vowel":
      return tx(
        `${vowelName(d.s, tx)} بدل ${vowelName(d.w, tx)}${onLetter ? ` على «${onLetter}»` : ""}`,
        `${onLetter ? `«${onLetter}» harfinde ` : ""}${vowelName(d.w, tx)} yerine ${vowelName(d.s, tx)}`,
        `${vowelName(d.s, tx)} for ${vowelName(d.w, tx)}${onLetter ? ` on «${onLetter}»` : ""}`
      );
    case "drop":
      if (isVowel(d.w))
        return tx(
          `سكّنتَ «${onLetter}» وهي ب${vowelName(d.w, tx)}`,
          `«${onLetter}» harfini ${vowelName(d.w, tx)} yerine cezimli okudunuz`,
          `«${onLetter}» said without its ${vowelName(d.w, tx)}`
        );
      return tx(`أسقطتَ «${w}»`, `«${w}» harfini atladınız`, `You left out «${w}»`);
    case "add":
      return tx(`زدتَ «${s}»`, `Fazladan «${s}» dediniz`, `You added «${s}»`);
    case "stop":
      if (d.w === "ن" || d.w === "ں")
        return tx("لم تنطق التنوين وأنت تصل الكلام", "Vasl ederken tenvini okumadınız", "Running on, the tanween wasn't said");
      if (isVowel(d.w))
        return tx(
          `وصلتَ الكلام فيجب ${vowelName(d.w, tx)} آخرها، لا السكون`,
          `Vasl ederken son harf ${vowelName(d.w, tx)} okunur, cezimli değil`,
          `Running on, it ends with ${vowelName(d.w, tx)}, not a stop`
        );
      return tx("قرأتَ آخرها كأنك واقف وأنت تصل الكلام", "Vasl ederken sonunu vakf eder gibi okudunuz", "Running on, you read its end as at a stop");
    case "hamza":
      return tx("نطقتَ همزة الوصل وأنت تصل الكلام", "Vasl ederken vasl hemzesini okudunuz", "Running on, you said the hamzat al-wasl");
    case "word":
      return tx(`قلتَ «${s}…» بدل الكلمة`, `Kelime yerine «${s}…» dediniz`, `You said «${s}…» instead`);
  }
  return "";
}
