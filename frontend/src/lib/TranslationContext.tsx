"use client";

import React, { createContext, useContext, useEffect, useState } from "react";

export type TranslationOption = {
  id: string;
  name: string;
  resourceId: number;
};

export const TRANSLATION_OPTIONS: TranslationOption[] = [
  { id: "none", name: "Çeviri yok...", resourceId: 0 },
  { id: "diyanet_yeni", name: "Diyanet İşleri Meali (Yeni)", resourceId: 77 },
  { id: "diyanet_eski", name: "Diyanet İşleri Meali (Eski)", resourceId: 77 },
  { id: "ahmet_varol", name: "Ahmet Varol Meali", resourceId: 124 },
  { id: "elmalili", name: "Elmalılı Hamdi Yazır Meali", resourceId: 52 },
];

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
    const cacheKey = `${selectedTranslationId}_${surahId}`;
    if (translationsCache[cacheKey]) return; // Already cached

    setIsLoading(true);
    try {
      const resourceId = selectedTranslation.resourceId;
      if (resourceId === 0) return; // "none" option
      
      // Fetch specifically for this chapter to minimize payload, but ensure we get all verses (up to 300 to cover Baqarah)
      const res = await fetch(`https://api.quran.com/api/v4/verses/by_chapter/${surahId}?translations=${resourceId}&per_page=300`);
      if (res.ok) {
        const data = await res.json();
        const map: Record<string, string> = {};
        if (data.verses) {
          data.verses.forEach((v: any) => {
            if (v.translations && v.translations.length > 0) {
              map[v.verse_key] = v.translations[0].text.replace(/<[^>]+>/g, ''); // strip HTML
            }
          });
        }
        setTranslationsCache((prev) => ({ ...prev, [cacheKey]: map }));
      }
    } catch (error) {
      console.error("Failed to fetch translations", error);
    } finally {
      setIsLoading(false);
    }
  };

  const getTranslation = (surahId: number, ayahId: number, fallback: string) => {
    if (selectedTranslationId === "none") return "";
    
    const cacheKey = `${selectedTranslationId}_${surahId}`;
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
