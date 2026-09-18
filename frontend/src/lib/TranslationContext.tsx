"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import diyanetYeniData from "@/data/translations/diyanet_yeni.json";
import ahmetVarolData from "@/data/translations/ahmet_varol.json";

export type TranslationOption = {
  id: string;
  name: string;
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
const LOCAL_ACIKKURAN_TRANSLATIONS: Record<string, Record<string, string>> = {
  diyanet_yeni: diyanetYeniData,
  ahmet_varol: ahmetVarolData,
};

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
export const TRANSLATION_OPTIONS: TranslationOption[] = [
  { id: "none", name: "Çeviri yok...", source: "none", ref: "" },
  { id: "diyanet_yeni", name: "Diyanet İşleri Meali (Yeni)", source: "acikkuran", ref: "11" },
  { id: "diyanet_eski", name: "Diyanet İşleri Meali (Eski)", source: "tanzil", ref: "tur-diyanetisleri" },
  { id: "ahmet_varol", name: "Süleyman Ateş Meali", source: "acikkuran", ref: "27" },
  { id: "elmalili", name: "Elmalılı Hamdi Yazır Meali", source: "alquran", ref: "tr.yazir" },
];

// Açık Kuran prefixes a translation shared across several verses with a
// range like "(2-4)" — the official site itself displays this as
// "2,3,4." (comma-separated verse numbers, see kuran-ikerim.org/meal/diyanet),
// so reformat here once at the source rather than in every place this text
// gets displayed (segmentation editor, video render, etc).
function formatVerseGroupPrefix(text: string): string {
  return text.replace(/^\((\d+)-(\d+)\)\s*/, (match, start, end) => {
    const from = parseInt(start, 10);
    const to = parseInt(end, 10);
    if (isNaN(from) || isNaN(to) || to < from) return match;
    const numbers: number[] = [];
    for (let n = from; n <= to; n++) numbers.push(n);
    return `${numbers.join(",")}. `;
  });
}

export const DEFAULT_TRANSLATION_ID = "none";

interface TranslationContextType {
  selectedTranslation: TranslationOption;
  setSelectedTranslationId: (id: string) => void;
  getTranslation: (surahId: number, ayahId: number, fallback: string) => string;
  fetchSurahTranslations: (surahId: number) => Promise<void>;
  isLoading: boolean;
}

const TranslationContext = createContext<TranslationContextType | undefined>(undefined);

export function TranslationProvider({ children }: { children: React.ReactNode }) {
  const [selectedTranslationId, setSelectedTranslationIdState] = useState<string>(DEFAULT_TRANSLATION_ID);
  const [translationsCache, setTranslationsCache] = useState<Record<string, Record<string, string>>>({});
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("selectedTranslation");
    if (saved && TRANSLATION_OPTIONS.some((t) => t.id === saved)) {
      setSelectedTranslationIdState(saved);
    }
  }, []);

  const setSelectedTranslationId = React.useCallback((id: string) => {
    if (TRANSLATION_OPTIONS.some((t) => t.id === id)) {
      setSelectedTranslationIdState(id);
      localStorage.setItem("selectedTranslation", id);
    }
  }, []);

  const selectedTranslation = TRANSLATION_OPTIONS.find((t) => t.id === selectedTranslationId) || TRANSLATION_OPTIONS[0];

  const fetchSurahTranslations = async (surahId: number) => {
    if (selectedTranslation.source === "none") return;

    // acikkuran and alquran are both per-surah APIs, so cache per
    // translation+surah. tanzil ships one whole-Quran file, so cache it
    // once per translation.
    const cacheKey = selectedTranslation.source === "acikkuran" || selectedTranslation.source === "alquran"
      ? `${selectedTranslationId}_${surahId}`
      : selectedTranslationId;
    if (translationsCache[cacheKey]) return; // Already cached

    setIsLoading(true);
    try {
      if (selectedTranslation.source === "acikkuran") {
        // Bundled locally -- see LOCAL_ACIKKURAN_TRANSLATIONS above.
        const data = LOCAL_ACIKKURAN_TRANSLATIONS[selectedTranslationId] || {};
        const prefix = `${surahId}:`;
        const map: Record<string, string> = {};
        for (const [key, text] of Object.entries(data)) {
          if (key.startsWith(prefix)) map[key] = text;
        }
        setTranslationsCache((prev) => ({ ...prev, [cacheKey]: map }));
      } else if (selectedTranslation.source === "alquran") {
        const res = await fetch(`https://api.alquran.cloud/v1/surah/${surahId}/${selectedTranslation.ref}`);
        if (res.ok) {
          const data = await res.json();
          const map: Record<string, string> = {};
          (data.data?.ayahs || []).forEach((a: { numberInSurah: number; text: string }) => {
            map[`${surahId}:${a.numberInSurah}`] = formatVerseGroupPrefix(a.text);
          });
          setTranslationsCache((prev) => ({ ...prev, [cacheKey]: map }));
        }
      } else {
        const res = await fetch(`https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions/${selectedTranslation.ref}.min.json`);
        if (res.ok) {
          const data = await res.json();
          const map: Record<string, string> = {};
          (data.quran || []).forEach((v: { chapter: number; verse: number; text: string }) => {
            map[`${v.chapter}:${v.verse}`] = v.text;
          });
          setTranslationsCache((prev) => ({ ...prev, [cacheKey]: map }));
        }
      }
    } catch (error) {
      console.error("Failed to fetch translations", error);
    } finally {
      setIsLoading(false);
    }
  };

  const getTranslation = (surahId: number, ayahId: number, fallback: string) => {
    if (selectedTranslationId === "none") return "";

    const cacheKey = selectedTranslation.source === "acikkuran" || selectedTranslation.source === "alquran"
      ? `${selectedTranslationId}_${surahId}`
      : selectedTranslationId;
    if (translationsCache[cacheKey]) {
      const verseKey = `${surahId}:${ayahId}`;
      return translationsCache[cacheKey][verseKey] || fallback;
    }
    return fallback; // Return original database text (which is Elmalili currently) until loaded
  };

  return (
    <TranslationContext.Provider
      value={{
        selectedTranslation,
        setSelectedTranslationId,
        getTranslation,
        fetchSurahTranslations,
        isLoading,
      }}
    >
      {children}
    </TranslationContext.Provider>
  );
}

export function useTranslationContext() {
  const context = useContext(TranslationContext);
  if (context === undefined) {
    throw new Error("useTranslationContext must be used within a TranslationProvider");
  }
  return context;
}
