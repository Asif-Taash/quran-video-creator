"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import DropdownSelect from "@/components/ui/DropdownSelect";
import TranslationSelector from "@/components/quran/TranslationSelector";
import QuranSearch from "../QuranSearch";
import { ExclamationTriangleIcon, MinusIcon, PlusIcon } from "@heroicons/react/24/outline";
import { fixMojibake } from "@/lib/textEncoding";
import { findSurahJump } from "@/lib/surahJump";
import {
  TRANSLATION_FONT_OPTIONS,
  resolveTranslationFont,
  translationFontStack,
  type ArabicFontKey,
  type TranslationFontKey,
} from "@/remotion/types";
import { useTranslationContext } from "@/lib/TranslationContext";
import { surahEnglishName } from "@/lib/surahEnglishNames";
import type { Surah, Verse, RenderState } from "../VideoCreatorForm";

import { useLanguage, useT } from "@/lib/LanguageContext";
import { BASMALA_VERSE_ID } from "@/lib/basmala";
interface Step1Props {
  isArabic: boolean;
  surahs: Surah[];
  surahTurkishNames: Map<number, string>;
  selectedSurah: Surah | null;
  setSelectedSurah: (s: Surah | null) => void;
  startVerse: number | null;
  setStartVerse: (n: number | null) => void;
  endVerse: number | null;
  setEndVerse: (n: number | null) => void;
  setRenderError: (s: string) => void;
  setRenderState: (s: RenderState) => void;
  handleAddNextVerse: () => void;
  handleRemoveLastVerse: () => void;
  versesArray: number[];
  // The basmala first when the video starts with it (BASMALA_VERSE_ID).
  selectedVersesContent: (Verse & { translation?: string; textV1?: string; pageV1?: number })[];
  // The selection starts at ayah 1 of a surah with a basmala, and whether
  // the video starts with it (see lib/basmala.ts).
  canStartWithBasmala: boolean;
  startsWithBasmala: boolean;
  onToggleBasmala: () => void;
  lowConfidenceAyahs: Set<number>;
  // The fonts the ayah list below previews in (chosen under the video, in
  // its Text section -- see TextFontPickers).
  arabicFont: ArabicFontKey;
  translationFont: TranslationFontKey | "custom";
  // The uploaded custom font's URL (blob: preview or a restored draft's
  // served path), to declare the @font-face that lets the list render it,
  // same as QuranVideo.tsx's own PageFontStyles.
  customTranslationFontUrl: string | null;
}

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";

// An ayah number box: what is typed is taken once it's done -- on Enter,
// on leaving the box, or after a short pause -- not digit by digit (typing
// 13 would otherwise pick ayah 1 first and start preparing its audio).
function AyahNumberField({
  value,
  min,
  max,
  disabled,
  placeholder,
  onCommit,
  ariaLabel,
}: {
  value: number | null;
  min: number;
  max: number;
  disabled: boolean;
  placeholder: string;
  onCommit: (n: number) => void;
  ariaLabel: string;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  const timerRef = useRef<number | null>(null);
  useEffect(() => setText(value === null ? "" : String(value)), [value]);
  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);
  const commit = (raw: string) => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) {
      setText(value === null ? "" : String(value));
      return;
    }
    const clamped = Math.min(Math.max(n, min), max);
    setText(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={ariaLabel}
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => {
        const typed = e.target.value.replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d))).replace(/\D/g, "");
        setText(typed);
        if (timerRef.current) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => commit(typed), 1000);
      }}
      onBlur={() => commit(text)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit(text);
      }}
      className="h-full w-full min-w-0 bg-transparent text-center text-base font-semibold tabular-nums text-foreground outline-none placeholder:text-sm placeholder:font-normal placeholder:text-muted-foreground disabled:cursor-not-allowed"
    />
  );
}

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
  startVerse,
  setStartVerse,
  endVerse,
  setEndVerse,
  setRenderError,
  setRenderState,
  handleAddNextVerse,
  handleRemoveLastVerse,
  versesArray,
  selectedVersesContent,
  canStartWithBasmala,
  startsWithBasmala,
  onToggleBasmala,
  lowConfidenceAyahs,
  arabicFont,
  translationFont,
  customTranslationFontUrl,
}: Step1Props) {
  const tx = useT();
  const { selectedTranslation } = useTranslationContext();
  // The translation preview's direction follows the TRANSLATION's language,
  // not the interface's (an English translation stays LTR in the Arabic UI).
  const translationRtl = selectedTranslation.language === "ar";
  const hasCustomFont = Boolean(customTranslationFontUrl);
  const { language } = useLanguage();

  // Joined into strings first so the memo below only recomputes when the
  // pages/font actually change, not on every new selectedVersesContent array.
  const v2Pages = Array.from(new Set(selectedVersesContent.map((v) => v.page).filter(Boolean))).join(",");
  const v1Pages = Array.from(new Set(selectedVersesContent.map((v) => v.pageV1).filter(Boolean))).join(",");
  const fontFaceCss = useMemo(
    () =>
      [
        ...(v2Pages ? v2Pages.split(",") : []).map(
          (page) => `
                  @font-face {
                    font-family: 'p${page}';
                    src: url('/fonts/2013/QCF2BSMLfonts/QCF2${page.padStart(3, "0")}.ttf') format('truetype');
                    font-weight: normal;
                    font-style: normal;
                    font-display: swap;
                  }
                `
        ),
        ...(v1Pages ? v1Pages.split(",") : []).map(
          (page) => `
                  @font-face {
                    font-family: 'pv1-${page}';
                    src: url('/fonts/2005/QCF_BSML.fonts/QCF_P${page.padStart(3, "0")}.ttf') format('truetype');
                    font-weight: normal;
                    font-style: normal;
                    font-display: swap;
                  }
                `
        ),
        ...(Object.keys(TRANSLATION_FONT_OPTIONS) as TranslationFontKey[]).map((key) => {
          const { family, file, format, weight } = TRANSLATION_FONT_OPTIONS[key];
          return `
                  @font-face {
                    font-family: '${family}';
                    src: url('/${file}') format('${format}');
                    font-weight: ${weight};
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
    [v2Pages, v1Pages, customTranslationFontUrl]
  );

  const surahName = (id: number) => {
    const surah = surahs.find((s) => s.id === id);
    if (!surah) return "";
    if (isArabic) return fixMojibake(surah.name);
    if (language === "en") return surahEnglishName(id) ?? fixMojibake(surah.transliteration);
    const turkishName = surahTurkishNames.get(id);
    return turkishName ? fixMojibake(turkishName) : fixMojibake(surah.transliteration);
  };
  // Every name a surah goes by, for going straight to it from the search box.
  const jumpSurahs = useMemo(
    () =>
      surahs.map((surah) => ({
        id: surah.id,
        totalVerses: surah.total_verses,
        names: [
          fixMojibake(surah.name),
          fixMojibake(surah.transliteration),
          surahEnglishName(surah.id) ?? "",
          fixMojibake(surahTurkishNames.get(surah.id) ?? ""),
        ].filter(Boolean),
      })),
    [surahs, surahTurkishNames]
  );
  const selectRange = (surahId: number, fromAyah: number, toAyah: number) => {
    const surah = surahs.find((s) => s.id === surahId);
    if (!surah) return;
    setSelectedSurah(surah);
    setStartVerse(fromAyah);
    setEndVerse(toAyah);
    setRenderError("");
    setRenderState("idle");
  };
  const total = selectedSurah?.total_verses ?? 1;
  const fieldShell =
    "flex h-[50px] items-stretch overflow-hidden rounded-xl border border-border bg-background shadow-sm transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20";
  const stepButton =
    "flex w-10 flex-shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary disabled:pointer-events-none disabled:opacity-30";

  return (
    <div className="space-y-5">
      {/* The quickest way in first: find the ayah by its words, its meaning,
          its surah and number ("البقرة 255"), or by reciting it (🎤). */}
      <QuranSearch
        getSurahName={surahName}
        resolveJump={(q) => findSurahJump(q, jumpSurahs)}
        onSelectVerse={(surahId, ayahNumber) => selectRange(surahId, ayahNumber, ayahNumber)}
        onSelectRange={selectRange}
      />

      <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden>
        <span className="h-px flex-1 bg-border" />
        {tx("أو اختر بنفسك", "ya da kendiniz seçin", "or choose yourself")}
        <span className="h-px flex-1 bg-border" />
      </div>

      {/* Surah, then the range: from (a new start is one ayah again, as
          before) and to (with − / + beside it). */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-[minmax(0,1fr)_9.5rem_11rem]">
        <div className="col-span-2 md:col-span-1">
          <DropdownSelect
            label={tx("السورة", "Sure", "Surah")}
            placeholder={tx("اختر السورة...", "Sure seçin...", "Choose a surah...")}
            options={surahs.map((surah) => ({
              value: String(surah.id),
              label: isArabic
                ? `سورة ${fixMojibake(surah.name)}`
                : language === "en"
                  ? `Surah ${surahEnglishName(surah.id) ?? fixMojibake(surah.transliteration)}`
                  : `${surahName(surah.id)} Suresi`,
            }))}
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
            searchPlaceholder={tx("ابحث عن سورة...", "Sure ara...", "Search surahs...")}
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">{tx("من الآية", "Başlangıç ayeti", "From ayah")}</label>
          <div className={fieldShell}>
            <AyahNumberField
              ariaLabel={tx("من الآية", "Başlangıç ayeti", "From ayah")}
              value={startVerse}
              min={1}
              max={total}
              disabled={!selectedSurah}
              placeholder={selectedSurah ? "1" : tx("السورة أولاً", "Önce sure", "Surah first")}
              onCommit={(n) => selectRange(selectedSurah!.id, n, n)}
            />
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">{tx("إلى الآية", "Bitiş ayeti", "To ayah")}</label>
          <div className={fieldShell} dir="ltr">
            <button
              type="button"
              onClick={handleRemoveLastVerse}
              disabled={!selectedSurah || endVerse === null || startVerse === null || endVerse <= startVerse}
              aria-label={tx("إزالة آخر آية", "Son ayeti çıkar", "Remove the last ayah")}
              className={`${stepButton} border-r border-border/70`}
            >
              <MinusIcon className="h-4 w-4" />
            </button>
            <AyahNumberField
              ariaLabel={tx("إلى الآية", "Bitiş ayeti", "To ayah")}
              value={endVerse}
              min={startVerse ?? 1}
              max={total}
              disabled={!selectedSurah || startVerse === null}
              placeholder="—"
              onCommit={(n) => {
                setEndVerse(n);
                setRenderError("");
                setRenderState("idle");
              }}
            />
            <button
              type="button"
              onClick={handleAddNextVerse}
              disabled={!selectedSurah || endVerse === null || endVerse >= total}
              aria-label={tx("أضف الآية التالية", "Sonraki ayeti ekle", "Add the next ayah")}
              className={`${stepButton} border-l border-border/70`}
            >
              <PlusIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">{tx("الترجمة", "Çeviri", "Translation")}</label>
        <TranslationSelector className="w-full" forceShow={true} />
      </div>

      {startVerse && endVerse && selectedSurah && (
        <div className="animate-slide-up space-y-4 rounded-2xl border border-border/60 bg-gradient-to-br from-surface/80 to-background p-4 sm:p-5 shadow-inner-soft">
          <div className="flex flex-wrap items-center gap-2 px-1">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              {tx("الآيات المختارة", "Seçili Ayetler", "Selected Ayahs")}
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold tabular-nums text-primary-dark dark:text-primary-light">
                {versesArray.length}
              </span>
            </h3>
            <span className="text-xs text-muted-foreground">
              {isArabic ? `سورة ${surahName(selectedSurah.id)}` : surahName(selectedSurah.id)} · {startVerse === endVerse ? startVerse : `${startVerse}–${endVerse}`}
            </span>
            {canStartWithBasmala && (
              <button
                type="button"
                onClick={onToggleBasmala}
                aria-pressed={startsWithBasmala}
                className={`ms-auto inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  startsWithBasmala
                    ? "border-primary/50 bg-primary/10 text-primary-dark dark:text-primary-light"
                    : "border-border bg-surface text-muted-foreground hover:border-primary/30 hover:text-foreground"
                }`}
              >
                {startsWithBasmala ? "✓ " : "+ "}
                {tx("البسملة في البداية", "Başta besmele", "Basmala first")}
              </button>
            )}
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
            upload) are declared the same way, for the same reason. The CSS
            is a plain text child built once per set of pages (see
            fontFaceCss): rewriting this tag's content -- which
            dangerouslySetInnerHTML did on EVERY render, even with
            identical CSS -- makes the browser rebuild all its FontFaces,
            blanking every web-font text on the page for a moment. */}
          <style>{fontFaceCss}</style>

          <div className="max-h-[420px] space-y-4 overflow-y-auto custom-scrollbar pr-1 -mr-1">
            {selectedVersesContent.map((verse) => {
              const isQcf1 = arabicFont === "qcf1";
              const arabicText = isQcf1 ? (verse.textV1 ?? verse.text) : verse.text;
              const arabicPage = isQcf1 ? (verse.pageV1 ?? verse.page) : verse.page;
              const arabicStyle = { fontFamily: arabicPage ? `'${isQcf1 ? "pv1-" : "p"}${arabicPage}'` : undefined };
              // Same resolution as the real video (QuranVideo.tsx): the
              // chosen font if it covers the translation's script, else that
              // script's default.
              const translationScript = translationRtl ? "ar" : "tr";
              const translationFontFamily = translationFontStack(
                resolveTranslationFont(translationFont, translationScript, hasCustomFont),
                translationScript,
                CUSTOM_TRANSLATION_FONT_FAMILY
              );

              return (
                <div
                  key={verse.id}
                  className="rounded-xl border border-border/60 bg-background/70 p-3.5 sm:p-4 space-y-3.5 transition-colors hover:border-primary/30"
                >
                  <div className="flex items-center gap-2">
                    {verse.id === BASMALA_VERSE_ID ? (
                      <span className="flex h-6 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 px-2.5 text-xs font-bold text-primary">
                        {tx("البسملة", "Besmele", "Basmala")}
                      </span>
                    ) : (
                      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                        {verse.id}
                      </span>
                    )}
                    {lowConfidenceAyahs.has(verse.id) && (
                      <span
                        className="flex items-center gap-1 rounded-full bg-accent-amber-bg/60 border border-accent-amber/30 px-2 py-0.5 text-[11px] font-medium text-accent-amber"
                        title={tx("لم يصل الذكاء الاصطناعي لنتيجة موثوقة لهذه الآية — يُنصح بمراجعة التقسيم في نافذة التوقيت", "Yapay zeka bu ayet için güvenilir bir sonuca ulaşamadı — bölümlemeyi zamanlama penceresinde kontrol etmeniz önerilir", "The AI couldn't reach a reliable result for this ayah — we recommend checking the segmentation in the timing window")}
                      >
                        <ExclamationTriangleIcon className="w-3.5 h-3.5" />
                        {tx("يحتاج مراجعة", "Kontrol gerekli", "Needs review")}
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
                      dir={translationRtl ? "rtl" : "ltr"}
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
