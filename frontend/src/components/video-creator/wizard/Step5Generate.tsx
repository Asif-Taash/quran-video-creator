"use client";

import { useState } from "react";
import { ArrowDownTrayIcon, AdjustmentsHorizontalIcon, ClipboardDocumentIcon, CheckIcon, SignalIcon } from "@heroicons/react/24/outline";
import Spinner from "@/components/ui/Spinner";
import type { RenderState } from "../VideoCreatorForm";
import { QUALITY_TIER_OPTIONS, WORD_HIGHLIGHT_COLORS, type AspectRatio, type QualityTier, type QuranVideoProps } from "@/remotion/types";
import VideoPreviewPlayer from "../VideoPreviewPlayer";

import { useT } from "@/lib/LanguageContext";
interface Step5Props {
  isArabic: boolean;
  handleGenerateVideo: () => void;
  canGenerate: boolean;
  renderState: RenderState;
  preparedAudioUrl: string | null;
  renderError: string;
  videoUrl: string | null;
  previewProps: QuranVideoProps | null;
  previewVersion: number;
  isLoadingPreview: boolean;
  previewError: string;
  // Ready-to-paste video title (surah + verse range + reciter credit, see
  // VideoCreatorForm's own suggestedTitle) -- null until a surah/verse
  // range is actually selected.
  suggestedTitle: string | null;
  // Status of the SAVED GALLERY VIDEO's own background auto-render (see
  // VideoCreatorForm's triggerBackgroundRender) -- distinct from
  // isLoadingPreview's spinner above, which only reflects the free,
  // instant, in-browser preview. This one reflects an actual server-side
  // renderMedia() encode that keeps the "فيديوهاتي المحفوظة" entry for this
  // project up to date as it's edited, without waiting for an explicit
  // "تنزيل الفيديو" click.
  backgroundSaveStatus: "idle" | "saving" | "saved" | "error";
  // Whether this render/save is even happening at all right now (the
  // gallery is login-gated) -- lets the badge below stay silent for a
  // logged-out visitor instead of implying a save that isn't occurring.
  isLoggedIn: boolean;
  aspectRatio: AspectRatio;
  onAspectRatioChange: (ratio: AspectRatio) => void;
  // Output resolution tier (144p .. 4K) -- purely an export-time render
  // setting (see render/route.ts's `scale`), never affects the live
  // preview above, which always displays at the composition's own fixed
  // canvas size regardless of this value.
  quality: QualityTier;
  onQualityChange: (quality: QualityTier) => void;
  // The unified audio-trim/timing panel's open state and toggle -- rendered
  // as a compact icon button right beside the download button (CapCut-style
  // "edit" affordance next to the primary export action), instead of a
  // separate row further down the page.
  showTimingEditor: boolean;
  onToggleTimingEditor: () => void;
  // Live, fully independent font-size/width controls for the Arabic verse
  // and the translation, set directly on the preview itself -- see
  // VideoCreatorForm's per-segment handlers and VideoPreviewPlayer's two
  // size popovers + drag-handle pairs. segmentKey identifies exactly which
  // displayed segment was edited (null falls back to the old video-wide
  // field) -- see VideoPreviewPlayerProps' own comment.
  onArabicTextScaleChange: (segmentKey: string | null, scale: number) => void;
  onArabicWidthScaleChange: (segmentKey: string | null, scale: number) => void;
  onTranslationTextScaleChange: (segmentKey: string | null, scale: number) => void;
  onTranslationWidthScaleChange: (segmentKey: string | null, scale: number) => void;
  // The shared, video-wide text-size sliders below the suggested-title box
  // -- unlike the per-segment controls above, these set ONE size for EVERY
  // segment at once (see VideoCreatorForm's applyBulkTextScale, which also
  // clears any existing per-segment override so nothing is left behind
  // ignoring the new shared value). arabicTextScale/translationTextScale
  // here are that same shared fallback value, just for display as each
  // slider's own position.
  arabicTextScale: number;
  translationTextScale: number;
  onBulkArabicTextScaleChange: (scale: number) => void;
  onBulkTranslationTextScaleChange: (scale: number) => void;
  // Colors the Arabic word being recited -- see QuranVideoProps.wordHighlight.
  wordHighlight: boolean;
  onWordHighlightChange: (on: boolean) => void;
  wordHighlightColor: string;
  onWordHighlightColorChange: (color: string) => void;
  // The video is created automatically once the surah, ayahs and reciter
  // are chosen (see VideoCreatorForm's auto-prepare effect) -- these drive
  // the placeholder shown until its preview exists.
  isPreparingAudio: boolean;
  audioProgressStage: string | null;
  hasSelection: boolean;
  // The optional background section (BackgroundPicker), shown right under
  // the video once it exists.
  backgroundPanel?: React.ReactNode;
}

const ASPECT_RATIO_OPTIONS: { value: AspectRatio; shape: string; labelAr: string; labelTr: string; labelEn: string }[] = [
  { value: "portrait", shape: "9 / 16", labelAr: "عمودي", labelTr: "Dikey", labelEn: "Portrait" },
  { value: "landscape", shape: "16 / 9", labelAr: "أفقي", labelTr: "Yatay", labelEn: "Landscape" },
  { value: "square", shape: "1 / 1", labelAr: "مربع", labelTr: "Kare", labelEn: "Square" },
];

function AspectRatioPicker({
  isArabic,
  aspectRatio,
  onAspectRatioChange,
}: {
  isArabic: boolean;
  aspectRatio: AspectRatio;
  onAspectRatioChange: (ratio: AspectRatio) => void;
}) {
  const tx = useT();
  return (
    <div className="flex items-center gap-2">
      {ASPECT_RATIO_OPTIONS.map((option) => {
        const active = aspectRatio === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onAspectRatioChange(option.value)}
            className={`flex flex-1 flex-col items-center gap-1.5 rounded-lg border py-2.5 transition-colors ${
              active
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-background text-muted-foreground hover:bg-surface"
            }`}
          >
            <div
              className={`rounded-[3px] border-2 ${active ? "border-primary" : "border-muted-foreground/60"}`}
              style={{ aspectRatio: option.shape, height: 18 }}
            />
            <span className="text-xs font-medium">{tx(option.labelAr, option.labelTr, option.labelEn)}</span>
          </button>
        );
      })}
    </div>
  );
}

// Popover CONTENT only (the trigger button + positioning live in
// Step5Generate below, right next to the download button) -- no outer
// border/background here since the popover card around it already
// provides that.
function QualityPicker({
  isArabic,
  quality,
  onQualityChange,
}: {
  isArabic: boolean;
  quality: QualityTier;
  onQualityChange: (quality: QualityTier) => void;
}) {
  const tx = useT();
  const index = Math.max(
    0,
    QUALITY_TIER_OPTIONS.findIndex((option) => option.value === quality)
  );
  const activeOption = QUALITY_TIER_OPTIONS[index];
  const percent = (index / (QUALITY_TIER_OPTIONS.length - 1)) * 100;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {tx("جودة الفيديو", "Video Kalitesi", "Video Quality")}
        </span>
        <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
          {activeOption.label}
        </span>
      </div>
      <input
        type="range"
        dir="ltr"
        min={0}
        max={QUALITY_TIER_OPTIONS.length - 1}
        step={1}
        value={index}
        onChange={(e) => onQualityChange(QUALITY_TIER_OPTIONS[Number(e.target.value)].value)}
        style={{ background: `linear-gradient(to right, var(--primary) ${percent}%, var(--border) ${percent}%)` }}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full outline-none
          [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none
          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary
          [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:transition-transform
          [&::-webkit-slider-thumb]:hover:scale-110
          [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full
          [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-primary [&::-moz-range-thumb]:shadow-md"
      />
      <div className="mt-1.5 flex justify-between text-[10px] text-muted-foreground">
        <span>{QUALITY_TIER_OPTIONS[0].label}</span>
        <span>{QUALITY_TIER_OPTIONS[QUALITY_TIER_OPTIONS.length - 1].label}</span>
      </div>
    </div>
  );
}

// Same range VideoPreviewPlayer's own per-segment corner-drag handle
// already covers (its MIN_TEXT_SCALE/MAX_TEXT_SCALE) -- keeps this bulk
// slider's feel/travel consistent with the per-segment control it sits
// alongside conceptually.
const BULK_TEXT_SCALE_MIN = 0.7;
const BULK_TEXT_SCALE_MAX = 1.4;

// One shared, video-wide size slider (Arabic verse OR translation, see the
// two call sites below) -- deliberately no numeric label anywhere, per the
// user's own request: a small "أ" at one end and a larger "أ" at the other
// are the only size cue, same spirit as QualityPicker above but without its
// percent badge/min-max captions.
function TextSizeSlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const percent = ((value - BULK_TEXT_SCALE_MIN) / (BULK_TEXT_SCALE_MAX - BULK_TEXT_SCALE_MIN)) * 100;
  return (
    <div>
      <span className="mb-2 block text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">أ</span>
        <input
          type="range"
          dir="ltr"
          min={BULK_TEXT_SCALE_MIN}
          max={BULK_TEXT_SCALE_MAX}
          step={0.01}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ background: `linear-gradient(to right, var(--primary) ${percent}%, var(--border) ${percent}%)` }}
          className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full outline-none
            [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none
            [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary
            [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:transition-transform
            [&::-webkit-slider-thumb]:hover:scale-110
            [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full
            [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-primary [&::-moz-range-thumb]:shadow-md"
        />
        <span className="text-lg text-muted-foreground">أ</span>
      </div>
    </div>
  );
}

export default function Step5Generate({
  isArabic,
  handleGenerateVideo,
  canGenerate,
  renderState,
  preparedAudioUrl,
  renderError,
  videoUrl,
  previewProps,
  previewVersion,
  isLoadingPreview,
  previewError,
  suggestedTitle,
  backgroundSaveStatus,
  isLoggedIn,
  aspectRatio,
  onAspectRatioChange,
  quality,
  onQualityChange,
  showTimingEditor,
  onToggleTimingEditor,
  onArabicTextScaleChange,
  onArabicWidthScaleChange,
  onTranslationTextScaleChange,
  onTranslationWidthScaleChange,
  arabicTextScale,
  translationTextScale,
  onBulkArabicTextScaleChange,
  onBulkTranslationTextScaleChange,
  wordHighlight,
  onWordHighlightChange,
  wordHighlightColor,
  onWordHighlightColorChange,
  isPreparingAudio,
  audioProgressStage,
  hasSelection,
  backgroundPanel,
}: Step5Props) {
  const tx = useT();
  // Brief "copied" checkmark swap on the title's copy button -- reverts on
  // its own after a couple seconds, no need to track anything past that.
  const [titleCopied, setTitleCopied] = useState(false);
  // Quality popover's own open state -- purely local UI, same reasoning as
  // titleCopied above (VideoCreatorForm only needs to know the selected
  // `quality` value itself, never whether this menu happens to be open).
  const [showQualityPanel, setShowQualityPanel] = useState(false);

  const handleCopyTitle = async () => {
    if (!suggestedTitle) return;
    try {
      await navigator.clipboard.writeText(suggestedTitle);
      setTitleCopied(true);
      setTimeout(() => setTitleCopied(false), 2000);
    } catch (err) {
      console.error("[Step5Generate] Copy title failed:", err);
    }
  };

  return (
    // Fixed ltr regardless of isArabic -- otherwise this whole section
    // (aspect ratio picker, the preview player's own surrounding layout,
    // download/edit buttons) mirrors into RTL the instant the user switches
    // the app to Arabic, visibly rearranging where the video sits and which
    // side every control is on. The video itself has no "reading direction"
    // of its own -- it's a fixed visual artifact -- so its whole interface
    // reads better staying put, exactly like VideoPreviewPlayer's own
    // internal controls already do (see its hardcoded dir="ltr" on the
    // scrubber/play bar). The suggested-title block below is deliberately
    // exempt -- it sets its OWN dir (its content is actual Arabic/Turkish
    // copy someone will read/paste elsewhere, unlike everything else here,
    // so it still needs to follow isArabic), and an explicit dir on a
    // descendant always wins over this root's, so it's unaffected by this.
    // Every OTHER text label inside still switches language normally
    // (isArabic ? ... : ...) -- only the LAYOUT direction is pinned here,
    // not the copy.
    <div className="space-y-4" dir="ltr">
      <AspectRatioPicker isArabic={isArabic} aspectRatio={aspectRatio} onAspectRatioChange={onAspectRatioChange} />

      {/* The actual rendered/downloaded file is never shown here -- the live
          preview (auto-refreshing on every relevant change, see
          VideoCreatorForm.tsx) is the ONLY visual representation of the
          video, styled to look identical to a finished video's own player.
          The download button below renders AND downloads the real file
          without ever displaying it. */}
      {previewProps ? (
        <div className="animate-slide-up relative">
          <VideoPreviewPlayer
            key={previewVersion}
            inputProps={previewProps}
            onArabicTextScaleChange={onArabicTextScaleChange}
            onArabicWidthScaleChange={onArabicWidthScaleChange}
            onTranslationTextScaleChange={onTranslationTextScaleChange}
            onTranslationWidthScaleChange={onTranslationWidthScaleChange}
          />
          {/* Small non-blocking badge instead of hiding the whole player --
              a text/timing-only edit still triggers a background refresh
              (see VideoCreatorForm.tsx's debounced handleLoadPreview), but
              the player itself only remounts when the actual audio/image
              source changes (previewVersion), so playback keeps going
              through any other edit. */}
          {isLoadingPreview && (
            <div className="absolute top-2 right-2 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-white/90 backdrop-blur-sm pointer-events-none">
              <Spinner size="sm" />
              {tx("جاري التحديث...", "Güncelleniyor...", "Updating...")}
            </div>
          )}
        </div>
      ) : isPreparingAudio || isLoadingPreview ? (
        <div
          className="flex min-h-[200px] flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-surface p-6 text-center"
          dir={isArabic ? "rtl" : "ltr"}
        >
          <Spinner size="md" />
          <p className="text-sm font-medium text-foreground">
            {tx("جاري إنشاء الفيديو...", "Video oluşturuluyor...", "Creating the video...")}
          </p>
          {isPreparingAudio && audioProgressStage && (
            <p className="text-xs text-muted-foreground">{audioProgressStage}</p>
          )}
        </div>
      ) : (
        !hasSelection && (
          <p
            className="rounded-2xl border border-dashed border-border bg-surface/60 p-6 text-center text-sm text-muted-foreground"
            dir={isArabic ? "rtl" : "ltr"}
          >
            {tx(
              "اختر السورة والآيات والقارئ، وسيظهر الفيديو هنا تلقائياً.",
              "Sureyi, ayetleri ve kariyi seçin; video burada otomatik olarak görünecek.",
              "Choose the surah, ayahs and reciter, and the video appears here automatically."
            )}
          </p>
        )
      )}

      {previewProps && backgroundPanel}

      {/* A ready-to-paste video title (e.g. for YouTube) -- see
          VideoCreatorForm's suggestedTitle for the exact format, which now
          follows isArabic just like the rest of this page (Arabic copy in
          Arabic, Turkish in Turkish), so the row's own direction follows it
          too instead of always being forced left-to-right. Label always sits
          on its own line above the title+copy row (not beside it, at any
          width) -- squeezing all three into one row left the title
          truncated, especially on a narrow phone. */}
      {suggestedTitle && (
        <div
          className="flex flex-col gap-1.5 rounded-xl border border-border bg-surface px-4 py-3"
          dir={isArabic ? "rtl" : "ltr"}
        >
          <span className="flex-shrink-0 text-xs font-medium text-muted-foreground">
            {tx("عنوان مقترح:", "Önerilen Başlık:", "Suggested Title:")}
          </span>
          <div className="flex items-center gap-2">
            <span className="flex-1 min-w-0 truncate text-sm font-medium text-foreground" title={suggestedTitle}>
              {suggestedTitle}
            </span>
            <button
              type="button"
              onClick={handleCopyTitle}
              title={tx("نسخ العنوان", "Başlığı kopyala", "Copy title")}
              className={`flex flex-shrink-0 items-center justify-center h-8 w-8 rounded-lg border transition-colors ${
                titleCopied
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-background text-muted-foreground hover:bg-primary/10 hover:text-primary"
              }`}
            >
              {titleCopied ? <CheckIcon className="h-4 w-4" /> : <ClipboardDocumentIcon className="h-4 w-4" />}
            </button>
          </div>
        </div>
      )}

      {/* Sets ONE text size for every ayah/translation segment in the whole
          video at once (see VideoCreatorForm's applyBulkTextScale) -- the
          per-segment size control (a corner-drag handle right on the
          preview, see VideoPreviewPlayer) still works independently on top
          of this for a one-off exception. */}
      {previewProps && (
        <div
          className="flex flex-col gap-4 rounded-xl border border-border bg-surface px-4 py-3"
          dir={isArabic ? "rtl" : "ltr"}
        >
          <TextSizeSlider
            label={tx("حجم نص الآية", "Ayet Yazı Boyutu", "Ayah Text Size")}
            value={arabicTextScale}
            onChange={onBulkArabicTextScaleChange}
          />
          <TextSizeSlider
            label={tx("حجم نص الترجمة", "Çeviri Yazı Boyutu", "Translation Text Size")}
            value={translationTextScale}
            onChange={onBulkTranslationTextScaleChange}
          />
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
            <label className="flex cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                checked={wordHighlight}
                onChange={(e) => onWordHighlightChange(e.target.checked)}
                className="peer sr-only"
              />
              <span
                aria-hidden
                className="relative h-5 w-9 flex-shrink-0 rounded-full bg-border transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow after:transition-all after:content-[''] peer-checked:bg-primary peer-checked:after:left-[18px] peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40"
              />
              <span className="text-xs font-medium text-muted-foreground">
                {tx("تلوين الكلمة أثناء التلاوة", "Okunan kelimeyi renklendir", "Highlight the word being recited")}
              </span>
            </label>
            {wordHighlight && (
              <div className="flex items-center gap-2">
                {WORD_HIGHLIGHT_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => onWordHighlightColorChange(color)}
                    aria-label={color}
                    aria-pressed={wordHighlightColor === color}
                    className={`h-6 w-6 rounded-full ring-offset-2 ring-offset-surface transition-transform hover:scale-110 ${
                      wordHighlightColor === color ? "ring-2 ring-foreground/70" : ""
                    }`}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {previewError && (
        <p className="rounded-xl border border-accent-red/30 bg-accent-red-bg/60 p-3 text-sm text-accent-red">
          {previewError}
        </p>
      )}

      {/* Reflects the SAVED gallery video quietly keeping itself in sync
          with every edit in the background (see VideoCreatorForm's
          triggerBackgroundRender) -- entirely separate from the "تنزيل
          الفيديو" button below, which stays untouched by this. Silent for a
          logged-out visitor (nothing is being saved for them) and while
          idle (nothing complete enough to save yet). */}
      {isLoggedIn && backgroundSaveStatus !== "idle" && (
        <div
          className="flex items-center gap-2 text-xs text-muted-foreground"
          dir={isArabic ? "rtl" : "ltr"}
        >
          {backgroundSaveStatus === "saving" && (
            <>
              <Spinner size="sm" />
              {tx("جارٍ حفظ التعديلات في المعرض...", "Değişiklikler galeriye kaydediliyor...", "Saving changes to the gallery...")}
            </>
          )}
          {backgroundSaveStatus === "saved" && (
            <span className="text-primary">
              {tx("✓ تم حفظ التعديلات في المعرض", "✓ Değişiklikler galeriye kaydedildi", "✓ Changes saved to the gallery")}
            </span>
          )}
          {backgroundSaveStatus === "error" && (
            <span className="text-accent-red">
              {tx("تعذر حفظ التعديلات في المعرض", "Değişiklikler galeriye kaydedilemedi", "Couldn't save changes to the gallery")}
            </span>
          )}
        </div>
      )}

      {/* The download button does both: renders the video, then
          auto-downloads it the moment it's ready (see executeVideoRender in
          VideoCreatorForm.tsx) -- no separate "generate" step followed by a
          second "download" click. The edit button opens the unified
          audio-trim/timing panel. On phones it's a full-width labeled button
          stacked below the primary action -- a bare icon-only square relies
          on the `title` hover tooltip to explain itself, which never appears
          on a touch screen, so on mobile it read as an unlabeled mystery
          button. From sm: up (where hover exists) it collapses back to a
          compact square icon beside the primary action. */}
      <div className="flex flex-col sm:flex-row items-stretch gap-2">
        <button
          type="button"
          onClick={handleGenerateVideo}
          disabled={!canGenerate}
          className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-primary to-primary-dark py-3 font-bold text-white shadow-lg transition-all hover:shadow-primary/25 disabled:opacity-50"
        >
          {renderState === "rendering" ? <Spinner size="md" className="border-white/30 border-t-white" /> : <ArrowDownTrayIcon className="h-6 w-6" />}
          {renderState === "rendering"
            ? tx("جاري الإنشاء والتنزيل...", "İndiriliyor...", "Downloading...")
            : !preparedAudioUrl
              ? tx("يجب تجهيز الصوت أولاً", "Önce Sesi Hazırlayın", "Prepare the Audio First")
              : tx("تنزيل الفيديو", "Videoyu İndir", "Download Video")}
        </button>
        {preparedAudioUrl && (
          <button
            type="button"
            onClick={onToggleTimingEditor}
            title={tx("تعديل الصوت والتوقيت والتقسيم", "Ses, zamanlama ve bölümlemeyi düzenle", "Edit audio, timing and segmentation")}
            className={`flex flex-shrink-0 items-center justify-center gap-2 h-[52px] px-4 sm:w-[52px] sm:px-0 rounded-lg border transition-colors ${
              showTimingEditor
                ? "border-primary bg-primary text-white shadow-lg shadow-primary/25"
                : "border-border bg-background text-primary hover:bg-primary/10"
            }`}
          >
            <AdjustmentsHorizontalIcon className="h-6 w-6 flex-shrink-0" />
            <span className="text-sm font-semibold sm:hidden">
              {tx("تعديل الصوت والتوقيت والتقسيم", "Ses, Zamanlama ve Bölümleme", "Audio, Timing and Segmentation")}
            </span>
          </button>
        )}
        {/* Appears once the interface video itself exists (previewProps) --
            a resolution setting has nothing to configure before there's a
            video to apply it to. Opens a popover instead of always sitting
            visible under the aspect ratio picker, matching the compact
            icon-button treatment of the edit/timing button right beside it. */}
        {previewProps && (
          <div className="relative flex-shrink-0">
            <button
              type="button"
              onClick={() => setShowQualityPanel((v) => !v)}
              title={tx("جودة الفيديو", "Video kalitesi", "Video quality")}
              className={`flex flex-shrink-0 items-center justify-center gap-2 h-[52px] px-4 sm:w-[52px] sm:px-0 rounded-lg border transition-colors ${
                showQualityPanel
                  ? "border-primary bg-primary text-white shadow-lg shadow-primary/25"
                  : "border-border bg-background text-primary hover:bg-primary/10"
              }`}
            >
              <SignalIcon className="h-6 w-6 flex-shrink-0" />
              <span className="text-sm font-semibold sm:hidden">
                {tx("جودة الفيديو", "Video Kalitesi", "Video Quality")}
              </span>
            </button>
            {showQualityPanel && (
              <>
                {/* Full-screen invisible backdrop beneath the panel -- closes
                    it on any outside click/tap without wiring up a ref +
                    document listener. */}
                <div className="fixed inset-0 z-10" onClick={() => setShowQualityPanel(false)} />
                <div className="animate-fade-in absolute bottom-full right-0 z-20 mb-2 w-72 rounded-lg border border-border bg-background p-4 shadow-xl">
                  <QualityPicker isArabic={isArabic} quality={quality} onQualityChange={onQualityChange} />
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {renderState === "error" && (
        <p className="animate-fade-in rounded-xl border border-accent-red/30 bg-accent-red-bg/60 p-3 text-sm text-accent-red">
          {tx("حدث خطأ أثناء إنشاء الفيديو: ", "Video oluşturulurken hata oluştu: ", "Error while creating the video: ")}
          {renderError}
        </p>
      )}
    </div>
  );
}
