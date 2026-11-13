"use client";

import React, { createContext, useCallback, useContext, useState, useEffect } from "react";

export type Language = "tr" | "ar" | "en";

const LANGUAGES: Language[] = ["tr", "ar", "en"];

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

function applyDocumentLanguage(lang: Language) {
  document.documentElement.setAttribute("lang", lang);
  document.documentElement.setAttribute("dir", lang === "ar" ? "rtl" : "ltr");
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>("tr");

  useEffect(() => {
    const saved = localStorage.getItem("preferred-lang") as Language;
    if (LANGUAGES.includes(saved)) {
      setLanguageState(saved);
      applyDocumentLanguage(saved);
    }
  }, []);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem("preferred-lang", lang);
    applyDocumentLanguage(lang);
  };

  return (
    <LanguageContext.Provider value={{ language, setLanguage }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (context === undefined) {
    throw new Error("useLanguage must be used within a LanguageProvider");
  }
  return context;
}

/** Picks the string for the current site language: t(arabic, turkish, english). */
export function useT() {
  const { language } = useLanguage();
  return useCallback(
    <T,>(ar: T, tr: T, en: T): T => (language === "ar" ? ar : language === "en" ? en : tr),
    [language]
  );
}
