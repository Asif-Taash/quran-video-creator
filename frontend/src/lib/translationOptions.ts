// Translation/tafsir editions the video creator offers, grouped by language.
// Shared by the client (TranslationContext) and the server render route
// (api/video/render), so both always agree on what each id means -- which
// is why this module has no "use client" and no React.

export type TranslationLanguage = "tr" | "en" | "ar";

export type TranslationOption = {
  id: string;
  name: string;
  /** null only for the "none" option, which belongs to every language. */
  language: TranslationLanguage | null;
  /** "acikkuran" = bundled locally in src/data/translations/ (scraped once
   *  from acikkuran.com by author id -- see the note below on why this
   *  isn't a live fetch anymore).
   *  "tanzil" = whole-Quran static JSON from the fawazahmed0/quran-api CDN
   *  (tanzil.net-sourced) by edition slug.
   *  "alquran" = per-surah fetch from api.alquran.cloud by edition slug.
   *  Empty ref for "none". */
  source: "acikkuran" | "tanzil" | "alquran" | "none";
  ref: string;
};

// Each language's own name for itself, for the language picker.
export const TRANSLATION_LANGUAGES: { id: TranslationLanguage; label: string }[] = [
  { id: "tr", label: "Türkçe" },
  { id: "en", label: "English" },
  { id: "ar", label: "العربية" },
];

// --- Turkish ---
// diyanet_yeni and ahmet_varol used to be fetched live from
// api.acikkuran.com on every surah change. That subdomain has been down
// (DNS NXDOMAIN, not just slow/erroring) since at least Aug 2026 --
// confirmed as a known, still-unresolved outage on Açık Kuran's own side:
// https://github.com/acik-kuran/acikkuran-api/issues/20. No other free API
// (alquran.cloud, quran.com, quranenc.com) carries a verified-matching
// edition, and the official Diyanet API caps free access at 9 ayahs/surah.
// So instead these two are bundled locally, scraped once from
// acikkuran.com's still-live Markdown pages (same verified text, just a
// different endpoint on the same site) by
// frontend/scripts/build-acikkuran-translations.mjs -- re-run that script to
// refresh if acikkuran.com's wording ever changes.
//
// Verified against the actual official text (screenshots of
// kuran.diyanet.gov.tr / kuran-ikerim.org's Diyanet meal matched
// api.acikkuran.com author 11 word-for-word, including its verse-grouping
// like "(2-4)" for verses sharing one translated sentence) — acikkuran.com is
// a Turkish-specific, well-curated source and is preferred where available.
//
// Earlier attempts and why they were wrong:
// - Quran.com's v4 API: diyanet_yeni/diyanet_eski both pointed at the SAME
//   resource id (77, one generic "Diyanet" edition — Quran.com doesn't
//   distinguish Eski/Yeni at all), and "ahmet_varol" (id 124) was actually
//   "Muslim Shahin", a different translator entirely.
// - fawazahmed0/quran-api's "tur-diyanetisleri" (tanzil.net-sourced): text
//   doesn't match the current official Diyanet meal at all (compared
//   verbatim against Yaseen 1-11) — it's some other/older Diyanet-attributed
//   edition. Ahmet Varol's translation isn't available through Quran.com,
//   alquran.cloud, quranenc.com, or acikkuran.com's APIs at all, so it's
//   substituted with Süleyman Ateş per user's explicit choice.
//
// acikkuran.com has no separate "Eski" edition, so diyanet_eski keeps using
// the tanzil-sourced text — it's at least a genuinely different translation
// from diyanet_yeni, even though it isn't verified against a specific named
// "Eski" edition.
//
// "elmalili": acikkuran.com's author id 14 was cross-checked against two
// independent sources (alquran.cloud's tr.yazir edition and tanzil.net's
// tur-elmalilihamdiya edition, which are verbatim-identical to each other on
// both Al-Fatiha and Ayat al-Kursi) and found to differ significantly in
// wording — acikkuran's text uses old-Ottoman-Turkish vocabulary throughout
// (e.g. "hayy-ü kayyum", old-spelling "şafaat", "kavrıyamazlar") consistent
// with Elmalılı's un-modernized original 1935 printing, not the standardized
// modern edition the other two sources (and most readers) recognize as "the"
// Elmalılı Hamdi Yazır meali today.
//
// Originally switched to the tanzil-sourced (fawazahmed0/quran-api) edition
// to match those two agreeing sources, but concretely observed (Al-Furqan
// 25:27-29, a passage of continuous quoted speech spanning several verses)
// that tanzil's per-verse split has its quotation marks offset by one verse
// boundary — ayah 27 ends missing its closing quote and ayah 28 opens
// mid-quote with an unmatched closing one instead. alquran.cloud's tr.yazir
// edition (verbatim-identical to tanzil's everywhere else, per the same
// cross-check) does NOT have this defect for that passage, so switched to it
// instead.
//
// --- English / Arabic ---
// All from api.alquran.cloud. The Arabic entries are tafsirs, not
// translations: only the two concise ones (al-Muyassar, al-Jalalayn, ~120
// words for Ayat al-Kursi, about the length of an English translation) --
// the longer ones alquran.cloud carries (al-Waseet: ~1700 words for the same
// ayah; al-Qurtubi, al-Baghawi) can't fit on a video frame.
export const TRANSLATION_OPTIONS: TranslationOption[] = [
  { id: "none", name: "—", language: null, source: "none", ref: "" },
  { id: "diyanet_yeni", name: "Diyanet İşleri Meali (Yeni)", language: "tr", source: "acikkuran", ref: "11" },
  { id: "diyanet_eski", name: "Diyanet İşleri Meali (Eski)", language: "tr", source: "tanzil", ref: "tur-diyanetisleri" },
  { id: "ahmet_varol", name: "Süleyman Ateş Meali", language: "tr", source: "acikkuran", ref: "27" },
  { id: "elmalili", name: "Elmalılı Hamdi Yazır Meali", language: "tr", source: "alquran", ref: "tr.yazir" },
  { id: "en_sahih", name: "Saheeh International", language: "en", source: "alquran", ref: "en.sahih" },
  { id: "en_itani", name: "The Clear Quran (Talal Itani)", language: "en", source: "alquran", ref: "en.itani" },
  { id: "en_pickthall", name: "Pickthall", language: "en", source: "alquran", ref: "en.pickthall" },
  { id: "en_yusufali", name: "Yusuf Ali", language: "en", source: "alquran", ref: "en.yusufali" },
  { id: "ar_muyassar", name: "التفسير الميسر", language: "ar", source: "alquran", ref: "ar.muyassar" },
  { id: "ar_jalalayn", name: "تفسير الجلالين", language: "ar", source: "alquran", ref: "ar.jalalayn" },
];

export function getTranslationOption(id: string): TranslationOption | undefined {
  return TRANSLATION_OPTIONS.find((t) => t.id === id);
}

/** Whether a translation's text is right-to-left (an Arabic tafsir). */
export function isRtlTranslation(id: string): boolean {
  return getTranslationOption(id)?.language === "ar";
}

// Açık Kuran prefixes a translation shared across several verses with a
// range like "(2-4)" — the official site itself displays this as
// "2,3,4." (comma-separated verse numbers, see kuran-ikerim.org/meal/diyanet),
// so reformat here once at the source rather than in every place this text
// gets displayed (segmentation editor, video render, etc).
export function formatVerseGroupPrefix(text: string): string {
  return text.replace(/^\((\d+)-(\d+)\)\s*/, (match, start, end) => {
    const from = parseInt(start, 10);
    const to = parseInt(end, 10);
    if (isNaN(from) || isNaN(to) || to < from) return match;
    const numbers: number[] = [];
    for (let n = from; n <= to; n++) numbers.push(n);
    return `${numbers.join(",")}. `;
  });
}
