"use client";

import { useRef } from "react";
import DropdownSelect from "@/components/ui/DropdownSelect";
import { useT } from "@/lib/LanguageContext";
import { useTranslationContext } from "@/lib/TranslationContext";
import {
  ARABIC_FONT_OPTIONS,
  TRANSLATION_FONT_OPTIONS,
  resolveTranslationFont,
  translationFontSupports,
  type ArabicFontKey,
  type TranslationFontKey,
} from "@/remotion/types";

// The video's two fonts (2026-11-20: moved from the ayah selection to the
// Text section under the video, where their effect is seen): the Arabic
// script (ARABIC_FONT_OPTIONS) and the translation's, or a font file of the
// user's own. Both apply to the preview at once.
export default function TextFontPickers({
  isArabic,
  arabicFont,
  onArabicFontChange,
  translationFont,
  onTranslationFontChange,
  customTranslationFontName,
  hasCustomFont,
  onCustomTranslationFontUpload,
}: {
  isArabic: boolean;
  arabicFont: ArabicFontKey;
  onArabicFontChange: (font: ArabicFontKey) => void;
  translationFont: TranslationFontKey | "custom";
  onTranslationFontChange: (font: TranslationFontKey | "custom") => void;
  // The uploaded font's original filename (null until one is uploaded or a
  // saved project restores it).
  customTranslationFontName: string | null;
  hasCustomFont: boolean;
  onCustomTranslationFontUpload: (file: File) => void;
}) {
  const tx = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const { translationLanguage } = useTranslationContext();

  // Only fonts whose letters cover the translation's language (Arabic ones
  // for an Arabic tafsir, Latin ones for Turkish/English). "custom" opens
  // the file picker until a file has been given.
  const translationOptions = [
    ...(Object.keys(TRANSLATION_FONT_OPTIONS) as TranslationFontKey[])
      .filter((key) => translationFontSupports(key, translationLanguage))
      .map((key) => ({ value: key, label: TRANSLATION_FONT_OPTIONS[key].label })),
    customTranslationFontName
      ? { value: "custom", label: tx("الخط المخصص", "Özel Yazı Tipi", "Custom Font"), subtitle: customTranslationFontName }
      : { value: "custom", label: tx("خط من ملف...", "Dosyadan yazı tipi...", "Font from a file...") },
  ];

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <DropdownSelect
        label={tx("خط الآيات", "Ayet Yazı Tipi", "Ayah Font")}
        placeholder={tx("اختر الخط...", "Yazı tipi seçin...", "Choose a font...")}
        options={(Object.keys(ARABIC_FONT_OPTIONS) as ArabicFontKey[]).map((key) => ({
          value: key,
          label: tx(ARABIC_FONT_OPTIONS[key].labelAr, ARABIC_FONT_OPTIONS[key].labelTr, ARABIC_FONT_OPTIONS[key].labelEn),
        }))}
        value={arabicFont}
        onChange={(val) => onArabicFontChange(val as ArabicFontKey)}
        isRtl={isArabic}
      />
      <div>
        <DropdownSelect
          label={tx("خط الترجمة", "Çeviri Yazı Tipi", "Translation Font")}
          placeholder={tx("اختر الخط...", "Yazı tipi seçin...", "Choose a font...")}
          options={translationOptions}
          value={resolveTranslationFont(translationFont, translationLanguage, hasCustomFont)}
          onChange={(value) => {
            if (value === "custom" && !customTranslationFontName) {
              fileRef.current?.click();
              return;
            }
            onTranslationFontChange(value as TranslationFontKey | "custom");
          }}
          isRtl={isArabic}
        />
        <input
          ref={fileRef}
          type="file"
          accept=".ttf,.otf,.woff,.woff2"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onCustomTranslationFontUpload(file);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
