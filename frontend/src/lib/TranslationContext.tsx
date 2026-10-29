"use client";

import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import diyanetYeniData from "@/data/translations/diyanet_yeni.json";
import ahmetVarolData from "@/data/translations/ahmet_varol.json";
import { useLanguage } from "@/lib/LanguageContext";
import {
  TRANSLATION_OPTIONS,
  formatVerseGroupPrefix,
  getTranslationOption,
  type TranslationLanguage,
  type TranslationOption,
} from "@/lib/translationOptions";

export { TRANSLATION_OPTIONS, type TranslationLanguage, type TranslationOption };

// Bundled locally -- see the "acikkuran" note in translationOptions.ts.
const LOCAL_ACIKKURAN_TRANSLATIONS: Record<string, Record<string, string>> = {
  diyanet_yeni: diyanetYeniData,
  ahmet_varol: ahmetVarolData,
};

export const DEFAULT_TRANSLATION_ID = "none";

interface TranslationContextType {
  selectedTranslation: TranslationOption;
  setSelectedTranslationId: (id: string) => void;
  // Which language's translations/tafsirs the picker lists. Follows the
  // site language automatically (switching the site to Arabic switches this
  // to Arabic too), but can be changed independently afterwards.
  translationLanguage: TranslationLanguage;
  setTranslationLanguage: (lang: TranslationLanguage) => void;
  getTranslation: (surahId: number, ayahId: number, fallback: string) => string;
  fetchSurahTranslations: (surahId: number) => Promise<void>;
  isLoading: boolean;
}

const TranslationContext = createContext<TranslationContextType | undefined>(undefined);

export function TranslationProvider({ children }: { children: React.ReactNode }) {
  const { language: siteLanguage } = useLanguage();
  const [selectedTranslationId, setSelectedTranslationIdState] = useState<string>(DEFAULT_TRANSLATION_ID);
  const [translationLanguage, setTranslationLanguageState] = useState<TranslationLanguage>(siteLanguage);
  const [translationsCache, setTranslationsCache] = useState<Record<string, Record<string, string>>>({});
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("selectedTranslation");
    const option = saved ? getTranslationOption(saved) : undefined;
    if (option) {
      setSelectedTranslationIdState(option.id);
      if (option.language) setTranslationLanguageState(option.language);
    }
  }, []);

  const setSelectedTranslationId = React.useCallback((id: string) => {
    const option = getTranslationOption(id);
    if (!option) return;
    setSelectedTranslationIdState(id);
    localStorage.setItem("selectedTranslation", id);
    // Picking (or restoring from a draft) a specific edition shows its
    // language's list, so the picker always displays what's selected.
    if (option.language) setTranslationLanguageState(option.language);
  }, []);

  // Changing the language list drops a selection that isn't in it, rather
  // than silently keeping a translation the picker no longer shows.
  const setTranslationLanguage = React.useCallback((lang: TranslationLanguage) => {
    setTranslationLanguageState(lang);
    setSelectedTranslationIdState((current) => {
      const option = getTranslationOption(current);
      if (!option?.language || option.language === lang) return current;
      localStorage.setItem("selectedTranslation", DEFAULT_TRANSLATION_ID);
      return DEFAULT_TRANSLATION_ID;
    });
  }, []);

  // Follow the site language whenever it changes (LanguageProvider restores
  // the saved one right after mount, which counts as a change too).
  const lastSiteLanguageRef = useRef(siteLanguage);
  useEffect(() => {
    if (lastSiteLanguageRef.current === siteLanguage) return;
    lastSiteLanguageRef.current = siteLanguage;
    setTranslationLanguage(siteLanguage);
  }, [siteLanguage, setTranslationLanguage]);

  const selectedTranslation = getTranslationOption(selectedTranslationId) || TRANSLATION_OPTIONS[0];

  // The cache is also read through a ref so both functions below keep one
  // identity per selected translation: consumers list them as effect
  // dependencies, and a new identity on every render (or every cache write)
  // re-ran those effects -- fetching the same translation twice and
  // reloading the preview twice per selection. A caller that awaited
  // fetchSurahTranslations sees the fetched text through the ref even from
  // a closure created before it arrived.
  const translationsCacheRef = useRef(translationsCache);
  const inFlightRef = useRef(new Map<string, Promise<void>>());

  // acikkuran and alquran are both per-surah APIs, so cache per
  // translation+surah. tanzil ships one whole-Quran file, so cache it once
  // per translation.
  const cacheKeyFor = React.useCallback(
    (surahId: number) =>
      selectedTranslation.source === "acikkuran" || selectedTranslation.source === "alquran"
        ? `${selectedTranslationId}_${surahId}`
        : selectedTranslationId,
    [selectedTranslation.source, selectedTranslationId]
  );

  const fetchSurahTranslations = React.useCallback(
    (surahId: number): Promise<void> => {
      if (selectedTranslation.source === "none") return Promise.resolve();
      const cacheKey = cacheKeyFor(surahId);
      if (translationsCacheRef.current[cacheKey]) return Promise.resolve();
      const pending = inFlightRef.current.get(cacheKey);
      if (pending) return pending;

      const store = (map: Record<string, string>) => {
        translationsCacheRef.current = { ...translationsCacheRef.current, [cacheKey]: map };
        setTranslationsCache(translationsCacheRef.current);
      };
      const load = async () => {
        setIsLoading(true);
        try {
          if (selectedTranslation.source === "acikkuran") {
            const data = LOCAL_ACIKKURAN_TRANSLATIONS[selectedTranslationId] || {};
            const prefix = `${surahId}:`;
            const map: Record<string, string> = {};
            for (const [key, text] of Object.entries(data)) {
              if (key.startsWith(prefix)) map[key] = text;
            }
            store(map);
          } else if (selectedTranslation.source === "alquran") {
            const res = await fetch(`https://api.alquran.cloud/v1/surah/${surahId}/${selectedTranslation.ref}`);
            if (res.ok) {
              const data = await res.json();
              const map: Record<string, string> = {};
              (data.data?.ayahs || []).forEach((a: { numberInSurah: number; text: string }) => {
                map[`${surahId}:${a.numberInSurah}`] = formatVerseGroupPrefix(a.text);
              });
              store(map);
            }
          } else {
            const res = await fetch(`https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions/${selectedTranslation.ref}.min.json`);
            if (res.ok) {
              const data = await res.json();
              const map: Record<string, string> = {};
              (data.quran || []).forEach((v: { chapter: number; verse: number; text: string }) => {
                map[`${v.chapter}:${v.verse}`] = v.text;
              });
              store(map);
            }
          }
        } catch (error) {
          console.error("Failed to fetch translations", error);
        }
      };
      // Cleanup lives in .finally(), not inside load(): the bundled acikkuran
      // branch never awaits, so load() finishes before it even returns -- a
      // finally in there ran before the set() below, leaving the entry in
      // the map for good and pinning isLoading at true on the next fetch.
      // A .finally() callback always runs after the set().
      const promise = load().finally(() => {
        inFlightRef.current.delete(cacheKey);
        setIsLoading(inFlightRef.current.size > 0);
      });
      inFlightRef.current.set(cacheKey, promise);
      return promise;
    },
    [selectedTranslation, selectedTranslationId, cacheKeyFor]
  );

  const getTranslation = React.useCallback(
    (surahId: number, ayahId: number, fallback: string) => {
      if (selectedTranslationId === "none") return "";
      const cached = translationsCacheRef.current[cacheKeyFor(surahId)];
      if (cached) return cached[`${surahId}:${ayahId}`] || fallback;
      return fallback; // Return original database text (which is Elmalili currently) until loaded
    },
    [selectedTranslationId, cacheKeyFor]
  );

  // translationsCache is listed so consumers re-render (and re-read
  // getTranslation) once a fetch lands, without the functions changing.
  const value = React.useMemo(
    () => ({
      selectedTranslation,
      setSelectedTranslationId,
      translationLanguage,
      setTranslationLanguage,
      getTranslation,
      fetchSurahTranslations,
      isLoading,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedTranslation, setSelectedTranslationId, translationLanguage, setTranslationLanguage, getTranslation, fetchSurahTranslations, isLoading, translationsCache]
  );

  return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>;
}

export function useTranslationContext() {
  const context = useContext(TranslationContext);
  if (context === undefined) {
    throw new Error("useTranslationContext must be used within a TranslationProvider");
  }
  return context;
}
