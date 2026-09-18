"use client";

import { useRef } from "react";
import DropdownSelect from "@/components/ui/DropdownSelect";
import TranslationSelector from "@/components/quran/TranslationSelector";
import QuranSearch from "../QuranSearch";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { fixMojibake } from "@/lib/textEncoding";
import { ARABIC_FONT_OPTIONS, TRANSLATION_FONT_OPTIONS, type ArabicFontKey, type TranslationFontKey } from "@/remotion/types";
import type { Surah, Verse, ApiSurah, RenderState } from "../VideoCreatorForm";

interface Step1Props {
  isArabic: boolean;
  surahs: Surah[];
  surahTurkishNames: Map<number, string>;
  selectedSurah: Surah | null;
  setSelectedSurah: (s: Surah | null) => void;
  setSelectedApiSurah: (s: ApiSurah | null) => void;
  startVerse: number | null;
  setStartVerse: (n: number | null) => void;
  endVerse: number | null;
  setEndVerse: (n: number | null) => void;
  setVideoUrl: (v: string | null) => void;
  setRenderError: (s: string) => void;
  setRenderState: (s: RenderState) => void;
  handleAddNextVerse: () => void;
  handleRemoveLastVerse: () => void;
  versesArray: number[];
  selectedVersesContent: (Verse & { translation?: string; textV1?: string; pageV1?: number })[];
  lowConfidenceAyahs: Set<number>;
  onSearchOpenChange?: (isOpen: boolean) => void;
  // Which Arabic verse script to use -- see ARABIC_FONT_OPTIONS in
  // types.ts. Applied instantly to the live preview client-side (see
  // VideoCreatorForm's own effect), no server round-trip needed.
  arabicFont: ArabicFontKey;
  onArabicFontChange: (font: ArabicFontKey) => void;
  // Which translation font to use -- one of TRANSLATION_FONT_OPTIONS' keys,
  // or "custom" for a user-uploaded font file (see
  // onCustomTranslationFontUpload below). Same instant client-side
  // switching as arabicFont above.
  translationFont: TranslationFontKey | "custom";
  onTranslationFontChange: (font: TranslationFontKey | "custom") => void;
  // The uploaded custom font's own original filename, for display only
  // (null until one has actually been uploaded this session or restored
  // from a saved draft) -- see VideoCreatorForm's customTranslationFontName.
  customTranslationFontName: string | null;
  // The uploaded custom font's actual URL (blob: preview or a restored
  // draft's served path) -- needed here (unlike customTranslationFontName)
  // to declare the @font-face that lets the verse-list preview below
  // render it, same as QuranVideo.tsx's own PageFontStyles.
  customTranslationFontUrl: string | null;
  onCustomTranslationFontUpload: (file: File) => void;
}

// Mirrors QuranVideo.tsx's own TRANSLATION_FONT_FILES registry (kept as a
// separate, duplicated literal there rather than shared through types.ts,
// same as the QCF v2 page-font directory below) -- so this preview box's
// translation text can switch fonts instantly, exactly like the real
// live-preview player already does.
const TRANSLATION_FONT_FILES: Record<TranslationFontKey, { path: string; format: "opentype" | "woff2" }> = {
  aileron: { path: "/fonts/video-fonts/Aileron-Thin.otf", format: "opentype" },
  inter: { path: "/fonts/video-fonts/Inter-Regular.woff2", format: "woff2" },
  notosans: { path: "/fonts/video-fonts/NotoSans-Regular.woff2", format: "woff2" },
  poppins: { path: "/fonts/video-fonts/Poppins-Regular.woff2", format: "woff2" },
};

const CUSTOM_TRANSLATION_FONT_FAMILY = "CustomTranslationFont";

// Same heuristic as QuranVideo.tsx's guessFontFormat -- a user-uploaded
// font's extension is the only signal available for its @font-face format().
function guessFontFormat(url: string): string {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  if (ext === "woff2") return "woff2";
  if (ext === "woff") return "woff";
  if (ext === "otf") return "opentype";
  return "truetype";
}

export default function Step1SurahVerse({
  isArabic,
  surahs,
  surahTurkishNames,
  selectedSurah,
  setSelectedSurah,
  setSelectedApiSurah,
  startVerse,
  setStartVerse,
  endVerse,
  setEndVerse,
  setVideoUrl,
  setRenderError,
  setRenderState,
  handleAddNextVerse,
  handleRemoveLastVerse,
  versesArray,
  selectedVersesContent,
  lowConfidenceAyahs,
  onSearchOpenChange,
  arabicFont,
  onArabicFontChange,
  translationFont,
  onTranslationFontChange,
  customTranslationFontName,
  customTranslationFontUrl,
  onCustomTranslationFontUpload,
}: Step1Props) {
  const customFontInputRef = useRef<HTMLInputElement>(null);

  // "custom" itself is only ever a REAL selectable option once a file has
  // actually been uploaded (this session or restored from a saved draft --
  // see customTranslationFontName) -- picking it before that just opens the
  // file picker instead of selecting a family nothing has been given yet.
  const translationFontOptions = [
    ...(Object.keys(TRANSLATION_FONT_OPTIONS) as TranslationFontKey[]).map((key) => ({
      value: key,
      label: TRANSLATION_FONT_OPTIONS[key].label,
    })),
    customTranslationFontName
      ? { value: "custom", label: isArabic ? "الخط المخصص" : "Özel Yazı Tipi", subtitle: customTranslationFontName }
      : { value: "custom", label: isArabic ? "خط خارجي (تحميل ملف)..." : "Özel Yazı Tipi (Dosya Yükle)..." },
  ];

  const handleTranslationFontSelect = (value: string | number) => {
    if (value === "custom" && !customTranslationFontName) {
      customFontInputRef.current?.click();
      return;
    }
    onTranslationFontChange(value as TranslationFontKey | "custom");
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <DropdownSelect
          label={isArabic ? "السورة" : "Sure"}
          placeholder={isArabic ? "اختر السورة..." : "Sure seçin..."}
          options={surahs.map((surah) => {
            const turkishName = surahTurkishNames.get(surah.id);
            let label: string;
            if (isArabic) {
              label = `سورة ${fixMojibake(surah.name)}`;
            } else if (turkishName) {
              label = `${fixMojibake(turkishName)} Suresi`;
            } else {
              label = `${fixMojibake(surah.transliteration)} Suresi`;
            }
            return {
              value: String(surah.id),
              label,
            };
          })}
          value={selectedSurah ? String(selectedSurah.id) : null}
          onChange={(val) => {
            const surah = surahs.find((s) => String(s.id) === val);
            setSelectedSurah(surah || null);
            if (surah) {
              setStartVerse(1);
              setEndVerse(1);
            }
          }}
          isRtl={isArabic}
          showNumberBadge
          disabled={false}
          enableSearch={true}
          searchPlaceholder={isArabic ? "ابحث عن سورة..." : "Sure ara..."}
        />

        <div className="space-y-1.5 flex flex-col justify-end">
          <label className="text-sm font-medium text-foreground">
            {isArabic ? "الترجمة" : "Çeviri"}
          </label>
          <div className="h-[50px] flex items-center w-full">
            <TranslationSelector className="w-full" forceShow={true} />
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium text-foreground">
            {isArabic ? "الآية الأولى" : "İlk Ayet"}
          </label>
          <input
            type="number"
            min={1}
            max={selectedSurah?.total_verses ?? 1}
            value={startVerse ?? ""}
            onChange={(e) => {
              const val = e.target.valueAsNumber;
              if (!isNaN(val)) {
                let num = Number(val);
                if (isNaN(num) || num < 1) num = 1;
                if (selectedSurah && num > selectedSurah.total_verses) num = selectedSurah.total_verses;
                setStartVerse(num);
                setEndVerse(num);
                setVideoUrl(null);
                setRenderError("");
                setRenderState("idle");
              } else if (e.target.value === "") {
                setStartVerse(null);
                setEndVerse(null);
              }
            }}
            disabled={!selectedSurah}
            placeholder={
              selectedSurah
                ? (isArabic ? "رقم الآية..." : "Ayet numarası...")
                : (isArabic ? "أولاً اختر السورة" : "Önce sure seçin")
            }
            className="w-full h-[50px] rounded-xl border border-border bg-background px-4 py-2.5 text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
            dir={isArabic ? "rtl" : "ltr"}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <DropdownSelect
          label={isArabic ? "الخط العربي" : "Arapça Yazı Tipi"}
          placeholder={isArabic ? "اختر الخط..." : "Yazı tipi seçin..."}
          options={(Object.keys(ARABIC_FONT_OPTIONS) as ArabicFontKey[]).map((key) => ({
            value: key,
            label: isArabic ? ARABIC_FONT_OPTIONS[key].labelAr : ARABIC_FONT_OPTIONS[key].labelTr,
          }))}
          value={arabicFont}
          onChange={(val) => onArabicFontChange(val as ArabicFontKey)}
          isRtl={isArabic}
        />

        <div>
          <DropdownSelect
            label={isArabic ? "خط الترجمة" : "Çeviri Yazı Tipi"}
            placeholder={isArabic ? "اختر الخط..." : "Yazı tipi seçin..."}
            options={translationFontOptions}
            value={translationFont}
            onChange={handleTranslationFontSelect}
            isRtl={isArabic}
          />
          <input
            ref={customFontInputRef}
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

      <div className="mt-4">
        <QuranSearch
          onOpenChange={onSearchOpenChange}
          getSurahName={(id) => {
            const surah = surahs.find((s) => s.id === id);
            if (!surah) return "";
            if (isArabic) return fixMojibake(surah.name);
            const turkishName = surahTurkishNames.get(id);
            return turkishName ? fixMojibake(turkishName) : fixMojibake(surah.transliteration);
          }}
          onSelectVerse={(surahId, ayahNumber) => {
            const surah = surahs.find((s) => s.id === surahId);
            if (surah) {
              setSelectedSurah(surah);
              setSelectedApiSurah(null);
              setStartVerse(ayahNumber);
              setEndVerse(ayahNumber);
              setVideoUrl(null);
              setRenderError("");
              setRenderState("idle");
            }
          }}
        />
      </div>

      {startVerse && endVerse && selectedSurah && (
        <div className="animate-slide-up mt-6 space-y-5 rounded-2xl border border-border/50 bg-gradient-to-br from-surface/80 to-background p-4 sm:p-5 shadow-inner-soft backdrop-blur-sm transition-all duration-300">
          <div className="flex items-center justify-between gap-2 px-1 flex-wrap">
            <h3 className="text-sm font-semibold text-foreground/80">
              {isArabic
                ? `الآيات المختارة (${versesArray.length})`
                : `Seçili Ayetler (${versesArray.length})`}
            </h3>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleAddNextVerse}
                disabled={endVerse >= selectedSurah.total_verses}
                className="inline-flex items-center gap-1 rounded-lg bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary transition-all hover:bg-primary/20 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                + {isArabic ? "أضف الآية التالية" : "Sonraki Ayeti Ekle"}
              </button>
              <button
                type="button"
                onClick={handleRemoveLastVerse}
                disabled={endVerse <= startVerse}
                className="inline-flex items-center gap-1 rounded-lg bg-accent-red-bg/60 px-2.5 py-1 text-xs font-medium text-accent-red transition-all hover:bg-accent-red-bg disabled:opacity-40 disabled:cursor-not-allowed"
              >
                - {isArabic ? "إزالة آخر آية" : "Son Ayeti Kaldır"}
              </button>
            </div>
            <span className="text-xs font-medium text-muted-foreground">
              {isArabic ? fixMojibake(selectedSurah.name) : fixMojibake(selectedSurah.transliteration)}
            </span>
          </div>

          {/* Per-page PUA fonts, both scripts:
            the local Quran text (verse.text/textV1, used whenever the live
            API text_arabic hasn't loaded yet) is encoded with page-specific
            QCF glyph codepoints, not standard Unicode, so it renders as
            garbled placeholder glyphs under any generic Arabic font. Both
            v2 ('p{page}') and v1 ('pv1-{page}') are always declared
            regardless of which arabicFont is CURRENTLY selected -- same
            reasoning as QuranVideo.tsx's own PageFontStyles -- so switching
            the dropdown here is instant, no re-render-triggered flash of
            missing glyphs. Translation fonts (built-in + optional custom
            upload) are declared the same way, for the same reason. */}
          <style
            dangerouslySetInnerHTML={{
              __html: [
                ...Array.from(new Set(selectedVersesContent.map((v) => v.page).filter(Boolean))).map(
                  (page) => `
                  @font-face {
                    font-family: 'p${page}';
                    src: url('/fonts/2013/QCF2BSMLfonts/QCF2${String(page).padStart(3, "0")}.ttf') format('truetype');
                    font-weight: normal;
                    font-style: normal;
                    font-display: swap;
                  }
                `
                ),
                ...Array.from(new Set(selectedVersesContent.map((v) => v.pageV1).filter(Boolean))).map(
                  (page) => `
                  @font-face {
                    font-family: 'pv1-${page}';
                    src: url('/fonts/2005/QCF_BSML.fonts/QCF_P${String(page).padStart(3, "0")}.ttf') format('truetype');
                    font-weight: normal;
                    font-style: normal;
                    font-display: swap;
                  }
                `
                ),
                ...(Object.keys(TRANSLATION_FONT_OPTIONS) as TranslationFontKey[]).map((key) => {
                  const { family } = TRANSLATION_FONT_OPTIONS[key];
                  const { path, format } = TRANSLATION_FONT_FILES[key];
                  return `
                  @font-face {
                    font-family: '${family}';
                    src: url('${path}') format('${format}');
                    font-display: swap;
                  }
                `;
                }),
                customTranslationFontUrl
                  ? `
                  @font-face {
                    font-family: '${CUSTOM_TRANSLATION_FONT_FAMILY}';
                    src: url('${customTranslationFontUrl}') format('${guessFontFormat(customTranslationFontUrl)}');
                    font-display: swap;
                  }
                `
                  : "",
              ].join("\n"),
            }}
          />

          <div className="max-h-[420px] space-y-4 overflow-y-auto custom-scrollbar pr-1 -mr-1">
            {selectedVersesContent.map((verse) => {
              const isQcf1 = arabicFont === "qcf1";
              const arabicText = isQcf1 ? (verse.textV1 ?? verse.text) : verse.text;
              const arabicPage = isQcf1 ? (verse.pageV1 ?? verse.page) : verse.page;
              const arabicStyle = { fontFamily: arabicPage ? `'${isQcf1 ? "pv1-" : "p"}${arabicPage}'` : undefined };
              const translationFontFamily =
                translationFont === "custom"
                  ? customTranslationFontUrl
                    ? `'${CUSTOM_TRANSLATION_FONT_FAMILY}', Arial, sans-serif`
                    : undefined
                  : `'${TRANSLATION_FONT_OPTIONS[translationFont].family}', Arial, sans-serif`;

              return (
                <div
                  key={verse.id}
                  className="rounded-xl border border-border/60 bg-background/70 p-3.5 sm:p-4 space-y-3.5 transition-colors hover:border-primary/30"
                >
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                      {verse.id}
                    </span>
                    {lowConfidenceAyahs.has(verse.id) && (
                      <span
                        className="flex items-center gap-1 rounded-full bg-accent-amber-bg/60 border border-accent-amber/30 px-2 py-0.5 text-[11px] font-medium text-accent-amber"
                        title={isArabic ? "لم يصل الذكاء الاصطناعي لنتيجة موثوقة لهذه الآية — يُنصح بمراجعة التقسيم في نافذة التوقيت" : "Yapay zeka bu ayet için güvenilir bir sonuca ulaşamadı — bölümlemeyi zamanlama penceresinde kontrol etmeniz önerilir"}
                      >
                        <ExclamationTriangleIcon className="w-3.5 h-3.5" />
                        {isArabic ? "يحتاج مراجعة" : "Kontrol gerekli"}
                      </span>
                    )}
                  </div>

                  {/* Purely a read-only preview -- splitting/editing the
                      translation per-part now happens entirely in the
                      timing window (SegmentTimingEditor), not here. */}
                  <p
                    dir="rtl"
                    className={`font-uthmanic-hafs ${
                      // qcf1's glyphs render visibly smaller than qcf2's at the
                      // same font-size -- bumped up here by the same
                      // sizeMultiplier QuranVideo.tsx applies to the real
                      // render/live preview (see ARABIC_FONT_OPTIONS in
                      // types.ts), expressed as Tailwind arbitrary values
                      // since text-xl/text-2xl's own rem values aren't
                      // otherwise reachable for a plain numeric multiply.
                      isQcf1 ? "text-[1.4375rem] sm:text-[1.725rem]" : "text-xl sm:text-2xl"
                    } text-foreground break-words`}
                    style={{ ...arabicStyle, lineHeight: "2.8" }}
                  >
                    {arabicText}
                  </p>
                  {verse.translation && (
                    <p
                      dir={isArabic ? "rtl" : "ltr"}
                      className="border-t border-border/40 pt-2 text-xs sm:text-sm leading-relaxed text-primary break-words"
                      style={{ fontFamily: translationFontFamily }}
                    >
                      {verse.translation}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
