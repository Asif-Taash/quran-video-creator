"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowPathIcon, FolderOpenIcon } from "@heroicons/react/24/outline";
import { useLanguage, useT } from "@/lib/LanguageContext";
import { fixMojibake } from "@/lib/textEncoding";
import { RECITER_DISPLAY_NAMES, RECITER_ARABIC_NAMES } from "@/lib/reciterNames";
import quranData from "@/data/quran.json";
import quranQcfV1Data from "@/data/quran-qcf-v1.json";

import { useTranslationContext } from "@/lib/TranslationContext";
import { getTranslationOption } from "@/lib/translationOptions";
import { surahEnglishName } from "@/lib/surahEnglishNames";
import SegmentTimingEditor, { type AyahWordTiming, type SegmentTimingInput, type SegmentTimingResult } from "./SegmentTimingEditor";
import {
  ARABIC_FONT_OPTIONS,
  DEFAULT_BACKGROUND_DIM,
  DEFAULT_TRANSLATION_FONT,
  DEFAULT_WORD_HIGHLIGHT_COLOR,
  resolveTranslationFont,
  TRANSLATION_FONT_OPTIONS,
  translationFontStack,
  translationFontSupports,
  type ArabicFontKey,
  type AspectRatio,
  type QualityTier,
  type QuranVideoProps,
  type TranslationFontKey,
} from "@/remotion/types";
import { buildVerseTimeline, fitWordCounts, holdWordsThroughRepeats, moveBoundariesOffMarks, repeatWordWindows, shiftWordsToTrim, voicedSpan } from "@/remotion/timing";
import { buildTextSchedule } from "@/remotion/textSchedule";
import { applyReadings } from "@/lib/readingPath";
import { type WizardStepMeta } from "./wizard/WizardShell";
import Step1SurahVerse from "./wizard/Step1SurahVerse";
import BackgroundPicker from "./BackgroundPicker";
import Step3Audio from "./wizard/Step3Audio";
import Step5Generate from "./wizard/Step5Generate";
import ProjectsDialog from "./ProjectsDialog";
import AudioChangeDialog from "./AudioChangeDialog";
import { keepPieces, ownParts, restorePieces, withPieces } from "@/lib/segmentTranslations";
import { BASMALA_GLYPHS, BASMALA_VERSE_ID, basmalaMeaning, canStartWithBasmala } from "@/lib/basmala";

// localStorage key holding the open project's draft id -- this browser's
// pointer into the project it resumes (see autosaveDraft, handleStartOver and
// handleOpenProject below). The draft itself is just a JSON file keyed by
// this id; every saved project is listed in "مشاريعي" (ProjectsDialog). No
// key means no draft, a stale/deleted id is treated the same as no key.
const DRAFT_STORAGE_KEY = "kurannuru:videoCreatorDraftId";

// The look of the last project worked on (translation, fonts, text sizes,
// dim, shape, quality...), written on every autosave: a new project starts
// from it instead of the defaults, which every project then had to be
// re-adjusted from. Never the reciter -- choosing one is what starts
// preparing the audio -- nor anything of one project's own (ayahs, audio,
// background, timing).
const STYLE_STORAGE_KEY = "kurannuru:lastProjectStyle";

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
export type RenderProgress = { stage: "preparing" | "rendering" | "saving"; progress: number };

type RealRenderRecord = {
  signature: string;
  renderId: string;
  inFlight: boolean;
  videoUrl: string | null;
};

class RenderCancelledError extends Error {}

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
// A part of an ayah the recording doesn't contain (it starts or ends
// mid-ayah, 57:20 on 2026-11-02): never on screen, but its words still
// count, so the parts after it show the right words (see QuranVideo.tsx).
// The timing editor never shows it, and nothing that rebuilds an ayah's
// parts may drop it, or the unrecited words come back on screen.
function isHiddenPart(mapping: any): boolean {
  return mapping?.hidden === true;
}

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
    // Hidden parts (see isHiddenPart) aren't in `results`: they go back
    // where they were, before or after the parts the editor showed.
    const allOldMappings: any[] | undefined = prev.find((s) => s.surah === surahId && s.ayah === ayahId)?.mappings;
    const firstShown = allOldMappings?.findIndex((m) => !isHiddenPart(m)) ?? -1;
    const hiddenBefore = allOldMappings?.filter((m, i) => isHiddenPart(m) && (firstShown === -1 || i < firstShown)) ?? [];
    const hiddenAfter = allOldMappings?.filter((m, i) => isHiddenPart(m) && firstShown !== -1 && i > firstShown) ?? [];
    const offset = hiddenBefore.length;
    const idToPart = new Map(ayahResults.map((r, idx) => [r.id, offset + idx + 1]));
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
    const oldMappings = allOldMappings?.filter((m) => !isHiddenPart(m));
    const canPreserveScale = oldMappings && oldMappings.length === ayahResults.length;
    // Every other translation's pieces (see lib/segmentTranslations.ts)
    // still fit while the parts hold the same words.
    const oldOwn = (oldMappings ?? []).filter((m) => typeof m.repeat_of_part !== "number");
    const newOwn = ayahResults.filter((r) => !(r.repeatOfId && idToPart.has(r.repeatOfId)));
    const samePartWords = oldOwn.length === newOwn.length && oldOwn.every((m, i) => m.word_count === Math.max(1, newOwn[i].wordCount));
    next.push({
      surah: surahId,
      ayah: ayahId,
      mappings: [
        ...hiddenBefore.map((m, i) => ({ ...m, part: i + 1 })),
        ...ayahResults.map((result, idx) => {
        const oldMapping = canPreserveScale ? oldMappings![idx] : undefined;
        const ownIdx = newOwn.indexOf(result);
        const keptPieces = samePartWords && ownIdx !== -1 ? oldOwn[ownIdx].translation_pieces : undefined;
        return {
          part: offset + idx + 1,
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
          ...(keptPieces ? { translation_pieces: keptPieces } : {}),
        };
        }),
        ...hiddenAfter.map((m, i) => ({ ...m, part: offset + ayahResults.length + i + 1 })),
      ],
    });
  }
  return next;
}

function StepCard({ idx, label, children, className }: { idx: number; label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`relative rounded-2xl p-4 sm:p-6 md:p-8 space-y-6 shadow-lg ${className ?? ""}`}>
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

export default function VideoCreatorForm() {
  const tx = useT();
  const { language } = useLanguage();
  const isArabic = language === "ar";
  const surahs = quranData as Surah[];
  const { selectedTranslation, setSelectedTranslationId, translationLanguage, setTranslationLanguage, getTranslation, fetchSurahTranslations } = useTranslationContext();

  const [selectedSurah, setSelectedSurah] = useState<Surah | null>(null);
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
  // A photo background too small for the video is swapped for a sharper,
  // upscaled copy once the backend has made it (api/backgrounds/enhance);
  // the user can switch back to their original. A newer pick/removal bumps
  // the token, so a late result never replaces a background it wasn't for.
  const [bgEnhance, setBgEnhance] = useState<{
    original: File;
    enhanced: File | null;
    status: "working" | "done";
    useEnhanced: boolean;
  } | null>(null);
  const bgEnhanceTokenRef = useRef(0);
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
  const [backgroundVignette, setBackgroundVignette] = useState(0);
  // Colors the Arabic word being recited -- see QuranVideoProps.wordHighlight.
  const [wordHighlight, setWordHighlight] = useState(false);
  // Start the video with the basmala before ayah 1 (lib/basmala.ts). Only
  // in effect where the selection starts at ayah 1 of a surah that has one;
  // the choice itself stays for the next such selection.
  const [includeBasmala, setIncludeBasmala] = useState(false);
  const startsWithBasmala = includeBasmala && canStartWithBasmala(selectedSurah?.id, startVerse);
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
  // The last finished render's file, for Step5Generate's "download didn't
  // start?" link (see handleGenerateVideo's own download below).
  const [lastDownload, setLastDownload] = useState<{ url: string; name: string } | null>(null);
  const [surahTurkishNames] = useState<Map<number, string>>(
    new Map(surahs.map((s) => [s.id, s.transliteration]))
  );
  const [renderError, setRenderError] = useState("");
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
  // The latest of it, for the translation re-sync (it waits for the server
  // between reading the parts and writing their new texts).
  const pendingSegmentationRef = useRef<any[]>(pendingSegmentationData);
  pendingSegmentationRef.current = pendingSegmentationData;
  // Per-ayah count of QCF glyph tokens each real word occupies in verse.text —
  // lets a mapping's word_count (real words) be converted into the glyph
  // token range needed to slice the Arabic preview text below.
  const [puaTokenCountsByAyah, setPuaTokenCountsByAyah] = useState<Record<number, number[]>>({});
  // Ayahs where the AI's auto-segmentation couldn't reach consensus across
  // its independent attempts and fell back to a best-effort proportional
  // split — surfaced in the UI so the user knows exactly which segments to
  // double-check/adjust manually instead of trusting them blindly.
  const [lowConfidenceAyahs, setLowConfidenceAyahs] = useState<Set<number>>(new Set());
  // Set when another translation was cut to fit an ayah's parts and a cut
  // came out uncertain (or couldn't be made) -- see the translation re-sync
  // (fetchSurahTranslations().then() below).
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
  // Why the last audio preparation failed, shown in the reciter step with a
  // retry button (it used to be a browser alert() that froze the page).
  const [audioPrepError, setAudioPrepError] = useState<string | null>(null);
  // A short message at the bottom of the page for the rarer problems (also
  // alert()s before), gone after a few seconds.
  const [pageNotice, setPageNotice] = useState<string | null>(null);
  const pageNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showPageNotice = (text: string) => {
    setPageNotice(text);
    if (pageNoticeTimerRef.current) clearTimeout(pageNoticeTimerRef.current);
    pageNoticeTimerRef.current = setTimeout(() => setPageNotice(null), 7000);
  };

  const [currentStep, setCurrentStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [showProjects, setShowProjects] = useState(false);
  // An audio change waiting for the user's answer (AudioChangeDialog, see
  // guardAudioChange). Wrapped: a bare function would be taken as an updater.
  const [pendingAudioChange, setPendingAudioChange] = useState<{ apply: () => void } | null>(null);
  // "مشروع جديد" says where the project it closed went (see handleStartOver).
  const [startOverNotice, setStartOverNotice] = useState(false);

  const [draftId, setDraftId] = useState<string | null>(null);
  const [autosaveStatus, setAutosaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // render/route.ts writes every real render of a range to the same fixed
  // `${surahId}-${startVerse}-${endVerse}.mp4` path, so two running at once
  // could each end up with a half-written file. Every real render (a
  // download) is queued through runSerializedRender below instead: at most
  // one runs for this project at a time, a second simply waits its turn.
  const realRenderChainRef = useRef<Promise<void>>(Promise.resolve());
  // The latest real render -- see runRealRender.
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
  // The files the server already holds for which draft (as of the last
  // successful save): autosave sends "keep" for them instead of uploading
  // the same audio/background again after every edit -- see api/drafts'
  // keptDraftFile.
  const savedDraftFilesRef = useRef<{ draftId: string | null; bgImage: File | null; bgVideo: File | null; customAudio: File | null }>({
    draftId: null,
    bgImage: null,
    bgVideo: null,
    customAudio: null,
  });
  // Saves run one after another: two in flight could finish in either order
  // and leave the older one's files on disk.
  const autosaveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
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
    shownVersesContent.map((verse) => ({
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
    setAudioPrepError(null);

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
      if (startsWithBasmala) formData.append("basmala", "true");
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
          setAudioPrepError(data.error || tx("فشل تجهيز الصوت.", "Ses hazırlanamadı.", "Couldn't prepare the audio."));
        }
      } else {
        // 409: this job was cancelled (a newer selection replaced it).
        if (isStale() || res.status === 409) return;
        const errData = await res.json().catch(() => null);
        setAudioPrepError(
          errData?.error || tx("فشل تجهيز الصوت. حدث خطأ في الخادم.", "Ses hazırlanamadı. Sunucu hatası.", "Couldn't prepare the audio. Server error.")
        );
      }
    } catch (e) {
      if (isStale() || prep.controller.signal.aborted) return;
      console.error(e);
      setAudioPrepError(tx("حدث خطأ أثناء الاتصال بالخادم", "Sunucuya bağlanırken hata oluştu", "Error connecting to the server"));
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
  // includeCustomAudio: a preview leaves the user's own audio file out (tens
  // of MB, re-sent on every reload) unless render/route.ts says it needs it.
  const buildRenderFormData = (mode?: "preview", includeCustomAudio = mode !== "preview") => {
    const formData = new FormData();
    if (!selectedSurah || !startVerse || !endVerse) throw new Error("Missing required fields");
    formData.append("surahId", String(selectedSurah.id));
    formData.append("startVerse", String(startVerse));
    formData.append("endVerse", String(endVerse));
    if (startsWithBasmala) formData.append("basmala", "true");

    formData.append("audioSourceMode", audioSourceMode);
    if (audioSourceMode === "custom" && customAudio && includeCustomAudio) {
      formData.append("customAudio", customAudio);
    }
    formData.append("reciterId", selectedReciter);

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
    formData.append("backgroundVignette", String(backgroundVignette));
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
      let response = await fetch("/api/video/render", {
        method: "POST",
        body: buildRenderFormData("preview"),
      });
      // The prepared clip is gone on the server (a container restart wipes
      // it), so it needs the original audio again.
      if (response.status === 409) {
        response = await fetch("/api/video/render", {
          method: "POST",
          body: buildRenderFormData("preview", true),
        });
      }
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

      // No real render from here or from any edit: it's the heaviest thing
      // the app does (a full headless-Chromium encode, all CPU cores, GBs
      // of memory). Only a download runs one.
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
  // project has settled, and makes any FURTHER real render wait its own turn
  // behind this one -- see realRenderChainRef's own comment.
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
  // segmentation it applies. renderId doesn't change the video.
  const renderSignature = (formData: FormData, segmentationData: any[] | null) => {
    const parts: string[] = [];
    formData.forEach((value, key) => {
      if (key === "renderId") return;
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
  // prunes old ones) -- so downloading the same video again reuses it
  // instead of rendering it all again.
  const reusableRenderUrl = async (signature: string): Promise<string | null> => {
    const videoUrl = lastRealRenderRef.current?.videoUrl;
    if (!videoUrl || !lastRenderMatches(signature)) return null;
    const res = await fetch(videoUrl, { headers: { Range: "bytes=0-0" } }).catch(() => null);
    await res?.body?.cancel().catch(() => undefined);
    return res?.ok ? videoUrl : null;
  };

  // POSTs one real render, tracked in lastRealRenderRef while it runs (the
  // download button polls its progress). Resolves to its video URL.
  const runRealRender = async (formData: FormData, signature: string): Promise<string> => {
    // crypto.randomUUID only exists in secure contexts, and the app is also
    // opened over plain-http LAN addresses.
    const renderId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    formData.append("renderId", renderId);
    const record: RealRenderRecord = { signature, renderId, inFlight: true, videoUrl: null };
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

  // "مشاريعي" keeps a copy of the project as each video was exported
  // (api/drafts/[id]/snapshot): the project itself goes on changing as the
  // user edits it, and once a change of audio reset its split, the exported
  // version was gone (Nuh 28, 2026-11-08). Never holds up the export.
  const keepExportCopy = async (id: string, exportName: string) => {
    try {
      const res = await fetch(`/api/drafts/${id}/snapshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exportName: exportName.replace(/\.mp4$/, "") }),
      });
      const data = await res.json();
      return res.ok && typeof data.snapshotId === "string"
        ? { snapshotId: data.snapshotId as string, reused: Boolean(data.reused) }
        : null;
    } catch {
      return null;
    }
  };

  const executeVideoRender = async (segmentationData: any[] | null = null) => {
    let exportCopy: { snapshotId: string; reused: boolean } | null = null;
    try {
      await applyPendingSegmentation(segmentationData);

      // Save right before rendering (rather than trusting the debounced
      // autosave effect to have already run) so the project in "مشاريعي"
      // is exactly the one downloaded, not what it looked like up to 1.5s
      // ago.
      const savedDraftId = await autosaveDraft();

      // Saved under the suggested title (minus characters filenames can't
      // hold -- its " | " reciter separator becomes " - ") instead of the
      // server's internal render filename.
      const downloadName = suggestedTitle
        ? `${suggestedTitle.replace(/\s*\|\s*/g, " - ").replace(/[\\/:*?"<>|]/g, "").trim()}.mp4`
        : "";
      // Copied before rendering: an edit made while the video renders
      // would otherwise end up in the copy without being in the video.
      if (savedDraftId) exportCopy = await keepExportCopy(savedDraftId, downloadName);

      const formData = buildRenderFormData();
      const signature = renderSignature(formData, segmentationData);
      const renderedUrl = (await reusableRenderUrl(signature)) ?? (await runRealRender(formData, signature));

      const finalVideoUrl = `${renderedUrl}?t=${Date.now()}`;
      setRenderState("done");

      // The "Videoyu İndir" button both renders AND downloads in one click --
      // trigger the actual browser download automatically the instant the
      // video is ready, instead of making the user click a second separate
      // download link/button after generation finishes.
      setLastDownload({ url: finalVideoUrl, name: downloadName });
      // iPhone/iPad Safari only honors `download` on a click the user made
      // themselves -- this one comes long after the tap, once the render is
      // done, and could open the video in place of this page instead. There
      // the "download didn't start?" link under the button (a real tap) is
      // the download.
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      if (!isIOS) {
        const link = document.createElement("a");
        link.href = finalVideoUrl;
        link.download = downloadName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }
    } catch (error) {
      // No video came out of it: its copy goes too (a reused copy belongs
      // to an earlier export that did succeed).
      if (exportCopy && !exportCopy.reused) {
        fetch(`/api/drafts/${exportCopy.snapshotId}`, { method: "DELETE" }).catch(() => {});
      }
      setRenderError(error instanceof Error ? error.message : "تعذر إنشاء الفيديو");
      setRenderState("error");
    } finally {
      setSegmentationProgress(null);
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
          // Always attached regardless of the CURRENTLY selected arabicFont
          // -- same reasoning as QuranVideo.tsx/render/route.ts -- so the
          // verse-list preview below can switch fonts instantly too.
          const qcfV1 = qcfV1TextBySurahAyah.get(`${selectedSurah.id}:${verse.id}`);

          return {
            ...verse,
            text: fixMojibake(verse.text),
            translation: getTranslation(selectedSurah.id, verse.id, ""),
            page: verse.page,
            textV1: qcfV1?.text,
            pageV1: qcfV1?.page,
          };
        })
      : [];

  // The ayahs as shown and timed: the basmala first when the video starts
  // with it (lib/basmala.ts) -- Al-Fatiha's own basmala glyphs, and its
  // translation. Splitting and the word maps stay with the real ayahs
  // (selectedVersesContent).
  const shownVersesContent: typeof selectedVersesContent = startsWithBasmala
    ? [
        {
          id: BASMALA_VERSE_ID,
          text: BASMALA_GLYPHS.text,
          page: BASMALA_GLYPHS.page,
          textV1: BASMALA_GLYPHS.textV1,
          pageV1: BASMALA_GLYPHS.pageV1,
          translation: basmalaMeaning(getTranslation(1, 1, ""), selectedTranslation.language),
        },
        ...selectedVersesContent,
      ]
    : selectedVersesContent;

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
  const noTranslation = selectedTranslation.id === "none";
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
        // No translation: none in any part (a project saved before the fix
        // in lib/segmentTranslations.ts may still hold the parts' texts).
        const shownMappings =
          mappings && noTranslation ? mappings.map((m) => ({ ...m, translation_text: "" })) : mappings;
        return {
          id: v.id,
          words: shiftWordsToTrim(words, trimStartMs),
          mappings: shownMappings && realWordCount ? fitWordCounts(shownMappings, realWordCount) : shownMappings,
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
  }, [previewProps, previewTimingBasis, selectedSurah, effectiveSegmentation, puaTokenCountsByAyah, noTranslation]);

  // The background look, word highlighting, fonts and text sizes always come
  // from the current state rather than whatever the last server preview
  // echoed back -- QuranVideo.tsx applies them itself, so a slider drag shows
  // instantly and a slower in-flight preview reload can never put an older
  // value back on screen. The fonts and sizes matter on reopening a project:
  // its first preview reload is scheduled before they are restored from the
  // draft, so the server echoed the defaults and a reopened Poppins project
  // previewed in Aileron (2026-11-09).
  const displayedPreviewProps = useMemo((): QuranVideoProps | null => {
    // reciterName applied here too, so typing it updates the preview on
    // every keystroke without a server round trip.
    return retimedPreviewProps
      ? {
          ...retimedPreviewProps,
          translationFont,
          customTranslationFontUrl: customTranslationFontUrl ?? undefined,
          arabicFont,
          arabicTextScale,
          arabicWidthScale,
          translationTextScale,
          translationWidthScale,
          backgroundDim,
          backgroundBlur,
          backgroundZoom,
          backgroundVignette,
          wordHighlight,
          wordHighlightColor,
          reciterName: reciterLabel || undefined,
        }
      : null;
  }, [
    retimedPreviewProps,
    translationFont,
    customTranslationFontUrl,
    arabicFont,
    arabicTextScale,
    arabicWidthScale,
    translationTextScale,
    translationWidthScale,
    backgroundDim,
    backgroundBlur,
    backgroundZoom,
    backgroundVignette,
    wordHighlight,
    wordHighlightColor,
    reciterLabel,
  ]);

  // The timing editor's live preview shows the text exactly as the video
  // preview does (see SegmentTimingEditor's textSchedule): the same
  // displayedPreviewProps, unsaved editor changes included, laid out by the
  // same code QuranVideo draws with. The editor's audio sits at
  // trimmedPreviewOffset on the prepared clip, the video's at trimStartMs.
  const timingEditorTextSchedule = useMemo(() => {
    if (!showTimingEditor || !displayedPreviewProps || !previewTimingBasis) return null;
    return {
      entries: buildTextSchedule(displayedPreviewProps),
      videoOffsetSec: (trimmedPreviewAudioUrl ? trimmedPreviewOffset : 0) - previewTimingBasis.trimStartMs / 1000,
    };
  }, [showTimingEditor, displayedPreviewProps, previewTimingBasis, trimmedPreviewAudioUrl, trimmedPreviewOffset]);

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
  //
  // Only when one of them really changed: Fast Refresh (dev) re-runs every
  // effect after a code edit, and this reset then wiped the user's trim and
  // segmentation, which autosave stored over their draft (2026-10-31).
  const audioParamsRef = useRef<unknown[] | null>(null);
  useEffect(() => {
    const params = [selectedSurah?.id ?? null, startVerse, endVerse, selectedReciter, customAudio, audioSourceMode, startsWithBasmala];
    const previous = audioParamsRef.current;
    audioParamsRef.current = params;
    if (isHydratingRef.current) return;
    if (previous && params.every((value, i) => Object.is(value, previous[i]))) return;
    audioParamsEpochRef.current += 1;
    // The old selection's preparation is abandoned: cancel it (browser
    // request + backend job) so the new selection's starts right away.
    cancelAudioPrep();
    audioPrepRef.current = null;
    setIsPreparingAudio(false);
    setAudioProgressStage(null);
    setAudioPrepError(null);
    setPreparedAudioUrl(null);
    setPreparedAudioLocalPath(null);
    setPreparedJsonData(null);
    setAudioTrimStart(0);
    setAudioTrimEnd(0);
    setTrimmedPreviewAudioUrl(null);
    setTrimmedPreviewOffset(0);
    setRenderState("idle");
    setPendingSegmentationData([]);
    setLiveTimingResults(null);
    setPuaTokenCountsByAyah({});
    setLowConfidenceAyahs(new Set());
    fetch("/api/segmentation/clear", { method: "POST" }).catch(() => {});
  }, [selectedSurah, startVerse, endVerse, selectedReciter, customAudio, audioSourceMode, startsWithBasmala, cancelAudioPrep]);

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
  }, [selectedSurah, startVerse, endVerse, hasAudioSource, selectedReciter, customAudio, audioSourceMode, startsWithBasmala, preparedAudioUrl, isPreparingAudio, hydrationVersion]);

  // Persists the current builder state server-side (JSON + any uploaded
  // files) under a generated id, keyed on THIS browser via localStorage --
  // there are no user accounts in this app, so there's no link/URL to share;
  // the point is purely "close the tab, reopen it later, everything is
  // exactly as I left it." Re-saving reuses the existing draftId
  // (update-in-place) instead of minting a new file every time.
  const saveDraftNow = async (): Promise<string | undefined> => {
    if (!selectedSurah || startVerse === null || endVerse === null) return;
    setAutosaveStatus("saving");
    // reuseSavedFiles false: the server lost a file it was told to keep.
    const buildDraftForm = (reuseSavedFiles: boolean) => {
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
      formData.append("backgroundVignette", String(backgroundVignette));
      formData.append("wordHighlight", String(wordHighlight));
      formData.append("wordHighlightColor", wordHighlightColor);
      formData.append("showReciterName", String(showReciterName));
      formData.append("includeBasmala", String(includeBasmala));
      formData.append("aspectRatio", aspectRatio);
      formData.append("quality", quality);
      // Only decides the title of a video without a translation (see
      // buildRenderFormData's videoLanguage); otherwise the edition's own.
      formData.append("translationLanguage", translationLanguage);
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

      const saved = savedDraftFilesRef.current;
      const onServer = (file: File, key: "bgImage" | "bgVideo" | "customAudio") =>
        reuseSavedFiles && draftId !== null && saved.draftId === draftId && saved[key] === file;
      if (bgImage) {
        if (onServer(bgImage, "bgImage")) formData.append("keepBgImage", "true");
        else formData.append("bgImage", bgImage);
      }
      if (bgVideo) {
        if (onServer(bgVideo, "bgVideo")) formData.append("keepBgVideo", "true");
        else formData.append("bgVideo", bgVideo);
      }
      // Kept in reciter mode too: switching to a built-in reciter used to
      // drop a recording taken from a link from the project for good
      // (Nuh 28, 2026-11-08), so switching back had nothing to go back to.
      if (customAudio) {
        if (onServer(customAudio, "customAudio")) formData.append("keepCustomAudio", "true");
        else formData.append("customAudio", customAudio);
      }
      return formData;
    };
    try {
      let res = await fetch("/api/drafts", { method: "POST", body: buildDraftForm(true) });
      if (res.status === 409) res = await fetch("/api/drafts", { method: "POST", body: buildDraftForm(false) });
      const data = await res.json();
      if (!res.ok || !data.draftId) throw new Error(data.error || "Failed to save draft");

      savedDraftFilesRef.current = {
        draftId: data.draftId,
        bgImage,
        bgVideo,
        customAudio,
      };
      setDraftId(data.draftId);
      localStorage.setItem(DRAFT_STORAGE_KEY, data.draftId);
      try {
        localStorage.setItem(
          STYLE_STORAGE_KEY,
          JSON.stringify({
            translationId: selectedTranslation.id,
            translationLanguage,
            arabicFont,
            translationFont,
            arabicTextScale,
            arabicWidthScale,
            translationTextScale,
            translationWidthScale,
            backgroundDim,
            backgroundBlur,
            backgroundZoom,
            backgroundVignette,
            wordHighlight,
            wordHighlightColor,
            showReciterName,
            aspectRatio,
            quality,
          })
        );
      } catch {
        // Only a convenience for the next project.
      }
      setAutosaveStatus("saved");
      return data.draftId as string;
    } catch (err) {
      // Unknown what reached the server: the next save sends every file.
      savedDraftFilesRef.current = { draftId: null, bgImage: null, bgVideo: null, customAudio: null };
      setAutosaveStatus("error");
      console.error("[Draft] Autosave failed:", err);
    }
  };
  const autosaveDraft = (): Promise<string | undefined> => {
    const run = autosaveQueueRef.current.then(() => saveDraftNow());
    autosaveQueueRef.current = run.catch(() => undefined);
    return run;
  };

  // Debounced autosave: fires ~1.5s after the user stops changing anything
  // meaningful, rather than on every keystroke/click. Skipped entirely while
  // a draft is actively being restored (isHydratingRef) so hydration doesn't
  // immediately re-save the very data it just loaded. Every value the draft
  // stores must be listed below: the trim alone (the panel's "قص الصوت
  // الآن"), the shape and the quality were left out, and a reopened project
  // lost them (2026-11-07).
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
    backgroundVignette,
    wordHighlight,
    wordHighlightColor,
    showReciterName,
    includeBasmala,
    reciterNameEdit,
    aspectRatio,
    quality,
    translationLanguage,
    audioTrimStart,
    audioTrimEnd,
    preparedJsonData,
  ]);

  // Starts a project with STYLE_STORAGE_KEY's look. False when there is none.
  const applySavedStyle = (): boolean => {
    let s: Record<string, unknown> | null = null;
    try {
      s = JSON.parse(localStorage.getItem(STYLE_STORAGE_KEY) ?? "null");
    } catch {
      s = null;
    }
    if (!s || typeof s !== "object") return false;
    const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
    if (typeof s.translationId === "string" && getTranslationOption(s.translationId)) {
      setSelectedTranslationId(s.translationId);
      if (
        (s.translationLanguage === "tr" || s.translationLanguage === "en" || s.translationLanguage === "ar") &&
        !getTranslationOption(s.translationId)?.language
      ) {
        setTranslationLanguage(s.translationLanguage);
      }
    }
    if (typeof s.arabicFont === "string" && s.arabicFont in ARABIC_FONT_OPTIONS) setArabicFont(s.arabicFont as ArabicFontKey);
    // An uploaded font belongs to its own project.
    if (typeof s.translationFont === "string" && s.translationFont in TRANSLATION_FONT_OPTIONS) {
      setTranslationFont(s.translationFont as TranslationFontKey);
    }
    if (num(s.arabicTextScale)) setArabicTextScale(s.arabicTextScale);
    if (num(s.arabicWidthScale)) setArabicWidthScale(s.arabicWidthScale);
    if (num(s.translationTextScale)) setTranslationTextScale(s.translationTextScale);
    if (num(s.translationWidthScale)) setTranslationWidthScale(s.translationWidthScale);
    if (num(s.backgroundDim)) setBackgroundDim(s.backgroundDim);
    if (num(s.backgroundBlur)) setBackgroundBlur(s.backgroundBlur);
    if (typeof s.backgroundZoom === "boolean") setBackgroundZoom(s.backgroundZoom);
    if (num(s.backgroundVignette)) setBackgroundVignette(s.backgroundVignette);
    if (typeof s.wordHighlight === "boolean") setWordHighlight(s.wordHighlight);
    if (typeof s.wordHighlightColor === "string" && /^#[0-9a-fA-F]{6}$/.test(s.wordHighlightColor)) {
      setWordHighlightColor(s.wordHighlightColor);
    }
    if (typeof s.showReciterName === "boolean") setShowReciterName(s.showReciterName);
    if (s.aspectRatio === "portrait" || s.aspectRatio === "landscape" || s.aspectRatio === "square") setAspectRatio(s.aspectRatio);
    if (s.quality === "720p" || s.quality === "1080p") setQuality(s.quality);
    return true;
  };

  // Resume the last in-progress project automatically on mount, keyed by a
  // draftId stashed in localStorage -- OR, taking priority over that, a
  // `?draft=` URL param: a deliberate link to one SPECIFIC draft (e.g. a
  // bookmarked link from before autosave existed) must always win over
  // whatever unrelated project
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
          applySavedStyle();
          return;
        }
        const data = await res.json();

        setDraftId(data.id);
        localStorage.setItem(DRAFT_STORAGE_KEY, data.id);

        const surah = surahs.find((s) => s.id === data.surahId) || null;
        setSelectedSurah(surah);
        setStartVerse(data.startVerse ?? null);
        setEndVerse(data.endVerse ?? null);
        if (data.selectedReciter) setSelectedReciter(data.selectedReciter);
        if (data.audioSourceMode) setAudioSourceMode(data.audioSourceMode);
        if (data.translationId) setSelectedTranslationId(data.translationId);
        // No translation: the saved language picks the video's title (an
        // edition sets its own language above).
        if (
          (data.translationLanguage === "tr" || data.translationLanguage === "en" || data.translationLanguage === "ar") &&
          !getTranslationOption(data.translationId ?? "none")?.language
        ) {
          setTranslationLanguage(data.translationLanguage);
        }
        if (surah) await fetchSurahTranslations(surah.id);

        let restoredBgImage: File | null = null;
        let restoredBgVideo: File | null = null;
        if (data.background?.url) {
          const blob = await (await fetch(data.background.url)).blob();
          const file = new File([blob], "draft-bg.jpg", { type: blob.type });
          restoredBgImage = file;
          // As saved -- already the sharper copy, or the original the user
          // chose over it.
          bgEnhanceTokenRef.current++;
          setBgEnhance(null);
          setBgImage(file);
          setBgPreview(URL.createObjectURL(file));
        }

        if (data.backgroundVideo?.url) {
          const blob = await (await fetch(data.backgroundVideo.url)).blob();
          const file = new File([blob], "draft-bg.mp4", { type: blob.type });
          restoredBgVideo = file;
          setBgVideo(file);
          setBgVideoPreview(URL.createObjectURL(file));
        }

        let restoredCustomAudio: File | null = null;
        if (data.customAudio?.url) {
          const blob = await (await fetch(data.customAudio.url)).blob();
          const file = new File([blob], data.customAudio.originalName || "draft-audio.mp3", { type: blob.type });
          setCustomAudio(file);
          restoredCustomAudio = file;
        }
        // Already on the server: the next autosave keeps them.
        savedDraftFilesRef.current = {
          draftId: data.id,
          bgImage: restoredBgImage,
          bgVideo: restoredBgVideo,
          customAudio: restoredCustomAudio,
        };

        // Saved before 2026-11-07, a draft pointed at the prepared clip's
        // temp copy, which a container restart wipes (api/drafts keeps its
        // own copy now). Such a project is prepared again, as a new one
        // would be (the auto-prepare effect, once hydration ends): restoring
        // the dead URL left the timing editor without audio, while the
        // render quietly re-extracted with the trim reset anyway. Only a 404
        // counts as gone: a failed request mustn't throw away a good clip
        // and the trim made on it.
        const preparedStillThere = data.preparedAudio?.preparedAudioUrl
          ? await fetch(data.preparedAudio.preparedAudioUrl, { headers: { Range: "bytes=0-0" } }).then(
              async (r) => {
                await r.body?.cancel().catch(() => undefined);
                return r.status !== 404;
              },
              () => true
            )
          : false;
        if (data.preparedAudio && preparedStillThere) {
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
        if (data.aspectRatio === "portrait" || data.aspectRatio === "landscape" || data.aspectRatio === "square") {
          setAspectRatio(data.aspectRatio);
        }
        if (data.quality === "720p" || data.quality === "1080p") setQuality(data.quality);
        if (data.arabicTextScale) setArabicTextScale(data.arabicTextScale);
        if (data.arabicWidthScale) setArabicWidthScale(data.arabicWidthScale);
        if (data.translationTextScale) setTranslationTextScale(data.translationTextScale);
        if (data.translationWidthScale) setTranslationWidthScale(data.translationWidthScale);
        if (data.translationFont) setTranslationFont(data.translationFont);
        if (data.arabicFont) setArabicFont(data.arabicFont);
        if (typeof data.backgroundDim === "number") setBackgroundDim(data.backgroundDim);
        if (typeof data.backgroundBlur === "number") setBackgroundBlur(data.backgroundBlur);
        if (typeof data.backgroundZoom === "boolean") setBackgroundZoom(data.backgroundZoom);
        // A project saved before the vignette existed has none, rather than
        // whatever the previously open project had.
        setBackgroundVignette(typeof data.backgroundVignette === "number" ? data.backgroundVignette : 0);
        if (typeof data.wordHighlight === "boolean") setWordHighlight(data.wordHighlight);
        if (typeof data.wordHighlightColor === "string") setWordHighlightColor(data.wordHighlightColor);
        if (typeof data.showReciterName === "boolean") setShowReciterName(data.showReciterName);
        // A project saved before it existed doesn't start with the basmala.
        setIncludeBasmala(data.includeBasmala === true);
        setReciterNameEdit(typeof data.reciterNameEdit === "string" ? data.reciterNameEdit : null);
        // No File object to restore (never was one, just its already-
        // uploaded URL) -- that's fine, getAssetUrl in QuranVideo.tsx
        // resolves this real server URL directly, no re-upload needed
        // unless the user picks a different file.
        if (data.customTranslationFont?.url) {
          setCustomTranslationFontUrl(data.customTranslationFont.url);
          if (data.customTranslationFont.originalName) setCustomTranslationFontName(data.customTranslationFont.originalName);
        }

        // The audio-invalidation effect compares against the last selection
        // it saw -- hand it the restored one. React may commit the updates
        // above only after isHydratingRef is cleared below, and the effect
        // then took the restore for a NEW selection: it wiped the restored
        // trim and segmentation and prepared the audio again (a reload of
        // a split 57:20-21, 2026-11-02). Same order as that effect's params;
        // fields the draft leaves unset keep this mount's initial state.
        audioParamsRef.current = [
          surah?.id ?? null,
          data.startVerse ?? null,
          data.endVerse ?? null,
          data.selectedReciter || selectedReciter,
          restoredCustomAudio ?? customAudio,
          data.audioSourceMode || audioSourceMode,
          data.includeBasmala === true && canStartWithBasmala(surah?.id, data.startVerse),
        ];
        // Same race for the translation re-sync effect: it would take the
        // restored translation for a change and write the whole ayah's
        // translation over the first segment of every split ayah. The
        // restored segments already carry this translation's text.
        if (data.translationId) lastSyncedTranslationIdRef.current = data.translationId;
        // It is the saved project, as it was saved.
        setAutosaveStatus("saved");
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

  // The open project is saved first: an edit from the last 1.5 s would
  // otherwise still be waiting for autosave.
  const flushAutosave = async () => {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    if (selectedSurah && startVerse !== null && endVerse !== null) await autosaveDraft();
  };

  // Wipes every field back to a blank project. The project it closes stays
  // saved in "مشاريعي" (it used to be deleted, which is why this asked for
  // confirmation first); the next pick of a surah starts a new draft.
  const handleStartOver = async () => {
    await flushAutosave();
    localStorage.removeItem(DRAFT_STORAGE_KEY);
    await fetch("/api/segmentation/clear", { method: "POST" }).catch(() => {});

    isHydratingRef.current = true;
    setSelectedSurah(null);
    setSelectedReciter("");
    setStartVerse(null);
    setEndVerse(null);
    if (bgPreview) URL.revokeObjectURL(bgPreview);
    setBgImage(null);
    setBgPreview(null);
    bgEnhanceTokenRef.current++;
    setBgEnhance(null);
    if (bgVideoPreview) URL.revokeObjectURL(bgVideoPreview);
    setBgVideo(null);
    setBgVideoPreview(null);
    // The look (translation, fonts, sizes, dim, shape, quality...) stays:
    // the new project starts like the one just closed (STYLE_STORAGE_KEY).
    setRenderState("idle");
    setRenderError("");
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
    setAudioPrepError(null);
    // Let the reset settle before re-enabling autosave/invalidation reactions.
    setTimeout(() => {
      isHydratingRef.current = false;
    }, 0);
    setStartOverNotice(true);
    setTimeout(() => setStartOverNotice(false), 5000);
  };

  // "مشاريعي" (ProjectsDialog): the page reloads into the chosen project --
  // the same resume path as reopening the tab, so nothing of this
  // project's state carries over. temp_segmentation.json is one global file
  // the render reads: cleared here, the resume applies the chosen project's
  // own (if it has one).
  const handleOpenProject = async (id: string) => {
    if (id === draftId) {
      setShowProjects(false);
      return;
    }
    await flushAutosave();
    cancelAudioPrep();
    await fetch("/api/segmentation/clear", { method: "POST" }).catch(() => {});
    localStorage.setItem(DRAFT_STORAGE_KEY, id);
    window.location.assign("/");
  };

  // An exported video in "مشاريعي" never changes: opening it opens a new
  // project copied from it.
  const handleOpenExport = async (exportId: string): Promise<boolean> => {
    const res = await fetch(`/api/drafts/${exportId}/copy`, { method: "POST" }).catch(() => null);
    const data = res?.ok ? await res.json().catch(() => null) : null;
    if (typeof data?.draftId !== "string") {
      setShowProjects(false);
      showPageNotice(tx("تعذر فتح الفيديو المُصدَّر.", "Dışa aktarılan video açılamadı.", "Couldn't open the exported video."));
      return false;
    }
    await handleOpenProject(data.draftId);
    return true;
  };

  // Whether the open project has parts or a trim timed to its current
  // audio, which another audio resets (the invalidation effect). The trim
  // counts once it differs from where preparation put it.
  const hasTimingWork = () => {
    if (!preparedAudioUrl) return false;
    if (pendingSegmentationData.length > 0) return true;
    const defaultTrim = defaultTrimFromTimings(preparedJsonData);
    return (
      defaultTrim !== null &&
      (Math.abs(audioTrimStart - defaultTrim.start) > 0.05 || Math.abs(audioTrimEnd - defaultTrim.end) > 0.05)
    );
  };

  // Every change of audio (source tab, reciter, file, link, removal) goes
  // through here: with parts or a trim to lose, the user is asked first.
  const guardAudioChange = (apply: () => void) => {
    if (hasTimingWork()) setPendingAudioChange({ apply });
    else apply();
  };

  // "غيّره في مشروع جديد": the open project is saved and left as it is; the
  // same ayahs and look go on under a new draft (the next autosave creates
  // it and uploads its files), where the change then applies.
  const continueInNewProject = async (apply: () => void) => {
    await flushAutosave();
    savedDraftFilesRef.current = { draftId: null, bgImage: null, bgVideo: null, customAudio: null };
    setDraftId(null);
    apply();
    showPageNotice(
      tx(
        "بدأ مشروع جديد بالصوت الجديد، والمشروع السابق محفوظ كما هو في «مشاريعي».",
        "Yeni sesle yeni bir proje başladı; önceki proje «Projelerim»de olduğu gibi duruyor.",
        "A new project started with the new audio; the previous one is kept as it was in My Projects."
      )
    );
  };

  useEffect(() => {
    // A project being resumed gets its own translation from its draft.
    // Setting "none" here too cleared it whenever this effect ran again
    // (development Fast Refresh re-runs it on every code edit, and the
    // autosave then stored "none"). A page with no project starts from the
    // last project's look (applySavedStyle), else from no translation.
    const resuming = new URLSearchParams(window.location.search).get("draft") || localStorage.getItem(DRAFT_STORAGE_KEY);
    if (resuming || applySavedStyle()) return;
    setSelectedTranslationId("none");
  }, [setSelectedTranslationId]);


  useEffect(() => {
    if (!selectedSurah) return;
    const surahId = selectedSurah.id;
    const translationId = selectedTranslation.id;
    const translationLanguage = selectedTranslation.language;
    // Al-Fatiha's too: the basmala's translation is its ayah 1 (lib/basmala.ts).
    Promise.allSettled([fetchSurahTranslations(surahId), fetchSurahTranslations(1)]).then(async () => {
      // Only re-sync already-timed ayahs' translation_text when the
      // TRANSLATION itself actually changed (not merely because this effect
      // also re-fires on a surah change) -- and only once the fetch that
      // populates getTranslation()'s cache has actually resolved, so we
      // never bake in a stale fallback string.
      if (isHydratingRef.current) return;
      const previousTranslationId = lastSyncedTranslationIdRef.current;
      if (previousTranslationId === translationId) return;
      lastSyncedTranslationIdRef.current = translationId;

      const noneNow = translationId === "none";
      // The basmala's is Al-Fatiha's ayah 1 (lib/basmala.ts).
      const textOf = (ayah: number) =>
        ayah === BASMALA_VERSE_ID ? basmalaMeaning(getTranslation(1, 1, ""), translationLanguage) : getTranslation(surahId, ayah, "");
      // Split ayahs this translation has no kept pieces for: its text is
      // cut to fit their parts on the server (lib/segmentTranslations.ts).
      const toCut = noneNow
        ? []
        : pendingSegmentationRef.current
            .filter(
              (entry) =>
                entry.surah === surahId &&
                entry.ayah !== BASMALA_VERSE_ID &&
                ownParts(entry).length > 1 &&
                textOf(entry.ayah) &&
                !restorePieces(entry, translationId, textOf(entry.ayah))
            )
            .map((entry) => ({ ayah: entry.ayah as number, wordCounts: ownParts(entry).map((m) => m.word_count as number) }));

      // Right away: no translation; kept pieces; ayahs of one part.
      setPendingSegmentationData((prev) => {
        let changed = false;
        const next = prev.map((entry) => {
          if (entry.surah !== surahId) return entry;
          const kept = keepPieces(entry, previousTranslationId);
          const own = ownParts(kept);
          let updated = kept;
          if (noneNow) {
            updated = withPieces(kept, own.map(() => ""));
          } else {
            const text = textOf(kept.ayah);
            updated = restorePieces(kept, translationId, text) ?? (own.length <= 1 ? withPieces(kept, [text]) : kept);
          }
          if (updated !== entry) changed = true;
          return updated;
        });
        // The same array when nothing changed -- a new one (even an empty
        // `[]`) would re-run everything keyed on it.
        return changed ? next : prev;
      });
      if (toCut.length === 0) return;

      const cuts = await Promise.all(
        toCut.map(async ({ ayah, wordCounts }) => {
          try {
            const res = await fetch("/api/segmentation/split-translation", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ surah: surahId, ayah, translation: textOf(ayah), wordCounts, language: translationLanguage ?? "tr" }),
            });
            const data = res.ok ? await res.json() : null;
            if (Array.isArray(data?.pieces) && data.pieces.length === wordCounts.length) {
              return { ayah, wordCounts, pieces: data.pieces as string[], uncertain: data.lowConfidence === true };
            }
          } catch (err) {
            console.warn(`[UI] Couldn't cut the translation of ayah ${ayah} for its parts:`, err);
          }
          // Not cut: the whole text on the first part, for the user to share out.
          return { ayah, wordCounts, pieces: wordCounts.map((_, i) => (i === 0 ? textOf(ayah) : "")), uncertain: true };
        })
      );
      // Another translation picked meanwhile: that one's re-sync applies.
      if (lastSyncedTranslationIdRef.current !== translationId) return;
      setPendingSegmentationData((prev) => {
        let changed = false;
        const next = prev.map((entry) => {
          if (entry.surah !== surahId) return entry;
          const cut = cuts.find((c) => c.ayah === entry.ayah);
          const counts = ownParts(entry).map((m) => m.word_count);
          // Parts changed while it was being cut: left as they are.
          if (!cut || counts.length !== cut.wordCounts.length || counts.some((c, i) => c !== cut.wordCounts[i])) return entry;
          const updated = withPieces(entry, cut.pieces);
          if (updated !== entry) changed = true;
          return updated;
        });
        return changed ? next : prev;
      });
      // Each cut ayah is marked for review in the ayah list exactly when its cut is uncertain.
      setLowConfidenceAyahs((prev) => {
        const next = new Set(prev);
        for (const cut of cuts) {
          if (cut.uncertain) next.add(cut.ayah);
          else next.delete(cut.ayah);
        }
        return next;
      });
      if (cuts.some((c) => c.uncertain)) setTranslationSyncNotice(true);
    });
  }, [selectedSurah?.id, selectedTranslation.id, fetchSurahTranslations, getTranslation]);


  const handleAddNextVerse = () => {
    if (!selectedSurah || endVerse === null) return;
    if (endVerse < selectedSurah.total_verses) {
      setEndVerse(endVerse + 1);
    }
    setRenderError("");
    setRenderState("idle");
  };

  const handleRemoveLastVerse = () => {
    if (startVerse === null || endVerse === null) return;
    if (endVerse > startVerse) {
      setEndVerse(endVerse - 1);
    }
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
      void enhanceBgImage(file);
    } else {
      setBgImage(null);
      setBgPreview(null);
      setBgVideo(file);
      setBgVideoPreview(URL.createObjectURL(file));
      bgEnhanceTokenRef.current++;
      setBgEnhance(null);
    }
    setRenderState("idle");
  };

  // Shows a photo as the background without touching bgEnhance (the original
  // and its sharper copy swap through here). Functional update: called after
  // an await, when bgPreview in this closure may be stale.
  const showBgImage = (file: File) => {
    const url = URL.createObjectURL(file);
    setBgPreview((prev) => {
      if (prev && prev !== url) URL.revokeObjectURL(prev);
      return url;
    });
    setBgImage(file);
    setRenderState("idle");
  };

  const enhanceBgImage = async (file: File) => {
    const token = ++bgEnhanceTokenRef.current;
    setBgEnhance({ original: file, enhanced: null, status: "working", useEnhanced: false });
    let enhanced: File | null = null;
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const res = await fetch("/api/backgrounds/enhance", { method: "POST", body: form });
      if (res.status === 200) {
        const blob = await res.blob();
        enhanced = new File([blob], `${file.name.replace(/\.[^.]*$/, "") || "background"}-hd.jpg`, { type: "image/jpeg" });
      }
    } catch {
      enhanced = null;
    }
    if (token !== bgEnhanceTokenRef.current) return;
    if (!enhanced) {
      // Already sharp enough, or the upscaler is unavailable: the photo stays.
      setBgEnhance(null);
      return;
    }
    showBgImage(enhanced);
    setBgEnhance({ original: file, enhanced, status: "done", useEnhanced: true });
  };

  const toggleBgEnhanced = () => {
    if (!bgEnhance?.enhanced) return;
    const useEnhanced = !bgEnhance.useEnhanced;
    showBgImage(useEnhanced ? bgEnhance.enhanced : bgEnhance.original);
    setBgEnhance({ ...bgEnhance, useEnhanced });
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
    bgEnhanceTokenRef.current++;
    setBgEnhance(null);
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
    setRenderState("idle");
  };

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
        // Cut where the recording starts or ends (isHiddenPart): its parts
        // stay as they are; the timing editor's scissors split them further.
        const partial = pendingSegmentationData.find(
          (e) => e.surah === selectedSurah.id && e.ayah === verse.id && e.mappings?.some(isHiddenPart)
        );
        if (partial) return partial;
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
      showPageNotice(tx("لم يتم العثور على ترجمات للآيات المحددة.", "Seçili ayetler için çeviri bulunamadı.", "No translation found for the selected ayahs."));
    }
    setSegmentationProgress(null);
  };

  const handleClearSegmentation = async () => {
    // Only the split goes: where the reciter went back, the repeats stay
    // (see lib/readingPath.ts) -- an ayah he returned to must still show again.
    // An ayah the recording only partly contains keeps its hidden part(s)
    // (isHiddenPart); its visible parts merge back into one.
    const partial = pendingSegmentationData
      .filter((e) => e.mappings?.some(isHiddenPart))
      .map((e) => {
        const visible = e.mappings.filter((m: any) => !isHiddenPart(m) && typeof m.repeat_of_part !== "number");
        const merged = {
          word_count: visible.reduce((sum: number, m: any) => sum + m.word_count, 0),
          translation_text: visible.map((m: any) => m.translation_text).filter(Boolean).join(" "),
          isFirstOfAyah: true,
        };
        const kept: any[] = [];
        for (const m of e.mappings) {
          if (isHiddenPart(m)) kept.push(m);
          else if (!kept.includes(merged)) kept.push(merged);
        }
        return { ...e, mappings: kept.map((m, i) => ({ ...m, part: i + 1 })) };
      });
    const base = selectedSurah ? applyReadings([], preparedJsonData?.readings, readingAyahs(preparedJsonData), selectedSurah.id) : [];
    setPendingSegmentationData([
      ...base.filter((b: any) => !partial.some((p) => p.surah === b.surah && p.ayah === b.ayah)),
      ...partial,
    ]);
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
      shownVersesContent.map((verse) => ({ id: verse.id, words: preparedJsonData.verses[String(verse.id)]?.words ?? [] })),
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

    for (const verse of shownVersesContent) {
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
        if (isHiddenPart(mapping)) {
          partWordRange.set(mapping.part, { start: wordCursor, count: mapping.word_count });
          wordCursor += mapping.word_count;
          return;
        }
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

    // Seed the first/last segment's own boundary with the audio's current
    // trim -- they ARE its trim handles (see handleSaveTimingEditor), so
    // opening the panel doesn't move it. A cut applied with "قص الصوت الآن"
    // and never saved lives only in audioTrimStart/End: seeding from the
    // default trim or an older saved boundary instead showed the old cut
    // again on reopening, and the next cut or save put it back (2026-10-31).
    // Freshly prepared audio already carries the default trim window there
    // (see handlePrepareAudio); with no trim at all, the default window is
    // seeded as before, only where nothing was saved.
    const defaultTrim = defaultTrimFromTimings(preparedJsonData);
    const hasTrim = audioTrimStart > 0 || audioTrimEnd > 0;
    if (allSegments.length > 0) {
      const first = allSegments[0];
      const last = allSegments[allSegments.length - 1];
      const start = hasTrim ? audioTrimStart : !firstSegHasManualTiming ? defaultTrim?.start : undefined;
      const end = hasTrim && audioTrimEnd > 0 ? audioTrimEnd : !lastSegHasManualTiming ? defaultTrim?.end : undefined;
      if (start !== undefined && start < first.endSec) first.startSec = Math.max(0, start);
      if (end !== undefined) last.endSec = Math.max(last.startSec, end);
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
    for (const verse of shownVersesContent) {
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
      showPageNotice(
        tx("يجب تجهيز الصوت أولاً (زر «تجهيز الصوت») قبل ضبط التوقيت يدويًا.", "Zamanlamayı elle ayarlamadan önce sesi hazırlamanız gerekir (\"Sesi Hazırla\" düğmesi).", "You need to prepare the audio (\"Prepare Audio\" button) before adjusting the timing manually.")
      );
      return;
    }
    const wordMap = await ensureWordMapForAyahs(selectedVersesContent.map((v) => v.id));
    const segments = buildTimingEditorSegments(wordMap);
    if (!segments || segments.length === 0) {
      showPageNotice(
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
    setSegmentationProgress(null);
    setRenderProgress(null);

    const segmentationData = pendingSegmentationData.length > 0 ? pendingSegmentationData : null;
    // Follows the real render this download is running.
    const progressTimer = setInterval(async () => {
      const current = lastRealRenderRef.current;
      if (!current?.inFlight) return;
      const res = await fetch(`/api/video/render?id=${encodeURIComponent(current.renderId)}`).catch(() => null);
      if (!res?.ok || lastRealRenderRef.current !== current) return;
      const data = await res.json().catch(() => null);
      if (data && typeof data.progress === "number") setRenderProgress(data);
    }, 1000);

    try {
      // Queued behind any real render already in flight for this project
      // (see runSerializedRender/realRenderChainRef).
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
    // Lets the same file be picked again after "إلغاء" in the dialog.
    e.target.value = "";
    if (!file) return;
    guardAudioChange(() => {
      setCustomAudio(file);
      setRenderState("idle");
    });
  };

  // The video file is staged as-is -- no client-side ffmpeg round trip. The
  // backend's custom-audio extraction (extract_custom_clip) already decodes
  // straight from a video container via ffmpeg's `-vn`/faster-whisper's own
  // decoder, so pre-extracting to mp3 here would only add a redundant
  // upload+download+re-upload of the full file (painfully slow on mobile
  // uplinks) before "Prepare Audio" does the real work anyway.
  const handleVideoUploadForAudio = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    guardAudioChange(() => {
      setCustomAudio(file);
      setRenderState("idle");
    });
  };

  const handleAudioFromLink = (file: File) => {
    guardAudioChange(() => {
      setCustomAudio(file);
      setRenderState("idle");
    });
  };

  const removeCustomAudio = () => {
    guardAudioChange(() => {
      setCustomAudio(null);
      setRenderState("idle");
    });
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
    const apply = () => {
      setSelectedReciter(val);
      setReciterNameEdit(null);
    };
    if (val === selectedReciter) apply();
    else guardAudioChange(apply);
  };
  const onAudioSourceModeChange = (mode: "reciter" | "custom") => {
    const apply = () => {
      setAudioSourceMode(mode);
      setReciterNameEdit(null);
    };
    if (mode === audioSourceMode) apply();
    else guardAudioChange(apply);
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

          {/* A matched pair, directly under the header. Both wait while a
              video is being exported: leaving the project then would
              abandon that export. */}
          <div className="mx-auto flex w-full max-w-md items-stretch justify-center gap-3">
            <button
              type="button"
              onClick={handleStartOver}
              disabled={renderState === "rendering"}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-primary/40 px-4 py-2.5 text-sm font-medium text-primary transition-colors hover:border-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ArrowPathIcon className="h-4 w-4" />
              {tx("مشروع جديد", "Yeni Proje", "New Project")}
            </button>
            <button
              type="button"
              onClick={() => setShowProjects(true)}
              disabled={renderState === "rendering"}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-primary/30 hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FolderOpenIcon className="h-4 w-4" />
              {tx("مشاريعي", "Projelerim", "My Projects")}
            </button>
          </div>
          {/* One line, always the same height (the page doesn't jump): that
              the project is saved, or why not. */}
          <p
            aria-live="polite"
            className={`h-4 text-xs ${autosaveStatus === "error" ? "text-accent-red" : autosaveStatus === "saved" ? "text-accent-green" : "text-muted-foreground"}`}
          >
            {autosaveStatus === "error"
              ? tx("تعذر الحفظ التلقائي", "Otomatik kaydetme başarısız", "Autosave failed")
              : startOverNotice
                ? tx("حُفظ المشروع السابق في «مشاريعي».", "Önceki proje «Projelerim» bölümüne kaydedildi.", "The previous project is saved in “My Projects”.")
                : autosaveStatus === "saving"
                  ? tx("جارٍ الحفظ…", "Kaydediliyor…", "Saving…")
                  : autosaveStatus === "saved"
                    ? tx("✓ محفوظ", "✓ Kaydedildi", "✓ Saved")
                    : ""}
          </p>
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
                    isArabic={isArabic}
                    surahs={surahs}
                    surahTurkishNames={surahTurkishNames}
                    selectedSurah={selectedSurah}
                    setSelectedSurah={setSelectedSurah}
                    startVerse={startVerse}
                    setStartVerse={setStartVerse}
                    endVerse={endVerse}
                    setEndVerse={setEndVerse}
                    setRenderError={setRenderError}
                    setRenderState={setRenderState}
                    handleAddNextVerse={handleAddNextVerse}
                    handleRemoveLastVerse={handleRemoveLastVerse}
                    versesArray={versesArray}
                    selectedVersesContent={shownVersesContent}
                    canStartWithBasmala={canStartWithBasmala(selectedSurah?.id, startVerse)}
                    startsWithBasmala={startsWithBasmala}
                    onToggleBasmala={() => guardAudioChange(() => setIncludeBasmala(!startsWithBasmala))}
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
                    onAudioFromLink={handleAudioFromLink}
                    removeCustomAudio={removeCustomAudio}
                    handlePrepareAudio={handlePrepareAudio}
                    prepareError={audioPrepError}
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
            <div className="relative rounded-2xl p-4 sm:p-6 md:p-8 space-y-6 shadow-lg" dir="ltr">
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
                    {tx("تغيّرت الترجمة، فوُزِّعت الترجمة الجديدة تلقائيًا على أجزاء كل آية مقسَّمة. الآيات المعلَّمة بـ«يحتاج مراجعة» في قائمة الآيات قد يكون موضع القطع فيها غير دقيق، فراجعها في لوحة التوقيت.", "Çeviri değişti; yeni çeviri, bölümlenmiş her ayetin bölümlerine otomatik dağıtıldı. Ayet listesinde «Kontrol gerekli» işaretli ayetlerde kesme yeri tam doğru olmayabilir; Zamanlama panelinden kontrol edin.", "The translation changed; the new one was spread over each split ayah's segments automatically. Where the ayah list marks an ayah «Needs review», the cut may be off: check it in the Timing panel.")}
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
                lastDownload={renderState === "done" ? lastDownload : null}
                preparedAudioUrl={preparedAudioUrl}
                renderError={renderError}
                previewProps={displayedPreviewProps}
                previewVersion={previewVersion}
                isLoadingPreview={isLoadingPreview}
                previewError={previewError}
                suggestedTitle={suggestedTitle}
                renderProgress={renderProgress}
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
                    bgEnhanceState={
                      bgEnhance && (bgEnhance.status === "working" ? "working" : bgEnhance.useEnhanced ? "enhanced" : "original")
                    }
                    onToggleBgEnhanced={toggleBgEnhanced}
                    backgroundDim={backgroundDim}
                    onBackgroundDimChange={setBackgroundDim}
                    backgroundBlur={backgroundBlur}
                    onBackgroundBlurChange={setBackgroundBlur}
                    backgroundZoom={backgroundZoom}
                    onBackgroundZoomChange={setBackgroundZoom}
                    backgroundVignette={backgroundVignette}
                    onBackgroundVignetteChange={setBackgroundVignette}
                    surahId={selectedSurah?.id ?? null}
                    startVerse={startVerse}
                    endVerse={endVerse}
                  />
                }
                backgroundKind={bgVideoPreview ? "video" : bgPreview ? "image" : "none"}
              />

              {/* Inline unified audio-trim/timing panel -- CapCut-style:
                  lives directly below the video instead of a full-screen
                  modal, so the user can fix an audio/timing mismatch while
                  still seeing (and hearing) the preview. Its own first/last
                  segment boundaries double as the audio trim handles (see
                  SegmentTimingEditor.tsx's buildRegions); its toggle is
                  the last folding section's header in Step5Generate, right
                  above. */}
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
                // Nor does the reciter going back: a repeat (repeat_of_part)
                // is a second showing of a part, not a part -- counted as
                // one, an ayah he went back in kept this on "Bölümlemeyi
                // kaldır", whose click changed nothing, and the ayahs could
                // never be split (the user, 2026-11-16).
                const isSegmented = pendingSegmentationData.some(
                  (entry) =>
                    Array.isArray(entry.mappings) &&
                    entry.mappings.filter((m: any) => !isHiddenPart(m) && typeof m.repeat_of_part !== "number").length > 1
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
                  <div ref={timingPanelRef} className="scroll-mt-24 -mx-4 sm:mx-0">
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
                      textSchedule={timingEditorTextSchedule}
                    />
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      </div>

      {pageNotice && (
        <div role="status" className="fixed inset-x-0 bottom-4 z-[150] flex justify-center px-4" dir={isArabic ? "rtl" : "ltr"}>
          <div className="flex max-w-md animate-fade-in items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm text-foreground shadow-lg">
            <p className="flex-1 leading-relaxed">{pageNotice}</p>
            <button
              type="button"
              onClick={() => setPageNotice(null)}
              aria-label={tx("إغلاق", "Kapat", "Close")}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {showProjects && (
        <ProjectsDialog
          currentDraftId={draftId}
          surahs={surahs}
          onOpen={(id, isExport) => (isExport ? handleOpenExport(id) : handleOpenProject(id))}
          onClose={() => setShowProjects(false)}
        />
      )}

      {pendingAudioChange && (
        <AudioChangeDialog
          onNewProject={() => {
            setPendingAudioChange(null);
            continueInNewProject(pendingAudioChange.apply);
          }}
          onChangeHere={() => {
            setPendingAudioChange(null);
            pendingAudioChange.apply();
          }}
          onCancel={() => setPendingAudioChange(null)}
        />
      )}
    </>
  );
}
