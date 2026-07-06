"use client";

import * as React from "react";
import { GlobeAltIcon } from "@heroicons/react/24/outline";
import { useLanguage } from "@/lib/LanguageContext";

export function LanguageToggle() {
  const { language, setLanguage } = useLanguage();
  const [mounted, setMounted] = React.useState(false);
  const [isOpen, setIsOpen] = React.useState(false);
  const dropdownRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    setMounted(true);
    
    // Close dropdown on outside click
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  if (!mounted) {
    return <div className="w-9 h-9" />;
  }

  const handleSelect = (lang: "tr" | "ar") => {
    setLanguage(lang);
    setIsOpen(false);
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-center p-2 rounded-full text-foreground hover:bg-surface transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
        aria-label="تغيير اللغة / Dili Değiştir"
        title="تغيير اللغة / Dili Değiştir"
      >
        <GlobeAltIcon className={`w-5 h-5 transition-colors ${isOpen ? 'text-primary' : 'text-foreground/70'}`} />
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-32 rounded-xl bg-surface border border-border shadow-lg py-1 z-50 animate-fade-in origin-top-right">
          <button
            onClick={() => handleSelect("ar")}
            className={`w-full text-right px-4 py-2 text-sm font-arabic hover:bg-primary/10 transition-colors ${language === 'ar' ? 'text-primary font-bold' : 'text-foreground'}`}
            dir="rtl"
          >
            العربية
          </button>
          <button
            onClick={() => handleSelect("tr")}
            className={`w-full text-left px-4 py-2 text-sm font-sans hover:bg-primary/10 transition-colors ${language === 'tr' ? 'text-primary font-bold' : 'text-foreground'}`}
          >
            Türkçe
          </button>
        </div>
      )}
    </div>
  );
}
