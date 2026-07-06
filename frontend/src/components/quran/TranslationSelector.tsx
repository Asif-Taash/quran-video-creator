"use client";

import { useTranslationContext, TRANSLATION_OPTIONS } from "@/lib/TranslationContext";
import { useLanguage } from "@/lib/LanguageContext";
import DropdownSelect from "@/components/ui/DropdownSelect";
import { useEffect } from "react";

export default function TranslationSelector({ 
  className,
  variant = "default",
  forceShow = false
}: { 
  className?: string;
  variant?: "default" | "toolbar";
  forceShow?: boolean;
}) {
  const { selectedTranslation, setSelectedTranslationId, isLoading } = useTranslationContext();
  const { language } = useLanguage();

  useEffect(() => {
    if (variant === "toolbar" && selectedTranslation.id === "none") {
      setSelectedTranslationId("diyanet_yeni");
    }
  }, [variant, selectedTranslation.id, setSelectedTranslationId]);

  if (language === "ar" && !forceShow) {
    return null;
  }

  const wrapperClass = className || (variant === "toolbar" ? "w-[240px]" : "w-full sm:w-[240px]");

  const options = TRANSLATION_OPTIONS
    .filter((opt) => variant === "default" || opt.id !== "none")
    .map((opt) => ({
      value: opt.id,
      label: opt.name,
    }));

  return (
    <div className={`relative inline-block ${wrapperClass}`}>
      <DropdownSelect
        options={options}
        value={selectedTranslation.id}
        onChange={(val) => setSelectedTranslationId(val as string)}
        placeholder="Çeviri seçin..."
        disabled={isLoading}
        showNumberBadge={variant === "default"}
        numberBadgeLabel={variant === "default" ? ((val) => String(TRANSLATION_OPTIONS.findIndex(o => o.id === val) + 1)) : undefined}
        buttonClassName={
          variant === "toolbar" 
            ? "rounded-full border border-primary/30 bg-primary/10 text-primary hover:bg-primary/15 px-4 py-2 font-medium" 
            : undefined
        }
      />
      {isLoading && (
        <div className="absolute top-1/2 right-12 -translate-y-1/2 flex items-center">
          <div className="h-4 w-4 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
        </div>
      )}
    </div>
  );
}
