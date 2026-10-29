"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowPathIcon, FilmIcon } from "@heroicons/react/24/outline";
import { useLanguage, useT } from "@/lib/LanguageContext";
import { fixMojibake } from "@/lib/textEncoding";
import { RECITER_DISPLAY_NAMES, RECITER_ARABIC_NAMES } from "@/lib/reciterNames";
import quranData from "@/data/quran.json";
import quranQcfV1Data from "@/data/quran-qcf-v1.json";
import Spinner from "@/components/ui/Spinner";

import { useTranslationContext } from "@/lib/TranslationContext";
import { surahEnglishName } from "@/lib/surahEnglishNames";
import SegmentTimingEditor, { type AyahWordTiming, type SegmentTimingInput, type SegmentTimingResult } from "./SegmentTimingEditor";
import {
  DEFAULT_BACKGROUND_DIM,
  DEFAULT_TRANSLATION_FONT,
  DEFAULT_WORD_HIGHLIGHT_COLOR,
  resolveTranslationFont,
  translationFontStack,
  translationFontSupports,
  type ArabicFontKey,
  type AspectRatio,
  type QualityTier,
  type QuranVideoProps,
  type TranslationFontKey,
} from "@/remotion/types";
import { buildVerseTimeline, fitWordCounts, holdWordsThroughRepeats, moveBoundariesOffMarks, repeatWordWindows, shiftWordsToTrim, voicedSpan } from "@/remotion/timing";
import { applyReadings } from "@/lib/readingPath";
import { type WizardStepMeta } from "./wizard/WizardShell";
import Step1SurahVerse from "./wizard/Step1SurahVerse";
import BackgroundPicker from "./BackgroundPicker";
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

// Default audio trim window (seconds, relative to the prepared clip) for
// freshly prepared audio. The backend's CTC engine reports the exact ayah
// boundaries itself (ayahStartMs/ayahEndMs: snapped to where the reciter's
// voice actually starts/stops); prepared data from before it (e.g. an older
// draft) falls back to padding the first/last word timing, with a wider end
// margin because Whisper used to under-shoot elongated (madd) endings.
function defaultTrimFromTimings(json: any): { start: number; end: number } | null {
  if (!json?.verses) return null;
  if (typeof json.ayahStartMs === "number" && typeof json.ayahEndMs === "number" && json.ayahEndMs > json.ayahStartMs) {
    return { start: json.ayahStartMs / 1000, end: json.ayahEndMs / 1000 };
  }
  const PAD_SECONDS = 10.0; // matches padSeconds sent when preparing audio
  let minStart = Infinity;
  let maxEnd = 0;
  Object.values(json.verses).forEach((v: any) => {
    v.words?.forEach((w: any) => {
      if (w.start < minStart) minStart = w.start;
      if (w.end > maxEnd) maxEnd = w.end;
    });
  });
  if (minStart === Infinity) return null;
  return {
    start: Math.max(0, minStart / 1000 - 0.35),
    end: maxEnd / 1000 + (json.lowConfidenceEnd ? PAD_SECONDS - 2.0 : 1.5),
  };
}



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

// Polled from GET /api/video/render while the download button waits.
export type RenderProgress = { stage: "preparing" | "rendering" | "saving"; progress: number; etaMs: number | null };

type RealRenderRecord = {
  signature: string;
  renderId: string;
  background: boolean;
  inFlight: boolean;
  videoUrl: string | null;
};

class RenderCancelledError extends Error {}

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
// Rebuilds the segmentation of every ayah the timing editor returned from its
// full segment set (`results`, in on-timeline order): the editor can split,
// merge and retitle segments, so its parts may no longer line up one-to-one
// with the old mappings. Used both for "حفظ التوقيت" and, unsaved, for the
// live preview while the editor is open -- the two can't differ.
// `offsetSec` shifts the editor's times back onto the untrimmed prepared
// clip (see trimmedPreviewOffset).
function applyTimingResults(prev: any[], results: SegmentTimingResult[], surahId: number, offsetSec: number): any[] {
  // Group results by ayah, preserving their on-timeline order within each
  // group (results already arrive in that order from SegmentTimingEditor).
  const resultsByAyah: Record<number, SegmentTimingResult[]> = {};
  for (const res of results) {
    if (!resultsByAyah[res.ayah]) resultsByAyah[res.ayah] = [];
    resultsByAyah[res.ayah].push(res);
  }

  // Part numbers are reassigned sequentially (1..N in timeline order), which
  // also fixes the "gap" bug class from the old part-preserving merge logic
  // (a merged-away part leaving e.g. parts 1 and 3 with no 2).
  const next = prev.filter((s) => !(s.surah === surahId && s.ayah in resultsByAyah));
  for (const [ayahIdStr, ayahResults] of Object.entries(resultsByAyah)) {
    const ayahId = Number(ayahIdStr);
    // Session-local SegmentTimingResult.id -> its new (1-based) part
    // number, so a "repeat" segment's repeatOfId (also a session-local
    // id) can be translated into a `repeat_of_part` reference that's
    // still valid once ids are regenerated fresh on the next reopen --
    // see buildTimingEditorSegments, which resolves it back into a fresh
    // id of that same shape (`${ayahId}-${part}`).
    const idToPart = new Map(ayahResults.map((r, idx) => [r.id, idx + 1]));
    // Per-segment size/width overrides (see VerseMapping's own scale
    // fields in types.ts, set via VideoPreviewPlayer's resize boxes) live
    // on the OLD mapping objects this rebuild is about to replace
    // wholesale -- carried over here position-for-position, or they'd
    // silently reset to default on every single save, even when nothing
    // about that ayah's actual split/timing changed. Only safe when the
    // segment COUNT hasn't changed: a split/merge/reorder means part N no
    // longer means the same thing it did before, so there's no reliable
    // old segment to carry a resize over from -- those simply reset, same
    // as a segment resized for the very first time always has.
    const oldMappings = prev.find((s) => s.surah === surahId && s.ayah === ayahId)?.mappings;
    const canPreserveScale = oldMappings && oldMappings.length === ayahResults.length;
    next.push({
      surah: surahId,
      ayah: ayahId,
      mappings: ayahResults.map((result, idx) => {
        const oldMapping = canPreserveScale ? oldMappings![idx] : undefined;
        return {
          part: idx + 1,
          // Real word count carried through as its own field (see
          // SegmentTimingInput.wordCount) rather than re-derived from
          // arabicText -- the raw QCF text's whitespace-token count can run
          // one higher than the real word count for whichever segment ends
          // an ayah, since the ayah-number marker glyph is its own trailing
          // token there.
          word_count: Math.max(1, result.wordCount),
          translation_text: result.translation_text,
          // Every boundary as the editor shows it, on the untrimmed
          // prepared clip -- the space render/route.ts expects. The ones
          // that only restate the word timing are told apart when the
          // video is timed (see remotion/timing.ts), so an untouched
          // boundary keeps following the words.
          start_ms: Math.round((result.startSec + offsetSec) * 1000),
          end_ms: Math.round((result.endSec + offsetSec) * 1000),
          // The editor already resolved the exact Arabic text for this
          // segment (including "repeat" segments, whose real-word range
          // isn't the next sequential one -- see SegmentTimingEditor's
          // resolveContent); kept for reference, see VerseMapping.
          ...(result.arabicText ? { arabic_text: result.arabicText } : {}),
          isFirstOfAyah: result.isFirstOfAyah,
          ...(result.repeatOfId && idToPart.has(result.repeatOfId) ? { repeat_of_part: idToPart.get(result.repeatOfId) } : {}),
          ...(oldMapping?.arabicTextScale !== undefined ? { arabicTextScale: oldMapping.arabicTextScale } : {}),
          ...(oldMapping?.arabicWidthScale !== undefined ? { arabicWidthScale: oldMapping.arabicWidthScale } : {}),
          ...(oldMapping?.translationTextScale !== undefined ? { translationTextScale: oldMapping.translationTextScale } : {}),
          ...(oldMapping?.translationWidthScale !== undefined ? { translationWidthScale: oldMapping.translationWidthScale } : {}),
        };
      }),
    });
  }
  return next;
}

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
  const tx = useT();
  const { language } = useLanguage();
  const isArabic = language === "ar";
  const surahs = quranData as Surah[];
  const { selectedTranslation, setSelectedTranslationId, translationLanguage, getTranslation, fetchSurahTranslations } = useTranslationContext();

  const [selectedSurah, setSelectedSurah] = useState<Surah | null>(null);
  const [selectedApiSurah, setSelectedApiSurah] = useState<ApiSurah | null>(null);
  // "" until the user picks one -- choosing the reciter is what starts the
  // automatic audio preparation (see the auto-prepare effect), so a
  // preselected default would start preparing the wrong voice.
  const [selectedReciter, setSelectedReciter] = useState<string>("");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("portrait");
  // Export resolution tier only -- never affects the live preview, which
  // always renders at the composition's own fixed canvas size (see
  // render/route.ts's `scale` option and qualityScale in remotion/types.ts).
  const [quality, setQuality] = useState<QualityTier>("720p");
  const [translationFont, setTranslationFont] = useState<TranslationFontKey | "custom">("aileron");
  // A translation language whose letters the current font can't render (a
  // Latin font for an Arabic tafsir, or vice versa) switches the font to
  // that language's default -- the picker only lists fonts that cover the
  // selected language. A custom upload is left alone: the user chose it.
  useEffect(() => {
    if (translationFont === "custom" || translationFontSupports(translationFont, translationLanguage)) return;
    setTranslationFont(DEFAULT_TRANSLATION_FONT[translationLanguage]);
  }, [translationFont, translationLanguage]);
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
  // How the background is shown (darken/blur/slow zoom) -- see
  // QuranVideoProps.backgroundDim. Pure client-side rendering parameters,
  // patched straight into previewProps like the text scales below.
  const [backgroundDim, setBackgroundDim] = useState(DEFAULT_BACKGROUND_DIM);
  const [backgroundBlur, setBackgroundBlur] = useState(0);
  const [backgroundZoom, setBackgroundZoom] = useState(false);
  // Colors the Arabic word being recited -- see QuranVideoProps.wordHighlight.
  const [wordHighlight, setWordHighlight] = useState(false);
  const [wordHighlightColor, setWordHighlightColor] = useState<string>(DEFAULT_WORD_HIGHLIGHT_COLOR);
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
  // Set when the server timed previewProps from our own preparedJsonData
  // (`json`, the object sent) cut at trimStartMs -- then
  // displayedPreviewProps re-times the preview client-side, with the same
  // rule (remotion/timing.ts), the instant the segmentation changes. null:
  // segmentation changes need a server reload to show.
  const [previewTimingBasis, setPreviewTimingBasis] = useState<{ trimStartMs: number; json: any } | null>(null);
  const previewReloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const [customAudio, setCustomAudio] = useState<File | null>(null);
  const [audioSourceMode, setAudioSourceMode] = useState<"reciter" | "custom">("reciter");
  // An Arabic video shows the reciter's name under the surah name (see
  // QuranVideoProps.reciterName) -- on by default, and editable: null
  // follows the picked reciter's Arabic name (nothing for an uploaded
  // file), a string is the user's own text. Picking another reciter or
  // switching the audio source drops the user's text (see
  // onReciterChange/onAudioSourceModeChange).
  const [showReciterName, setShowReciterName] = useState(true);
  const [reciterNameEdit, setReciterNameEdit] = useState<string | null>(null);
  const reciterNameText =
    reciterNameEdit ?? (audioSourceMode === "reciter" ? RECITER_ARABIC_NAMES[selectedReciter] ?? "" : "");
  const isArabicVideo = (selectedTranslation.language ?? translationLanguage) === "ar";
  // What the video's second header line shows ("" = nothing).
  const reciterLabel = isArabicVideo && showReciterName ? reciterNameText.trim() : "";

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
  // Set once the user has dealt with (or dismissed) a prepared clip's
  // needsReview warning -- see the banner above Step5Generate.
  const [reviewNoticeDismissed, setReviewNoticeDismissed] = useState(false);
  const openTimingEditorAfterPrepareRef = useRef(false);
  // Whether the unified audio-trim/timing panel is currently open.
  const [showTimingEditor, setShowTimingEditor] = useState<boolean>(false);
  // The open timing editor's current, unsaved state (its onLiveChange) --
  // shown in the preview right away; "حفظ التوقيت" commits it into
  // pendingSegmentationData, closing the panel any other way drops it.
  const [liveTimingResults, setLiveTimingResults] = useState<SegmentTimingResult[] | null>(null);

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
  // The latest real render, manual or background -- see runRealRender.
  const lastRealRenderRef = useRef<RealRenderRecord | null>(null);
  // Uploaded Files by identity, for renderSignature.
  const renderFileIdsRef = useRef({ ids: new WeakMap<File, number>(), next: 1 });
  const [renderProgress, setRenderProgress] = useState<RenderProgress | null>(null);
  // Set for the whole duration of resuming a draft so the prepared-audio/
  // segmentation invalidation effect below (which reacts to surah/verse/
  // reciter/custom-audio changes) doesn't immediately wipe the very state
  // hydration just restored.
  const isHydratingRef = useRef(false);
  // Bumped once a draft restore finishes, so effects that skip while
  // isHydratingRef is set (a ref, so it can't re-trigger them itself) get
  // one more look at the restored state -- see the auto-prepare effect.
  const [hydrationVersion, setHydrationVersion] = useState(0);
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

  // The audio preparation currently in flight. A selection change cancels
  // it outright -- the browser request AND the backend job behind it (see
  // backend/scripts/job_control.py) -- instead of the new selection waiting
  // for it to finish: an abandoned pick (say a whole Al-Baqarah from a slow
  // mirror) used to hold up the next one for many minutes.
  const audioPrepRef = useRef<{ epoch: number; jobId: string; controller: AbortController } | null>(null);
  const cancelAudioPrep = useCallback(() => {
    const prep = audioPrepRef.current;
    if (!prep || prep.controller.signal.aborted) return;
    prep.controller.abort();
    // keepalive: also sent when this runs on pagehide (see below).
    fetch(`/api/video/prepare-audio/job?jobId=${prep.jobId}`, { method: "DELETE", keepalive: true }).catch(() => {});
  }, []);
  // Leaving or reloading the page abandons its request too -- otherwise the
  // reloaded page's request for the same surah queued behind it.
  useEffect(() => {
    window.addEventListener("pagehide", cancelAudioPrep);
    return () => {
      window.removeEventListener("pagehide", cancelAudioPrep);
      cancelAudioPrep();
    };
  }, [cancelAudioPrep]);

  // The backend's real stage for the request in flight (job_control.report).
  const audioStageLabel = (job: { stage?: string | null; percent?: number | null; source?: string | null }) => {
    const pct = typeof job.percent === "number" ? ` ${job.percent}%` : "";
    switch (job.stage) {
      case "queued":
        return tx("⏳ جاري التحضير...", "⏳ Hazırlanıyor...", "⏳ Getting ready...");
      case "waiting":
        return tx("⏳ بانتظار انتهاء تنزيل نفس السورة...", "⏳ Aynı surenin indirilmesi bekleniyor...", "⏳ Waiting for the same surah's download to finish...");
      case "download":
        return job.source === "backup"
          ? tx(`⬇️ تنزيل السورة من المصدر الاحتياطي...${pct}`, `⬇️ Sure yedek kaynaktan indiriliyor...${pct}`, `⬇️ Downloading the surah from the backup source...${pct}`)
          : tx(`⬇️ تنزيل السورة...${pct}`, `⬇️ Sure indiriliyor...${pct}`, `⬇️ Downloading the surah...${pct}`);
      case "locate":
        return tx(`🔍 تحديد موضع الآيات في التسجيل...${pct}`, `🔍 Ayetlerin kayıttaki yeri bulunuyor...${pct}`, `🔍 Finding the ayahs in the recording...${pct}`);
      case "align":
        return tx("🎯 مطابقة الآيات مع الصوت...", "🎯 Ayetler sesle eşleştiriliyor...", "🎯 Aligning the ayahs with the audio...");
      case "verify":
        return tx("✅ التحقق من القص...", "✅ Kesim doğrulanıyor...", "✅ Verifying the cut...");
      default:
        return null;
    }
  };

  // The selected ayahs as applyReadings needs them: translation, and the
  // prepared clip's tokens.
  const readingAyahs = (json: any) =>
    selectedVersesContent.map((verse) => ({
      id: verse.id,
      translation: verse.translation || "",
      tokens: ((json?.verses?.[String(verse.id)]?.words ?? []) as { w?: string }[]).map((w) => w.w ?? ""),
    }));

  const handlePrepareAudio = async () => {
    if (!selectedSurah || startVerse === null || endVerse === null) return;

    // If we already have prepared audio (meaning parameters haven't changed),
    // just expand the inline timing/trim panel (below the video preview)
    // and scroll it into view instead of re-running extraction.
    if (preparedAudioUrl) {
      handleOpenTimingEditor();
      return;
    }

    // A request for this exact selection is already in flight -- the
    // debounced auto-prepare effect below and a manual button click can
    // both land here before either resolves (preparedAudioUrl is still
    // null either way) -- so don't start a second, identical one. One for
    // an older selection is cancelled instead (normally the invalidation
    // effect already did that).
    const inFlight = audioPrepRef.current;
    if (inFlight && inFlight.epoch === audioParamsEpochRef.current && !inFlight.controller.signal.aborted) return;
    cancelAudioPrep();

    // Snapshotted now, re-checked once the request resolves below -- if the
    // user changes surah/verse/reciter/custom-audio while this fetch is
    // still in flight, the invalidation effect bumps this epoch, and the
    // (now stale) response must be discarded instead of overwriting the
    // newer selection's state.
    const requestEpoch = audioParamsEpochRef.current;
    const isStale = () => audioParamsEpochRef.current !== requestEpoch;
    const prep = {
      epoch: requestEpoch,
      // randomUUID only exists in secure contexts (not plain http on a LAN IP).
      jobId:
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`,
      controller: new AbortController(),
    };
    audioPrepRef.current = prep;

    setIsPreparingAudio(true);
    setAudioProgressStage(tx("⏳ جاري تجهيز الصوت...", "⏳ Ses hazırlanıyor...", "⏳ Preparing the audio..."));
    // Shows what the backend is really doing until this request settles.
    const pollTimer = setInterval(async () => {
      try {
        const job = await (await fetch(`/api/video/prepare-audio/job?jobId=${prep.jobId}`)).json();
        const label = audioStageLabel(job);
        if (label && audioPrepRef.current === prep) setAudioProgressStage(label);
      } catch {
        // A missed poll just keeps the previous stage on screen.
      }
    }, 1500);
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
      formData.append("jobId", prep.jobId);

      const res = await fetch("/api/video/prepare-audio", {
        method: "POST",
        body: formData,
        signal: prep.controller.signal,
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
          setAudioProgressStage(tx("✂️ جاري تجهيز النتيجة...", "✂️ Sonuç hazırlanıyor...", "✂️ Preparing the result..."));

          // Default trim bounds so the preview already looks right even
          // before the user ever opens the timing panel (the same helper
          // seeds the panel's first/last segment boundary in
          // buildTimingEditorSegments, so the two can't disagree).
          const defaultTrim = defaultTrimFromTimings(data.wordTimingsData);
          setAudioTrimStart(defaultTrim?.start ?? 0);
          setAudioTrimEnd(defaultTrim?.end ?? 0);

          setPreparedAudioUrl(data.audioUrl);
          setPreparedAudioLocalPath(data.localAudioPath);
          setPreparedJsonData(data.wordTimingsData);
          // Where the reciter went back and read part of it again, those
          // repeats show too, timed to the audio (see lib/readingPath.ts).
          if (data.wordTimingsData?.readings) {
            setPendingSegmentationData((prev) =>
              applyReadings(prev, data.wordTimingsData.readings, readingAyahs(data.wordTimingsData), selectedSurah.id)
            );
          }
          // The backend couldn't fully verify this cut (e.g. the recording
          // seems to start after the ayah, or the independent check heard a
          // different first word): open the timing panel right away and
          // show why, instead of letting a possibly wrong cut go unnoticed.
          setReviewNoticeDismissed(false);
          if (data.wordTimingsData?.needsReview) {
            openTimingEditorAfterPrepareRef.current = true;
          }
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
        // 409: this job was cancelled (a newer selection replaced it).
        if (isStale() || res.status === 409) return;
        const errData = await res.json().catch(() => null);
        if (errData && errData.error) {
          alert(errData.error);
        } else {
          alert(tx("فشل تجهيز الصوت. حدث خطأ في الخادم.", "Ses hazırlanamadı. Sunucu hatası.", "Couldn't prepare the audio. Server error."));
        }
      }
    } catch (e) {
      if (isStale() || prep.controller.signal.aborted) return;
      console.error(e);
      alert(tx("حدث خطأ أثناء الاتصال بالخادم", "Sunucuya bağlanırken hata oluştu", "Error connecting to the server"));
    } finally {
      clearInterval(pollTimer);
      // Only the request that's still current owns the spinner: one
      // replaced by a newer request settling late must not clear the newer
      // one's progress.
      if (audioPrepRef.current === prep) {
        audioPrepRef.current = null;
        setIsPreparingAudio(false);
        setAudioProgressStage(null);
      }
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
      tx("جاري تطبيق التقسيم...", "Bölümleme uygulanıyor...", "Applying segmentation...")
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
      // "No translation" has no language of its own, so the picker's
      // language list decides it (Arabic there = Arabic-only surah title).
      formData.append("videoLanguage", selectedTranslation.language ?? translationLanguage);
    }
    formData.append("reciterName", reciterLabel);

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
    formData.append("backgroundDim", String(backgroundDim));
    formData.append("backgroundBlur", String(backgroundBlur));
    formData.append("backgroundZoom", String(backgroundZoom));
    formData.append("wordHighlight", String(wordHighlight));
    formData.append("wordHighlightColor", wordHighlightColor);
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
    // The object buildRenderFormData sends -- what the server times from.
    const jsonSent = preparedAudioUrl ? preparedJsonData : null;
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
      setPreviewTimingBasis(
        data.timing && jsonSent && typeof data.timing.trimStartMs === "number"
          ? { trimStartMs: data.timing.trimStartMs, json: jsonSent }
          : null
      );
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
  //
  // pendingSegmentationData isn't in this list either: a split/word
  // move/boundary change only re-times text over the SAME audio, which
  // displayedPreviewProps does client-side instantly (see
  // previewTimingBasis); only a preview the server had to time on its own
  // reloads for it (the effect after this one).
  const schedulePreviewReload = () => {
    if (previewReloadTimerRef.current) clearTimeout(previewReloadTimerRef.current);
    previewReloadTimerRef.current = setTimeout(() => {
      previewReloadTimerRef.current = null;
      handleLoadPreview();
    }, 400);
  };
  useEffect(() => {
    if (!preparedAudioUrl) {
      if (previewReloadTimerRef.current) clearTimeout(previewReloadTimerRef.current);
      setPreviewProps(null);
      setPreviewTimingBasis(null);
      return;
    }
    schedulePreviewReload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    preparedAudioUrl,
    audioTrimStart,
    audioTrimEnd,
    bgImage,
    bgVideo,
    selectedTranslation,
    // Picks the surah title's language when no translation is selected
    // (see buildRenderFormData's videoLanguage).
    translationLanguage,
    aspectRatio,
    // Turning it on fetches every verse's word-to-glyph map (see
    // QuranVerse.highlightGlyphCounts); the color itself is client-side.
    wordHighlight,
  ]);
  useEffect(() => {
    if (!preparedAudioUrl || previewTimingBasis) return;
    schedulePreviewReload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSegmentationData, previewTimingBasis]);
  useEffect(() => () => {
    if (previewReloadTimerRef.current) clearTimeout(previewReloadTimerRef.current);
  }, []);

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

  // Sets ONE text size for every segment in the whole video at once (the
  // "حجم نص الآية/الترجمة" sliders below the suggested-title box) -- unlike
  // applySegmentScaleChange above, which only ever touches one segmentKey.
  // Setting the shared fallback value alone (fallbackSetter) wouldn't be
  // enough: any segment that already has its OWN per-segment override (set
  // via a corner-drag in VideoPreviewPlayer) would keep ignoring it, since
  // `mapping.arabicTextScale ?? arabicTextScale` always prefers the
  // per-segment value when present (QuranVideo.tsx). Clearing the field on
  // every mapping first (key OMITTED, not set to undefined -- matches this
  // codebase's established convention, see e.g. the spread pattern around
  // handleSaveTimingEditor) makes every segment fall through to the new
  // shared value uniformly, which is the whole point of this control.
  const applyBulkTextScale = (block: "arabic" | "translation", scale: number) => {
    const field = block === "arabic" ? "arabicTextScale" : "translationTextScale";
    (block === "arabic" ? setArabicTextScale : setTranslationTextScale)(scale);

    setPreviewProps((prev) =>
      prev
        ? {
            ...prev,
            verses: prev.verses.map((v) =>
              v.mappings
                ? {
                    ...v,
                    mappings: v.mappings.map((m) => {
                      const { [field]: _drop, ...rest } = m;
                      return rest;
                    }),
                  }
                : v
            ),
          }
        : prev
    );

    setPendingSegmentationData((prev) =>
      prev.map((entry) => ({
        ...entry,
        mappings: entry.mappings.map((m: any) => {
          const { [field]: _drop, ...rest } = m;
          return rest;
        }),
      }))
    );
  };

  const handleBulkArabicTextScaleChange = (scale: number) => applyBulkTextScale("arabic", scale);
  const handleBulkTranslationTextScaleChange = (scale: number) => applyBulkTextScale("translation", scale);

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

  // What a real render's video depends on: every form field (an uploaded
  // File by identity -- the same File object is the same upload) plus the
  // segmentation it applies. draftId/renderId don't change the video.
  const renderSignature = (formData: FormData, segmentationData: any[] | null) => {
    const parts: string[] = [];
    formData.forEach((value, key) => {
      if (key === "draftId" || key === "renderId") return;
      if (typeof value === "string") {
        parts.push(`${key}=${value}`);
        return;
      }
      const fileIds = renderFileIdsRef.current;
      let id = fileIds.ids.get(value);
      if (id === undefined) {
        id = fileIds.next++;
        fileIds.ids.set(value, id);
      }
      parts.push(`${key}=file#${id}`);
    });
    parts.push(`segmentation=${JSON.stringify(segmentationData ?? [])}`);
    return parts.join("\n");
  };

  const lastRenderMatches = (signature: string) => {
    const last = lastRealRenderRef.current;
    return Boolean(last && !last.inFlight && last.videoUrl && last.signature === signature);
  };

  // The finished video of the last real render, when it was rendered from
  // exactly these settings and its file is still there (render/route.ts
  // prunes old ones) -- so a download right after the background auto-save
  // rendered the same thing reuses it instead of rendering it all again.
  const reusableRenderUrl = async (signature: string): Promise<string | null> => {
    const videoUrl = lastRealRenderRef.current?.videoUrl;
    if (!videoUrl || !lastRenderMatches(signature)) return null;
    const res = await fetch(videoUrl, { headers: { Range: "bytes=0-0" } }).catch(() => null);
    await res?.body?.cancel().catch(() => undefined);
    return res?.ok ? videoUrl : null;
  };

  // POSTs one real render, tracked in lastRealRenderRef while it runs (the
  // download button polls its progress; a newer download cancels it if it's
  // a background one of older settings). Resolves to its video URL.
  const runRealRender = async (formData: FormData, signature: string, background: boolean): Promise<string> => {
    // crypto.randomUUID only exists in secure contexts, and the app is also
    // opened over plain-http LAN addresses.
    const renderId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    formData.append("renderId", renderId);
    const record: RealRenderRecord = { signature, renderId, background, inFlight: true, videoUrl: null };
    lastRealRenderRef.current = record;
    try {
      const response = await fetch("/api/video/render", { method: "POST", body: formData });
      const data = await response.json();
      if (data.cancelled) throw new RenderCancelledError();
      if (!response.ok || !data.videoUrl) {
        throw new Error(data.error || "Video render failed");
      }
      record.videoUrl = data.videoUrl;
      return data.videoUrl;
    } catch (err) {
      if (lastRealRenderRef.current === record) lastRealRenderRef.current = null;
      throw err;
    } finally {
      record.inFlight = false;
    }
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
      const signature = renderSignature(formData, segmentationData);
      const renderedUrl = (await reusableRenderUrl(signature)) ?? (await runRealRender(formData, signature, false));

      const finalVideoUrl = `${renderedUrl}?t=${Date.now()}`;
      setVideoUrl(finalVideoUrl);
      setRenderState("done");

      // The "Videoyu İndir" button both renders AND downloads in one click --
      // trigger the actual browser download automatically the instant the
      // video is ready, instead of making the user click a second separate
      // download link/button after generation finishes.
      // Saved under the suggested title (minus characters filenames can't
      // hold -- its " | " reciter separator becomes " - ") instead of the
      // server's internal render filename.
      const link = document.createElement("a");
      link.href = finalVideoUrl;
      link.download = suggestedTitle
        ? `${suggestedTitle.replace(/\s*\|\s*/g, " - ").replace(/[\\/:*?"<>|]/g, "").trim()}.mp4`
        : "";
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
          // render/route.ts reads the segmentation from the server-side
          // file; preview reloads no longer refresh it on every timing edit
          // (they re-time client-side), so this render brings it up to date
          // itself, like executeVideoRender does.
          const segmentationData = pendingSegmentationData.length > 0 ? pendingSegmentationData : null;
          if (segmentationData) {
            await fetch("/api/segmentation/apply", {
              method: "POST",
              body: JSON.stringify(segmentationData),
              headers: { "Content-Type": "application/json" },
            });
          }
          const formData = buildRenderFormData(undefined, currentDraftId);
          const signature = renderSignature(formData, segmentationData);
          // A download of exactly these settings already rendered -- and
          // saved to the gallery -- this video.
          if (lastRenderMatches(signature)) return;
          await runRealRender(formData, signature, true);
        });
      } while (backgroundRenderStaleRef.current);

      setBackgroundSaveStatus("saved");
    } catch (error) {
      if (error instanceof RenderCancelledError) {
        // Cancelled by a download of newer settings, which saves to the
        // gallery itself.
        setBackgroundSaveStatus("idle");
      } else {
        console.error("[Auto-save] Background gallery render failed:", error);
        setBackgroundSaveStatus("error");
      }
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
  // Same font resolution as the video itself (see resolveTranslationFont):
  // the chosen font if it covers the translation's script, else the
  // script's default. Every @font-face is declared by Step1SurahVerse.
  const timingEditorTranslationScript = selectedTranslation.language === "ar" ? "ar" : "tr";
  const timingEditorTranslationFontFamily = translationFontStack(
    resolveTranslationFont(translationFont, timingEditorTranslationScript, Boolean(customTranslationFontUrl)),
    timingEditorTranslationScript,
    "CustomTranslationFont"
  );

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
        audioSourceMode === "reciter" && selectedReciter ? ` | القارئ: ${RECITER_ARABIC_NAMES[selectedReciter] ?? selectedReciter}` : "";
      return `سورة ${surahName}${verseRange}${reciterPart}`;
    }

    if (language === "en") {
      const surahName = surahEnglishName(selectedSurah.id) ?? fixMojibake(selectedSurah.transliteration);
      const verseRange = isWholeSurah
        ? ""
        : startVerse === endVerse
          ? ` - Ayah ${startVerse}`
          : ` - Ayahs ${startVerse}-${endVerse}`;
      const reciterPart =
        audioSourceMode === "reciter" && selectedReciter ? ` | Reciter: ${RECITER_DISPLAY_NAMES[selectedReciter] ?? selectedReciter}` : "";
      return `Surah ${surahName}${verseRange}${reciterPart}`;
    }

    const turkishName = surahTurkishNames.get(selectedSurah.id);
    const surahName = turkishName ? fixMojibake(turkishName) : fixMojibake(selectedSurah.transliteration);
    const verseRange = isWholeSurah
      ? ""
      : startVerse === endVerse
        ? ` ${startVerse}. Ayet`
        : ` ${startVerse}-${endVerse}`;
    const reciterPart =
      audioSourceMode === "reciter" && selectedReciter ? ` | Okuyan: ${RECITER_DISPLAY_NAMES[selectedReciter] ?? selectedReciter}` : "";
    return `${surahName} Suresi${verseRange}${reciterPart}`;
  })();

  // What the preview shows: the saved segmentation, with the open timing
  // editor's unsaved state on top (built exactly as saving it would).
  const effectiveSegmentation = useMemo(
    () =>
      liveTimingResults && selectedSurah
        ? applyTimingResults(pendingSegmentationData, liveTimingResults, selectedSurah.id, trimmedPreviewAudioUrl ? trimmedPreviewOffset : 0)
        : pendingSegmentationData,
    [liveTimingResults, pendingSegmentationData, selectedSurah, trimmedPreviewAudioUrl, trimmedPreviewOffset]
  );

  useEffect(() => {
    if (!showTimingEditor) setLiveTimingResults(null);
  }, [showTimingEditor]);

  // previewProps re-timed client-side for effectiveSegmentation, with the
  // same function render/route.ts timed them with (remotion/timing.ts) and
  // on the same audio (previewTimingBasis) -- so a split, word move,
  // boundary drag or AI split shows in the preview the instant it happens,
  // with no server round trip, and exactly as the export will show it.
  // Word counts get the same correction segmentation/apply/route.ts makes
  // for the export (fitWordCounts). Falls back to the server's own timing
  // whenever that can't be reproduced here.
  const retimedPreviewProps = useMemo((): QuranVideoProps | null => {
    if (!previewProps || !previewTimingBasis || !selectedSurah) return previewProps;
    const { json, trimStartMs } = previewTimingBasis;
    // The server's props may already hold an ayah more than once (one entry
    // per appearance, see remotion/timing.ts); the timeline is rebuilt from
    // each ayah once.
    const baseVerses = previewProps.verses.filter((v, i, all) => all.findIndex((x) => x.id === v.id) === i);
    const held = holdWordsThroughRepeats(
      baseVerses.map((v) => ({ id: v.id, words: (json?.verses?.[String(v.id)]?.words ?? []) as any[] })),
      json?.readings
    );
    const repeats = repeatWordWindows(baseVerses.map((v) => v.id), json?.readings);
    const timeline = buildVerseTimeline(
      baseVerses.map((v) => {
        const words: any[] = held.get(v.id) ?? [];
        const wordRepeats = repeats.get(v.id);
        const mappings: any[] | undefined = effectiveSegmentation.find(
          (s) => s.surah === selectedSurah.id && s.ayah === v.id
        )?.mappings;
        const realWordCount = puaTokenCountsByAyah[v.id]?.length ?? (json?.engine ? words.length : undefined);
        return {
          id: v.id,
          words: shiftWordsToTrim(words, trimStartMs),
          mappings: mappings && realWordCount ? fitWordCounts(mappings, realWordCount) : mappings,
          repeats: wordRepeats && shiftWordsToTrim(wordRepeats, trimStartMs),
        };
      }),
      { trimStartMs, fps: 30, totalFrames: previewProps.totalDurationInFrames }
    );
    if (!timeline) return previewProps;
    return {
      ...previewProps,
      verses: timeline.map((t) => {
        const v = baseVerses[t.verseIndex];
        const { mappings: _serverMappings, wordRepeats: _serverRepeats, ...verse } = v;
        return {
          ...verse,
          durationInFrames: t.durationInFrames,
          wordTimings: t.wordTimings,
          ...(t.wordRepeats ? { wordRepeats: t.wordRepeats } : {}),
          ...(t.mappings ? { mappings: t.mappings } : {}),
          ...(puaTokenCountsByAyah[v.id] ? { puaTokenCounts: puaTokenCountsByAyah[v.id] } : {}),
        };
      }),
    };
  }, [previewProps, previewTimingBasis, selectedSurah, effectiveSegmentation, puaTokenCountsByAyah]);

  // The background look and word highlighting always come from the current
  // state rather than whatever the last server preview echoed back --
  // QuranVideo.tsx applies them itself, so a slider drag shows instantly and
  // a slower in-flight preview reload can never put an older value back on
  // screen.
  const displayedPreviewProps = useMemo((): QuranVideoProps | null => {
    // reciterName applied here too, so typing it updates the preview on
    // every keystroke without a server round trip.
    return retimedPreviewProps
      ? {
          ...retimedPreviewProps,
          backgroundDim,
          backgroundBlur,
          backgroundZoom,
          wordHighlight,
          wordHighlightColor,
          reciterName: reciterLabel || undefined,
        }
      : null;
  }, [retimedPreviewProps, backgroundDim, backgroundBlur, backgroundZoom, wordHighlight, wordHighlightColor, reciterLabel]);

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
    // The old selection's preparation is abandoned: cancel it (browser
    // request + backend job) so the new selection's starts right away.
    cancelAudioPrep();
    audioPrepRef.current = null;
    setIsPreparingAudio(false);
    setAudioProgressStage(null);
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
    setLiveTimingResults(null);
    setPuaTokenCountsByAyah({});
    setLowConfidenceAyahs(new Set());
    fetch("/api/segmentation/clear", { method: "POST" }).catch(() => {});
  }, [selectedSurah, startVerse, endVerse, selectedReciter, customAudio, audioSourceMode, cancelAudioPrep]);

  // The video is created automatically: once the surah, the ayah range and
  // the audio source (a picked reciter, or an uploaded file) are all set,
  // audio preparation starts on its own after a short pause, and the
  // preview follows from it. At most one automatic attempt per selection
  // (audioParamsEpochRef, bumped by the invalidation effect right above,
  // which must stay declared before this one): a failure shows its error
  // once instead of retrying in a loop, and Step3Audio keeps a manual
  // button for retrying. A request still in flight for an older selection
  // doesn't hold this up: the invalidation effect cancels it and clears
  // isPreparingAudio (a dependency here), so this one starts right away.
  const lastAutoPrepareEpochRef = useRef(-1);
  const hasAudioSource = audioSourceMode === "reciter" ? Boolean(selectedReciter) : Boolean(customAudio);
  useEffect(() => {
    if (isHydratingRef.current) return;
    if (!selectedSurah || startVerse === null || endVerse === null || !hasAudioSource) return;
    if (preparedAudioUrl || isPreparingAudio) return;
    const epoch = audioParamsEpochRef.current;
    if (lastAutoPrepareEpochRef.current === epoch) return;
    const timer = setTimeout(() => {
      if (audioParamsEpochRef.current !== epoch) return;
      lastAutoPrepareEpochRef.current = epoch;
      handlePrepareAudio();
    }, 700);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSurah, startVerse, endVerse, hasAudioSource, selectedReciter, customAudio, audioSourceMode, preparedAudioUrl, isPreparingAudio, hydrationVersion]);

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
      formData.append("backgroundDim", String(backgroundDim));
      formData.append("backgroundBlur", String(backgroundBlur));
      formData.append("backgroundZoom", String(backgroundZoom));
      formData.append("wordHighlight", String(wordHighlight));
      formData.append("wordHighlightColor", wordHighlightColor);
      formData.append("showReciterName", String(showReciterName));
      if (reciterNameEdit !== null) formData.append("reciterNameEdit", reciterNameEdit);
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
    backgroundDim,
    backgroundBlur,
    backgroundZoom,
    wordHighlight,
    wordHighlightColor,
    showReciterName,
    reciterNameEdit,
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
    translationLanguage,
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
    backgroundDim,
    backgroundBlur,
    backgroundZoom,
    wordHighlight,
    wordHighlightColor,
    reciterLabel,
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
  const resumeStartedRef = useRef(false);
  useEffect(() => {
    // Once per mount: development Strict Mode runs mount effects twice, and
    // two parallel resumes share isHydratingRef -- the first to finish
    // re-enabled the invalidation effect while the second was still
    // restoring, which then wiped the prepared audio and segmentation it
    // had just restored.
    if (resumeStartedRef.current) return;
    resumeStartedRef.current = true;
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
        if (typeof data.backgroundDim === "number") setBackgroundDim(data.backgroundDim);
        if (typeof data.backgroundBlur === "number") setBackgroundBlur(data.backgroundBlur);
        if (typeof data.backgroundZoom === "boolean") setBackgroundZoom(data.backgroundZoom);
        if (typeof data.wordHighlight === "boolean") setWordHighlight(data.wordHighlight);
        if (typeof data.wordHighlightColor === "string") setWordHighlightColor(data.wordHighlightColor);
        if (typeof data.showReciterName === "boolean") setShowReciterName(data.showReciterName);
        setReciterNameEdit(typeof data.reciterNameEdit === "string" ? data.reciterNameEdit : null);
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
        setHydrationVersion((v) => v + 1);
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
    setSelectedReciter("");
    setStartVerse(null);
    setEndVerse(null);
    if (bgPreview) URL.revokeObjectURL(bgPreview);
    setBgImage(null);
    setBgPreview(null);
    if (bgVideoPreview) URL.revokeObjectURL(bgVideoPreview);
    setBgVideo(null);
    setBgVideoPreview(null);
    setBackgroundDim(DEFAULT_BACKGROUND_DIM);
    setBackgroundBlur(0);
    setBackgroundZoom(false);
    setWordHighlight(false);
    setWordHighlightColor(DEFAULT_WORD_HIGHLIGHT_COLOR);
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
    setLiveTimingResults(null);
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
        let changed = false;
        const next = prev.map((entry) => {
          if (entry.surah !== surahId) return entry;
          const apiAyah = selectedApiSurah?.ayahs.find((a) => a.ayah_number === entry.ayah);
          const fallback = fixMojibake(apiAyah?.text_turkish || "");
          const liveTranslation = getTranslation(surahId, entry.ayah, fallback);
          if (entry.mappings[0]?.translation_text === liveTranslation) return entry;
          changed = true;
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
        // The same array when nothing changed -- a new one (even an empty
        // `[]`) would re-run everything keyed on it.
        return changed ? next : prev;
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

  // Shared by BackgroundPicker's upload buttons and stock library. A video
  // and an image background are mutually exclusive -- picking one clears
  // the other rather than leaving a stale, invisible selection behind
  // (QuranVideo.tsx would ignore it anyway, since video takes priority, but
  // keeping both "selected" is confusing in the wizard UI).
  const applyBackgroundFile = (file: File, kind: "image" | "video") => {
    if (bgPreview) URL.revokeObjectURL(bgPreview);
    if (bgVideoPreview) URL.revokeObjectURL(bgVideoPreview);
    if (kind === "image") {
      setBgVideo(null);
      setBgVideoPreview(null);
      setBgImage(file);
      setBgPreview(URL.createObjectURL(file));
    } else {
      setBgImage(null);
      setBgPreview(null);
      setBgVideo(file);
      setBgVideoPreview(URL.createObjectURL(file));
    }
    setVideoUrl(null);
    setRenderState("idle");
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) applyBackgroundFile(file, "image");
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
    if (file) applyBackgroundFile(file, "video");
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

  // A part never opens on a waqf sign nor ends on a Hizb sign ۞ (see
  // moveBoundariesOffMarks) -- the server's aligner places them already;
  // this is a second check of every answer. The CTC engine's words are
  // exactly the real Uthmani tokens (`w`), so they can check it here.
  const placeMarksInParts = (ayah: number, mappings: any[]): any[] => {
    const words: { w?: string }[] | undefined = preparedJsonData?.engine ? preparedJsonData.verses?.[String(ayah)]?.words : undefined;
    if (!words || words.some((w) => typeof w.w !== "string")) return mappings;
    const counts = moveBoundariesOffMarks(
      mappings.map((m) => m.word_count),
      words.map((w) => w.w as string)
    );
    return mappings.map((m, i) => (counts[i] === m.word_count ? m : { ...m, word_count: counts[i] }));
  };

  const handleSegmentLongVerses = async () => {
    if (!selectedSurah || selectedVersesContent.length === 0) return;

    const lowConfidenceIds = new Set<number>();
    setSegmentationProgress(tx("جاري تقسيم الآيات...", "Ayetler bölümleniyor...", "Splitting ayahs..."));

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
                language: selectedTranslation.language ?? "tr",
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
                  mappings: placeMarksInParts(verse.id, segData.mappings),
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
      // The new parts keep the reciter's repeats (see lib/readingPath.ts).
      setPendingSegmentationData(
        applyReadings(segmentationResults, preparedJsonData?.readings, readingAyahs(preparedJsonData), selectedSurah.id)
      );
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
      alert(tx("لم يتم العثور على ترجمات للآيات المحددة.", "Seçili ayetler için çeviri bulunamadı.", "No translation found for the selected ayahs."));
    }
    setSegmentationProgress(null);
  };

  const handleClearSegmentation = async () => {
    // Only the split goes: where the reciter went back, the repeats stay
    // (see lib/readingPath.ts) -- an ayah he returned to must still show again.
    setPendingSegmentationData(
      selectedSurah ? applyReadings([], preparedJsonData?.readings, readingAyahs(preparedJsonData), selectedSurah.id) : []
    );
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
    // Same word timing the video uses, a repeat inside a part included.
    const heldWords = holdWordsThroughRepeats(
      selectedVersesContent.map((verse) => ({ id: verse.id, words: preparedJsonData.verses[String(verse.id)]?.words ?? [] })),
      preparedJsonData.readings
    );
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
    const manualIds = new Set<string>();

    for (const verse of selectedVersesContent) {
      const ayahId = verse.id;
      const segmentation = pendingSegmentationData.find(
        (s) => s.surah === selectedSurah.id && s.ayah === ayahId
      );
      const words: { start: number; end: number }[] = heldWords.get(ayahId)!;
      if (!words || words.length === 0) continue;

      if (!segmentation || segmentation.mappings.length === 0) {
        // Same rule as the video (remotion/timing.ts): from the first voiced
        // word to the last one -- a leading ۞ has no sound of its own.
        const span = voicedSpan(words, 0, words.length - 1);
        const startSec = (span?.start ?? words[0].start) / 1000;
        const endSec = (span?.end ?? words[words.length - 1].end) / 1000;
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
          wordStart: 0,
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
      // A placeholder entry (e.g. created by resizing an unsplit ayah's box)
      // can carry a glyph-token count; segmentation/apply/route.ts corrects
      // it for the video with this same function, so the editor uses the
      // corrected counts too.
      const realWordCountForAyah = puaMap[ayahId]?.length ?? (preparedJsonData.engine ? words.length : undefined);
      const mappings: any[] = realWordCountForAyah
        ? fitWordCounts(segmentation.mappings, realWordCountForAyah)
        : segmentation.mappings;
      const totalWordCount = mappings.reduce(
        (sum: number, m: any) => sum + (typeof m.repeat_of_part === "number" ? 0 : m.word_count),
        0
      );
      let wordCursor = 0;
      // Tracks each NON-repeat mapping's own resolved [start, count] word
      // range as we go, purely so a LATER repeat can borrow its SOURCE
      // part's range for text derivation below -- unrelated to wordCursor
      // itself, which stays exactly as before (timing still only ever
      // advances past real, newly-consumed words).
      const partWordRange = new Map<number, { start: number; count: number }>();
      mappings.forEach((mapping: any) => {
        const isRepeatMapping = typeof mapping.repeat_of_part === "number";
        const startWordIdx = wordCursor;
        const endWordIdx = Math.min(wordCursor + mapping.word_count - 1, words.length - 1);
        // Re-derive live from the SOURCE part's own word range for a repeat
        // -- same fix and reasoning as QuranVideo.tsx's own chunkText (see
        // VerseMapping's comment in types.ts): the saved arabic_text
        // snapshot is frozen in whichever QCF encoding was selected when
        // this repeat was last saved, so trusting it verbatim rendered
        // garbled glyphs the instant arabicFont was switched afterward,
        // even inside this very editor. sliceArabicForWordRange always
        // matches the CURRENTLY selected font instead. Falls back to the
        // saved arabic_text, then to this repeat's own (not the source's)
        // range, only if the source part no longer exists -- e.g. the
        // segmentation was re-split/merged since this repeat was created.
        let arabicText: string;
        if (isRepeatMapping) {
          const sourceRange = partWordRange.get(mapping.repeat_of_part);
          if (sourceRange) {
            arabicText = sliceArabicForWordRange(verse, sourceRange.start, sourceRange.count, totalWordCount, puaMap);
          } else if (typeof mapping.arabic_text === "string" && mapping.arabic_text.length > 0) {
            arabicText = mapping.arabic_text;
          } else {
            arabicText = sliceArabicForWordRange(verse, startWordIdx, mapping.word_count, totalWordCount, puaMap);
          }
        } else {
          arabicText = sliceArabicForWordRange(verse, startWordIdx, mapping.word_count, totalWordCount, puaMap);
          partWordRange.set(mapping.part, { start: startWordIdx, count: mapping.word_count });
        }
        if (!isRepeatMapping) wordCursor += mapping.word_count;

        const hasManual = typeof mapping.start_ms === "number" && typeof mapping.end_ms === "number";
        // Unsaved timing: the same voiced-word rule as the video, so the
        // editor's boundaries sit exactly where the text will switch.
        const span = isRepeatMapping ? null : voicedSpan(words, startWordIdx, endWordIdx);
        const startSec = hasManual ? mapping.start_ms / 1000 : (span?.start ?? words[startWordIdx]?.start ?? 0) / 1000;
        const endSec = hasManual ? mapping.end_ms / 1000 : (span?.end ?? words[endWordIdx]?.end ?? words[words.length - 1].end) / 1000;

        if (allSegments.length === 0) firstSegHasManualTiming = hasManual;
        lastSegHasManualTiming = hasManual;
        if (hasManual) manualIds.add(`${ayahId}-${mapping.part}`);
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
          ...(isRepeatMapping ? { repeatOfId: `${ayahId}-${mapping.repeat_of_part}` } : { wordStart: startWordIdx }),
        });
      });
    }

    // In the order they're heard: a repeat the reciter went back for after
    // the next ayah began sits after that ayah's segments (stable otherwise).
    const heard = allSegments.map((seg, k) => ({ seg, k })).sort((x, y) => x.seg.startSec - y.seg.startSec || x.k - y.k);
    if (heard.some(({ k }, n) => k !== n)) {
      allSegments.splice(0, allSegments.length, ...heard.map(({ seg }) => seg));
      firstSegHasManualTiming = manualIds.has(allSegments[0].id);
      lastSegHasManualTiming = manualIds.has(allSegments[allSegments.length - 1].id);
    }

    // Seed the first/last segment's own boundary with the default trim
    // window (see defaultTrimFromTimings) -- the same one handlePrepareAudio
    // applied to the preview, so opening the panel doesn't move it.
    // Only when neither already carries a manually-saved boundary (see
    // firstSegHasManualTiming/lastSegHasManualTiming above) -- otherwise
    // this would silently discard a trim the user already chose and saved.
    const defaultTrim = defaultTrimFromTimings(preparedJsonData);
    if (allSegments.length > 0 && defaultTrim) {
      if (!firstSegHasManualTiming) {
        allSegments[0].startSec = defaultTrim.start;
      }
      if (!lastSegHasManualTiming) {
        const last = allSegments[allSegments.length - 1];
        last.endSec = Math.max(last.startSec, defaultTrim.end);
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

  // Real-word timing per selected ayah for SegmentTimingEditor's ayahWords
  // prop (split/word-shift snap their new boundary to the real word onset),
  // on the same timeline as buildTimingEditorSegments' startSec/endSec.
  // Only offered for timing from the CTC engine (preparedJsonData.engine),
  // which has exactly one entry per real Uthmani word -- the older Whisper
  // pipeline dropped/shifted entries around waqf marks, so "word k" there
  // could be a different word. glyphCounts only applies to the QCF v2 text
  // (the same condition sliceArabicForWordRange uses).
  const buildTimingEditorWordData = (): Record<number, AyahWordTiming> | undefined => {
    if (!preparedJsonData?.verses || !preparedJsonData.engine) return undefined;
    const offset = trimmedPreviewAudioUrl ? trimmedPreviewOffset : 0;
    const data: Record<number, AyahWordTiming> = {};
    for (const verse of selectedVersesContent) {
      const words: { start: number; end: number }[] | undefined = preparedJsonData.verses[String(verse.id)]?.words;
      const glyphCounts = arabicFont === "qcf1" ? undefined : puaTokenCountsByAyah[verse.id];
      if (!words?.length || (glyphCounts && glyphCounts.length !== words.length)) continue;
      data[verse.id] = {
        times: words.map((w) => ({ start: w.start / 1000 - offset, end: w.end / 1000 - offset })),
        glyphCounts,
      };
    }
    return data;
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
        tx("يجب تجهيز الصوت أولاً (زر «تجهيز الصوت») قبل ضبط التوقيت يدويًا.", "Zamanlamayı elle ayarlamadan önce sesi hazırlamanız gerekir (\"Sesi Hazırla\" düğmesi).", "You need to prepare the audio (\"Prepare Audio\" button) before adjusting the timing manually.")
      );
      return;
    }
    const wordMap = await ensureWordMapForAyahs(selectedVersesContent.map((v) => v.id));
    const segments = buildTimingEditorSegments(wordMap);
    if (!segments || segments.length === 0) {
      alert(
        tx("لا يمكن تحديد التوقيت — تأكد من أن الصوت المُجهَّز يغطي الآيات المحددة.", "Zamanlaması belirlenemiyor — hazırlanan sesin bu ayetleri kapsadığından emin olun.", "Timing can't be determined — make sure the prepared audio covers these ayahs.")
      );
      return;
    }
    setShowTimingEditor(true);
    requestAnimationFrame(() => timingPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  // handlePrepareAudio flags a needsReview result; the panel can only open
  // once its setState calls have landed, i.e. on the next render.
  useEffect(() => {
    if (!openTimingEditorAfterPrepareRef.current || !preparedAudioUrl || !preparedJsonData) return;
    openTimingEditorAfterPrepareRef.current = false;
    handleOpenTimingEditor();
  }, [preparedAudioUrl, preparedJsonData]);

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
    setReviewNoticeDismissed(true);
    setAudioTrimStart(Math.max(0, trimStart + offset));
    setAudioTrimEnd(Math.max(0, trimEnd + offset));
  };

  const handleSaveTimingEditor = (results: SegmentTimingResult[]) => {
    if (!selectedSurah || !showTimingEditor) return;
    setReviewNoticeDismissed(true);

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

    const surahId = selectedSurah.id;
    setPendingSegmentationData((prev) => applyTimingResults(prev, results, surahId, previewOffsetSec));
    setLiveTimingResults(null);

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
    setRenderProgress(null);

    const segmentationData = pendingSegmentationData.length > 0 ? pendingSegmentationData : null;
    // A background auto-save still rendering OLDER settings would make this
    // download wait out a whole render nobody needs anymore -- cancel it.
    // One of these exact settings is left running: its video is reused.
    const running = lastRealRenderRef.current;
    if (running?.inFlight && running.background && running.signature !== renderSignature(buildRenderFormData(), segmentationData)) {
      fetch(`/api/video/render?id=${encodeURIComponent(running.renderId)}`, { method: "DELETE" }).catch(() => undefined);
    }

    // Follows whichever real render is running -- the background one this
    // download waits on, then its own.
    const progressTimer = setInterval(async () => {
      const current = lastRealRenderRef.current;
      if (!current?.inFlight) return;
      const res = await fetch(`/api/video/render?id=${encodeURIComponent(current.renderId)}`).catch(() => null);
      if (!res?.ok || lastRealRenderRef.current !== current) return;
      const data = await res.json().catch(() => null);
      if (data && typeof data.progress === "number") setRenderProgress(data);
    }, 1000);

    try {
      // Queued behind any background auto-save render already in flight for
      // this same project (see runSerializedRender/realRenderChainRef) --
      // renderState is already "rendering" from the moment of the click
      // above regardless of how long that wait turns out to be, so the
      // button's own spinner/disabled state is accurate either way.
      await runSerializedRender(() => executeVideoRender(segmentationData));
    } catch (error) {
      setRenderError(error instanceof Error ? error.message : "تعذر إنشاء الفيديو");
      setRenderState("error");
      setSegmentationProgress(null);
    } finally {
      clearInterval(progressTimer);
      setRenderProgress(null);
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
  // The background isn't a step before the video anymore -- it's an
  // optional section under the video (BackgroundPicker, passed into
  // Step5Generate), once the video already exists.
  const WIZARD_STEPS: WizardStepMeta[] = [
    { label: tx("اختيار السورة والآيات", "Sure ve Ayet Seçimi", "Surah and Ayah Selection") },
    { label: tx("اختيار القارئ", "Kari Seçimi", "Choose the Reciter") },
  ];

  // A new reciter (or audio source) brings its own name back into the
  // reciter-name field -- text typed for the previous one no longer fits.
  const onReciterChange = (val: string) => {
    setSelectedReciter(val);
    setReciterNameEdit(null);
  };
  const onAudioSourceModeChange = (mode: "reciter" | "custom") => {
    setAudioSourceMode(mode);
    setReciterNameEdit(null);
  };

  return (
    <>
      <div className="mx-auto max-w-5xl space-y-8" dir={isArabic ? "rtl" : "ltr"}>
        <div className="text-center space-y-3">
          <h1 className="text-3xl font-bold text-gradient-gold">
            {tx("صانع الفيديو القرآني", "Kuran Videosu Oluşturucu", "Quran Video Creator")}
          </h1>
          <p className="text-muted-foreground">
            {tx("اختر السورة والآيات والخلفية والقارئ، ثم أنشئ فيديو جاهزًا للتحميل.", "Sureyi, ayetleri, arka planı ve kariyi seçip indirilebilir video oluşturun.", "Choose the surah, ayahs, background and reciter to create a downloadable video.")}
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
              {tx("مشروع جديد", "Yeni Proje", "New Project")}
            </button>
            <Link
              href="/?tab=gallery"
              className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-primary/30 hover:bg-surface"
            >
              <FilmIcon className="h-4 w-4" />
              {tx("فيديوهاتي المحفوظة", "Videolarım", "My Videos")}
            </Link>
          </div>
          {autosaveStatus === "error" && (
            <p className="animate-fade-in text-xs text-accent-red">
              {tx("تعذر الحفظ التلقائي", "Otomatik kaydetme başarısız", "Autosave failed")}
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
                  <Step3Audio
                    isArabic={isArabic}
                    audioSourceMode={audioSourceMode}
                    setAudioSourceMode={onAudioSourceModeChange}
                    selectedReciter={selectedReciter}
                    onReciterChange={onReciterChange}
                    showReciterNameOption={isArabicVideo}
                    showReciterName={showReciterName}
                    onShowReciterNameChange={setShowReciterName}
                    reciterNameText={reciterNameText}
                    onReciterNameTextChange={setReciterNameEdit}
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
                {tx("الفيديو والتعديل", "Video ve Düzenleme", "Video and Editing")}
              </h2>

              {translationSyncNotice && (
                <div
                  className="animate-fade-in flex items-start justify-between gap-3 rounded-xl border border-accent-amber/30 bg-accent-amber-bg/20 px-3 py-2.5"
                  dir={isArabic ? "rtl" : "ltr"}
                >
                  <p className="text-xs text-accent-amber">
                    {tx("تم تغيير الترجمة: تحدّث القسم الأول تلقائيًا لكل آية مقسَّمة إلى عدة أجزاء، لكن باقي الأجزاء لا تزال تحمل نص الترجمة القديم -- افتح لوحة التوقيت وأعد توزيع النص عليها يدويًا.", "Çeviri değişti: birden çok bölüme ayrılmış her ayetin yalnızca ilk bölümü otomatik güncellendi, diğer bölümler hâlâ eski çeviri metnini taşıyor -- Zamanlama panelini açıp metni elle yeniden dağıtın.", "The translation changed: only the first segment of each ayah split into several segments was updated automatically; the other segments still carry the old translation text -- open the Timing panel and redistribute the text manually.")}
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

              {preparedJsonData?.needsReview && !reviewNoticeDismissed && (
                <div
                  className="animate-fade-in flex items-start justify-between gap-3 rounded-xl border border-accent-amber/30 bg-accent-amber-bg/20 px-3 py-2.5"
                  dir={isArabic ? "rtl" : "ltr"}
                >
                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold text-accent-amber">
                      {tx("⚠️ لم يتمكن النظام من التحقق من هذا المقطع الصوتي بالكامل -- استمع إليه واضبط البداية/النهاية من لوحة التوقيت إن لزم:", "⚠️ Bu ses klibi tam olarak doğrulanamadı -- dinleyin ve gerekirse başlangıcı/bitişi Zamanlama panelinden ayarlayın:", "⚠️ This audio clip couldn't be fully verified -- listen to it and adjust the start/end in the Timing panel if needed:")}
                    </p>
                    <ul className="list-disc ps-5 text-xs text-accent-amber">
                      {(preparedJsonData.reviewReasons || []).map((r: any, i: number) => {
                        // Where in the video (the played audio starts audioTrimStart into the clip).
                        const atSec = typeof r.atMs === "number" ? Math.max(0, r.atMs / 1000 - audioTrimStart) : null;
                        const at =
                          atSec === null ? "" : ` (${Math.floor(atSec / 60)}:${String(Math.floor(atSec % 60)).padStart(2, "0")})`;
                        return <li key={`${r.code}-${i}`}>{tx(r.ar, r.tr, r.en ?? r.tr)}{at}</li>;
                      })}
                    </ul>
                    {!showTimingEditor && (
                      <button
                        type="button"
                        onClick={handleOpenTimingEditor}
                        className="text-xs font-semibold text-accent-amber underline underline-offset-2 hover:opacity-80 transition-opacity"
                      >
                        {tx("افتح لوحة التوقيت", "Zamanlama panelini aç", "Open the Timing panel")}
                      </button>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setReviewNoticeDismissed(true)}
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
                previewProps={displayedPreviewProps}
                previewVersion={previewVersion}
                isLoadingPreview={isLoadingPreview}
                previewError={previewError}
                suggestedTitle={suggestedTitle}
                renderProgress={renderProgress}
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
                arabicTextScale={arabicTextScale}
                translationTextScale={translationTextScale}
                onBulkArabicTextScaleChange={handleBulkArabicTextScaleChange}
                onBulkTranslationTextScaleChange={handleBulkTranslationTextScaleChange}
                wordHighlight={wordHighlight}
                onWordHighlightChange={setWordHighlight}
                wordHighlightColor={wordHighlightColor}
                onWordHighlightColorChange={setWordHighlightColor}
                isPreparingAudio={isPreparingAudio}
                audioProgressStage={audioProgressStage}
                hasSelection={Boolean(selectedSurah && startVerse !== null && endVerse !== null && hasAudioSource)}
                backgroundPanel={
                  <BackgroundPicker
                    isArabic={isArabic}
                    aspectRatio={aspectRatio}
                    videoDurationSec={displayedPreviewProps ? displayedPreviewProps.totalDurationInFrames / 30 : null}
                    bgPreview={bgPreview}
                    bgVideoPreview={bgVideoPreview}
                    handleImageUpload={handleImageUpload}
                    handleVideoUpload={handleVideoUpload}
                    removeImage={removeImage}
                    removeVideo={removeVideo}
                    onBackgroundFile={applyBackgroundFile}
                    backgroundDim={backgroundDim}
                    onBackgroundDimChange={setBackgroundDim}
                    backgroundBlur={backgroundBlur}
                    onBackgroundBlurChange={setBackgroundBlur}
                    backgroundZoom={backgroundZoom}
                    onBackgroundZoomChange={setBackgroundZoom}
                  />
                }
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
                      ayahLabel={tx(`جميع الآيات`, `Tüm Ayetler`, `All Ayahs`)}
                      segments={segments}
                      isArabic={isArabic}
                      onCancel={() => setShowTimingEditor(false)}
                      onConfirm={handleSaveTimingEditor}
                      isSegmented={isSegmented}
                      isSegmenting={segmentationProgress !== null}
                      onToggleSegmentation={isSegmented ? handleClearSegmentation : handleSegmentLongVerses}
                      onTrimOnly={handleTrimOnly}
                      onPersistTrimmedAudio={handlePersistTrimmedAudio}
                      onLiveChange={setLiveTimingResults}
                      arabicFont={arabicFont}
                      translationFontFamily={timingEditorTranslationFontFamily}
                      ayahWords={buildTimingEditorWordData()}
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
              {tx("تأكيد مسح البيانات", "Emin misiniz?", "Are you sure?")}
            </h2>
            <p className="text-sm sm:text-base text-muted-foreground mb-8">
              {tx("هل أنت متأكد أنك تريد بدء إنشاء فيديو جديد من الصفر؟ سيتم مسح كافة البيانات الحالية ولن تتمكن من استعادتها.", "Sıfırdan yeni bir video oluşturmak istiyor musunuz? Mevcut tüm veriler silinecek ve geri alınamayacak.", "Do you want to create a new video from scratch? All current data will be deleted and can't be undone.")}
            </p>
            <div className="flex gap-3 justify-center w-full">
              <button
                onClick={() => setShowStartOverConfirm(false)}
                className="flex-1 rounded-xl bg-background border border-border px-4 py-2.5 text-sm sm:text-base font-medium text-foreground hover:bg-surface transition-colors"
              >
                {tx("إلغاء", "İptal", "Cancel")}
              </button>
              <button
                onClick={handleStartOver}
                className="flex-1 rounded-xl bg-accent-red border border-accent-red px-4 py-2.5 text-sm sm:text-base font-medium text-white hover:opacity-90 transition-opacity shadow-[0_0_15px_rgba(239,68,68,0.2)]"
              >
                {tx("مسح", "Yeniden Başla", "Start Over")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
