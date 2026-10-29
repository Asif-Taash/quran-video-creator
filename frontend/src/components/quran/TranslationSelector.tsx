"use client";

import { useTranslationContext, TRANSLATION_OPTIONS, type TranslationLanguage } from "@/lib/TranslationContext";
import { TRANSLATION_LANGUAGES } from "@/lib/translationOptions";
import { useT } from "@/lib/LanguageContext";
import DropdownSelect from "@/components/ui/DropdownSelect";
import Spinner from "@/components/ui/Spinner";
import { useEffect } from "react";

// Two pickers side by side: the translation/tafsir LANGUAGE (defaults to the
// site language, see TranslationContext) and the editions in that language.
export default function TranslationSelector({
  className,
  variant = "default",
}: {
  className?: string;
  variant?: "default" | "toolbar";
  // Kept for callers; the selector used to hide itself in the Arabic UI back
  // when only Turkish translations existed.
  forceShow?: boolean;
}) {
  const {
    selectedTranslation,
    setSelectedTranslationId,
    translationLanguage,
    setTranslationLanguage,
    isLoading,
  } = useTranslationContext();
  const t = useT();

  const editions = TRANSLATION_OPTIONS.filter((opt) => opt.language === translationLanguage);

  useEffect(() => {
    if (variant === "toolbar" && selectedTranslation.id === "none" && editions.length > 0) {
      setSelectedTranslationId(editions[0].id);
    }
  }, [variant, selectedTranslation.id, setSelectedTranslationId, editions]);

  const wrapperClass = className || (variant === "toolbar" ? "w-[340px]" : "w-full sm:w-[340px]");

  const options = [
    ...(variant === "default" ? [{ value: "none", label: t("بدون ترجمة", "Çeviri yok", "No translation") }] : []),
    ...editions.map((opt) => ({ value: opt.id, label: opt.name })),
  ];
  const languageOptions = TRANSLATION_LANGUAGES.map((l) => ({ value: l.id, label: l.label }));
  const toolbarButtonClass =
    variant === "toolbar"
      ? "rounded-full border border-primary/30 bg-primary/10 text-primary hover:bg-primary/15 px-4 py-2 font-medium"
      : undefined;

  return (
    <div className={`flex items-center gap-2 ${wrapperClass}`}>
      <div className="w-[118px] shrink-0">
        <DropdownSelect
          options={languageOptions}
          value={translationLanguage}
          onChange={(val) => setTranslationLanguage(val as TranslationLanguage)}
          placeholder={t("اللغة", "Dil", "Language")}
          buttonClassName={toolbarButtonClass}
        />
      </div>
      <div className="relative min-w-0 flex-1">
        <DropdownSelect
          options={options}
          value={selectedTranslation.id}
          onChange={(val) => setSelectedTranslationId(val as string)}
          placeholder={t("اختر الترجمة...", "Çeviri seçin...", "Choose a translation...")}
          disabled={isLoading}
          isRtl={translationLanguage === "ar"}
          showNumberBadge={variant === "default"}
          numberBadgeLabel={variant === "default" ? (val) => String(options.findIndex((o) => o.value === val) + 1) : undefined}
          buttonClassName={toolbarButtonClass}
        />
        {isLoading && (
          <div className="absolute top-1/2 right-12 -translate-y-1/2 flex items-center">
            <Spinner size="sm" />
          </div>
        )}
      </div>
    </div>
  );
}
