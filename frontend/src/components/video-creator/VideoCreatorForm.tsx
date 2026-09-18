"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowPathIcon, FilmIcon } from "@heroicons/react/24/outline";
import { useLanguage } from "@/lib/LanguageContext";
import { fixMojibake } from "@/lib/textEncoding";
import { RECITER_DISPLAY_NAMES, RECITER_ARABIC_NAMES } from "@/lib/reciterNames";
import quranData from "@/data/quran.json";
import quranQcfV1Data from "@/data/quran-qcf-v1.json";
import Spinner from "@/components/ui/Spinner";

import { useTranslationContext } from "@/lib/TranslationContext";
import SegmentTimingEditor, { type SegmentTimingInput, type SegmentTimingResult } from "./SegmentTimingEditor";
import { TRANSLATION_FONT_OPTIONS, type ArabicFontKey, type AspectRatio, type QualityTier, type QuranVideoProps, type TranslationFontKey } from "@/remotion/types";
import { type WizardStepMeta } from "./wizard/WizardShell";
import Step1SurahVerse from "./wizard/Step1SurahVerse";
import Step2Background from "./wizard/Step2Background";
import Step3Audio from "./wizard/Step3Audio";
import Step5Generate from "./wizard/Step5Generate";

// localStorage key holding the current draft's id -- this browser's pointer
// into its own in-progress project (see autosaveDraft/handleStartOver
// below). The draft itself is just a JSON file keyed by this id, with no
// account/session check of its own -- no key means no draft, a stale/deleted
// id is treated the same as no key. (The GALLERY video this draft renders
// into, on the other hand, IS account-gated -- see the isLoggedIn prop and
// triggerBackgroundRender below.)
const DRAFT_STORAGE_KEY = "kurannuru:videoCreatorDraftId";

// Same source/shape render/route.ts builds server-side for the actual
// export (see its own identical map) -- kept here too so the Step1
// verse-list preview can resolve the QCF v1 text/page for arabicFont ===
// "qcf1" instantly, client-side, without a server round-trip.
const qcfV1TextBySurahAyah = new Map<string, { text: string; page: number }>(
  (quranQcfV1Data as { id: number; verses: { id: number; text: string; page: number }[] }[]).flatMap((surah) =>
    surah.verses.map((v) => [`${surah.id}:${v.id}`, { text: v.text, page: v.page }] as const)
  )
);




export interface Verse {
  id: number;
  text: string;
  translation?: string;
  page?: number;
}

export interface Surah {
  id: number;
  name: string;
  transliteration: string;
  total_verses: number;
  verses: Verse[];
}

export type RenderState = "idle" | "rendering" | "done" | "error";

interface ApiAyah {
  ayah_number: number;
  text_arabic: string;
  text_turkish: string;
}

export interface ApiSurah {
  id: number;
  name_arabic: string;
  name_turkish: string;
  name_transliteration: string;
  ayahs: ApiAyah[];
}

// Shared visual chrome for every step card. Defined at module scope (NOT
// inside VideoCreatorForm) deliberately -- a component defined inside
// another component's body gets a brand-new function identity on every
// single render of the parent, and React treats a changed component
// identity as a completely different component type, unmounting and
// remounting everything inside it (destroying all descendant state) even
// though visually nothing changed. That's exactly what was silently
// clearing the ayah search box's typed text: typing triggers a state
// update in VideoCreatorForm (the search-open flag), which re-renders it,
// which (with StepCard defined inline) remounted the whole Step1SurahVerse
// subtree -- including QuranSearch's own `query` state -- on every
// keystroke.
function StepCard({ idx, label, children, className }: { idx: number; label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`relative rounded-2xl p-6 md:p-8 space-y-6 shadow-lg ${className ?? ""}`}>
      <div className="absolute inset-0 bg-surface-2/80 backdrop-blur-md border border-primary/10 rounded-2xl overflow-hidden -z-10">
      </div>
      <h2 className="text-xl font-semibold flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-primary-light/30 via-primary/20 to-primary-dark/20 text-sm text-primary ring-1 ring-primary/20">
          {idx + 1}
        </span>
        {label}
      </h2>
      {children}
    </div>
  );
}

export default function VideoCreatorForm({ isLoggedIn }: { isLoggedIn: boolean }) {
  const { language } = useLanguage();
  const isArabic = language === "ar";
  const surahs = quranData as Surah[];
  const { selectedTranslation, setSelectedTranslationId, getTranslation, fetchSurahTranslations } = useTranslationContext();

  const [selectedSurah, setSelectedSurah] = useState<Surah | null>(null);
  const [selectedApiSurah, setSelectedApiSurah] = useState<ApiSurah | null>(null);
  const [selectedReciter, setSelectedReciter] = useState<string>("mishary_alafasy");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("portrait");
  // Export resolution tier only -- never affects the live preview, which
  // always renders at the composition's own fixed canvas size (see
  // render/route.ts's `scale` option and QUALITY_SCALE in remotion/types.ts).
  const [quality, setQuality] = useState<QualityTier>("720p");
  const [translationFont, setTranslationFont] = useState<TranslationFontKey | "custom">("aileron");
  const [arabicFont, setArabicFont] = useState<ArabicFontKey>("qcf2");
  // A user-uploaded translation font (translationFont === "custom"). The
  // File itself is only ever set within THIS session (picking a new file);
  // customTranslationFontUrl is either that fresh file's blob: preview URL
  // (optimistic, same pattern as bgPreview/bgVideoPreview) or, once
  // uploaded/restored from a saved draft, the real server URL -- see
  // handleCustomTranslationFontUpload and the draft-restore effect below.
  const [customTranslationFontFile, setCustomTranslationFontFile] = useState<File | null>(null);
  const [customTranslationFontUrl, setCustomTranslationFontUrl] = useState<string | null>(null);
  // Display-only (the actual file's original name) -- shown in the picker
  // so "a custom font is already set" doesn't just read as a bare generic
  // label once uploaded.
  const [customTranslationFontName, setCustomTranslationFontName] = useState<string | null>(null);
  const [startVerse, setStartVerse] = useState<number | null>(null);
  const [endVerse, setEndVerse] = useState<number | null>(null);
  const [bgImage, setBgImage] = useState<File | null>(null);
  const [bgPreview, setBgPreview] = useState<string | null>(null);
  // Video background -- mutually exclusive with bgImage (selecting one clears
  // the other, see handleImageUpload/handleVideoUpload below). Mirrors
  // bgImage/bgPreview's whole lifecycle (optimistic blob preview, upload,
  // draft persistence) with one addition: the server probes the uploaded
  // video's own duration (ffprobe) so QuranVideo.tsx can loop it seamlessly,
  // which this component has no reason to duplicate client-side.
  const [bgVideo, setBgVideo] = useState<File | null>(null);
  const [bgVideoPreview, setBgVideoPreview] = useState<string | null>(null);
  // Font size and text-box width (1 = default, narrower widths force more
  // line breaks) -- fully independent between the Arabic verse and the
  // translation, each user-adjustable directly on the live preview
  // (VideoPreviewPlayer's two separate slider/drag-handle pairs). See the
  // optimistic-preview-sync effect below for why these feed straight into
  // previewProps instead of only the debounced server reload.
  const [arabicTextScale, setArabicTextScale] = useState(1);
  const [arabicWidthScale, setArabicWidthScale] = useState(1);
  const [translationTextScale, setTranslationTextScale] = useState(1);
  const [translationWidthScale, setTranslationWidthScale] = useState(1);
  const [renderState, setRenderState] = useState<RenderState>("idle");
  const [surahTurkishNames, setSurahTurkishNames] = useState<Map<number, string>>(
    new Map(surahs.map((s) => [s.id, s.transliteration]))
  );
  const [renderError, setRenderError] = useState("");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  // Live in-browser preview (Step 5, before the actual slow render) --
  // populated from the SAME /api/video/render endpoint's "preview" mode, so
  // it can never structurally drift from what the real render would produce.
  const [previewProps, setPreviewProps] = useState<QuranVideoProps | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState("");
  // Bumped ONLY when globalAudioPath actually changes (see
  // handleLoadPreview) -- used as VideoPreviewPlayer's React key so a real
  // audio-source swap always gets a fresh <Player>/<Audio> mount (swapping
  // a LIVE Audio element's src is what crashes Remotion's dev-mode Audio
  // component). backgroundImagePath is deliberately NOT compared here --
  // swapping a plain <Img> src has no such crash risk, so a background
  // change (including the blob-preview -> real-server-path handoff in the
  // bgPreview effect below) just patches the same live Player's props in
  // place. Any other change (translation text, per-segment timing, etc.)
  // does the same -- keeps playback running uninterrupted instead of a
  // full reload flicker.
  const [previewVersion, setPreviewVersion] = useState(0);
  const lastPreviewAudioRef = useRef<string | null>(null);
  // Last bgImage File actually uploaded for a PREVIEW request, and the
  // backgroundImagePath the server resolved it to -- lets buildRenderFormData
  // send that resolved path back instead of re-uploading the identical file
  // on every unrelated preview reload (translation/timing edits keep
  // triggering handleLoadPreview via the debounced effect below, but never
  // touch bgImage itself). Only used for preview requests; the real render
  // always re-uploads, matching its existing behavior.
  const lastUploadedBgImageRef = useRef<{ file: File | null; path: string | null }>({ file: null, path: null });
  // Same idea as lastUploadedBgImageRef, plus the server-probed duration
  // (frames) needed to resend as existingBackgroundVideoDurationInFrames.
  const lastUploadedBgVideoRef = useRef<{ file: File | null; path: string | null; durationInFrames: number | null }>({
    file: null,
    path: null,
    durationInFrames: null,
  });
  // Scroll target for the unified audio-trim/timing panel living in the
  // video+editing section -- expanding it (from Step3Audio's "prepare/edit
  // audio" button, or the panel's own toggle) also scrolls it into view,
  // since it can be well below the fold on a long page.
  const timingPanelRef = useRef<HTMLDivElement>(null);
  const [isGeneratingBg, setIsGeneratingBg] = useState(false);
  const [customAudio, setCustomAudio] = useState<File | null>(null);
  const [audioSourceMode, setAudioSourceMode] = useState<"reciter" | "custom">("reciter");

  const [segmentationProgress, setSegmentationProgress] = useState<string | null>(null);
  const [pendingSegmentationData, setPendingSegmentationData] = useState<any[]>([]);
  // Per-ayah count of QCF glyph tokens each real word occupies in verse.text —
  // lets a mapping's word_count (real words) be converted into the glyph
  // token range needed to slice the Arabic preview text below.
  const [puaTokenCountsByAyah, setPuaTokenCountsByAyah] = useState<Record<number, number[]>>({});
  // Ayahs where the AI's auto-segmentation couldn't reach consensus across
  // its independent attempts and fell back to a best-effort proportional
  // split — surfaced in the UI so the user knows exactly which segments to
  // double-check/adjust manually instead of trusting them blindly.
  const [lowConfidenceAyahs, setLowConfidenceAyahs] = useState<Set<number>>(new Set());
  // Set when the translation selector changes while an ayah that's already
  // been split into multiple timed parts exists -- only that ayah's FIRST
  // part gets re-synced to the newly selected translation automatically
  // (see the fetchSurahTranslations().then() below), since the other parts
  // hold text the user manually distributed across them and re-deriving
  // that split from the new translation isn't something we can do safely.
  const [translationSyncNotice, setTranslationSyncNotice] = useState(false);
  // Whether the unified audio-trim/timing panel is currently open.
  const [showTimingEditor, setShowTimingEditor] = useState<boolean>(false);

  const [preparedAudioUrl, setPreparedAudioUrl] = useState<string | null>(null);
  const [preparedAudioLocalPath, setPreparedAudioLocalPath] = useState<string | null>(null);
  const [preparedJsonData, setPreparedJsonData] = useState<any>(null);
  const [audioTrimStart, setAudioTrimStart] = useState<number>(0);
  const [audioTrimEnd, setAudioTrimEnd] = useState<number>(0);
  // A client-side cut made in SegmentTimingEditor (see its applyTrimOnly),
  // persisted server-side on Save (see handlePersistTrimmedAudio below) --
  // when set, the timing editor reopens with THIS shorter file instead of
  // the full original, so a cut actually "sticks" across close/reopen.
  // `trimmedPreviewOffset` is how far this preview's own time 0 sits inside
  // the TRUE original (preparedAudioUrl) -- audioTrimStart/End and every
  // saved segment's start_ms/end_ms stay in that original's coordinate
  // space throughout (see buildTimingEditorSegments/handleSaveTimingEditor/
  // handleTrimOnly), so the render pipeline never has to know this preview
  // exists at all.
  const [trimmedPreviewAudioUrl, setTrimmedPreviewAudioUrl] = useState<string | null>(null);
  const [trimmedPreviewOffset, setTrimmedPreviewOffset] = useState<number>(0);
  const [isPreparingAudio, setIsPreparingAudio] = useState(false);
  const [audioProgressStage, setAudioProgressStage] = useState<string | null>(null);

  const [currentStep, setCurrentStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [showStartOverConfirm, setShowStartOverConfirm] = useState(false);
  const [isVerseSearchOpen, setIsVerseSearchOpen] = useState(false);

  const [draftId, setDraftId] = useState<string | null>(null);
  const [autosaveStatus, setAutosaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // Mirrors autosaveStatus, but for the actual GALLERY video (a real
  // renderMedia() encode + saveToGallery upsert -- see triggerBackgroundRender
  // below), not the lightweight draft JSON. "idle" until the project has
  // been complete enough to render even once. Shown in Step5Generate right
  // next to the live preview, since that's the thing the user is actually
  // watching update.
  const [backgroundSaveStatus, setBackgroundSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // In-flight guard for triggerBackgroundRender: a real render takes real
  // time (renderMedia -- seconds to minutes), so if another edit lands while
  // one is still running, it's recorded here rather than starting a second
  // renderMedia() call in parallel for the same project. The in-flight run
  // then loops once more with the latest state as soon as it finishes, so
  // edits made mid-render are never silently dropped, but at most one real
  // render for this draft is ever running at a time.
  const backgroundRenderInFlightRef = useRef(false);
  const backgroundRenderStaleRef = useRef(false);
  const backgroundRenderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // render/route.ts always writes a real (non-preview) render to the same
  // fixed `${surahId}-${startVerse}-${endVerse}.mp4` path in its ephemeral
  // renders dir, regardless of what triggered it -- a manual "تنزيل الفيديو"
  // click (executeVideoRender) and the background auto-save
  // (triggerBackgroundRender) alike. backgroundRenderInFlightRef above only
  // ever guards AGAINST OTHER background renders; without something guarding
  // the manual path too, a click landing while a background render is
  // already mid-renderMedia() would start a SECOND renderMedia() writing the
  // exact same file at the same time, and either caller could end up
  // downloading/saving a corrupted, half-written result. Every real render
  // (either kind) is queued through runSerializedRender below instead, so at
  // most one is ever actually running for this project at a time -- a
  // second one simply waits its turn.
  const realRenderChainRef = useRef<Promise<void>>(Promise.resolve());
  // Set for the whole duration of resuming a draft so the prepared-audio/
  // segmentation invalidation effect below (which reacts to surah/verse/
  // reciter/custom-audio changes) doesn't immediately wipe the very state
  // hydration just restored.
  const isHydratingRef = useRef(false);
  // Bumped every time the invalidation effect below fires (surah/verse/
  // reciter/custom-audio/mode changed). handlePrepareAudio snapshots this at
  // request start and re-checks it before applying a successful response --
  // a slow request (e.g. reciter audio) that resolves AFTER the user has
  // since switched to a different source (e.g. uploaded a video) would
  // otherwise clobber the newer selection's state with stale audio, which is
  // exactly what silently played the wrong reciter's voice in the preview.
  const audioParamsEpochRef = useRef(0);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last translation id already re-synced into pendingSegmentationData (see
  // the fetchSurahTranslations().then() below) -- guards against re-running
  // that sync redundantly (e.g. on every surah change) when the translation
  // itself hasn't actually changed.
  const lastSyncedTranslationIdRef = useRef(selectedTranslation.id);

  const handlePrepareAudio = async () => {
    if (!selectedSurah || startVerse === null || endVerse === null) return;

    // If we already have prepared audio (meaning parameters haven't changed),
    // just expand the inline timing/trim panel (below the video preview)
    // and scroll it into view instead of re-running extraction.
    if (preparedAudioUrl) {
      handleOpenTimingEditor();
      return;
    }

    // A request for this exact parameter set is already in flight -- the
    // debounced auto-prepare effect below and a manual button click can
    // both land here before either resolves (preparedAudioUrl is still
    // null either way). Without this guard, two identical extraction
    // requests race on the backend's shared temp-file name and one
    // truncates the other mid-write, failing both with a 400/500.
    if (isPreparingAudio) return;

    // Snapshotted now, re-checked once the request resolves below -- if the
    // user changes surah/verse/reciter/custom-audio while this fetch is
    // still in flight, the invalidation effect bumps this epoch, and the
    // (now stale) response must be discarded instead of overwriting the
    // newer selection's state.
    const requestEpoch = audioParamsEpochRef.current;
    const isStale = () => audioParamsEpochRef.current !== requestEpoch;

    setIsPreparingAudio(true);
    setAudioProgressStage(isArabic ? "⬇️ تحميل الملف الصوتي..." : "⬇️ Ses dosyası indiriliyor...");
    try {
      const formData = new FormData();
      formData.append("surahId", selectedSurah.id.toString());
      formData.append("startVerse", startVerse.toString());
      formData.append("endVerse", endVerse.toString());
      formData.append("reciterId", selectedReciter);
      if (audioSourceMode === "custom" && customAudio) {
        formData.append("customAudio", customAudio);
      }
      // Add 10.0s padding so the user can use the timing editor's trim
      // handles (its first/last segment boundaries) to expand the selection
      // if needed
      formData.append("padSeconds", "10.0");

      setAudioProgressStage(isArabic ? "🔍 تحليل الموجات الصوتية..." : "🔍 Ses dalgaları analiz ediliyor...");

      const res = await fetch("/api/video/prepare-audio", {
        method: "POST",
        body: formData,
      });

      if (res.ok) {
        const data = await res.json();
        // The user moved on (changed surah/verse/reciter/custom-audio) while
        // this request was in flight -- the invalidation effect already
        // reset preparedAudioUrl etc. for the new selection, so applying
        // this now-stale result would silently resurrect the abandoned
        // selection's audio (e.g. a reciter's voice after the user switched
        // to an uploaded video). Discard it quietly instead.
        if (isStale()) return;
        if (data.success) {
          setAudioProgressStage(isArabic ? "✂️ جاري تجهيز النتيجة..." : "✂️ Sonuç hazırlanıyor...");

          // Calculate default trim bounds so the preview already looks
          // reasonable even before the user ever opens the timing panel.
          // Kept in sync with the identical calculation in
          // buildTimingEditorSegments (which seeds the same margin onto the
          // first/last segment's own boundary the first time the panel
          // opens) -- both copies must use the same lowConfidenceEnd-aware
          // margin or one would silently override the other once the user
          // actually saves.
          let defaultRegionStart = 0;
          let defaultRegionEnd = 0;
          const PAD_SECONDS = 10.0; // matches padSeconds sent above
          const lowConfidenceEnd = !!data.wordTimingsData?.lowConfidenceEnd;
          if (data.wordTimingsData && data.wordTimingsData.verses) {
            let minStart = Infinity;
            let maxEnd = 0;
            Object.values(data.wordTimingsData.verses).forEach((v: any) => {
              v.words?.forEach((w: any) => {
                if (w.start < minStart) minStart = w.start;
                if (w.end > maxEnd) maxEnd = w.end;
              });
            });
            if (minStart !== Infinity) {
              // Whisper's forced alignment can under-shoot the true end of elongated
              // (madd) word endings by upwards of 1.5s, so the end margin is kept
              // wider than the start margin to avoid clipping the last word's tail.
              defaultRegionStart = Math.max(0, (minStart / 1000) - 0.35);
              defaultRegionEnd = (maxEnd / 1000) + (lowConfidenceEnd ? PAD_SECONDS - 2.0 : 1.5);
            }
          }

          setAudioTrimStart(defaultRegionStart);
          setAudioTrimEnd(defaultRegionEnd);

          setPreparedAudioUrl(data.audioUrl);
          setPreparedAudioLocalPath(data.localAudioPath);
          setPreparedJsonData(data.wordTimingsData);
          // Inline trim/timing panels below the video preview start
          // collapsed even after a fresh automatic prepare -- the user sees
          // the video immediately and opens either panel deliberately only
          // if something actually needs fixing (see the CapCut-style
          // sticky-column panels in the render below).
          // Segmentation is no longer auto-triggered here -- it now only
          // ever runs when the user explicitly presses the split button
          // (onToggleSegmentation -> handleSegmentLongVerses in
          // SegmentTimingEditor), never as a side effect of preparing audio.
        } else {
          alert(data.error);
        }
      } else {
        if (isStale()) return;
        const errData = await res.json().catch(() => null);
        if (errData && errData.error) {
          alert(errData.error);
        } else {
          alert(isArabic ? "فشل تجهيز الصوت. حدث خطأ في الخادم." : "Ses hazırlanamadı. Sunucu hatası.");
        }
      }
    } catch (e) {
      if (isStale()) return;
      console.error(e);
      alert(isArabic ? "حدث خطأ أثناء الاتصال بالخادم" : "Sunucuya bağlanırken hata oluştu");
    } finally {
      setIsPreparingAudio(false);
      setAudioProgressStage(null);
    }
  };


  // Applies whatever segmentation is currently pending (from the timing
  // editor) to the server-side temp_segmentation.json BEFORE either a real
  // render or a preview request -- both need render/route.ts to read the
  // SAME, latest segmentation, or a preview could silently show stale
  // timing from before the user's last edit in Step 4, defeating the whole
  // point of previewing before committing to a render.
  const applyPendingSegmentation = async (segmentationData: any[] | null) => {
    if (!segmentationData || segmentationData.length === 0) return;
    setSegmentationProgress(
      isArabic ? "جاري تطبيق التقسيم..." : "Bölümleme uygulanıyor..."
    );
    try {
      const applyRes = await fetch("/api/segmentation/apply", {
        method: "POST",
        body: JSON.stringify(segmentationData),
        headers: { "Content-Type": "application/json" },
      });

      if (!applyRes.ok) {
        const applyData = await applyRes.json();
        console.warn(`[UI] Failed to apply segmentation: ${applyData.error}. Continuing without segmentation.`);
        await fetch("/api/segmentation/clear", { method: "POST" }).catch(() => { });
      } else {
        console.log(`[UI] Successfully applied segmentation for ${segmentationData.length} verses`);
      }
    } finally {
      setSegmentationProgress(null);
    }
  };

  // Shared by both the real render (executeVideoRender) and the live
  // preview (handleLoadPreview) -- identical payload either way except for
  // the "mode" flag, so render/route.ts always builds inputProps off the
  // exact same inputs regardless of which one triggered it.
  const buildRenderFormData = (mode?: "preview", draftIdOverride?: string) => {
    const formData = new FormData();
    if (!selectedSurah || !startVerse || !endVerse) throw new Error("Missing required fields");
    formData.append("surahId", String(selectedSurah.id));
    formData.append("startVerse", String(startVerse));
    formData.append("endVerse", String(endVerse));
    // Only meaningful for a real (non-preview) render -- see
    // executeVideoRender, which is the only caller that ever passes
    // draftIdOverride. Lets the resulting gallery entry link back to this
    // exact draft, so GalleryGrid.tsx's Edit button can restore it later.
    const effectiveDraftId = draftIdOverride ?? draftId;
    if (effectiveDraftId) formData.append("draftId", effectiveDraftId);

    if (audioSourceMode === "custom" && customAudio) {
      formData.append("customAudio", customAudio);
      formData.append("reciterId", selectedReciter);
    } else {
      formData.append("reciterId", selectedReciter);
    }

    if (bgImage) {
      // For a preview reload triggered by something unrelated to the
      // background (translation/timing edit), bgImage is still the SAME
      // File object as last time -- resend the already-resolved server
      // path instead of re-uploading/rewriting an identical file every
      // time. A real render always re-uploads (unchanged behavior).
      if (mode === "preview" && bgImage === lastUploadedBgImageRef.current.file && lastUploadedBgImageRef.current.path) {
        formData.append("existingBackgroundImagePath", lastUploadedBgImageRef.current.path);
      } else {
        formData.append("bgImage", bgImage);
      }
    }
    if (bgVideo) {
      if (mode === "preview" && bgVideo === lastUploadedBgVideoRef.current.file && lastUploadedBgVideoRef.current.path) {
        formData.append("existingBackgroundVideoPath", lastUploadedBgVideoRef.current.path);
        if (lastUploadedBgVideoRef.current.durationInFrames) {
          formData.append("existingBackgroundVideoDurationInFrames", String(lastUploadedBgVideoRef.current.durationInFrames));
        }
      } else {
        formData.append("bgVideo", bgVideo);
      }
    }
    if (selectedTranslation) {
      formData.append("translationId", selectedTranslation.id);
    }

    if (preparedAudioUrl) {
      formData.append("usePreparedAudio", "true");
      if (preparedAudioLocalPath) formData.append("preparedAudioLocalPath", preparedAudioLocalPath);
      if (preparedJsonData) formData.append("preparedJsonData", JSON.stringify(preparedJsonData));
      if (audioTrimStart > 0 || audioTrimEnd > 0) {
        formData.append("trimStart", String(audioTrimStart));
        formData.append("trimEnd", String(audioTrimEnd));
      }
    }

    formData.append("aspectRatio", aspectRatio);
    formData.append("quality", quality);
    formData.append("arabicTextScale", String(arabicTextScale));
    formData.append("arabicWidthScale", String(arabicWidthScale));
    formData.append("translationTextScale", String(translationTextScale));
    formData.append("translationWidthScale", String(translationWidthScale));
    formData.append("translationFont", translationFont);
    formData.append("arabicFont", arabicFont);
    if (translationFont === "custom") {
      if (customTranslationFontFile) {
        formData.append("customTranslationFont", customTranslationFontFile);
      } else if (customTranslationFontUrl && !customTranslationFontUrl.startsWith("blob:")) {
        formData.append("existingCustomTranslationFontUrl", customTranslationFontUrl);
      }
    }

    if (mode === "preview") formData.append("mode", "preview");

    return formData;
  };

  const handleLoadPreview = async () => {
    setIsLoadingPreview(true);
    setPreviewError("");
    try {
      await applyPendingSegmentation(pendingSegmentationData.length > 0 ? pendingSegmentationData : null);
      const formData = buildRenderFormData("preview");
      const response = await fetch("/api/video/render", {
        method: "POST",
        body: formData,
      });
      const data = await response.json();
      if (!response.ok || !data.inputProps) {
        throw new Error(data.error || "Failed to load preview");
      }
      lastUploadedBgImageRef.current = { file: bgImage, path: data.inputProps.backgroundImagePath ?? null };
      lastUploadedBgVideoRef.current = {
        file: bgVideo,
        path: data.inputProps.backgroundVideoPath ?? null,
        durationInFrames: data.inputProps.backgroundVideoDurationInFrames ?? null,
      };
      setPreviewProps(data.inputProps);
      // Only force VideoPreviewPlayer (keyed on this in Step5Generate) to
      // unmount and remount when the actual audio SOURCE changed --
      // swapping an already-mounted Remotion Audio element's src while the
      // user might be mid-interaction with it (e.g. toggling mute) is what
      // crashes Remotion's own dev-mode Audio component, so a real audio
      // swap still gets a clean remount. Any other change (translation
      // text, per-segment timing, background image, etc.) just patches the
      // SAME Player instance's props in place -- playback keeps running
      // instead of restarting from scratch on every edit.
      const newAudio: string | null = data.inputProps.globalAudioPath ?? null;
      if (lastPreviewAudioRef.current !== newAudio) {
        lastPreviewAudioRef.current = newAudio;
        setPreviewVersion((v) => v + 1);
      }

      // Deliberately NOT triggering the real background gallery save from
      // here (a previous version of this did) -- a real renderMedia() call
      // is CPU-heavy (ffmpeg + a full headless-Chromium frame-by-frame
      // encode), and this preview reload fires on every single edit tick,
      // often every ~400ms while the user is actively adjusting something.
      // Kicking off a real render on every one of those starved the
      // server's CPU almost continuously during active editing -- including
      // THIS very preview request's own follow-ups, which is exactly what
      // made the preview itself get stuck on "جاري التحميل" without ever
      // resolving. The debounced effect further down (which waits for the
      // user to actually stop touching anything for a few seconds first)
      // is the only trigger for the real background save now -- see its own
      // comment.
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : "تعذر تحميل المعاينة");
    } finally {
      setIsLoadingPreview(false);
    }
  };

  // Fully automatic preview: reloads itself on every change that would
  // actually affect the rendered video (audio, background, translation,
  // trim, segmentation/timing) -- no manual refresh button anywhere. Debounced
  // briefly so a burst of changes (e.g. picking a translation right after
  // confirming a trim) collapses into a single reload instead of firing one
  // per change. Also clears any stale preview the instant preparedAudioUrl
  // is reset (surah/verse/reciter changed), so an old preview never lingers
  // on screen after its underlying audio is gone.
  //
  // The four text-scale/width values are deliberately NOT in this dependency
  // list. They used to be, which meant every drag on VideoPreviewPlayer's
  // resize box fired a full server round-trip ~400ms after the user's last
  // pointer movement -- handleLoadPreview() replaces previewProps with an
  // entirely new object fetched from /api/video/render, which is exactly
  // the kind of wholesale prop swap that made the preview appear to "jump
  // back to the start" the user kept reporting. It's also simply
  // unnecessary: these four are pure client-side rendering parameters --
  // QuranVideo.tsx (the SAME component this preview and the real render
  // both use) applies them directly, so the optimistic-sync effect right
  // below already reflects every drag tick instantly and correctly with no
  // server involved, and the real render's own FormData (buildRenderFormData)
  // sends the latest values independently of this effect regardless. So
  // dropping them here costs nothing and removes the one thing left that
  // could reset playback mid-edit.
  useEffect(() => {
    if (!preparedAudioUrl) {
      setPreviewProps(null);
      return;
    }
    const timeoutId = setTimeout(() => {
      handleLoadPreview();
    }, 400);
    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    preparedAudioUrl,
    audioTrimStart,
    audioTrimEnd,
    bgImage,
    bgVideo,
    selectedTranslation,
    pendingSegmentationData,
    aspectRatio,
  ]);

  // Optimistic background preview: the instant the user picks a new image,
  // show it immediately via its local blob: URL (bgPreview, already created
  // synchronously wherever bgImage is set) instead of waiting out the 400ms
  // debounce above plus a full server round-trip just to see it appear.
  // The debounced reload above still runs as normal and replaces this with
  // the real server-saved path once ready -- getAssetUrl() in QuranVideo.tsx
  // treats blob: the same as an already-resolved URL, and swapping it isn't
  // the crash-prone case handleLoadPreview's remount guard exists for (that
  // one's specifically about a live <Audio> element), so this never causes
  // a flicker either way.
  useEffect(() => {
    if (!bgPreview) return;
    setPreviewProps((prev) => (prev ? { ...prev, backgroundImagePath: bgPreview } : prev));
  }, [bgPreview]);

  // Same optimistic-preview idea for a freshly picked video: shows the local
  // blob immediately via QuranVideo.tsx's backgroundVideoPath branch (which
  // takes priority over backgroundImagePath). backgroundVideoDurationInFrames
  // is deliberately left as whatever the previous preview had (or unset) --
  // it's only known once the server actually probes the file, and
  // QuranVideo.tsx's Loop already falls back to the full timeline length
  // when it's missing, so this is a harmless brief approximation until the
  // debounced reload above replaces it with the real probed value.
  useEffect(() => {
    if (!bgVideoPreview) return;
    setPreviewProps((prev) => (prev ? { ...prev, backgroundVideoPath: bgVideoPreview } : prev));
  }, [bgVideoPreview]);

  // Same optimistic-update idea, but for every single change while the user
  // is actively dragging either of the two independent (Arabic/translation)
  // font-size sliders or width handles in VideoPreviewPlayer -- these fire
  // continuously (many times per second), and re-wrapping/re-sizing text
  // client-side is instant, so there's no reason to wait on the debounced
  // server reload just to see the drag track live. That reload still runs
  // as normal (all four are in its dependency list above) and settles the
  // "official" value once dragging pauses -- this effect is purely what
  // makes the preview feel responsive DURING the drag itself.
  useEffect(() => {
    setPreviewProps((prev) =>
      prev ? { ...prev, arabicTextScale, arabicWidthScale, translationTextScale, translationWidthScale } : prev
    );
  }, [arabicTextScale, arabicWidthScale, translationTextScale, translationWidthScale]);

  // Same reasoning as the scale patch above -- a font choice needs no
  // server-side computation at all, so it's applied to the live preview
  // instantly here instead of round-tripping through the debounced reload.
  // customTranslationFontUrl rides along in the SAME effect (not a separate
  // one) since "custom" is meaningless without it -- keeping them in one
  // update avoids ever patching previewProps with one but not the other.
  useEffect(() => {
    setPreviewProps((prev) =>
      prev ? { ...prev, translationFont, customTranslationFontUrl: customTranslationFontUrl ?? undefined } : prev
    );
  }, [translationFont, customTranslationFontUrl]);

  // Same reasoning -- arabicFont's own text/font-face for BOTH options is
  // always already present in previewProps (see textV1/pageV1 in types.ts),
  // so this too is a pure client-side instant switch.
  useEffect(() => {
    setPreviewProps((prev) => (prev ? { ...prev, arabicFont } : prev));
  }, [arabicFont]);

  // A user-picked translation font FILE (as opposed to one of the built-in
  // TRANSLATION_FONT_OPTIONS) -- see the picker in Step1SurahVerse.tsx.
  // blob: URL is purely an optimistic local preview (same pattern as
  // bgPreview/bgVideoPreview) -- getAssetUrl in QuranVideo.tsx passes it
  // through as-is, which only ever resolves inside THIS browser tab, never
  // during the actual server-side render (buildRenderFormData below sends
  // the real File for that instead).
  const handleCustomTranslationFontUpload = (file: File) => {
    if (customTranslationFontUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(customTranslationFontUrl);
    }
    setCustomTranslationFontFile(file);
    setCustomTranslationFontUrl(URL.createObjectURL(file));
    setCustomTranslationFontName(file.name);
    setTranslationFont("custom");
  };

  // Per-SEGMENT resize (see VerseMapping's own scale fields in types.ts and
  // VideoPreviewPlayer's segmentKey-aware onXxxScaleChange props, which now
  // edit whichever segment is on screen instead of one video-wide value).
  // Patches previewProps (so the live <Player> reflects it immediately,
  // same spirit as the effect just above) AND pendingSegmentationData --
  // the latter is the durable source of truth actually sent to
  // /api/segmentation/apply by both autosaveDraft and
  // executeVideoRender/handleLoadPreview (see applyPendingSegmentation), so
  // without also patching it here a per-segment resize would only ever
  // last until the next preview/render reload silently rebuilt verses from
  // the untouched original mappings. Falls back to the old video-wide
  // setter only when there's genuinely no segment at all to target
  // (segmentKey null -- can no longer actually happen for a verse that's
  // on screen, see QuranVideo.tsx's own synthetic single-mapping fallback,
  // but kept as a defensive no-op-safe default).
  const applySegmentScaleChange = (
    segmentKey: string | null,
    scale: number,
    field: "arabicTextScale" | "arabicWidthScale" | "translationTextScale" | "translationWidthScale",
    fallbackSetter: (value: number) => void
  ) => {
    if (!segmentKey) {
      fallbackSetter(scale);
      return;
    }
    const [verseIdStr, idxStr] = segmentKey.split(":");
    const verseId = Number(verseIdStr);
    const idx = Number(idxStr);
    if (!Number.isFinite(verseId) || !Number.isFinite(idx)) {
      fallbackSetter(scale);
      return;
    }

    // A verse that has never gone through real segmentation still needs a
    // mapping SLOT of its own to hold this override -- otherwise there's
    // nowhere to put it, and the drag would either silently do nothing or
    // (before segmentKey started covering this case too) fall back to the
    // shared video-wide scale, which is exactly the bug this is fixing:
    // resizing one ayah's box was visibly resizing every other ayah/segment
    // that had never been individually resized. QuranVideo.tsx synthesizes
    // the SAME single-mapping shape ephemerally for display, but that
    // in-memory copy alone wouldn't survive the next debounced preview
    // reload -- this materializes it into both previewProps (live, right
    // now) and pendingSegmentationData (durable, read by
    // applyPendingSegmentation into the actual export) the first time such
    // a verse is ever resized.
    setPreviewProps((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        verses: prev.verses.map((v) => {
          if (v.id !== verseId) return v;
          if (v.mappings && v.mappings.length > 0) {
            return { ...v, mappings: v.mappings.map((m, i) => (i === idx ? { ...m, [field]: scale } : m)) };
          }
          return {
            ...v,
            mappings: [
              {
                part: 1,
                translation_text: v.translation,
                word_count: v.wordTimings?.length ?? v.text.trim().split(/\s+/).length,
                [field]: scale,
              },
            ],
          };
        }),
      };
    });

    setPendingSegmentationData((prev) => {
      const existingIdx = prev.findIndex((entry) => entry.surah === selectedSurah?.id && entry.ayah === verseId);
      if (existingIdx !== -1) {
        return prev.map((entry, i) =>
          i === existingIdx
            ? { ...entry, mappings: entry.mappings.map((m: any, mi: number) => (mi === idx ? { ...m, [field]: scale } : m)) }
            : entry
        );
      }
      // No segmentation entry exists yet for this ayah at all -- create one
      // with a single mapping spanning the whole verse (same shape
      // handleSegmentLongVerses itself falls back to when the AI declines
      // to split a verse). word_count here is /api/segmentation/apply's own
      // REAL-Uthmani-word domain (it validates and auto-corrects against
      // that), NOT the QCF glyph-token count QuranVideo.tsx works in --
      // selectedVersesContent's `.text` is the plain-Unicode source, same
      // basis handleSegmentLongVerses already uses for this.
      const verse = selectedVersesContent.find((sv) => sv.id === verseId);
      if (!verse || !selectedSurah) return prev;
      return [
        ...prev,
        {
          surah: selectedSurah.id,
          ayah: verseId,
          mappings: [
            {
              part: 1,
              translation_text: verse.translation || "",
              word_count: verse.text.trim().split(/\s+/).length,
              [field]: scale,
            },
          ],
        },
      ];
    });
  };

  const handleArabicTextScaleChange = (segmentKey: string | null, scale: number) =>
    applySegmentScaleChange(segmentKey, scale, "arabicTextScale", setArabicTextScale);
  const handleArabicWidthScaleChange = (segmentKey: string | null, scale: number) =>
    applySegmentScaleChange(segmentKey, scale, "arabicWidthScale", setArabicWidthScale);
  const handleTranslationTextScaleChange = (segmentKey: string | null, scale: number) =>
    applySegmentScaleChange(segmentKey, scale, "translationTextScale", setTranslationTextScale);
  const handleTranslationWidthScaleChange = (segmentKey: string | null, scale: number) =>
    applySegmentScaleChange(segmentKey, scale, "translationWidthScale", setTranslationWidthScale);

  // Mirrors applySegmentScaleChange's own reasoning above: SegmentTimingEditor
  // used to only reach previewProps/pendingSegmentationData through its
  // "حفظ التوقيت" onConfirm, so a translation-text edit (e.g. placing a
  // manual line break) never showed up in the live preview until that
  // button was pressed. This patches both the SAME way, on every keystroke,
  // matching the resize boxes' own instant feedback. `part` is 1-based and
  // matches the mapping's own array index + 1 exactly, since
  // handleSaveTimingEditor assigns part numbers as idx+1 in the same
  // on-timeline order the mappings array is stored in -- but that only
  // holds for mappings whose structure (count/order) hasn't changed since
  // the last save, so an edit made after an UNCONFIRMED split/merge in this
  // same editor session can target a stale index until "حفظ التوقيت" is
  // pressed and rebuilds it properly; a live preview nicety, not the
  // authoritative save.
  const handleLiveTranslationEdit = (ayah: number, part: number, text: string) => {
    const idx = part - 1;

    // Same materialization as applySegmentScaleChange above -- a verse
    // that's never been segmented or resized has no mapping slot of its own
    // yet in either previewProps or pendingSegmentationData, so there'd be
    // nowhere to patch this text into (the edit would just silently not
    // show up live, though "حفظ التوقيت" would still save it correctly
    // regardless, since it rebuilds mappings from scratch).
    setPreviewProps((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        verses: prev.verses.map((v) => {
          if (v.id !== ayah) return v;
          if (v.mappings && v.mappings.length > 0) {
            return { ...v, mappings: v.mappings.map((m, i) => (i === idx ? { ...m, translation_text: text } : m)) };
          }
          return {
            ...v,
            mappings: [
              {
                part: 1,
                translation_text: text,
                word_count: v.wordTimings?.length ?? v.text.trim().split(/\s+/).length,
              },
            ],
          };
        }),
      };
    });

    setPendingSegmentationData((prev) => {
      const existingIdx = prev.findIndex((entry) => entry.surah === selectedSurah?.id && entry.ayah === ayah);
      if (existingIdx !== -1) {
        return prev.map((entry, i) =>
          i === existingIdx
            ? { ...entry, mappings: entry.mappings.map((m: any, mi: number) => (mi === idx ? { ...m, translation_text: text } : m)) }
            : entry
        );
      }
      const verse = selectedVersesContent.find((sv) => sv.id === ayah);
      if (!verse || !selectedSurah) return prev;
      return [
        ...prev,
        {
          surah: selectedSurah.id,
          ayah,
          mappings: [{ part: 1, translation_text: text, word_count: verse.text.trim().split(/\s+/).length }],
        },
      ];
    });
  };

  // Runs `fn` only after any real render already queued/running for this
  // project has settled, and makes any FURTHER real render (manual or
  // background, in whichever order they're called) wait its own turn behind
  // this one -- see realRenderChainRef's own comment for why this must cover
  // BOTH executeVideoRender and triggerBackgroundRender rather than each
  // guarding only against its own kind.
  const runSerializedRender = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = realRenderChainRef.current.then(fn, fn);
    realRenderChainRef.current = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  const executeVideoRender = async (segmentationData: any[] | null = null) => {
    try {
      await applyPendingSegmentation(segmentationData);

      // Force a fresh save right before rendering (rather than trusting the
      // debounced autosave effect to have already run) so the draft this
      // gallery entry links to (see buildRenderFormData's draftIdOverride)
      // definitely exists AND matches this EXACT render -- not whatever the
      // project happened to look like up to 1.5s ago.
      const currentDraftId = await autosaveDraft();

      const formData = buildRenderFormData(undefined, currentDraftId);
      console.log("[UI] Sending payload:", Object.fromEntries(formData.entries()));

      const response = await fetch("/api/video/render", {
        method: "POST",
        body: formData,
      });
      const data = await response.json();

      if (!response.ok || !data.videoUrl) {
        throw new Error(data.error || "Video render failed");
      }

      const finalVideoUrl = `${data.videoUrl}?t=${Date.now()}`;
      setVideoUrl(finalVideoUrl);
      setRenderState("done");

      // The "Videoyu İndir" button both renders AND downloads in one click --
      // trigger the actual browser download automatically the instant the
      // video is ready, instead of making the user click a second separate
      // download link/button after generation finishes.
      const link = document.createElement("a");
      link.href = finalVideoUrl;
      link.download = "";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      setRenderError(error instanceof Error ? error.message : "تعذر إنشاء الفيديو");
      setRenderState("error");
    } finally {
      setSegmentationProgress(null);
    }
  };

  // Real render + gallery save, run silently in the background as the user
  // edits an already-complete project -- no download, and deliberately NEVER
  // touches renderState/videoUrl (those drive the "تنزيل الفيديو" button's
  // own disabled/spinner state, which must stay tied ONLY to a user-clicked
  // download, not to this). See the debounced effect below for when this
  // actually fires, and saveToGallery's upsert-by-draftId (videoGallery.ts)
  // for why calling this repeatedly updates the SAME gallery entry instead
  // of piling up a new one on every edit.
  const triggerBackgroundRender = async () => {
    if (backgroundRenderInFlightRef.current) {
      // Already rendering an older snapshot of this project -- don't start a
      // second renderMedia() in parallel for it, just remember that one more
      // pass is needed once the current one finishes.
      backgroundRenderStaleRef.current = true;
      return;
    }

    backgroundRenderInFlightRef.current = true;
    setBackgroundSaveStatus("saving");
    try {
      // Loop instead of a single pass: if an edit lands WHILE renderMedia()
      // is running (backgroundRenderStaleRef gets set by a re-entrant call
      // above), that edit only exists in the draft/live-preview so far, not
      // yet in the saved video -- render once more immediately with
      // whatever the project looks like NOW, instead of waiting out a whole
      // extra debounce cycle to notice it.
      do {
        backgroundRenderStaleRef.current = false;
        const currentDraftId = await autosaveDraft();
        if (!currentDraftId) break;

        // Queued through the same mutex a manual "تنزيل الفيديو" click uses
        // (see runSerializedRender) -- if one lands right now, this
        // iteration's renderMedia() call waits its turn rather than racing
        // it for the same output file.
        await runSerializedRender(async () => {
          const formData = buildRenderFormData(undefined, currentDraftId);
          const response = await fetch("/api/video/render", {
            method: "POST",
            body: formData,
          });
          const data = await response.json();
          if (!response.ok || !data.videoUrl) {
            throw new Error(data.error || "Background render failed");
          }
        });
      } while (backgroundRenderStaleRef.current);

      setBackgroundSaveStatus("saved");
    } catch (error) {
      console.error("[Auto-save] Background gallery render failed:", error);
      setBackgroundSaveStatus("error");
    } finally {
      backgroundRenderInFlightRef.current = false;
    }
  };

  const versesArray = useMemo(
    () =>
      startVerse && endVerse
        ? Array.from({ length: endVerse - startVerse + 1 }, (_, i) => startVerse + i)
        : [],
    [startVerse, endVerse]
  );

  const selectedVersesContent =
    selectedSurah && startVerse && endVerse
      ? selectedSurah.verses
        .filter((verse) => verse.id >= startVerse && verse.id <= endVerse)
        .map((verse) => {
          const apiAyah = selectedApiSurah?.ayahs.find((ayah) => ayah.ayah_number === verse.id);
          const fallbackTranslation = fixMojibake(apiAyah?.text_turkish || "");
          // Always attached regardless of the CURRENTLY selected arabicFont
          // -- same reasoning as QuranVideo.tsx/render/route.ts -- so the
          // verse-list preview below can switch fonts instantly too.
          const qcfV1 = qcfV1TextBySurahAyah.get(`${selectedSurah.id}:${verse.id}`);

          return {
            ...verse,
            text: fixMojibake(apiAyah?.text_arabic || verse.text),
            translation: getTranslation(selectedSurah.id, verse.id, fallbackTranslation),
            page: verse.page,
            textV1: qcfV1?.text,
            pageV1: qcfV1?.page,
          };
        })
      : [];

  // Mirrors QuranVideo.tsx's own resolvedTranslationFontFamily -- so
  // SegmentTimingEditor's Arabic-script-aware text (see arabicFont passed
  // to it below) shows the translation in the SAME font the actual
  // video/live preview uses, instead of the browser's plain default.
  const timingEditorTranslationFontFamily =
    translationFont === "custom" && customTranslationFontUrl
      ? "'CustomTranslationFont', Arial, sans-serif"
      : `${TRANSLATION_FONT_OPTIONS[translationFont === "custom" ? "aileron" : translationFont].family}, Arial, sans-serif`;

  // A ready-to-paste video title (e.g. for YouTube), shown under the
  // preview player -- follows the app's OWN current interface language
  // (isArabic), unlike the video's actual on-screen Turkish text/translation
  // (which always stays Turkish regardless of isArabic, since that's fixed
  // content baked into the video itself for its Turkish-speaking audience --
  // a suggested TITLE has no such fixed audience, it's just copy this UI
  // hands the user, so it follows the UI's own language like everything
  // else on this page). No verse-range suffix at all once the WHOLE surah
  // is selected (1..total_verses); a single verse gets its own phrasing, a
  // real range shows "start-end" either way. The reciter credit only
  // appears for a picked reciter -- a user-uploaded custom audio file has
  // no reciter name to credit.
  const suggestedTitle = (() => {
    if (!selectedSurah || !startVerse || !endVerse) return null;
    const isWholeSurah = startVerse === 1 && endVerse === selectedSurah.total_verses;

    if (isArabic) {
      const surahName = fixMojibake(selectedSurah.name);
      const verseRange = isWholeSurah
        ? ""
        : startVerse === endVerse
          ? ` - الآية ${startVerse}`
          : ` - الآيات ${startVerse}-${endVerse}`;
      const reciterPart =
        audioSourceMode === "reciter" ? ` | القارئ: ${RECITER_ARABIC_NAMES[selectedReciter] ?? selectedReciter}` : "";
      return `سورة ${surahName}${verseRange}${reciterPart}`;
    }

    const turkishName = surahTurkishNames.get(selectedSurah.id);
    const surahName = turkishName ? fixMojibake(turkishName) : fixMojibake(selectedSurah.transliteration);
    const verseRange = isWholeSurah
      ? ""
      : startVerse === endVerse
        ? ` ${startVerse}. Ayet`
        : ` ${startVerse}-${endVerse}`;
    const reciterPart =
      audioSourceMode === "reciter" ? ` | Okuyan: ${RECITER_DISPLAY_NAMES[selectedReciter] ?? selectedReciter}` : "";
    return `${surahName} Suresi${verseRange}${reciterPart}`;
  })();

  const canGenerate = Boolean(
    renderState !== "rendering" &&
    selectedSurah && startVerse && endVerse &&
    preparedAudioUrl !== null
  );

  // Reset prepared audio if user changes audio-related selection (NOT background).
  // Also clears any existing segmentation/timing data: its start_ms/end_ms are
  // indexed against the OLD prepared audio's timeline, so it silently
  // desyncs once the verse range/reciter/custom-audio changes. The
  // server-side /api/segmentation/clear call matters too, not just the
  // in-memory reset -- render/route.ts reads temp_segmentation.json from
  // disk independently of this component's state, so a stale file left over
  // from a prior segmentation would otherwise get applied to a new verse
  // range if the user regenerates without re-opening the timing step.
  useEffect(() => {
    if (isHydratingRef.current) return;
    audioParamsEpochRef.current += 1;
    setPreparedAudioUrl(null);
    setPreparedAudioLocalPath(null);
    setPreparedJsonData(null);
    setAudioTrimStart(0);
    setAudioTrimEnd(0);
    setTrimmedPreviewAudioUrl(null);
    setTrimmedPreviewOffset(0);
    setVideoUrl(null);
    setRenderState("idle");
    setPendingSegmentationData([]);
    setPuaTokenCountsByAyah({});
    setLowConfidenceAyahs(new Set());
    fetch("/api/segmentation/clear", { method: "POST" }).catch(() => {});
  }, [selectedSurah, startVerse, endVerse, selectedReciter, customAudio, audioSourceMode]);

  // Audio preparation is intentionally NOT automatic: it only runs when the
  // user explicitly presses the "تجهيز الصوت" button in Step3Audio (see
  // handlePrepareAudio). Selecting a reciter, uploading a custom audio file,
  // or extracting audio from an uploaded video only stages that source --
  // it does not itself trigger extraction/Whisper alignment, which is slow
  // and shouldn't run behind the user's back on every field change.

  // Persists the current builder state server-side (JSON + any uploaded
  // files) under a generated id, keyed on THIS browser via localStorage --
  // there are no user accounts in this app, so there's no link/URL to share;
  // the point is purely "close the tab, reopen it later, everything is
  // exactly as I left it." Re-saving reuses the existing draftId
  // (update-in-place) instead of minting a new file every time.
  const autosaveDraft = async () => {
    if (!selectedSurah || startVerse === null || endVerse === null) return;
    setAutosaveStatus("saving");
    try {
      const formData = new FormData();
      if (draftId) formData.append("draftId", draftId);
      formData.append("surahId", String(selectedSurah.id));
      formData.append("startVerse", String(startVerse));
      formData.append("endVerse", String(endVerse));
      formData.append("selectedReciter", selectedReciter);
      formData.append("audioSourceMode", audioSourceMode);
      formData.append("translationId", selectedTranslation.id);
      formData.append("wizardStep", String(currentStep));
      formData.append("arabicTextScale", String(arabicTextScale));
      formData.append("arabicWidthScale", String(arabicWidthScale));
      formData.append("translationTextScale", String(translationTextScale));
      formData.append("translationWidthScale", String(translationWidthScale));
      formData.append("translationFont", translationFont);
      formData.append("arabicFont", arabicFont);
      if (customTranslationFontFile) {
        formData.append("customTranslationFont", customTranslationFontFile);
      } else if (customTranslationFontUrl && !customTranslationFontUrl.startsWith("blob:")) {
        formData.append("existingCustomTranslationFontUrl", customTranslationFontUrl);
      }

      if (preparedAudioUrl) {
        formData.append(
          "preparedAudio",
          JSON.stringify({
            preparedAudioUrl,
            preparedAudioLocalPath,
            preparedJsonData,
            audioTrimStart,
            audioTrimEnd,
          })
        );
      }

      if (pendingSegmentationData.length > 0) {
        formData.append(
          "segmentation",
          JSON.stringify({
            pendingSegmentationData,
            lowConfidenceAyahs: Array.from(lowConfidenceAyahs),
          })
        );
      }

      if (bgImage) formData.append("bgImage", bgImage);
      if (bgVideo) formData.append("bgVideo", bgVideo);
      if (audioSourceMode === "custom" && customAudio) formData.append("customAudio", customAudio);

      const res = await fetch("/api/drafts", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok || !data.draftId) throw new Error(data.error || "Failed to save draft");

      setDraftId(data.draftId);
      localStorage.setItem(DRAFT_STORAGE_KEY, data.draftId);
      setAutosaveStatus("saved");
      // Returned (not just set via state, which wouldn't be visible to a
      // caller in this same tick) so executeVideoRender can thread the
      // definitely-current id straight into this exact render's gallery
      // entry -- see its own comment.
      return data.draftId as string;
    } catch (err) {
      setAutosaveStatus("error");
      console.error("[Draft] Autosave failed:", err);
    }
  };

  // Debounced autosave: fires ~1.5s after the user stops changing anything
  // meaningful, rather than on every keystroke/click. Skipped entirely while
  // a draft is actively being restored (isHydratingRef) so hydration doesn't
  // immediately re-save the very data it just loaded.
  useEffect(() => {
    if (isHydratingRef.current) return;
    if (!selectedSurah || startVerse === null || endVerse === null) return;

    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      autosaveDraft();
    }, 1500);

    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedSurah,
    startVerse,
    endVerse,
    selectedReciter,
    audioSourceMode,
    selectedTranslation.id,
    bgImage,
    bgVideo,
    customAudio,
    preparedAudioUrl,
    pendingSegmentationData,
    currentStep,
    arabicTextScale,
    arabicWidthScale,
    translationTextScale,
    translationWidthScale,
    translationFont,
    arabicFont,
    customTranslationFontFile,
    customTranslationFontUrl,
  ]);

  // The ONLY trigger for the real background gallery save (see
  // triggerBackgroundRender/saveToGallery's upsert-by-draftId) -- fires ~3s
  // after the user stops changing anything that affects the rendered
  // output, not immediately on every edit tick. This delay is load-bearing,
  // not just politeness: a real renderMedia() call is CPU-heavy (ffmpeg +
  // a full headless-Chromium encode), and firing one on every single
  // preview reload (as an earlier version of this did, straight from
  // handleLoadPreview) kept the server's CPU saturated almost continuously
  // during active editing -- degrading everything else running on it,
  // INCLUDING the free/instant preview requests themselves, which is what
  // made the preview visibly get stuck on "جاري التحميل" without ever
  // resolving. Waiting for actual quiet time avoids that entirely, at the
  // cost of the save no longer being instant -- gated on the project being
  // complete enough to render (canGenerate) and belonging to a logged-in
  // user (the gallery is login-gated -- see render/route.ts's own `if
  // (session)` guard; for a logged-out visitor this render would burn real
  // server time only for saveToGallery to be skipped entirely).
  useEffect(() => {
    if (isHydratingRef.current) return;
    if (!isLoggedIn || !canGenerate) return;

    if (backgroundRenderTimerRef.current) clearTimeout(backgroundRenderTimerRef.current);
    backgroundRenderTimerRef.current = setTimeout(() => {
      triggerBackgroundRender();
    }, 3000);

    return () => {
      if (backgroundRenderTimerRef.current) clearTimeout(backgroundRenderTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isLoggedIn,
    canGenerate,
    selectedReciter,
    audioSourceMode,
    selectedTranslation.id,
    bgImage,
    bgVideo,
    customAudio,
    preparedAudioUrl,
    audioTrimStart,
    audioTrimEnd,
    pendingSegmentationData,
    arabicTextScale,
    arabicWidthScale,
    translationTextScale,
    translationWidthScale,
    translationFont,
    arabicFont,
    customTranslationFontFile,
    customTranslationFontUrl,
    aspectRatio,
    quality,
  ]);

  // Resume the last in-progress project automatically on mount, keyed by a
  // draftId stashed in localStorage -- OR, taking priority over that, a
  // `?draft=` URL param: a deliberate link to one SPECIFIC draft (e.g.
  // GalleryGrid.tsx's Edit button, or a bookmarked link from before
  // autosave existed) must always win over whatever unrelated project
  // happens to still be sitting in localStorage from a previous session,
  // never silently resume the wrong one instead.
  // isHydratingRef suppresses the prepared-audio/segmentation invalidation
  // effect above while the surah/verse/reciter fields below are being set,
  // then the prepared-audio/segmentation fields are restored directly from
  // the draft afterward -- reversing that order would have the invalidation
  // effect immediately wipe what hydration just restored.
  useEffect(() => {
    const draftIdToResume =
      new URLSearchParams(window.location.search).get("draft") || localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!draftIdToResume) return;

    (async () => {
      isHydratingRef.current = true;
      try {
        const res = await fetch(`/api/drafts/${draftIdToResume}`);
        if (!res.ok) {
          localStorage.removeItem(DRAFT_STORAGE_KEY);
          return;
        }
        const data = await res.json();

        setDraftId(data.id);
        localStorage.setItem(DRAFT_STORAGE_KEY, data.id);

        const surah = surahs.find((s) => s.id === data.surahId) || null;
        setSelectedSurah(surah);
        setSelectedApiSurah(null);
        setStartVerse(data.startVerse ?? null);
        setEndVerse(data.endVerse ?? null);
        if (data.selectedReciter) setSelectedReciter(data.selectedReciter);
        if (data.audioSourceMode) setAudioSourceMode(data.audioSourceMode);
        if (data.translationId) setSelectedTranslationId(data.translationId);
        if (surah) await fetchSurahTranslations(surah.id);

        if (data.background?.url) {
          const blob = await (await fetch(data.background.url)).blob();
          const file = new File([blob], "draft-bg.jpg", { type: blob.type });
          setBgImage(file);
          setBgPreview(URL.createObjectURL(file));
        }

        if (data.backgroundVideo?.url) {
          const blob = await (await fetch(data.backgroundVideo.url)).blob();
          const file = new File([blob], "draft-bg.mp4", { type: blob.type });
          setBgVideo(file);
          setBgVideoPreview(URL.createObjectURL(file));
        }

        if (data.customAudio?.url) {
          const blob = await (await fetch(data.customAudio.url)).blob();
          const file = new File([blob], data.customAudio.originalName || "draft-audio.mp3", { type: blob.type });
          setCustomAudio(file);
        }

        if (data.preparedAudio) {
          setPreparedAudioUrl(data.preparedAudio.preparedAudioUrl ?? null);
          setPreparedAudioLocalPath(data.preparedAudio.preparedAudioLocalPath ?? null);
          setPreparedJsonData(data.preparedAudio.preparedJsonData ?? null);
          setAudioTrimStart(data.preparedAudio.audioTrimStart ?? 0);
          setAudioTrimEnd(data.preparedAudio.audioTrimEnd ?? 0);
        }

        if (data.segmentation) {
          setPendingSegmentationData(data.segmentation.pendingSegmentationData ?? []);
          setLowConfidenceAyahs(new Set(data.segmentation.lowConfidenceAyahs ?? []));
          // Re-sync the server-side temp_segmentation.json (render/route.ts
          // reads it independently of this component's in-memory state) so
          // a resumed draft renders with its segmentation intact.
          if (data.segmentation.pendingSegmentationData?.length > 0) {
            await fetch("/api/segmentation/apply", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(data.segmentation.pendingSegmentationData),
            }).catch(() => {});
          }
        }

        if (data.wizardStep) setCurrentStep(data.wizardStep);
        if (data.arabicTextScale) setArabicTextScale(data.arabicTextScale);
        if (data.arabicWidthScale) setArabicWidthScale(data.arabicWidthScale);
        if (data.translationTextScale) setTranslationTextScale(data.translationTextScale);
        if (data.translationWidthScale) setTranslationWidthScale(data.translationWidthScale);
        if (data.translationFont) setTranslationFont(data.translationFont);
        if (data.arabicFont) setArabicFont(data.arabicFont);
        // No File object to restore (never was one, just its already-
        // uploaded URL) -- that's fine, getAssetUrl in QuranVideo.tsx
        // resolves this real server URL directly, no re-upload needed
        // unless the user picks a different file.
        if (data.customTranslationFont?.url) {
          setCustomTranslationFontUrl(data.customTranslationFont.url);
          if (data.customTranslationFont.originalName) setCustomTranslationFontName(data.customTranslationFont.originalName);
        }
      } catch (err) {
        console.error("[Draft] Resume failed:", err);
      } finally {
        isHydratingRef.current = false;
      }
    })();
    // Intentionally run once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wipes every field back to a blank project and forgets the saved draft
  // entirely -- the only way out of autosave's "always remember where I left
  // off" behavior. Deletes the server-side draft (JSON + any uploaded
  // files) too, rather than just abandoning it, so it doesn't linger forever
  // with no automatic expiry (see /api/drafts).
  const handleStartOver = async () => {
    setShowStartOverConfirm(false);

    const idToDelete = draftId;
    localStorage.removeItem(DRAFT_STORAGE_KEY);
    if (idToDelete) {
      fetch(`/api/drafts/${idToDelete}`, { method: "DELETE" }).catch(() => {});
    }
    await fetch("/api/segmentation/clear", { method: "POST" }).catch(() => {});

    isHydratingRef.current = true;
    setSelectedSurah(null);
    setSelectedApiSurah(null);
    setSelectedReciter("mishary_alafasy");
    setStartVerse(null);
    setEndVerse(null);
    if (bgPreview) URL.revokeObjectURL(bgPreview);
    setBgImage(null);
    setBgPreview(null);
    if (bgVideoPreview) URL.revokeObjectURL(bgVideoPreview);
    setBgVideo(null);
    setBgVideoPreview(null);
    setRenderState("idle");
    setRenderError("");
    setVideoUrl(null);
    // The live-preview trio (previewProps/isLoadingPreview/previewError)
    // was never touched here -- previewProps happens to get cleared as a
    // side effect of preparedAudioUrl going null below (see the debounced
    // auto-reload effect's own early-return), but previewError has no
    // such indirect path and was staying on screen showing whatever
    // error the PREVIOUS project last hit (e.g. "Failed to trim audio
    // using FFmpeg") even after starting a brand new one.
    setPreviewProps(null);
    setIsLoadingPreview(false);
    setPreviewError("");
    setTranslationSyncNotice(false);
    setCustomAudio(null);
    setAudioSourceMode("reciter");
    setSegmentationProgress(null);
    setPendingSegmentationData([]);
    setPuaTokenCountsByAyah({});
    setLowConfidenceAyahs(new Set());
    setShowTimingEditor(false);
    setPreparedAudioUrl(null);
    setPreparedAudioLocalPath(null);
    setPreparedJsonData(null);
    setAudioTrimStart(0);
    setAudioTrimEnd(0);
    setTrimmedPreviewAudioUrl(null);
    setTrimmedPreviewOffset(0);
    setCurrentStep(1);
    setDraftId(null);
    setAutosaveStatus("idle");
    setSelectedTranslationId("none");
    // Let the reset settle before re-enabling autosave/invalidation reactions.
    setTimeout(() => {
      isHydratingRef.current = false;
    }, 0);
  };

  useEffect(() => {
    const baseUrl = process.env.NEXT_PUBLIC_API_URL || "/backend";
    fetch(`${baseUrl}/surahs/`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && Array.isArray(data)) {
          setSurahTurkishNames(
            new Map(data.map((s: { id: number; name_turkish: string }) => [s.id, s.name_turkish]))
          );
        }
      })
      .catch(() => { });

    // Default to "none" in the Video Creator
    setSelectedTranslationId("none");
  }, [setSelectedTranslationId]);

  const handleSurahChange = async (surahId: number | string) => {
    surahId = Number(surahId);
    const surah = surahs.find((item) => item.id === surahId) || null;
    setSelectedSurah(surah);
    setSelectedApiSurah(null);
    setStartVerse(null);
    setEndVerse(null);
    setVideoUrl(null);
    setRenderError("");
    setRenderState("idle");

    if (!surah) return;

    try {
      const baseUrl = process.env.NEXT_PUBLIC_API_URL || "/backend";
      const response = await fetch(`${baseUrl}/surahs/${surahId}`);
      if (response.ok) {
        setSelectedApiSurah(await response.json());
      }

      // Fetch dynamic translations for the selected surah
      await fetchSurahTranslations(surah.id);

    } catch {
      setSelectedApiSurah(null);
    }
  };

  useEffect(() => {
    if (!selectedSurah) return;
    const surahId = selectedSurah.id;
    const translationId = selectedTranslation.id;
    fetchSurahTranslations(surahId).then(() => {
      // Only re-sync already-timed ayahs' translation_text when the
      // TRANSLATION itself actually changed (not merely because this effect
      // also re-fires on a surah change) -- and only once the fetch that
      // populates getTranslation()'s cache has actually resolved, so we
      // never bake in a stale fallback string.
      if (isHydratingRef.current) return;
      if (lastSyncedTranslationIdRef.current === translationId) return;
      lastSyncedTranslationIdRef.current = translationId;

      setPendingSegmentationData((prev) => {
        let touchedMultiPart = false;
        const next = prev.map((entry) => {
          if (entry.surah !== surahId) return entry;
          const apiAyah = selectedApiSurah?.ayahs.find((a) => a.ayah_number === entry.ayah);
          const fallback = fixMojibake(apiAyah?.text_turkish || "");
          const liveTranslation = getTranslation(surahId, entry.ayah, fallback);
          if (entry.mappings.length <= 1) {
            return {
              ...entry,
              mappings: entry.mappings.map((m: any) => ({ ...m, translation_text: liveTranslation })),
            };
          }
          // Split ayah: only the first part is safe to auto-update -- the
          // rest hold text the user manually distributed across them.
          touchedMultiPart = true;
          return {
            ...entry,
            mappings: entry.mappings.map((m: any, idx: number) =>
              idx === 0 ? { ...m, translation_text: liveTranslation } : m
            ),
          };
        });
        if (touchedMultiPart) setTranslationSyncNotice(true);
        return next;
      });
    });
  }, [selectedSurah?.id, selectedTranslation.id, fetchSurahTranslations, selectedApiSurah, getTranslation]);

  const handleStartVerseChange = (verse: number | string) => {
    let num = Number(verse);
    if (isNaN(num) || num < 1) num = 1;
    if (selectedSurah && num > selectedSurah.total_verses) num = selectedSurah.total_verses;
    setStartVerse(num);
    setEndVerse(num);
    setVideoUrl(null);
    setRenderError("");
    setRenderState("idle");
  };

  const handleAddNextVerse = () => {
    if (!selectedSurah || endVerse === null) return;
    if (endVerse < selectedSurah.total_verses) {
      setEndVerse(endVerse + 1);
    }
    setVideoUrl(null);
    setRenderError("");
    setRenderState("idle");
  };

  const handleRemoveLastVerse = () => {
    if (startVerse === null || endVerse === null) return;
    if (endVerse > startVerse) {
      setEndVerse(endVerse - 1);
    }
    setVideoUrl(null);
    setRenderError("");
    setRenderState("idle");
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (bgPreview) {
      URL.revokeObjectURL(bgPreview);
    }
    // A video and an image background are mutually exclusive -- picking one
    // clears the other rather than leaving a stale, invisible selection
    // behind (QuranVideo.tsx would ignore it anyway, since video takes
    // priority, but keeping both "selected" is confusing in the wizard UI).
    if (bgVideoPreview) {
      URL.revokeObjectURL(bgVideoPreview);
    }
    setBgVideo(null);
    setBgVideoPreview(null);

    setBgImage(file);
    setBgPreview(URL.createObjectURL(file));
    setVideoUrl(null);
    setRenderState("idle");
  };

  const removeImage = () => {
    if (bgPreview) {
      URL.revokeObjectURL(bgPreview);
    }
    setBgImage(null);
    setBgPreview(null);
    setVideoUrl(null);
    setRenderState("idle");
  };

  const handleVideoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (bgVideoPreview) {
      URL.revokeObjectURL(bgVideoPreview);
    }
    if (bgPreview) {
      URL.revokeObjectURL(bgPreview);
    }
    setBgImage(null);
    setBgPreview(null);

    setBgVideo(file);
    setBgVideoPreview(URL.createObjectURL(file));
    setVideoUrl(null);
    setRenderState("idle");
  };

  const removeVideo = () => {
    if (bgVideoPreview) {
      URL.revokeObjectURL(bgVideoPreview);
    }
    setBgVideo(null);
    setBgVideoPreview(null);
    setVideoUrl(null);
    setRenderState("idle");
  };

  const LONG_VERSE_THRESHOLD = 7; // Only segment verses with more than 7 Arabic words

  const handleSegmentLongVerses = async () => {
    if (!selectedSurah || selectedVersesContent.length === 0) return;

    const lowConfidenceIds = new Set<number>();
    setSegmentationProgress(isArabic ? "جاري تقسيم الآيات..." : "Ayetler bölümleniyor...");

    // Each verse's segmentation is fully independent of every other verse's,
    // so they're all fired concurrently instead of one `await` at a time --
    // Promise.all still returns them in the same order as
    // selectedVersesContent regardless of which fetch resolves first, so
    // downstream ordering is unaffected.
    const perVerseResults = await Promise.all(
      selectedVersesContent.map(async (verse) => {
        const arabicWordCount = verse.text.trim().split(/\s+/).length;
        const translation = verse.translation || "";

        if (!translation.trim()) return null;

        // Only call AI if it's reasonably long, to save time and tokens
        if (arabicWordCount >= 6) {
          try {
            const segRes = await fetch("/api/segmentation/auto", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                surah: selectedSurah.id,
                ayah: verse.id,
                translation,
                arabicWordCount,
              }),
            });

            if (segRes.ok) {
              const segData = await segRes.json();
              if (segData.success && segData.mappings && segData.mappings.length > 1) {
                if (segData.lowConfidence) {
                  lowConfidenceIds.add(verse.id);
                }
                return {
                  surah: selectedSurah.id,
                  ayah: verse.id,
                  mappings: segData.mappings,
                };
              }
            }
          } catch (err) {
            console.warn(`[UI] Auto-segmentation error for verse ${verse.id}:`, err);
          }
        }

        // If AI didn't segment it (too short, failed, or returned 1 segment), add as a single block
        // so the user can still manually divide it in the editor.
        // word_count only needs to be a positive placeholder here — a single
        // mapping spanning the whole verse gets auto-corrected to the exact
        // real word count by /api/segmentation/apply.
        return {
          surah: selectedSurah.id,
          ayah: verse.id,
          mappings: [
            {
              part: 1,
              translation_text: translation,
              word_count: arabicWordCount,
            },
          ],
        };
      })
    );

    const segmentationResults = perVerseResults.filter(
      (r): r is NonNullable<typeof r> => r !== null
    );

    if (segmentationResults.length > 0) {
      setPendingSegmentationData(segmentationResults);
      setLowConfidenceAyahs(lowConfidenceIds);
      try {
        const wordMapRes = await fetch("/api/segmentation/word-map", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            surah: selectedSurah.id,
            ayahs: segmentationResults.map((r) => r.ayah),
          }),
        });
        if (wordMapRes.ok) {
          const { wordMap } = await wordMapRes.json();
          const puaCounts: Record<number, number[]> = {};
          for (const ayah in wordMap) {
            puaCounts[Number(ayah)] = wordMap[ayah].puaTokenCounts;
          }
          setPuaTokenCountsByAyah(puaCounts);
        }
      } catch (err) {
        console.warn("[UI] Failed to fetch word map for segmentation preview:", err);
      }
    } else {
      alert(isArabic ? "لم يتم العثور على ترجمات للآيات المحددة." : "Seçili ayetler için çeviri bulunamadı.");
    }
    setSegmentationProgress(null);
  };

  const handleClearSegmentation = async () => {
    setPendingSegmentationData([]);
    setPuaTokenCountsByAyah({});
    setLowConfidenceAyahs(new Set());
    await fetch("/api/segmentation/clear", { method: "POST" }).catch(() => { });
  };

  // The timing editor now doubles as the audio trimmer (its first/last
  // segment boundaries ARE the trim points -- see SegmentTimingEditor.tsx's
  // buildRegions), so it always works directly on the untouched prepared
  // clip -- there's no separate pre-trimmed file/offset to account for.
  const getTimingEditorAudioUrl = () => trimmedPreviewAudioUrl ?? preparedAudioUrl;

  // Slices verse.text (QCF glyph text) the same way the main segmentation
  // list preview does, converting a real-word range into the matching
  // glyph-token range via puaTokenCountsByAyah (falls back to 1:1 if that
  // map isn't loaded yet for this ayah). Reads the CURRENTLY selected
  // arabicFont from closure (same as QuranVideo.tsx's own isQcf1) to slice
  // verse.textV1 instead when qcf1 is picked -- puaTokenCounts is deliberately
  // NOT applied for v1 either way (see its own comment in types.ts: those
  // counts are qcf2-glyph-specific), always the 1:1 real-word fallback below.
  const sliceArabicForWordRange = (
    verse: Verse & { textV1?: string; pageV1?: number },
    startWordIdx: number,
    wordCount: number,
    totalWordCount: number,
    puaTokenCountsOverride?: Record<number, number[]>
  ): string => {
    const isQcf1 = arabicFont === "qcf1";
    const allWords = (isQcf1 ? verse.textV1 ?? verse.text : verse.text).trim().split(/\s+/);
    const puaTokenCounts = isQcf1 ? undefined : (puaTokenCountsOverride ?? puaTokenCountsByAyah)[verse.id];
    const puaCountsValid = puaTokenCounts && puaTokenCounts.length === totalWordCount;
    let puaStart = startWordIdx;
    let puaEnd = startWordIdx + wordCount;
    if (puaCountsValid) {
      puaStart = puaTokenCounts!.slice(0, startWordIdx).reduce((a, b) => a + b, 0);
      puaEnd = puaStart + puaTokenCounts!.slice(startWordIdx, startWordIdx + wordCount).reduce((a, b) => a + b, 0);
    }
    const coreWords = allWords.slice(puaStart, puaEnd);
    // The verse's LAST word range must always reach the end of allWords --
    // trailing QCF glyph tokens (waqf marks, the ayah-number marker) sit
    // past the real-word count in both the naive 1:1 fallback above and any
    // undercounted puaTokenCounts map. Any such leftover tokens are fused
    // directly onto the last real word with NO separating space (matching
    // how the Mushaf actually typesets the ayah-number marker flush against
    // the preceding word) rather than appended as their own array entries --
    // otherwise callers that infer word_count by counting whitespace tokens
    // in this string (e.g. VideoCreatorForm's handleSaveTimingEditor) would
    // miscount the marker as an extra "word" and desync every word-indexed
    // lookup downstream (wordTimings, puaTokenCounts) for that segment.
    if (startWordIdx + wordCount >= totalWordCount) {
      const trailing = allWords.slice(puaEnd, allWords.length);
      return trailing.length > 0 ? coreWords.join(" ") + trailing.join("") : coreWords.join(" ");
    }
    return coreWords.join(" ");
  };

  // Builds the initial region bounds (in seconds, relative to whatever
  // getTimingEditorAudioUrl() returns) for every mapping of one ayah: reuses
  // any previously-saved manual start_ms/end_ms if present, otherwise
  // derives it from the Whisper wordTimings the same way QuranVideo.tsx
  // does (cumulative word_count as a word-index range into
  // preparedJsonData.verses[ayah].words). Both paths are stored/read in the
  // RAW pre-trim coordinate space, so the trim offset is subtracted here to
  // land on the trimmed audio's own 0-based timeline.
  //
  // When the ayah hasn't been segmented into parts yet, falls back to a
  // single synthetic segment spanning the whole ayah (full translation/
  // Arabic text, first-word-start to last-word-end) — this is what lets the
  // editor open purely to preview/play the prepared audio, with no
  // segmentation required first.
  const buildTimingEditorSegments = (wordMapOverride?: Record<number, number[]>): SegmentTimingInput[] | null => {
    if (!selectedSurah || !preparedJsonData?.verses || !selectedVersesContent) return null;

    const allSegments: SegmentTimingInput[] = [];
    const puaMap = wordMapOverride ?? puaTokenCountsByAyah;
    // Same isQcf1 resolution as sliceArabicForWordRange above -- every
    // `page:` below needs the matching v1/v2 page number too, or the
    // Arabic text and the @font-face family SegmentTimingEditor picks for
    // it (via its own arabicFont prop) would disagree.
    const isQcf1 = arabicFont === "qcf1";
    // Tracks whether the absolute first/last segment across the WHOLE
    // selection already carries a manually-saved boundary (from a previous
    // save -- see handleSaveTimingEditor, which now derives audioTrimStart/
    // End straight from these same two positions) -- only when neither has
    // one yet do we seed the smart-default trim margin below, so re-opening
    // an already-trimmed editor never silently resets the user's choice.
    let firstSegHasManualTiming = false;
    let lastSegHasManualTiming = false;

    for (const verse of selectedVersesContent) {
      const ayahId = verse.id;
      const segmentation = pendingSegmentationData.find(
        (s) => s.surah === selectedSurah.id && s.ayah === ayahId
      );
      const words: { start: number; end: number }[] = preparedJsonData.verses[String(ayahId)]?.words;
      if (!words || words.length === 0) continue;

      if (!segmentation || segmentation.mappings.length === 0) {
        const startSec = words[0].start / 1000;
        const endSec = words[words.length - 1].end / 1000;
        // The REAL Uthmani word count (same basis apply/route.ts validates
        // against and getAyahRealWords/auto-segmentation use) -- NOT
        // Whisper's `words.length`, and NOT the raw QCF glyph-token count of
        // verse.text. Falls back to Whisper's count only if the word map
        // genuinely couldn't be fetched (see ensureWordMapForAyahs), same as
        // before this fix -- better than nothing, but no longer the default
        // path. Using the real count here (with arabicText sliced via
        // sliceArabicForWordRange, the same glyph-token-aware conversion the
        // segmented branch below already uses) keeps `wordCount` and
        // `arabicText` on the SAME basis from the moment this segment is
        // created, so splitting it in SegmentTimingEditor (which derives new
        // word counts from arabicText's own whitespace tokens) never drifts
        // away from what apply/route.ts will later validate -- previously,
        // wordCount was seeded from Whisper's count while arabicText held
        // the raw glyph text (a different token count whenever the ayah's
        // trailing waqf/ayah-number marker glyph didn't line up 1:1 with a
        // real word), so every split silently desynced the two, and
        // apply/route.ts's word-count auto-correction would then rewrite
        // word_count out from under the user's manually-dragged timings.
        const realWordCount = puaMap[ayahId]?.length ?? words.length;
        const arabicText = sliceArabicForWordRange(verse, 0, realWordCount, realWordCount, puaMap);
        if (allSegments.length === 0) firstSegHasManualTiming = false;
        lastSegHasManualTiming = false;
        allSegments.push({
          id: `${ayahId}-1`,
          ayah: ayahId,
          part: 1,
          translation_text: verse.translation || "",
          arabicText,
          wordCount: realWordCount,
          page: isQcf1 ? verse.pageV1 ?? verse.page : verse.page,
          startSec: Math.max(0, startSec),
          endSec: Math.max(0, endSec),
          isFirstOfAyah: true,
        });
        continue;
      }

      // A "repeat" mapping (repeat_of_part set) re-displays an EARLIER
      // mapping's own words -- it doesn't consume any new words of the
      // ayah, so it must be excluded from both the total (otherwise every
      // segment after it would be computed as if the ayah had more real
      // words than it does) and the running cursor below (otherwise its
      // word range, and every later segment's, drifts past the ayah's
      // actual last word and slices out empty Arabic text).
      const totalWordCount = segmentation.mappings.reduce(
        (sum: number, m: any) => sum + (typeof m.repeat_of_part === "number" ? 0 : m.word_count),
        0
      );
      let wordCursor = 0;
      segmentation.mappings.forEach((mapping: any) => {
        const isRepeatMapping = typeof mapping.repeat_of_part === "number";
        const startWordIdx = wordCursor;
        const endWordIdx = Math.min(wordCursor + mapping.word_count - 1, words.length - 1);
        // Trust the saved arabic_text verbatim ONLY for a repeat mapping --
        // same reasoning and same rule as QuranVideo.tsx's own chunkText
        // (see VerseMapping's comment in types.ts): re-deriving live via
        // sliceArabicForWordRange is correct for every OTHER segment and,
        // unlike the frozen saved text, always matches the CURRENTLY
        // selected arabicFont instead of whichever one was picked when this
        // was last saved.
        const arabicText =
          isRepeatMapping && typeof mapping.arabic_text === "string" && mapping.arabic_text.length > 0
            ? mapping.arabic_text
            : sliceArabicForWordRange(verse, startWordIdx, mapping.word_count, totalWordCount, puaMap);
        if (!isRepeatMapping) wordCursor += mapping.word_count;

        const hasManual = typeof mapping.start_ms === "number" && typeof mapping.end_ms === "number";
        const startSec = hasManual ? mapping.start_ms / 1000 : (words[startWordIdx]?.start ?? 0) / 1000;
        const endSec = hasManual ? mapping.end_ms / 1000 : (words[endWordIdx]?.end ?? words[words.length - 1].end) / 1000;

        if (allSegments.length === 0) firstSegHasManualTiming = hasManual;
        lastSegHasManualTiming = hasManual;
        allSegments.push({
          id: `${ayahId}-${mapping.part}`,
          ayah: ayahId,
          part: mapping.part,
          translation_text: mapping.translation_text,
          arabicText,
          wordCount: mapping.word_count,
          page: isQcf1 ? verse.pageV1 ?? verse.page : verse.page,
          startSec: Math.max(0, startSec),
          endSec: Math.max(0, endSec),
          // Prefer the persisted value (a duplicated first-of-ayah segment
          // keeps it, even though it isn't at part 1) -- only fall back to
          // the positional guess for older saved data without this field.
          isFirstOfAyah: typeof mapping.isFirstOfAyah === "boolean" ? mapping.isFirstOfAyah : mapping.part === 1,
          ...(isRepeatMapping ? { repeatOfId: `${ayahId}-${mapping.repeat_of_part}` } : {}),
        });
      });
    }

    // Seed the first/last segment's own boundary with the same smart trim
    // margin the old standalone AudioTrimmer defaulted to -- a bit before
    // the first detected word and a bit after the last, so the merged
    // editor doesn't start out clipped flush against Whisper's own word
    // boundaries (which can under/overshoot the true recitation edges).
    // Only when neither already carries a manually-saved boundary (see
    // firstSegHasManualTiming/lastSegHasManualTiming above) -- otherwise
    // this would silently discard a trim the user already chose and saved.
    if (allSegments.length > 0 && preparedJsonData?.verses) {
      const PAD_SECONDS = 10.0; // matches padSeconds sent when preparing audio
      const lowConfidenceEnd = !!preparedJsonData.lowConfidenceEnd;
      let minStart = Infinity;
      let maxEnd = 0;
      Object.values(preparedJsonData.verses).forEach((v: any) => {
        v.words?.forEach((w: any) => {
          if (w.start < minStart) minStart = w.start;
          if (w.end > maxEnd) maxEnd = w.end;
        });
      });
      if (!firstSegHasManualTiming && minStart !== Infinity) {
        allSegments[0].startSec = Math.max(0, minStart / 1000 - 0.35);
      }
      if (!lastSegHasManualTiming && maxEnd > 0) {
        const last = allSegments[allSegments.length - 1];
        last.endSec = Math.max(last.startSec, maxEnd / 1000 + (lowConfidenceEnd ? PAD_SECONDS - 2.0 : 1.5));
      }
    }

    // Every startSec/endSec above was computed relative to the TRUE
    // original prepared audio -- but getTimingEditorAudioUrl() may hand the
    // editor a shorter, already-cut preview instead (see
    // trimmedPreviewAudioUrl). Re-express every segment relative to THAT
    // file's own time 0 so the editor's regions land in the right place;
    // handleSaveTimingEditor/handleTrimOnly undo this same shift on the way
    // back, so nothing else in the app ever needs to know this preview
    // exists.
    if (trimmedPreviewAudioUrl && trimmedPreviewOffset > 0) {
      for (const seg of allSegments) {
        seg.startSec = Math.max(0, seg.startSec - trimmedPreviewOffset);
        seg.endSec = Math.max(0, seg.endSec - trimmedPreviewOffset);
      }
    }

    return allSegments.length > 0 ? allSegments : null;
  };

  // Fetches (and caches into puaTokenCountsByAyah) the real-word/PUA-glyph
  // map for any of the given ayahs not already loaded. Previously this map
  // was only ever populated as a side effect of running AI auto-segmentation
  // (handleSegmentLongVerses) -- opening the timing editor directly on an
  // unsegmented ayah (a normal flow: split it manually there without ever
  // clicking "auto-segment") left the map empty, forcing
  // buildTimingEditorSegments' fallback branch onto a different word-count
  // basis than what apply/route.ts validates against. Returns the merged
  // map directly (not just relying on state) so the caller can use it
  // immediately, before the setState below has actually re-rendered.
  const ensureWordMapForAyahs = async (ayahIds: number[]): Promise<Record<number, number[]>> => {
    if (!selectedSurah) return puaTokenCountsByAyah;
    const missing = ayahIds.filter((id) => !puaTokenCountsByAyah[id]);
    if (missing.length === 0) return puaTokenCountsByAyah;
    try {
      const res = await fetch("/api/segmentation/word-map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ surah: selectedSurah.id, ayahs: missing }),
      });
      if (!res.ok) return puaTokenCountsByAyah;
      const { wordMap } = await res.json();
      const merged = { ...puaTokenCountsByAyah };
      for (const ayah in wordMap) {
        merged[Number(ayah)] = wordMap[ayah].puaTokenCounts;
      }
      setPuaTokenCountsByAyah(merged);
      return merged;
    } catch (err) {
      console.warn("[UI] Failed to ensure word map for timing editor:", err);
      return puaTokenCountsByAyah;
    }
  };

  const handleOpenTimingEditor = async () => {
    if (!preparedAudioUrl || !preparedJsonData) {
      alert(
        isArabic
          ? "يجب تجهيز الصوت أولاً (زر «تجهيز الصوت») قبل ضبط التوقيت يدويًا."
          : "Zamanlamayı elle ayarlamadan önce sesi hazırlamanız gerekir (\"Sesi Hazırla\" düğmesi)."
      );
      return;
    }
    const wordMap = await ensureWordMapForAyahs(selectedVersesContent.map((v) => v.id));
    const segments = buildTimingEditorSegments(wordMap);
    if (!segments || segments.length === 0) {
      alert(
        isArabic
          ? "لا يمكن تحديد التوقيت — تأكد من أن الصوت المُجهَّز يغطي الآيات المحددة."
          : "Zamanlaması belirlenemiyor — hazırlanan sesin bu ayetleri kapsadığından emin olun."
      );
      return;
    }
    setShowTimingEditor(true);
    requestAnimationFrame(() => timingPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  // Applies JUST the trim (the panel's dedicated "قص الصوت الآن" button) --
  // deliberately does NOT touch pendingSegmentationData/translation/timing
  // at all, so it's safe to use mid-edit without saving or discarding
  // anything else the user hasn't finished with yet in the panel. Setting
  // these two alone is enough to make the (already debounced) live preview
  // reload with the newly-trimmed audio, exactly like a full save would.
  const handleTrimOnly = (trimStart: number, trimEnd: number) => {
    // trimStart/trimEnd are relative to whatever getTimingEditorAudioUrl()
    // handed the editor -- shift back to the TRUE original's coordinate
    // space (see buildTimingEditorSegments) before storing, since that's
    // what the render pipeline crops against.
    const offset = trimmedPreviewAudioUrl ? trimmedPreviewOffset : 0;
    setAudioTrimStart(Math.max(0, trimStart + offset));
    setAudioTrimEnd(Math.max(0, trimEnd + offset));
  };

  const handleSaveTimingEditor = (results: SegmentTimingResult[]) => {
    if (!selectedSurah || !showTimingEditor) return;

    // Every result.startSec/endSec is relative to whatever
    // getTimingEditorAudioUrl() handed the editor for THIS session -- shift
    // back to the TRUE original prepared clip's coordinate space (see
    // buildTimingEditorSegments) before storing anything, since that's the
    // one render/route.ts and audioTrimStart/End actually crop against.
    const previewOffsetSec = trimmedPreviewAudioUrl ? trimmedPreviewOffset : 0;

    // The editor's first/last segment boundaries (in on-timeline order,
    // exactly as SegmentTimingEditor's handleConfirm produced them) ARE the
    // audio trim points now -- see SegmentTimingEditor.tsx's buildRegions.
    // Feeds the exact same trimStart/trimEnd used everywhere else in the
    // pipeline (buildRenderFormData), no other change needed there.
    if (results.length > 0) {
      setAudioTrimStart(Math.max(0, results[0].startSec + previewOffsetSec));
      setAudioTrimEnd(Math.max(0, results[results.length - 1].endSec + previewOffsetSec));
    }

    // Group results by ayah, preserving their on-timeline order within each
    // group (results already arrive in that order from SegmentTimingEditor).
    const resultsByAyah: Record<number, SegmentTimingResult[]> = {};
    for (const res of results) {
       if (!resultsByAyah[res.ayah]) resultsByAyah[res.ayah] = [];
       resultsByAyah[res.ayah].push(res);
    }

    // Rebuild each ayah's mappings array from scratch based on the FULL
    // returned segment set, rather than patching existing mappings by
    // `part` number. The timing editor can now split/merge/retitle segments
    // inline, so the set of parts handed back may no longer line up
    // one-to-one with what was passed in -- part numbers are reassigned
    // sequentially here (1..N in timeline order), which also fixes the
    // "gap" bug class from the old part-preserving merge logic (a merged-
    // away part leaving e.g. parts 1 and 3 with no 2).
    setPendingSegmentationData((prev) => {
      const next = prev.filter(
        (s) => !(s.surah === selectedSurah.id && s.ayah in resultsByAyah)
      );
      for (const [ayahIdStr, ayahResults] of Object.entries(resultsByAyah)) {
        const ayahId = Number(ayahIdStr);
        // Session-local SegmentTimingResult.id -> its new (1-based) part
        // number, so a "repeat" segment's repeatOfId (also a session-local
        // id) can be translated into a `repeat_of_part` reference that's
        // still valid once ids are regenerated fresh on the next reopen --
        // see buildTimingEditorSegments below, which resolves it back into
        // a fresh id of that same shape (`${ayahId}-${part}`).
        const idToPart = new Map(ayahResults.map((r, idx) => [r.id, idx + 1]));
        // Per-segment size/width overrides (see VerseMapping's own scale
        // fields in types.ts, set via VideoPreviewPlayer's resize boxes)
        // live on the OLD mapping objects this rebuild is about to replace
        // wholesale -- carried over here position-for-position, or they'd
        // silently reset to default on every single "حفظ التوقيت", even
        // when nothing about that ayah's actual split/timing changed.
        // Only safe when the segment COUNT hasn't changed: a split/merge/
        // reorder means part N no longer means the same thing it did
        // before, so there's no reliable old segment to carry a resize over
        // from -- those simply reset, same as a segment resized for the
        // very first time always has.
        const oldMappings = prev.find((s) => s.surah === selectedSurah.id && s.ayah === ayahId)?.mappings;
        const canPreserveScale = oldMappings && oldMappings.length === ayahResults.length;
        next.push({
          surah: selectedSurah.id,
          ayah: ayahId,
          mappings: ayahResults.map((result, idx) => {
            const oldMapping = canPreserveScale ? oldMappings![idx] : undefined;
            return {
              part: idx + 1,
              // Real word count carried through as its own field (see
              // SegmentTimingInput.wordCount) rather than re-derived from
              // arabicText -- the raw QCF text's whitespace-token count can
              // run one higher than the real word count for whichever segment
              // ends an ayah, since the ayah-number marker glyph is its own
              // trailing token there.
              word_count: Math.max(1, result.wordCount),
              translation_text: result.translation_text,
              // Shifted back to the TRUE raw prepared clip's coordinate space
              // (see previewOffsetSec above) -- the exact space render/route.ts
              // expects for start_ms/end_ms, regardless of which file this
              // session's editor was actually showing.
              start_ms: Math.round((result.startSec + previewOffsetSec) * 1000),
              end_ms: Math.round((result.endSec + previewOffsetSec) * 1000),
              // The editor already resolved the exact Arabic text for this
              // segment (including "repeat" segments, whose real-word range
              // isn't the next sequential one -- see SegmentTimingEditor's
              // resolveContent). Passing it through verbatim instead of
              // letting QuranVideo.tsx re-derive it from cumulative
              // word_count is what makes repeats (and any future segment
              // whose word range isn't sequential) render the correct text.
              ...(result.arabicText ? { arabic_text: result.arabicText } : {}),
              isFirstOfAyah: result.isFirstOfAyah,
              ...(result.repeatOfId && idToPart.has(result.repeatOfId)
                ? { repeat_of_part: idToPart.get(result.repeatOfId) }
                : {}),
              ...(oldMapping?.arabicTextScale !== undefined ? { arabicTextScale: oldMapping.arabicTextScale } : {}),
              ...(oldMapping?.arabicWidthScale !== undefined ? { arabicWidthScale: oldMapping.arabicWidthScale } : {}),
              ...(oldMapping?.translationTextScale !== undefined
                ? { translationTextScale: oldMapping.translationTextScale }
                : {}),
              ...(oldMapping?.translationWidthScale !== undefined
                ? { translationWidthScale: oldMapping.translationWidthScale }
                : {}),
            };
          }),
        });
      }
      return next;
    });

    setShowTimingEditor(false);
  };

  // Uploads a client-side cut (see SegmentTimingEditor's applyTrimOnly) so
  // it survives past this panel closing -- called from handleConfirm there
  // right as Save is clicked. `sessionOffsetSeconds` is relative to
  // whatever getTimingEditorAudioUrl() handed the editor for THIS session
  // (the previous preview, if one was already active, or the true original
  // otherwise) -- add whatever base offset that session started from to
  // land back in the TRUE original's coordinate space, same as
  // handleSaveTimingEditor/handleTrimOnly.
  const handlePersistTrimmedAudio = async (blob: Blob, sessionOffsetSeconds: number) => {
    try {
      const baseOffset = trimmedPreviewAudioUrl ? trimmedPreviewOffset : 0;
      const formData = new FormData();
      formData.append("audio", blob, "trimmed.wav");
      const res = await fetch("/api/video/save-trimmed-preview", { method: "POST", body: formData });
      if (!res.ok) return;
      const data = await res.json();
      if (data.success && data.audioUrl) {
        setTrimmedPreviewAudioUrl(data.audioUrl);
        setTrimmedPreviewOffset(baseOffset + sessionOffsetSeconds);
      }
    } catch (err) {
      console.error("Failed to persist trimmed audio preview:", err);
    }
  };

  const handleGenerateVideo = async () => {
    if (!selectedSurah || !startVerse || !endVerse) return;

    setRenderState("rendering");
    setRenderError("");
    setVideoUrl(null);
    setSegmentationProgress(null);

    try {
      // Queued behind any background auto-save render already in flight for
      // this same project (see runSerializedRender/realRenderChainRef) --
      // renderState is already "rendering" from the moment of the click
      // above regardless of how long that wait turns out to be, so the
      // button's own spinner/disabled state is accurate either way.
      await runSerializedRender(() =>
        executeVideoRender(pendingSegmentationData.length > 0 ? pendingSegmentationData : null)
      );
    } catch (error) {
      setRenderError(error instanceof Error ? error.message : "تعذر إنشاء الفيديو");
      setRenderState("error");
      setSegmentationProgress(null);
    }
  };

  const handleGenerateBg = async () => {
    setIsGeneratingBg(true);
    setRenderError("");
    try {
      // Each prompt describes a unique scene, spanning several deliberately
      // DIFFERENT color families (navy-night, sunset-orange, desert-gold,
      // dusk-teal/green) instead of just one -- but every option still stays
      // dark/muted (dusk, twilight or night, never bright midday color), and
      // keeps the landscape as a silhouette confined to the bottom third
      // with a huge, mostly-empty sky above it. That darkness/emptiness is
      // load-bearing, not just stylistic: QuranVideo.tsx overlays white
      // Arabic/translation text directly on top of this image with no extra
      // dark scrim behind it (only opacity 0.8 + a text-shadow) -- a bright
      // or busy sky would make that text hard to read. Real photography
      // feel, not fantasy or over-processed.
      const sceneryOptions = [
        "dark silhouetted mountain ridge at the bottom of frame against a vast deep navy blue night sky with subtle scattered stars, minimalist landscape photography, very dark and moody",
        "dark silhouetted coastal cliffs and ocean shoreline at bottom of frame, vast deep dark blue night sky above with faint stars, misty atmosphere, real photograph, serene and minimal",
        "single dark tree silhouette in bottom corner of frame, vast completely dark night sky filling most of the image, very faint scattered stars, extremely minimal and moody, real photograph",
        "dark rolling hills silhouetted at the bottom of frame, vast deep navy night sky with a small thin crescent moon, no clouds, very dark and minimal, real night photograph",
        "dark forest treeline silhouette at the very bottom of frame, enormous deep dark indigo night sky, very few faint stars scattered, extremely dark and serene, real night photograph",
        "dark pine forest silhouette at bottom corner, vast deep navy-black night sky, one or two bright stars visible, extremely dark and peaceful, minimalist real photograph",
        "dark mountain silhouette at the bottom of frame against a vast muted burnt-orange and deep red sunset sky, sun long set, no clouds, minimalist real photograph, moody and warm",
        "single dark tree silhouette in bottom corner, enormous deep amber-orange dusk sky fading to near-black at the top of frame, extremely minimal, real photograph",
        "dark rocky coastline silhouette at bottom, vast muted coral-orange and dark maroon sunset sky reflecting faintly on calm water, real photograph, serene and warm",
        "dark sand dunes silhouetted at bottom of frame, enormous deep golden-brown desert dusk sky, warm and muted, very minimal, real desert photograph",
        "layered dark dune ridges silhouetted at bottom creating depth, vast deep amber-brown desert sky at dusk, subtle haze between layers, real photograph",
        "dark volcanic mountain silhouette at bottom, vast deep brown-orange sky fading to black at top, subtle warm glow at far horizon, real photograph",
        "dark forest treeline silhouette at bottom of frame, vast deep teal-green twilight sky with a faint aurora-like glow, very muted and dark, real photograph",
        "jagged dark mountain peaks at bottom of frame, vast deep emerald-teal dusk sky, barely visible stars, subtle horizon glow, real landscape night photograph",
        "dark cliff edge with single small tree silhouette at bottom of frame, vast deep muted purple-indigo dusk sky, thin crescent moon small in upper area, extremely minimal real photograph",
        "dark meadow with distant treeline silhouette at bottom, enormous deep indigo-black night sky, very faint milky stars, peaceful and serene, real night landscape photograph"
      ];
      const randomScenery = sceneryOptions[Math.floor(Math.random() * sceneryOptions.length)];
      const prompt = `${randomScenery}, vertical portrait 9:16 aspect ratio, ultra dark and muted tones for readable white text overlay, no text no watermark, 4K high resolution, shot on Sony A7III, long exposure photography, f/2.8, clean sharp image, variation ${Date.now()}`;
      const response = await fetch("/api/ai/generate-background", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to generate background");
      }

      // Fetch the image from the URL and create a File object so it works with the existing flow
      const imgRes = await fetch(data.imageUrl);
      const blob = await imgRes.blob();
      const file = new File([blob], `ai-bg-${Date.now()}.jpg`, { type: blob.type });

      if (bgPreview) {
        URL.revokeObjectURL(bgPreview);
      }
      if (bgVideoPreview) {
        URL.revokeObjectURL(bgVideoPreview);
      }
      setBgVideo(null);
      setBgVideoPreview(null);
      setBgImage(file);
      setBgPreview(URL.createObjectURL(file));
      setVideoUrl(null);
      setRenderState("idle");
    } catch (err) {
      setRenderError(err instanceof Error ? err.message : "تعذر توليد الخلفية");
    } finally {
      setIsGeneratingBg(false);
    }
  };

  const handleCustomAudioUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCustomAudio(file);
    setVideoUrl(null);
    setRenderState("idle");
  };

  // The video file is staged as-is -- no client-side ffmpeg round trip. The
  // backend's custom-audio extraction (extract_custom_clip) already decodes
  // straight from a video container via ffmpeg's `-vn`/faster-whisper's own
  // decoder, so pre-extracting to mp3 here would only add a redundant
  // upload+download+re-upload of the full file (painfully slow on mobile
  // uplinks) before "Prepare Audio" does the real work anyway.
  const handleVideoUploadForAudio = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCustomAudio(file);
    setVideoUrl(null);
    setRenderState("idle");
  };

  const removeCustomAudio = () => {
    setCustomAudio(null);
    setVideoUrl(null);
    setRenderState("idle");
  };



  // Only the 3 real setup steps are numbered now -- audio preparation,
  // timing/splitting, and generation all happen automatically/inline in the
  // unified video+editing section right below them (see the render below),
  // not as separate numbered wizard steps.
  const WIZARD_STEPS: WizardStepMeta[] = [
    { label: isArabic ? "اختيار السورة والآيات" : "Sure ve Ayet Seçimi" },
    { label: isArabic ? "الخلفية الاختيارية" : "İsteğe Bağlı Arka Plan", optional: true },
    { label: isArabic ? "الصوت" : "Ses" },
  ];

  const onReciterChange = (val: string) => setSelectedReciter(val);

  return (
    <>
      <div className="mx-auto max-w-5xl space-y-8" dir={isArabic ? "rtl" : "ltr"}>
        <div className="text-center space-y-3">
          <h1 className="text-3xl font-bold text-gradient-gold">
            {isArabic ? "صانع الفيديو القرآني" : "Kuran Videosu Oluşturucu"}
          </h1>
          <p className="text-muted-foreground">
            {isArabic
              ? "اختر السورة والآيات والخلفية والقارئ، ثم أنشئ فيديو جاهزًا للتحميل."
              : "Sureyi, ayetleri, arka planı ve kariyi seçip indirilebilir video oluşturun."}
          </p>

          {/* A matched pair, directly under the header -- not a lone corner
              overlay anymore (easy to miss, cramped on a phone). "فيديوهاتي"
              here is the SAME destination as Navbar's own link (just
              "?tab=gallery" on this same page, see HomeTabs) -- added
              alongside "مشروع جديد" so it's reachable without scrolling all
              the way back up to the nav bar. */}
          <div className="mx-auto flex w-full max-w-md items-stretch justify-center gap-3">
            <button
              type="button"
              onClick={() => setShowStartOverConfirm(true)}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-primary/40 px-4 py-2.5 text-sm font-medium text-primary transition-colors hover:border-primary hover:bg-primary/10"
            >
              <ArrowPathIcon className="h-4 w-4" />
              {isArabic ? "مشروع جديد" : "Yeni Proje"}
            </button>
            <Link
              href="/?tab=gallery"
              className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-primary/30 hover:bg-surface"
            >
              <FilmIcon className="h-4 w-4" />
              {isArabic ? "فيديوهاتي المحفوظة" : "Videolarım"}
            </Link>
          </div>
          {autosaveStatus === "error" && (
            <p className="animate-fade-in text-xs text-accent-red">
              {isArabic ? "تعذر الحفظ التلقائي" : "Otomatik kaydetme başarısız"}
            </p>
          )}
        </div>

        <div className="mx-auto max-w-3xl space-y-8 lg:max-w-none">
          {/* Simple single column, top to bottom, identical on every screen
              size: 3 numbered setup steps (verses, background, audio),
              followed by ONE unified, unnumbered "video + editing" section
              that appears automatically once audio preparation finishes.
              No sticky side column, no CSS order/reflow tricks -- audio
              trim, text timing and long-verse splitting all live as
              collapsible panels directly under the video there, CapCut-style. */}
          <div className="space-y-8">
            {WIZARD_STEPS.map((step, idx) => (
              <StepCard key={step.label} idx={idx} label={step.label}>
                {idx === 0 && (
                  <Step1SurahVerse
                    onSearchOpenChange={setIsVerseSearchOpen}
                    isArabic={isArabic}
                    surahs={surahs}
                    surahTurkishNames={surahTurkishNames}
                    selectedSurah={selectedSurah}
                    setSelectedSurah={setSelectedSurah}
                    setSelectedApiSurah={setSelectedApiSurah}
                    startVerse={startVerse}
                    setStartVerse={setStartVerse}
                    endVerse={endVerse}
                    setEndVerse={setEndVerse}
                    setVideoUrl={setVideoUrl}
                    setRenderError={setRenderError}
                    setRenderState={setRenderState}
                    handleAddNextVerse={handleAddNextVerse}
                    handleRemoveLastVerse={handleRemoveLastVerse}
                    versesArray={versesArray}
                    selectedVersesContent={selectedVersesContent}
                    lowConfidenceAyahs={lowConfidenceAyahs}
                    arabicFont={arabicFont}
                    onArabicFontChange={setArabicFont}
                    translationFont={translationFont}
                    onTranslationFontChange={setTranslationFont}
                    customTranslationFontName={customTranslationFontName}
                    customTranslationFontUrl={customTranslationFontUrl}
                    onCustomTranslationFontUpload={handleCustomTranslationFontUpload}
                  />
                )}

                {idx === 1 && (
                  <Step2Background
                    isArabic={isArabic}
                    bgPreview={bgPreview}
                    handleImageUpload={handleImageUpload}
                    removeImage={removeImage}
                    handleGenerateBg={handleGenerateBg}
                    isGeneratingBg={isGeneratingBg}
                    bgVideoPreview={bgVideoPreview}
                    handleVideoUpload={handleVideoUpload}
                    removeVideo={removeVideo}
                  />
                )}

                {idx === 2 && (
                  <Step3Audio
                    isArabic={isArabic}
                    audioSourceMode={audioSourceMode}
                    setAudioSourceMode={setAudioSourceMode}
                    selectedReciter={selectedReciter}
                    onReciterChange={onReciterChange}
                    customAudio={customAudio}
                    handleCustomAudioUpload={handleCustomAudioUpload}
                    handleVideoUploadForAudio={handleVideoUploadForAudio}
                    removeCustomAudio={removeCustomAudio}
                    handlePrepareAudio={handlePrepareAudio}
                    isPreparingAudio={isPreparingAudio}
                    audioProgressStage={audioProgressStage}
                    preparedAudioUrl={preparedAudioUrl}
                    selectedSurah={selectedSurah}
                    startVerse={startVerse}
                    endVerse={endVerse}
                  />
                )}
              </StepCard>
            ))}

            {/* dir fixed to ltr regardless of isArabic -- this whole card is
                "the video interface" (heading, aspect ratio picker, preview
                player, download/edit buttons all live inside Step5Generate
                below), which should stay visually put across a language
                switch rather than mirror into RTL -- see Step5Generate's own
                identical reasoning for why. translationSyncNotice below sets
                its OWN dir to counter this, since unlike everything else
                here it's real Arabic/Turkish prose someone actually reads. */}
            <div className="relative rounded-2xl p-6 md:p-8 space-y-6 shadow-lg" dir="ltr">
              <div className="absolute inset-0 bg-surface-2/80 backdrop-blur-md border border-primary/10 rounded-2xl overflow-hidden -z-10" />
              <h2 className="text-xl font-semibold flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-primary-light/30 via-primary/20 to-primary-dark/20 text-sm text-primary ring-1 ring-primary/20">
                  🎬
                </span>
                {isArabic ? "الفيديو والتعديل" : "Video ve Düzenleme"}
              </h2>

              {translationSyncNotice && (
                <div
                  className="animate-fade-in flex items-start justify-between gap-3 rounded-xl border border-accent-amber/30 bg-accent-amber-bg/20 px-3 py-2.5"
                  dir={isArabic ? "rtl" : "ltr"}
                >
                  <p className="text-xs text-accent-amber">
                    {isArabic
                      ? "تم تغيير الترجمة: تحدّث القسم الأول تلقائيًا لكل آية مقسَّمة إلى عدة أجزاء، لكن باقي الأجزاء لا تزال تحمل نص الترجمة القديم -- افتح لوحة التوقيت وأعد توزيع النص عليها يدويًا."
                      : "Çeviri değişti: birden çok bölüme ayrılmış her ayetin yalnızca ilk bölümü otomatik güncellendi, diğer bölümler hâlâ eski çeviri metnini taşıyor -- Zamanlama panelini açıp metni elle yeniden dağıtın."}
                  </p>
                  <button
                    type="button"
                    onClick={() => setTranslationSyncNotice(false)}
                    className="flex-shrink-0 text-accent-amber/70 hover:text-accent-amber transition-colors text-xs font-bold"
                  >
                    ✕
                  </button>
                </div>
              )}

              <Step5Generate
                isArabic={isArabic}
                handleGenerateVideo={handleGenerateVideo}
                canGenerate={canGenerate}
                renderState={renderState}
                preparedAudioUrl={preparedAudioUrl}
                renderError={renderError}
                videoUrl={videoUrl}
                previewProps={previewProps}
                previewVersion={previewVersion}
                isLoadingPreview={isLoadingPreview}
                previewError={previewError}
                suggestedTitle={suggestedTitle}
                backgroundSaveStatus={backgroundSaveStatus}
                isLoggedIn={isLoggedIn}
                aspectRatio={aspectRatio}
                onAspectRatioChange={setAspectRatio}
                quality={quality}
                onQualityChange={setQuality}
                showTimingEditor={showTimingEditor}
                onToggleTimingEditor={() => (showTimingEditor ? setShowTimingEditor(false) : handleOpenTimingEditor())}
                onArabicTextScaleChange={handleArabicTextScaleChange}
                onArabicWidthScaleChange={handleArabicWidthScaleChange}
                onTranslationTextScaleChange={handleTranslationTextScaleChange}
                onTranslationWidthScaleChange={handleTranslationWidthScaleChange}
              />

              {/* Inline unified audio-trim/timing panel -- CapCut-style:
                  lives directly below the video instead of a full-screen
                  modal, so the user can fix an audio/timing mismatch while
                  still seeing (and hearing) the preview. Its own first/last
                  segment boundaries double as the audio trim handles (see
                  SegmentTimingEditor.tsx's buildRegions); its toggle button
                  now lives right next to the download button in
                  Step5Generate above. */}
              {showTimingEditor && preparedAudioUrl && (() => {
                const segments = buildTimingEditorSegments();
                if (!segments || segments.length === 0) return null;
                // "Segmented" means at least one ayah has REALLY been split
                // into 2+ timed parts -- NOT merely "pendingSegmentationData
                // has an entry", which is also now true for any ayah that's
                // simply had its text/translation box resized (see
                // applySegmentScaleChange's own single-mapping fallback
                // above). Without this distinction, resizing one never-split
                // ayah's box would flip this toggle to "Bölümlemeyi kaldır"
                // even though the user never asked to split anything's
                // timing -- and clicking it would wipe every ayah's
                // segmentation, not just undo the resize.
                const isSegmented = pendingSegmentationData.some(
                  (entry) => Array.isArray(entry.mappings) && entry.mappings.length > 1
                );
                return (
                  // Cancels this card's own p-6/md:p-8 padding on phone
                  // screens only (sm: and up reverts to the normal inset) --
                  // SegmentTimingEditor already carries its own border/
                  // padding/rounded corners, so left as a normal child it was
                  // effectively double-inset (this card's padding PLUS its
                  // own), visibly narrower than the video preview right above
                  // it which sits directly in this card with only one layer
                  // of inset. On a phone that lost ~48px of usable width to
                  // padding no other sibling here pays twice.
                  <div ref={timingPanelRef} className="scroll-mt-24 -mx-6 sm:mx-0">
                    <SegmentTimingEditor
                      audioUrl={getTimingEditorAudioUrl()!}
                      ayahLabel={isArabic ? `جميع الآيات` : `Tüm Ayetler`}
                      segments={segments}
                      isArabic={isArabic}
                      onCancel={() => setShowTimingEditor(false)}
                      onConfirm={handleSaveTimingEditor}
                      isSegmented={isSegmented}
                      isSegmenting={segmentationProgress !== null}
                      onToggleSegmentation={isSegmented ? handleClearSegmentation : handleSegmentLongVerses}
                      onTrimOnly={handleTrimOnly}
                      onPersistTrimmedAudio={handlePersistTrimmedAudio}
                      onLiveTranslationEdit={handleLiveTranslationEdit}
                      arabicFont={arabicFont}
                      translationFontFamily={timingEditorTranslationFontFamily}
                    />
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      </div>

      {showStartOverConfirm && (
        <div className="animate-fadeIn fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-md p-4 sm:p-6" dir={isArabic ? "rtl" : "ltr"}>
          <div className="animate-slide-up bg-surface w-full max-w-md border border-border rounded-2xl shadow-2xl overflow-hidden flex flex-col p-6 sm:p-8 text-center">
            <h2 className="text-xl sm:text-2xl font-bold text-foreground mb-3">
              {isArabic ? "تأكيد مسح البيانات" : "Emin misiniz?"}
            </h2>
            <p className="text-sm sm:text-base text-muted-foreground mb-8">
              {isArabic
                ? "هل أنت متأكد أنك تريد بدء إنشاء فيديو جديد من الصفر؟ سيتم مسح كافة البيانات الحالية ولن تتمكن من استعادتها."
                : "Sıfırdan yeni bir video oluşturmak istiyor musunuz? Mevcut tüm veriler silinecek ve geri alınamayacak."}
            </p>
            <div className="flex gap-3 justify-center w-full">
              <button
                onClick={() => setShowStartOverConfirm(false)}
                className="flex-1 rounded-xl bg-background border border-border px-4 py-2.5 text-sm sm:text-base font-medium text-foreground hover:bg-surface transition-colors"
              >
                {isArabic ? "إلغاء" : "İptal"}
              </button>
              <button
                onClick={handleStartOver}
                className="flex-1 rounded-xl bg-accent-red border border-accent-red px-4 py-2.5 text-sm sm:text-base font-medium text-white hover:opacity-90 transition-opacity shadow-[0_0_15px_rgba(239,68,68,0.2)]"
              >
                {isArabic ? "مسح" : "Yeniden Başla"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
