"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/dist/plugins/regions.esm.js";
import {
  PlayIcon,
  PauseIcon,
  CheckIcon,
  XMarkIcon,
  ArrowUturnLeftIcon,
  ArrowUturnRightIcon,
  ScissorsIcon,
  PlusCircleIcon,
  MinusCircleIcon,
  TrashIcon,
  DocumentDuplicateIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  ArrowPathIcon,
} from "@heroicons/react/24/solid";
import Spinner from "@/components/ui/Spinner";
import type { ArabicFontKey } from "@/remotion/types";

// qcf1 ("الخط القديم") is the size users already find just right here; qcf2
// ("الخط الجديد") renders visibly BIGGER glyphs at the same font-size -- the
// exact inverse of why QuranVideo.tsx scales qcf1 UP by 1.15x for the real
// video (see ARABIC_FONT_OPTIONS.qcf1.sizeMultiplier's own comment in
// types.ts). So every arabicText size below picks a SMALLER literal
// Tailwind class for qcf2 specifically -- roughly qcf1's own size ÷ 1.15
// (~0.87x) -- rather than leaving both fonts sharing one size (too big for
// qcf2) or shrinking qcf1 too (already right, per the user). qcf1's classes
// are untouched from before.

export interface SegmentTimingInput {
  id: string;
  ayah: number;
  part: number;
  translation_text: string;
  arabicText?: string;
  // arabicText is QCF page-glyph text (Arabic Presentation Forms PUA
  // codepoints), not standard Unicode -- it renders as unreadable tofu
  // boxes under any generic font. `page` selects the matching 'pN'
  // @font-face already injected globally by VideoCreatorForm.tsx (same
  // convention used for the verse list itself).
  page?: number;
  startSec: number;
  endSec: number;
  // Count of REAL Uthmani words this segment covers -- NOT the number of
  // whitespace tokens in arabicText, which can be one higher for whichever
  // segment ends an ayah (the QCF ayah-number marker glyph, and mid-verse
  // waqf marks, are their own trailing whitespace token(s) in the page-glyph
  // text). Passed through explicitly and kept in sync by split/merge below
  // so the caller (VideoCreatorForm) never has to re-derive it by counting
  // arabicText tokens, which under-/over-counts real words whenever such a
  // marker is present.
  wordCount: number;
  // When set, this segment is a "repeat" of another segment (the reciter
  // said this same text again later in the audio, e.g. a teaching-style
  // recitation that repeats a phrase) -- its own translation_text/
  // arabicText/wordCount are never stored independently and are always
  // resolved live from the segment this id points to (see resolveContent),
  // so editing the original instantly updates every repeat of it. Only
  // startSec/endSec are independent per repeat.
  repeatOfId?: string;
  // A manually-added blank segment (free-typed text with no corresponding
  // Quran word range, wordCount 0) -- always appended at the very end of
  // the whole timeline, carved out of the current last segment's own tail
  // so no earlier segment's timing is ever affected. Only used to know
  // which segments are safe to delete via a plain "give the time back to
  // the previous segment" op instead of a repeat's parent-lookup removal.
  isBlank?: boolean;
  // Whether this segment shows the ayah number before its translation --
  // set once when the segment is first built (true only for the true first
  // chunk of the ayah) and then carried through duplicate/split/merge below,
  // instead of being re-derived from array position. This is what lets a
  // duplicated first-chunk segment keep its ayah number no matter where it
  // lands in the timeline.
  isFirstOfAyah?: boolean;
}

export interface SegmentTimingResult {
  id: string;
  ayah: number;
  part: number;
  startSec: number;
  endSec: number;
  isFirstOfAyah?: boolean;
  // Present so the caller can rebuild each ayah's mapping list (text +
  // word_count) from scratch based on the FULL returned segment set --
  // segments can now be split/merged/retitled inline in this editor, not
  // just retimed, so the set of segments handed back may no longer match
  // one-to-one with what was originally passed in.
  translation_text: string;
  arabicText?: string;
  // See SegmentTimingInput.wordCount -- the real word count, kept in sync
  // through every split/merge, for the caller to use as-is instead of
  // re-deriving it from arabicText.
  wordCount: number;
  // Session-local id (SegmentTimingInput.id) of the segment this one is a
  // duplicate of, when it is one. The caller (VideoCreatorForm) resolves
  // this into a stable, persistable `repeat_of_part` reference before
  // saving, since ids are regenerated fresh every time the editor reopens.
  repeatOfId?: string;
}

interface SegmentTimingEditorProps {
  audioUrl: string;
  ayahLabel: string;
  segments: SegmentTimingInput[];
  isArabic: boolean;
  onConfirm: (results: SegmentTimingResult[]) => void;
  onCancel: () => void;
  // Long-verse splitting now happens here instead of in the verse list --
  // one toggle button that either runs the AI auto-segmentation (when
  // nothing's segmented yet) or removes it entirely (when it is), so the
  // verse list can stay a plain read-only preview. Structural changes this
  // causes (segment count/boundaries changing under us) are picked up via
  // the `isSegmented`-keyed sync effect below, not a remount.
  isSegmented: boolean;
  isSegmenting: boolean;
  onToggleSegmentation: () => void;
  // Applies JUST the current trim boundaries (first segment's live start,
  // last segment's live end) immediately -- independent of "حفظ التوقيت"
  // below, which saves everything (trim + every segment's timing/text) at
  // once. Lets the user hear/see the trimmed result in the preview right
  // away without first finishing unrelated text/timing edits.
  onTrimOnly: (trimStart: number, trimEnd: number) => void;
  // Fired on Save, ONLY when a client-side cut (see applyTrimOnly) is
  // currently loaded -- hands the caller the cut audio blob plus how far
  // its own time 0 sits from `audioUrl`'s time 0, so the caller can persist
  // it server-side and reopen the editor with THIS shorter file next time
  // instead of the original (which otherwise silently "undoes" every cut
  // the instant the panel is closed and reopened -- see trimOffsetRef).
  onPersistTrimmedAudio?: (blob: Blob, sessionOffsetSeconds: number) => void;
  // Fired on every translation-text keystroke (not just on "حفظ التوقيت"),
  // so the live video preview updates instantly -- same spirit as
  // VideoPreviewPlayer's resize boxes, which patch the preview on every
  // drag tick instead of waiting for an explicit save. Identifies the
  // target mapping by (ayah, part) rather than this editor's own
  // session-local segment id, since that id is regenerated fresh every time
  // the editor reopens and means nothing to the caller. Only ever called
  // for a REAL segment (never a "repeat" one, which is read-only here and
  // has no translation_text of its own to edit -- see isRepeat below).
  onLiveTranslationEdit?: (ayah: number, part: number, text: string) => void;
  // Which Arabic verse script arabicText/page below are ALREADY resolved
  // against (see VideoCreatorForm's buildTimingEditorSegments/
  // sliceArabicForWordRange, which pick verse.text/.page or
  // verse.textV1/.pageV1 up front based on this same value) -- needed here
  // purely to pick the matching @font-face family PREFIX ('p' for qcf2,
  // 'pv1-' for qcf1; see ARABIC_FONT_OPTIONS' own comment in types.ts). The
  // actual @font-face rules themselves are declared globally by
  // Step1SurahVerse.tsx (always mounted alongside this), not here.
  arabicFont: ArabicFontKey;
  // Already-resolved CSS font-family string for the translation text (e.g.
  // "Inter, Arial, sans-serif") -- mirrors QuranVideo.tsx's own
  // resolvedTranslationFontFamily, computed once in VideoCreatorForm from
  // its translationFont/customTranslationFontUrl state. The @font-face
  // rules for it are likewise already declared globally by
  // Step1SurahVerse.tsx.
  translationFontFamily: string;
}

// Kept low-opacity (~0.12) so the waveform bars stay clearly visible
// through the tint, exactly like AudioTrimmer.tsx's single region — but
// cycled per segment (unlike AudioTrimmer, which only ever has one region)
// so adjacent segments are distinguishable by color at a glance, not just
// by their boundary line and number.
const REGION_PALETTE: { fill: string; badge: string }[] = [
  { fill: "rgba(180, 140, 70, 0.12)", badge: "rgba(180, 130, 50, 0.95)" },
  { fill: "rgba(70, 140, 190, 0.12)", badge: "rgba(45, 115, 170, 0.95)" },
  { fill: "rgba(150, 90, 190, 0.12)", badge: "rgba(125, 65, 170, 0.95)" },
  { fill: "rgba(70, 165, 120, 0.12)", badge: "rgba(45, 140, 95, 0.95)" },
  { fill: "rgba(195, 90, 90, 0.12)", badge: "rgba(180, 65, 65, 0.95)" },
  { fill: "rgba(175, 150, 55, 0.12)", badge: "rgba(155, 130, 35, 0.95)" },
];

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return mins > 0 ? `${mins}:${String(secs).padStart(2, "0")}.${ms}` : `${secs}.${ms}`;
}

// Copies just [startSec, endSec) out of a decoded buffer -- used to
// physically cut away the trimmed padding client-side (no backend/ffmpeg
// round trip) so the waveform can be reloaded with the shorter result.
function sliceAudioBuffer(ctx: AudioContext, buffer: AudioBuffer, startSec: number, endSec: number): AudioBuffer {
  const sampleRate = buffer.sampleRate;
  const startSample = Math.max(0, Math.min(buffer.length, Math.floor(startSec * sampleRate)));
  const endSample = Math.max(startSample, Math.min(buffer.length, Math.ceil(endSec * sampleRate)));
  const frameCount = Math.max(1, endSample - startSample);
  const sliced = ctx.createBuffer(buffer.numberOfChannels, frameCount, sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    sliced.copyToChannel(buffer.getChannelData(ch).subarray(startSample, startSample + frameCount), ch);
  }
  return sliced;
}

// Minimal PCM16 WAV encoder -- gives WaveSurfer a plain Blob URL to reload
// without depending on MediaRecorder/lossy codec availability.
function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const blockAlign = numChannels * 2;
  const dataSize = numFrames * blockAlign;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}

// A full, self-contained undo/redo point -- see the history refs inside the
// component for why this isn't a diff.
interface EditorSnapshot {
  segments: SegmentTimingInput[];
  audioSrc: string;
  trimOffset: number;
}

// Smallest a segment may ever be -- guarantees every segment stays
// independently visible/draggable and two segments can never end up pinned
// to the exact same instant (which caused their on-screen text to
// conflict/flicker against each other).
const MIN_REGION_WIDTH = 0.3;

export default function SegmentTimingEditor({
  audioUrl,
  ayahLabel,
  segments: initialSegments,
  isArabic,
  onConfirm,
  onCancel,
  isSegmented,
  isSegmenting,
  onToggleSegmentation,
  onTrimOnly,
  onPersistTrimmedAudio,
  onLiveTranslationEdit,
  arabicFont,
  translationFontFamily,
}: SegmentTimingEditorProps) {
  // See arabicFont's own comment above -- 'p{page}' for qcf2, 'pv1-{page}'
  // for qcf1, matching QuranVideo.tsx/Step1SurahVerse.tsx's own naming.
  const arabicFontFamilyPrefix = arabicFont === "qcf1" ? "pv1-" : "p";
  const containerRef = useRef<HTMLDivElement>(null);
  const [isReady, setIsReady] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [totalDuration, setTotalDuration] = useState<number>(0);
  const [zoom, setZoom] = useState<number>(0);
  // Segments can now be split/merged/retitled right here (not just
  // retimed), so the working set is local, mutable state seeded from the
  // prop rather than a fixed prop used directly.
  const [localSegments, setLocalSegments] = useState<SegmentTimingInput[]>(initialSegments);
  const splitCounterRef = useRef(0);
  const repeatCounterRef = useRef(0);

  // A repeat segment never stores its own translation_text/arabicText/
  // wordCount -- it always mirrors whatever its parent (repeatOfId)
  // currently holds, so editing the parent instantly updates every repeat
  // of it with zero propagation code. Falls back to the segment's own
  // (empty) fields if the parent was somehow removed.
  const resolveContent = useCallback(
    (seg: SegmentTimingInput): SegmentTimingInput => {
      if (!seg.repeatOfId) return seg;
      const parent = localSegments.find((s) => s.id === seg.repeatOfId);
      return parent
        ? { ...seg, translation_text: parent.translation_text, arabicText: parent.arabicText, wordCount: parent.wordCount, page: parent.page }
        : seg;
    },
    [localSegments]
  );

  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsPluginRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null);
  const regionsByIdRef = useRef<Map<string, Region>>(new Map());
  // Non-interactive dark overlays marking the audio OUTSIDE [boundaries[0],
  // boundaries[n]] -- i.e. exactly what gets trimmed away from the final
  // clip. Purely visual (never resized/dragged themselves); kept in sync
  // with the first/last segment's own draggable edge in the "update"
  // handler below, so it's immediately obvious which part of the waveform
  // is "in" vs "cut" instead of the trim boundary being just another
  // same-colored region edge with no distinguishing mark.
  const trimShadeRegionsRef = useRef<{ before: Region | null; after: Region | null }>({ before: null, after: null });
  // Live start/end per segment, kept in state purely to re-render the
  // duration badges below the waveform as the user drags — the source of
  // truth for saving is always read directly off the Region objects.
  const [liveBounds, setLiveBounds] = useState<Record<string, { start: number; end: number }>>({});
  // Drives the live preview panel: whichever segment's [start, end) the
  // playhead currently sits inside, and whether audio is playing at all
  // (shared by the per-segment play buttons and the dedicated preview
  // button below -- they're both just wavesurfer play/pause under the hood).
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  // Drives the "Sesi Şimdi Kes" client-side trim: cuts the loaded audio down
  // to just [trimStart, trimEnd] and reloads the waveform with the result
  // (see applyTrimOnly), instead of only forwarding the numbers upward and
  // leaving this editor's own waveform/cursor showing the untouched file.
  const [isTrimming, setIsTrimming] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  // The ORIGINAL (never-trimmed) decoded buffer for `audioUrl` -- every cut
  // re-slices from this, never from a previously-cut/re-encoded blob, so
  // repeated trims don't compound WAV re-encoding loss.
  const originalBufferRef = useRef<AudioBuffer | null>(null);
  // How far the currently-loaded buffer's time 0 sits inside the ORIGINAL
  // file -- lets every region position (always expressed relative to
  // whatever's currently loaded) be converted back to the absolute
  // coordinates the parent/render pipeline actually needs.
  const trimOffsetRef = useRef<number>(0);
  // Every blob URL created by a cut this session -- NOT revoked as each new
  // cut supersedes the last, because undo/redo (see history refs below)
  // must be able to reload an EARLIER cut's blob at any point, not just the
  // latest one. All revoked together on unmount or when a genuinely new
  // audioUrl prop arrives (see the creation effect's reset block).
  const blobUrlsRef = useRef<Set<string>>(new Set());
  // Segments to rebuild regions from once the just-triggered ws.load(...)
  // fires "ready" -- the ready handler otherwise always falls back to the
  // ORIGINAL `initialSegments` prop, which would silently discard the trim/
  // rebase just performed.
  const pendingSegmentsAfterLoadRef = useRef<SegmentTimingInput[] | null>(null);

  // Undo/redo history for every edit made to the waveform (drags, splits,
  // word shifts, duplicate/move/remove/reset, and "Sesi Şimdi Kes" cuts).
  // Each snapshot is a full, self-contained state -- not a diff -- since a
  // cut changes the loaded audio itself (not just region positions), so
  // restoring one may need to reload a different (or the original) source.
  const localSegmentsRef = useRef<SegmentTimingInput[]>(initialSegments);
  useEffect(() => {
    localSegmentsRef.current = localSegments;
  }, [localSegments]);
  // Whatever's currently loaded into WaveSurfer -- the ORIGINAL audioUrl
  // prop until the first client-side cut, a blob URL after that. Lets
  // restoreSnapshot skip the reload entirely when a snapshot's audio
  // matches what's already playing (the common case: undoing/redoing a
  // plain drag never touches the audio).
  const currentAudioSrcRef = useRef<string>(audioUrl);
  const lastCommittedRef = useRef<EditorSnapshot>({ segments: initialSegments, audioSrc: audioUrl, trimOffset: 0 });
  const undoStackRef = useRef<EditorSnapshot[]>([]);
  const redoStackRef = useRef<EditorSnapshot[]>([]);
  const [historyVersion, setHistoryVersion] = useState(0);

  // Reads exactly what's on screen right now (segment metadata + LIVE
  // region positions) -- the same pattern every structural edit below
  // already used inline to build its own "next" array, now shared so
  // history snapshots and those edits never disagree about "current state".
  const captureLiveSegments = useCallback((): SegmentTimingInput[] => {
    return localSegmentsRef.current.map((s) => {
      const r = regionsByIdRef.current.get(s.id);
      return r ? { ...s, startSec: r.start, endSec: r.end } : s;
    });
  }, []);

  // Records the state as it was BEFORE an edit (== whatever was last
  // committed) onto the undo stack, then advances the committed baseline to
  // `next`. Call this right before applying any edit, structural or drag.
  const commitChange = useCallback((next: SegmentTimingInput[], audioSrc?: string, trimOffset?: number) => {
    undoStackRef.current.push(lastCommittedRef.current);
    redoStackRef.current = [];
    lastCommittedRef.current = {
      segments: next,
      audioSrc: audioSrc ?? lastCommittedRef.current.audioSrc,
      trimOffset: trimOffset ?? lastCommittedRef.current.trimOffset,
    };
    setHistoryVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    if (!wsRef.current || !isReady) return;
    // isReady tracks OUR state, which can still be a render behind
    // WaveSurfer's own internal "audio loaded" flag right as a reload
    // starts (applyTrimOnly/restoreSnapshot) -- catch rather than let a
    // stale-timing call to .zoom() throw an uncaught "No audio loaded" and
    // crash the whole panel; the next isReady flip re-runs this anyway.
    try {
      wsRef.current.zoom(zoom);
    } catch (err) {
      console.warn("WaveSurfer zoom skipped (audio not loaded yet):", err);
    }
  }, [zoom, isReady]);

  // (Re)creates every region from scratch for the given segment list --
  // called on initial load AND after every split/merge, since the segment
  // count itself can change (unlike a plain drag, which only ever moves
  // existing regions). Rebuilding fresh each time keeps every region's
  // "update" handler closure correctly bound to the CURRENT neighbor list,
  // instead of risking a stale reference to a segment that just got
  // split/merged away.
  const buildRegions = useCallback((segs: SegmentTimingInput[]) => {
    const ws = wsRef.current;
    const regions = regionsPluginRef.current;
    if (!ws || !regions) return;

    regionsByIdRef.current.forEach((r) => r.remove());
    regionsByIdRef.current.clear();
    trimShadeRegionsRef.current.before?.remove();
    trimShadeRegionsRef.current.after?.remove();
    trimShadeRegionsRef.current = { before: null, after: null };

    const duration = ws.getDuration();
    const n = segs.length;
    if (n === 0) return;

    // Every instant WITHIN THE CLIP'S SELECTED RANGE must be covered by
    // exactly one segment's on-screen text -- no silent gaps, no overlaps.
    // Model this as n+1 shared boundary points: boundaries[0] and
    // boundaries[n] start out at the first/last segment's own
    // startSec/endSec (VideoCreatorForm seeds these with the same
    // smart-default trim margins the old standalone AudioTrimmer used --
    // slightly before the first detected word, slightly after the last),
    // NOT hard-pinned to 0/`duration` -- this doubles as the audio
    // trim tool: whatever's outside [boundaries[0], boundaries[n]] is the
    // padding that gets cut from the final clip (see the "update" handler
    // below, which lets the user drag these two same as any other
    // boundary). EVERY boundary -- including the two outer ones and any
    // between two different ayahs -- is free, and once resolved below is
    // always dragged as a single linked point from either side so
    // neighboring segments can never shrink past MIN_REGION_WIDTH or leave
    // a gap between them. A manually-dragged verse-to-verse boundary is
    // honored by render/route.ts too (VideoCreatorForm saves it on both
    // sides of the boundary), so there's no render-time wall to lock any
    // of this to.
    const boundaries: number[] = new Array(n + 1);
    const trimStart = Math.max(0, Math.min(segs[0].startSec, duration));
    const trimEnd = Math.max(trimStart, Math.min(segs[n - 1].endSec, duration));
    boundaries[0] = trimStart;
    boundaries[n] = trimEnd;
    const span = trimEnd - trimStart;
    const rawWidths = segs.map((s) => Math.max(0, s.endSec - s.startSec));
    const rawTotal = rawWidths.reduce((a, b) => a + b, 0);
    let widths = rawTotal > 0 && span > 0
      ? rawWidths.map((w) => (w / rawTotal) * span)
      : new Array(n).fill(span / n);
    const minW = Math.min(MIN_REGION_WIDTH, span / n);
    widths = widths.map((w) => Math.max(minW, w));
    const widthSum = widths.reduce((a, b) => a + b, 0);
    if (widthSum > 0) widths = widths.map((w) => (w / widthSum) * span);
    let cursor = trimStart;
    for (let k = 0; k < n; k++) {
      cursor += widths[k];
      boundaries[k + 1] = k === n - 1 ? trimEnd : cursor;
    }

    // Dark, non-interactive shading over whatever falls outside the trim
    // range -- makes it immediately visible (not just theoretically
    // possible) that dragging the very first/last segment's edge trims the
    // clip. Only created when there's actually something to shade on that
    // side (trimStart/trimEnd sitting past the file's own edge already).
    // Created BEFORE the segment regions below so they paint underneath --
    // otherwise, sitting on top at the exact shared boundary pixel, they'd
    // visually and interactively cover the adjacent segment's own resize
    // handle at that same point, making it impossible to grab.
    trimShadeRegionsRef.current.before = trimStart > 0.01
      ? regions.addRegion({ start: 0, end: trimStart, color: "rgba(20, 15, 5, 0.55)", drag: false, resize: false })
      : null;
    trimShadeRegionsRef.current.after = trimEnd < duration - 0.01
      ? regions.addRegion({ start: trimEnd, end: duration, color: "rgba(20, 15, 5, 0.55)", drag: false, resize: false })
      : null;

    const initialLive: Record<string, { start: number; end: number }> = {};
    segs.forEach((seg, idx) => {
      const start = boundaries[idx];
      const end = boundaries[idx + 1];

      // Small corner badge, NOT a full-width/full-height bar -- absolute
      // positioning keeps it out of the way of the waveform bars
      // underneath instead of stretching to fill the region (which is
      // what made the whole strip look like a solid gray band before).
      const label = document.createElement("div");
      label.textContent = `${seg.ayah}:${seg.part}`;
      label.style.cssText =
        "position:absolute;top:2px;left:2px;font-size:10px;font-weight:700;padding:1px 5px;color:#fff;background:rgba(0,0,0,0.5);border-radius:5px;line-height:1.4;white-space:nowrap;pointer-events:none;";

      const r = regions.addRegion({
        id: seg.id,
        start,
        end,
        color: REGION_PALETTE[idx % REGION_PALETTE.length].fill,
        drag: false,
        resize: true,
        content: label,
      });

      regionsByIdRef.current.set(seg.id, r);
      initialLive[seg.id] = { start, end };

      // Fires continuously while dragging (not just on release). Every
      // boundary this segment shares with a neighbor is moved as a single
      // linked point -- see the big comment above the boundary computation
      // for why (no gaps, no overlaps). The first segment's start and the
      // last segment's end are the audio TRIM points -- clamped against the
      // absolute file edges (0/`duration`) instead of a neighboring
      // segment, but otherwise just as freely draggable as any interior
      // boundary; whatever ends up outside them is the padding trimmed
      // from the final clip (see handleSaveTimingEditor in
      // VideoCreatorForm.tsx, which reads them straight off the first/last
      // result's startSec/endSec).
      r.on("update", (side?: "start" | "end") => {
        if (side === "start") {
          if (idx === 0) {
            const ceil = r.end - MIN_REGION_WIDTH;
            const clamped = Math.min(Math.max(r.start, 0), ceil);
            if (clamped !== r.start) r.setOptions({ start: clamped });
            // Keep the "cut" shading glued to this same edge while dragging.
            const shades = trimShadeRegionsRef.current;
            if (clamped > 0.01) {
              if (shades.before) {
                shades.before.setOptions({ end: clamped });
              } else if (regionsPluginRef.current) {
                shades.before = regionsPluginRef.current.addRegion({
                  start: 0, end: clamped, color: "rgba(20, 15, 5, 0.55)", drag: false, resize: false,
                });
              }
            } else if (shades.before) {
              shades.before.remove();
              shades.before = null;
            }
          } else {
            const prevSeg = segs[idx - 1];
            const prevRegion = regionsByIdRef.current.get(prevSeg.id);
            if (prevRegion) {
              const floor = prevRegion.start + MIN_REGION_WIDTH;
              const ceil = r.end - MIN_REGION_WIDTH;
              const clamped = Math.min(Math.max(r.start, floor), ceil);
              if (clamped !== r.start) r.setOptions({ start: clamped });
              if (prevRegion.end !== clamped) {
                prevRegion.setOptions({ end: clamped });
                setLiveBounds((prev) => ({ ...prev, [prevSeg.id]: { start: prevRegion.start, end: clamped } }));
              }
            }
          }
        } else if (side === "end") {
          if (idx === n - 1) {
            const floor = r.start + MIN_REGION_WIDTH;
            const clamped = Math.max(Math.min(r.end, duration), floor);
            if (clamped !== r.end) r.setOptions({ end: clamped });
            // Keep the "cut" shading glued to this same edge while dragging.
            const shades = trimShadeRegionsRef.current;
            if (clamped < duration - 0.01) {
              if (shades.after) {
                shades.after.setOptions({ start: clamped });
              } else if (regionsPluginRef.current) {
                shades.after = regionsPluginRef.current.addRegion({
                  start: clamped, end: duration, color: "rgba(20, 15, 5, 0.55)", drag: false, resize: false,
                });
              }
            } else if (shades.after) {
              shades.after.remove();
              shades.after = null;
            }
          } else {
            const nextSeg = segs[idx + 1];
            const nextRegion = regionsByIdRef.current.get(nextSeg.id);
            if (nextRegion) {
              const ceil = nextRegion.end - MIN_REGION_WIDTH;
              const floor = r.start + MIN_REGION_WIDTH;
              const clamped = Math.max(Math.min(r.end, ceil), floor);
              if (clamped !== r.end) r.setOptions({ end: clamped });
              if (nextRegion.start !== clamped) {
                nextRegion.setOptions({ start: clamped });
                setLiveBounds((prev) => ({ ...prev, [nextSeg.id]: { start: clamped, end: nextRegion.end } }));
              }
            }
          }
        }
        setLiveBounds((prev) => ({ ...prev, [seg.id]: { start: r.start, end: r.end } }));
      });

      r.on("play", () => setPlayingId(seg.id));
    });

    setLiveBounds(initialLive);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    // A genuinely new source file -- any cached decode/offset from
    // client-side cuts made on the PREVIOUS audioUrl no longer applies.
    originalBufferRef.current = null;
    trimOffsetRef.current = 0;
    blobUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    blobUrlsRef.current = new Set();
    currentAudioSrcRef.current = audioUrl;
    lastCommittedRef.current = { segments: initialSegments, audioSrc: audioUrl, trimOffset: 0 };
    undoStackRef.current = [];
    redoStackRef.current = [];
    setHistoryVersion((v) => v + 1);

    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: "rgba(180, 140, 70, 0.3)",
      progressColor: "rgba(180, 130, 50, 0.9)",
      cursorColor: "#000",
      cursorWidth: 2,
      barWidth: 2,
      barGap: 2,
      barRadius: 2,
      height: 120,
      normalize: true,
    });

    const regions = ws.registerPlugin(RegionsPlugin.create());
    wsRef.current = ws;
    regionsPluginRef.current = regions;

    // Fires exactly once per completed drag/resize gesture (never for the
    // programmatic setOptions() calls the "update" handler below uses for
    // clamping/syncing) -- the right granularity to commit one undo step
    // per user edit, not one per mousemove tick. Still fires for a plain
    // click with no actual movement though, so skip the commit when
    // nothing about the positions actually changed -- otherwise "تراجع"
    // would visibly do nothing on its top entry (before/after identical)
    // while still consuming a stack slot and wiping the redo stack.
    regions.on("region-updated", () => {
      const next = captureLiveSegments();
      const prev = lastCommittedRef.current.segments;
      const changed =
        next.length !== prev.length ||
        next.some((s, i) => Math.abs(s.startSec - prev[i].startSec) > 0.001 || Math.abs(s.endSec - prev[i].endSec) > 0.001);
      if (changed) commitChange(next);
    });

    ws.on("ready", () => {
      setIsReady(true);
      setTotalDuration(ws.getDuration());
      const pending = pendingSegmentsAfterLoadRef.current;
      pendingSegmentsAfterLoadRef.current = null;
      buildRegions(pending ?? initialSegments);
    });

    // Live preview: whichever segment currently contains the playhead is the
    // one that would be showing on-screen at this instant in the final video
    // (same [start, end) boundaries that get saved). Checked against the
    // LIVE regions map directly (rebuilt fresh on every split/merge), so it
    // stays accurate through both dragging and structural edits.
    ws.on("timeupdate", (time) => {
      let found: string | null = null;
      for (const [segId, r] of regionsByIdRef.current.entries()) {
        if (time >= r.start && time < r.end) {
          found = segId;
          break;
        }
      }
      setActiveSegmentId((prev) => (prev === found ? prev : found));
    });

    ws.on("play", () => setIsPlaying(true));
    ws.on("pause", () => {
      setIsPlaying(false);
      setPlayingId(null);
    });
    ws.on("finish", () => {
      setIsPlaying(false);
      setPlayingId(null);
      setActiveSegmentId(null);
    });

    ws.load(audioUrl).catch((err) => {
      if (err.name !== "AbortError") {
        console.error("WaveSurfer load error:", err);
      }
    });

    return () => {
      ws.destroy();
      regionsByIdRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl]);

  useEffect(() => {
    return () => {
      blobUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      audioContextRef.current?.close().catch(() => {});
    };
  }, []);

  // Auto-segmentation ("تقسيم الآيات الطويلة") structurally replaces the
  // whole segment set once the AI call resolves -- re-sync in place (same
  // wavesurfer instance, same loaded audio, just fresh regions) instead of
  // the caller fully unmounting/remounting this component, which used to
  // tear down and reload the waveform from scratch (a jarring "starting
  // over" flash) for what's actually just a structural update to an
  // already-loaded clip. Triggered strictly off `isSegmented` flipping, not
  // the `segments` prop itself, since that prop is a fresh array on every
  // parent render and would otherwise fire this on every keystroke
  // elsewhere in the app, stomping any drag/edit in progress here.
  const lastSyncedIsSegmentedRef = useRef(isSegmented);
  useEffect(() => {
    if (lastSyncedIsSegmentedRef.current === isSegmented) return;
    lastSyncedIsSegmentedRef.current = isSegmented;
    if (!isReady) return;
    commitChange(initialSegments);
    setLocalSegments(initialSegments);
    buildRegions(initialSegments);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSegmented, isReady]);

  // Same reasoning/pattern as the isSegmented sync right above -- but for
  // arabicFont specifically. VideoCreatorForm recomputes arabicText/page for
  // every segment on the CURRENTLY selected font on every render
  // (buildTimingEditorSegments), so `initialSegments` already carries the
  // right font's text/page the instant arabicFont changes -- but localSegments
  // only ever adopts a fresh `initialSegments` snapshot wholesale when
  // isSegmented flips, so leaving the panel open across an old/new font
  // switch left every segment showing the PREVIOUS font's page number and
  // PUA codepoints under the NEW font's @font-face family (arabicFontFamilyPrefix
  // itself DOES update live, since it just reads the arabicFont prop
  // directly) -- codepoints that family's font file was never given glyphs
  // for at that page, rendering as tofu going old->new, or nothing at all
  // going new->old. Merges in just `arabicText`/`page` by segment id instead
  // of replacing localSegments wholesale, so timing bounds/translation edits/
  // splits/repeats made during this session are left completely untouched
  // (a repeat segment always displays its parent's arabicText/page via
  // resolveContent, so fixing the parent's entry here is enough to fix the
  // repeat's own display too). A session-local segment with no counterpart
  // in the freshly rebuilt `initialSegments` (a manually duplicated/blank
  // one) simply has nothing to merge in and is left as-is.
  const lastSyncedArabicFontRef = useRef(arabicFont);
  useEffect(() => {
    if (lastSyncedArabicFontRef.current === arabicFont) return;
    lastSyncedArabicFontRef.current = arabicFont;
    setLocalSegments((prev) =>
      prev.map((seg) => {
        const fresh = initialSegments.find((s) => s.id === seg.id);
        return fresh ? { ...seg, arabicText: fresh.arabicText, page: fresh.page } : seg;
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arabicFont]);

  const playSegment = useCallback(
    (id: string) => {
      const region = regionsByIdRef.current.get(id);
      if (!region || !wsRef.current) return;
      if (playingId === id) {
        wsRef.current.pause();
        setPlayingId(null);
      } else {
        region.play(true);
      }
    },
    [playingId]
  );

  // Plays the WHOLE clip straight through (not one region at a time) with
  // the live preview panel switching text exactly when the real video would
  // -- letting the user verify the full result in seconds instead of
  // waiting on a full render.
  const togglePreview = useCallback(() => {
    const ws = wsRef.current;
    if (!ws) return;
    if (isPlaying) {
      ws.pause();
    } else {
      if (ws.getCurrentTime() >= totalDuration - 0.05) {
        ws.setTime(0);
      }
      ws.play();
    }
  }, [isPlaying, totalDuration]);

  // Splits one segment into two roughly even halves by word count (first
  // half keeps the larger share on an odd count). Each half's time range is
  // proportional to how many of the original words it keeps; the shared
  // boundary is still freely draggable afterward like any other. The second
  // half's translation starts EMPTY -- there's no reliable way to guess
  // where in the Turkish sentence the split should fall, so the user
  // redistributes the wording themselves via the inline text field below.
  const splitSegment = useCallback((id: string) => {
    const idx = localSegments.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const seg = localSegments[idx];
    const region = regionsByIdRef.current.get(id);
    const start = region ? region.start : seg.startSec;
    const end = region ? region.end : seg.endSec;

    const words = (seg.arabicText || "").trim().split(/\s+/).filter(Boolean);
    if (words.length < 2) return;
    if (end - start < MIN_REGION_WIDTH * 2) return;

    const splitIdx = Math.ceil(words.length / 2);
    const firstWords = words.slice(0, splitIdx);
    const secondWords = words.slice(splitIdx);

    const perWordShare = (end - start) / words.length;
    const boundary = Math.min(
      end - MIN_REGION_WIDTH,
      Math.max(start + MIN_REGION_WIDTH, start + perWordShare * splitIdx)
    );

    splitCounterRef.current += 1;
    const suffix = splitCounterRef.current;

    const first: SegmentTimingInput = {
      ...seg,
      id: `${seg.id}-split${suffix}a`,
      arabicText: firstWords.join(" "),
      wordCount: firstWords.length,
      startSec: start,
      endSec: boundary,
    };
    const second: SegmentTimingInput = {
      ...seg,
      id: `${seg.id}-split${suffix}b`,
      arabicText: secondWords.join(" "),
      wordCount: secondWords.length,
      translation_text: "",
      startSec: boundary,
      endSec: end,
      // The second half never carries the ayah number -- only whichever
      // half keeps the ayah's opening words should.
      isFirstOfAyah: false,
    };

    const next = localSegments.map((s) => {
      const r = regionsByIdRef.current.get(s.id);
      return r ? { ...s, startSec: r.start, endSec: r.end } : s;
    });
    next.splice(idx, 1, first, second);
    commitChange(next);
    setLocalSegments(next);
    buildRegions(next);
  }, [localSegments, buildRegions, commitChange]);

  // Pulls the NEXT segment's first word into this one (same ayah only) --
  // the "+" counterpart of the old word_count adjustment. Only touches
  // which TEXT belongs to which segment, not the timing boundary between
  // them (that's still whatever the user drags on the waveform
  // separately). If the next segment is left with no words at all, it's
  // absorbed entirely: its translation text merges in and its time range
  // extends to cover what was the next segment's, since an empty segment
  // has nowhere else to keep its slot in the timeline.
  const addWordFromNext = useCallback((id: string) => {
    const idx = localSegments.findIndex((s) => s.id === id);
    if (idx === -1 || idx >= localSegments.length - 1) return;
    const seg = localSegments[idx];
    const nextSeg = localSegments[idx + 1];
    if (nextSeg.ayah !== seg.ayah) return;

    const nextWords = (nextSeg.arabicText || "").trim().split(/\s+/).filter(Boolean);
    if (nextWords.length === 0) return;
    const curWords = (seg.arabicText || "").trim().split(/\s+/).filter(Boolean);
    const newCurArabic = [...curWords, nextWords[0]].join(" ");
    const remainingNextWords = nextWords.slice(1);

    const next = localSegments.map((s) => {
      const r = regionsByIdRef.current.get(s.id);
      return r ? { ...s, startSec: r.start, endSec: r.end } : s;
    });
    if (remainingNextWords.length === 0) {
      const nextRegion = regionsByIdRef.current.get(nextSeg.id);
      const end = nextRegion ? nextRegion.end : nextSeg.endSec;
      next.splice(idx, 2, {
        ...next[idx],
        arabicText: newCurArabic,
        wordCount: seg.wordCount + nextSeg.wordCount,
        translation_text: [seg.translation_text, nextSeg.translation_text].filter(Boolean).join(" "),
        endSec: end,
      });
    } else {
      next[idx] = { ...next[idx], arabicText: newCurArabic, wordCount: seg.wordCount + 1 };
      next[idx + 1] = { ...next[idx + 1], arabicText: remainingNextWords.join(" "), wordCount: nextSeg.wordCount - 1 };
    }
    commitChange(next);
    setLocalSegments(next);
    buildRegions(next);
  }, [localSegments, buildRegions, commitChange]);

  // Gives this segment's LAST word back to the next one (same ayah only) --
  // the "-" counterpart, mirroring addWordFromNext. If this segment is left
  // with no words at all, it's absorbed into the next one entirely (its
  // translation text merges in, prepended since it came first; the next
  // segment's range extends backward to cover what was this segment's).
  const returnWordToNext = useCallback((id: string) => {
    const idx = localSegments.findIndex((s) => s.id === id);
    if (idx === -1 || idx >= localSegments.length - 1) return;
    const seg = localSegments[idx];
    const nextSeg = localSegments[idx + 1];
    if (nextSeg.ayah !== seg.ayah) return;

    const curWords = (seg.arabicText || "").trim().split(/\s+/).filter(Boolean);
    if (curWords.length === 0) return;
    const givenWord = curWords[curWords.length - 1];
    const remainingCurWords = curWords.slice(0, -1);
    const nextWords = (nextSeg.arabicText || "").trim().split(/\s+/).filter(Boolean);
    const newNextArabic = [givenWord, ...nextWords].join(" ");

    const next = localSegments.map((s) => {
      const r = regionsByIdRef.current.get(s.id);
      return r ? { ...s, startSec: r.start, endSec: r.end } : s;
    });
    if (remainingCurWords.length === 0) {
      const region = regionsByIdRef.current.get(seg.id);
      const start = region ? region.start : seg.startSec;
      next.splice(idx, 2, {
        ...next[idx + 1],
        arabicText: newNextArabic,
        wordCount: seg.wordCount + nextSeg.wordCount,
        translation_text: [seg.translation_text, nextSeg.translation_text].filter(Boolean).join(" "),
        startSec: start,
        // seg (being absorbed) may itself be the ayah's first chunk -- don't
        // let that get silently dropped just because the merge spreads from
        // nextSeg's object.
        isFirstOfAyah: seg.isFirstOfAyah || nextSeg.isFirstOfAyah,
      });
    } else {
      next[idx] = { ...next[idx], arabicText: remainingCurWords.join(" "), wordCount: seg.wordCount - 1 };
      next[idx + 1] = { ...next[idx + 1], arabicText: newNextArabic, wordCount: nextSeg.wordCount + 1 };
    }
    commitChange(next);
    setLocalSegments(next);
    buildRegions(next);
  }, [localSegments, buildRegions, commitChange]);

  // Inserts a "repeat" of this segment right after it -- same text/content
  // (mirrored live via resolveContent, never copied), independent timing.
  // Disabled entirely for a segment that is itself already a repeat (no
  // repeat-of-repeat chains -- keeps the model simple: repeats always point
  // directly at a "real" segment).
  const duplicateSegment = useCallback((id: string) => {
    const idx = localSegments.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const seg = localSegments[idx];
    if (seg.repeatOfId) return;

    repeatCounterRef.current += 1;
    const newSeg: SegmentTimingInput = {
      ...seg,
      id: `${seg.id}-repeat${repeatCounterRef.current}`,
      repeatOfId: seg.id,
    };

    const next = localSegments.map((s) => {
      const r = regionsByIdRef.current.get(s.id);
      return r ? { ...s, startSec: r.start, endSec: r.end } : s;
    });
    next.splice(idx + 1, 0, newSeg);
    commitChange(next);
    setLocalSegments(next);
    buildRegions(next);
  }, [localSegments, buildRegions, commitChange]);

  // Swaps this segment with its neighbor in the sequence -- the mechanism
  // for placing a freshly-duplicated repeat at its correct position in the
  // timeline (segments are always played back in array order, so moving a
  // repeat past the segments that come between it and its real position in
  // the recording is how the user tells the editor "the reciter said this
  // again HERE").
  const moveSegment = useCallback((id: string, direction: -1 | 1) => {
    const idx = localSegments.findIndex((s) => s.id === id);
    const targetIdx = idx + direction;
    if (idx === -1 || targetIdx < 0 || targetIdx >= localSegments.length) return;

    const next = localSegments.map((s) => {
      const r = regionsByIdRef.current.get(s.id);
      return r ? { ...s, startSec: r.start, endSec: r.end } : s;
    });
    [next[idx], next[targetIdx]] = [next[targetIdx], next[idx]];
    commitChange(next);
    setLocalSegments(next);
    buildRegions(next);
  }, [localSegments, buildRegions, commitChange]);

  // Removes a repeat or a manually-added blank segment -- there's no
  // general-purpose delete for an original/AI-derived segment, out of
  // scope here. A blank segment gives its time back to whichever segment
  // comes right before it (instead of a full proportional rebuild); a
  // repeat is just dropped and the rest reflows normally (matching how
  // duplicateSegment already redistributes on creation).
  const removeSegment = useCallback((id: string) => {
    const idx = localSegments.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const seg = localSegments[idx];
    if (!seg.repeatOfId && !seg.isBlank) return;

    const current = localSegments.map((s) => {
      const r = regionsByIdRef.current.get(s.id);
      return r ? { ...s, startSec: r.start, endSec: r.end } : s;
    });

    let next: SegmentTimingInput[];
    if (seg.isBlank && idx > 0) {
      const removedEnd = current[idx].endSec;
      next = current.filter((_, i) => i !== idx);
      next[idx - 1] = { ...next[idx - 1], endSec: removedEnd };
    } else {
      next = current.filter((_, i) => i !== idx);
    }
    commitChange(next);
    setLocalSegments(next);
    buildRegions(next);
  }, [localSegments, buildRegions, commitChange]);

  const updateTranslationText = useCallback((id: string, text: string) => {
    setLocalSegments((prev) => {
      const seg = prev.find((s) => s.id === id);
      // Live-patch the actual video preview immediately, same as every
      // other live control here -- (ayah, part) is this segment's CURRENT
      // position, which only stays valid until the next structural edit
      // (split/merge/reorder) is confirmed; onLiveTranslationEdit is purely
      // a preview nicety, "حفظ التوقيت" remains the authoritative save.
      if (seg) onLiveTranslationEdit?.(seg.ayah, seg.part, text);
      return prev.map((s) => (s.id === id ? { ...s, translation_text: text } : s));
    });
  }, [onLiveTranslationEdit]);

  const handleConfirm = () => {
    // Region positions are relative to whatever's CURRENTLY loaded, which
    // after one or more client-side cuts (see applyTrimOnly) is no longer
    // the original file -- shift back to original-file-absolute coordinates
    // via trimOffsetRef, since that's the frame the parent/render pipeline
    // expects (it re-crops the ORIGINAL prepared audio, not this preview).
    const results: SegmentTimingResult[] = localSegments.map((seg) => {
      const resolved = resolveContent(seg);
      const region = regionsByIdRef.current.get(seg.id);
      const start = (region ? region.start : seg.startSec) + trimOffsetRef.current;
      const end = (region ? region.end : seg.endSec) + trimOffsetRef.current;
      return {
        id: seg.id,
        ayah: seg.ayah,
        part: seg.part,
        startSec: start,
        endSec: end,
        translation_text: resolved.translation_text,
        arabicText: resolved.arabicText,
        wordCount: resolved.wordCount,
        isFirstOfAyah: seg.isFirstOfAyah,
        repeatOfId: seg.repeatOfId,
      };
    });

    // A client-side cut is currently loaded (audioUrl prop is still the
    // ORIGINAL file, but WaveSurfer has a cut blob loaded instead) -- hand
    // it off to be persisted, in parallel with onConfirm below, so it
    // survives this panel unmounting instead of only living in a Blob URL
    // that's gone the moment React tears this component down.
    if (currentAudioSrcRef.current !== audioUrl && onPersistTrimmedAudio) {
      const sessionOffset = trimOffsetRef.current;
      fetch(currentAudioSrcRef.current)
        .then((r) => r.blob())
        .then((blob) => onPersistTrimmedAudio(blob, sessionOffset))
        .catch((err) => console.error("Failed to hand off trimmed audio for persistence:", err));
    }

    onConfirm(results);
  };

  // Physically cuts the loaded audio down to just the current live trim
  // boundaries (first segment's start, last segment's end) and reloads the
  // waveform with the shorter result -- so the "will be cut" black padding
  // and the playhead actually reflect the cut instead of staying pinned to
  // the untouched original file. Done client-side (Web Audio API slice +
  // WAV re-encode) rather than round-tripping to a backend ffmpeg endpoint.
  // Does not touch translation_text/segment timing/segmentation, so it's
  // safe to click mid-edit without losing unrelated in-progress changes.
  const applyTrimOnly = useCallback(async () => {
    const ws = wsRef.current;
    if (localSegments.length === 0 || !ws || isTrimming) return;
    const firstSeg = localSegments[0];
    const lastSeg = localSegments[localSegments.length - 1];
    const firstRegion = regionsByIdRef.current.get(firstSeg.id);
    const lastRegion = regionsByIdRef.current.get(lastSeg.id);
    const currentTrimStart = firstRegion ? firstRegion.start : firstSeg.startSec;
    const currentTrimEnd = lastRegion ? lastRegion.end : lastSeg.endSec;
    const duration = ws.getDuration();

    const originStart = trimOffsetRef.current + currentTrimStart;
    const originEnd = trimOffsetRef.current + currentTrimEnd;
    onTrimOnly(originStart, originEnd);

    // Selection already spans the whole loaded buffer -- nothing to
    // actually cut away, so skip the decode/reload round trip.
    if (currentTrimStart <= 0.01 && currentTrimEnd >= duration - 0.01) return;

    setIsTrimming(true);
    try {
      if (!audioContextRef.current) {
        const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
        audioContextRef.current = new AudioContextCtor();
      }
      const audioCtx = audioContextRef.current;

      if (!originalBufferRef.current) {
        const res = await fetch(audioUrl);
        const arrayBuf = await res.arrayBuffer();
        originalBufferRef.current = await audioCtx.decodeAudioData(arrayBuf);
      }

      const sliced = sliceAudioBuffer(audioCtx, originalBufferRef.current, originStart, originEnd);
      const wavBlob = audioBufferToWavBlob(sliced);
      const newUrl = URL.createObjectURL(wavBlob);
      blobUrlsRef.current.add(newUrl);

      const newDuration = sliced.duration;
      const rebased = localSegments.map((s) => {
        const r = regionsByIdRef.current.get(s.id);
        const start = r ? r.start : s.startSec;
        const end = r ? r.end : s.endSec;
        return {
          ...s,
          startSec: Math.min(Math.max(0, start - currentTrimStart), newDuration),
          endSec: Math.min(Math.max(0, end - currentTrimStart), newDuration),
        };
      });

      commitChange(rebased, newUrl, originStart);
      trimOffsetRef.current = originStart;
      currentAudioSrcRef.current = newUrl;
      pendingSegmentsAfterLoadRef.current = rebased;
      setLocalSegments(rebased);
      // WaveSurfer clears its own loaded audio the instant load() is
      // called, well before the new "ready" event fires -- isReady must
      // drop immediately too, otherwise anything gated on it (the zoom
      // effect below, in particular) can still call into WaveSurfer during
      // this window and hit its "No audio loaded" error.
      setIsReady(false);
      await ws.load(newUrl);
    } catch (err) {
      console.error("Client-side audio trim failed:", err);
    } finally {
      setIsTrimming(false);
    }
  }, [localSegments, onTrimOnly, audioUrl, isTrimming, commitChange]);

  // Applies a history snapshot -- reloads the waveform ONLY when the
  // snapshot's audio differs from what's currently loaded (undoing/redoing
  // a plain drag never touches the audio, so this is the common, cheap
  // path; undoing/redoing across a "Sesi Şimdi Kes" cut is the one that
  // needs a reload, since the audio itself is different at that point).
  const restoreSnapshot = useCallback(async (snap: EditorSnapshot) => {
    const ws = wsRef.current;
    if (!ws) return;
    trimOffsetRef.current = snap.trimOffset;
    if (currentAudioSrcRef.current !== snap.audioSrc) {
      currentAudioSrcRef.current = snap.audioSrc;
      pendingSegmentsAfterLoadRef.current = snap.segments;
      setLocalSegments(snap.segments);
      // See the matching comment in applyTrimOnly -- must drop immediately,
      // not wait for the new "ready" event, or the zoom effect (and
      // anything else gated on isReady) can call into WaveSurfer while it
      // has no audio loaded.
      setIsReady(false);
      try {
        await ws.load(snap.audioSrc);
      } catch (err) {
        console.error("Undo/redo audio reload failed:", err);
      }
    } else {
      setLocalSegments(snap.segments);
      buildRegions(snap.segments);
    }
  }, [buildRegions]);

  const handleUndo = useCallback(() => {
    if (undoStackRef.current.length === 0 || isTrimming) return;
    const prev = undoStackRef.current.pop()!;
    redoStackRef.current.push(lastCommittedRef.current);
    lastCommittedRef.current = prev;
    setHistoryVersion((v) => v + 1);
    restoreSnapshot(prev);
  }, [restoreSnapshot, isTrimming]);

  const handleRedo = useCallback(() => {
    if (redoStackRef.current.length === 0 || isTrimming) return;
    const next = redoStackRef.current.pop()!;
    undoStackRef.current.push(lastCommittedRef.current);
    lastCommittedRef.current = next;
    setHistoryVersion((v) => v + 1);
    restoreSnapshot(next);
  }, [restoreSnapshot, isTrimming]);

  const canUndo = undoStackRef.current.length > 0 && !isTrimming;
  const canRedo = redoStackRef.current.length > 0 && !isTrimming;
  // Referenced so this render re-evaluates canUndo/canRedo whenever the
  // history stacks change -- the stacks themselves are plain refs (mutated
  // outside React's state) for O(1) push/pop, so this is the only thing
  // that actually ties them to a re-render.
  void historyVersion;

  const activeSegmentRaw = localSegments.find((s) => s.id === activeSegmentId) ?? null;
  const activeSegment = activeSegmentRaw ? resolveContent(activeSegmentRaw) : null;
  const activeBadgeIdx = activeSegmentRaw ? localSegments.findIndex((s) => s.id === activeSegmentRaw.id) : -1;
  // For the live "duration after trim" readout next to the trim button --
  // liveBounds is already kept in sync with the actual dragged region
  // positions (see buildRegions' "update" handler), including for these
  // same two outer segments.
  const firstSegForTrim = localSegments[0];
  const lastSegForTrim = localSegments[localSegments.length - 1];
  const liveTrimStart = firstSegForTrim ? (liveBounds[firstSegForTrim.id]?.start ?? firstSegForTrim.startSec) : 0;
  const liveTrimEnd = lastSegForTrim ? (liveBounds[lastSegForTrim.id]?.end ?? lastSegForTrim.endSec) : 0;

  // Renders inline (no portal/full-screen overlay) -- lives directly below
  // the video preview in VideoCreatorForm's unified video+editing section,
  // so the video stays visible and playable while the user adjusts timing.
  return (
      <div
        className="animate-fade-in bg-surface w-full border border-border rounded-2xl shadow-lg overflow-hidden flex flex-col max-h-[85vh]"
        dir={isArabic ? "rtl" : "ltr"}
      >
        <div className="p-4 sm:p-5 border-b border-border flex items-center justify-between bg-surface">
          <h2 className="text-base sm:text-lg font-bold text-foreground">
            {isArabic ? `ضبط توقيت الأقسام — ${ayahLabel}` : `Bölüm Zamanlamasını Ayarla — ${ayahLabel}`}
          </h2>
          <button
            onClick={onCancel}
            className="text-muted-foreground hover:text-foreground transition-colors bg-background p-2 rounded-full border border-border"
          >
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-6 flex-1 flex flex-col overflow-y-auto">
          <div className="flex items-start justify-between gap-3 mb-4">
            <p className="text-xs sm:text-sm text-muted-foreground flex-1">
              {isArabic
                ? "اسحب حواف المناطق الملوّنة لضبط توقيت كل قسم. الجزء الأسود في الطرفين سيُقصّ من الفيديو."
                : "Bölümleri ayarlamak için renkli kenarları sürükleyin. Koyu kısımlar videodan kesilecek."}
            </p>
            <button
              type="button"
              onClick={onToggleSegmentation}
              disabled={isSegmenting}
              className={`flex-shrink-0 inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs sm:text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm ${
                isSegmented
                  ? "bg-accent-red-bg/60 text-accent-red hover:bg-accent-red-bg"
                  : "bg-primary/10 text-primary hover:bg-primary/20"
              }`}
            >
              {isSegmenting ? (
                <Spinner size="sm" />
              ) : isSegmented ? (
                <TrashIcon className="w-4 h-4" />
              ) : (
                <ScissorsIcon className="w-4 h-4" />
              )}
              <span className="whitespace-nowrap">
                {isSegmenting
                  ? (isArabic ? "جاري التقسيم..." : "Bölümleniyor...")
                  : isSegmented
                  ? (isArabic ? "إزالة التقسيم" : "Bölümlemeyi Kaldır")
                  : (isArabic ? "تقسيم الآيات الطويلة" : "Uzun Ayetleri Bölümle")}
              </span>
            </button>
          </div>

          {!isReady && (
            <div className="h-[120px] flex items-center justify-center gap-2 bg-background rounded-xl border border-border">
              <Spinner size="sm" />
              <span className="text-sm font-medium text-muted-foreground">
                {isArabic ? "جاري تحميل الموجات الصوتية..." : "Ses dalgaları yükleniyor..."}
              </span>
            </div>
          )}

          <div
            ref={containerRef}
            className={`w-full min-h-[140px] flex-shrink-0 bg-background rounded-xl border border-border p-2 overflow-x-auto overflow-y-hidden transition-opacity duration-300 ${
              isReady ? "opacity-100" : "opacity-0 hidden"
            }`}
          />

          {isReady && (
            <div className="flex items-center gap-3 mt-4 px-2">
              <span className="text-muted-foreground" title={isArabic ? "تصغير" : "Uzaklaştır"}>
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM13 10H7" />
                </svg>
              </span>
              <input
                type="range"
                min="0"
                max="200"
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="flex-1 h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                dir="ltr"
              />
              <span className="text-muted-foreground" title={isArabic ? "تكبير" : "Yakınlaştır"}>
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v6m3-3H7" />
                </svg>
              </span>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {isArabic ? "الإجمالي:" : "Toplam:"} <span className="font-bold">{formatTime(totalDuration)}</span>
              </span>
            </div>
          )}

          {/* Dedicated trim action -- separate from "حفظ التوقيت" below, so
              the user can apply/hear just the trim immediately without
              first finishing unrelated text/timing edits elsewhere in the
              panel (see applyTrimOnly). Sits right under the waveform,
              next to the same edges it controls. */}
          {isReady && (
            <div className="flex items-center justify-between gap-3 mt-3 rounded-xl border border-border bg-background/70 px-3 py-2.5">
              <span className="text-xs text-muted-foreground">
                {isArabic ? "مدة الصوت بعد القص:" : "Kesim sonrası süre:"}{" "}
                <span className="font-bold text-foreground">{formatTime(Math.max(0, liveTrimEnd - liveTrimStart))}</span>
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleUndo}
                  disabled={!canUndo}
                  className="flex-shrink-0 flex items-center justify-center w-8 h-8 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  title={isArabic ? "تراجع" : "Geri al"}
                >
                  <ArrowUturnLeftIcon className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={handleRedo}
                  disabled={!canRedo}
                  className="flex-shrink-0 flex items-center justify-center w-8 h-8 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  title={isArabic ? "إعادة" : "Yinele"}
                >
                  <ArrowUturnRightIcon className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={applyTrimOnly}
                  disabled={isTrimming}
                  className="flex-shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/20 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isTrimming ? <Spinner size="sm" /> : <ScissorsIcon className="w-3.5 h-3.5" />}
                  {isArabic ? "قص الصوت الآن" : "Sesi Şimdi Kes"}
                </button>
              </div>
            </div>
          )}

          {/* Live preview: plays the whole clip straight through and shows
              exactly which segment's text would be on-screen at each
              instant, using the SAME live boundaries being edited above --
              so timing/text problems surface here in seconds instead of
              only after a full video render. */}
          {isReady && (
            <div className="mt-4 rounded-xl border border-border bg-background/70 p-4">
              <div className="flex items-center justify-between gap-3 mb-3">
                <span className="text-xs font-semibold text-muted-foreground">
                  {isArabic ? "معاينة حية" : "Canlı Önizleme"}
                </span>
                <button
                  onClick={togglePreview}
                  className="flex-shrink-0 flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-dark transition-colors"
                >
                  {isPlaying ? <PauseIcon className="w-3.5 h-3.5" /> : <PlayIcon className="w-3.5 h-3.5" />}
                  {isPlaying
                    ? (isArabic ? "إيقاف" : "Durdur")
                    : (isArabic ? "تشغيل المعاينة" : "Önizlemeyi Oynat")}
                </button>
              </div>
              {activeSegment ? (
                <div className="flex items-start gap-3">
                  <span
                    className="mt-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                    style={{ backgroundColor: REGION_PALETTE[activeBadgeIdx % REGION_PALETTE.length].badge }}
                  >
                    {activeBadgeIdx + 1}
                  </span>
                  <div className="min-w-0 flex-1 space-y-2">
                    {activeSegment.arabicText && (
                      <p
                        dir="rtl"
                        className={`${arabicFont === "qcf2" ? "text-[0.98rem] sm:text-[1.09rem]" : "text-lg sm:text-xl"} text-foreground break-words`}
                        style={{ fontFamily: activeSegment.page ? `'${arabicFontFamilyPrefix}${activeSegment.page}'` : undefined }}
                      >
                        {activeSegment.arabicText}
                      </p>
                    )}
                    <p
                      dir={isArabic ? "rtl" : "ltr"}
                      className="text-base text-primary break-words"
                      style={{ fontFamily: translationFontFamily }}
                    >
                      {activeSegment.translation_text}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  {isArabic
                    ? "اضغط \"تشغيل المعاينة\" لمشاهدة النص كما سيظهر بالضبط في الفيديو النهائي."
                    : "Son videoda tam olarak nasıl görüneceğini izlemek için \"Önizlemeyi Oynat\"a basın."}
                </p>
              )}
            </div>
          )}

          {isReady && (
            <div className="mt-4 space-y-2">
              {localSegments.map((seg, idx) => {
                const resolved = resolveContent(seg);
                const bounds = liveBounds[seg.id] ?? { start: seg.startSec, end: seg.endSec };
                const badgeColor = REGION_PALETTE[idx % REGION_PALETTE.length].badge;
                const isRepeat = !!seg.repeatOfId;
                const hasDependentRepeats = localSegments.some((s) => s.repeatOfId === seg.id);
                const parentIdx = isRepeat ? localSegments.findIndex((s) => s.id === seg.repeatOfId) : -1;
                const canSplit = !isRepeat && !hasDependentRepeats && resolved.wordCount >= 2;
                const nextSeg = idx < localSegments.length - 1 ? localSegments[idx + 1] : null;
                const canShiftWord = !isRepeat && !hasDependentRepeats && !!nextSeg && nextSeg.ayah === seg.ayah && !nextSeg.repeatOfId;
                const canDuplicate = !isRepeat;
                return (
                  <div
                    key={seg.id}
                    className={`flex flex-col gap-2.5 rounded-xl border px-3 py-2.5 ${
                      isRepeat ? "border-primary/30 bg-primary/5" : seg.isBlank ? "border-accent-amber/30 bg-accent-amber-bg/20" : "border-border bg-background/70"
                    }`}
                  >
                    {/* Content always gets the full card width, on every
                        screen size -- squeezing it next to the button
                        cluster (the old sm:flex-row layout) is what made
                        the Arabic text wrap awkwardly one word per line. */}
                    <div className="flex items-start gap-3 min-w-0">
                      <span
                        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                        style={{ backgroundColor: badgeColor }}
                      >
                        {isRepeat ? <ArrowPathIcon className="w-3.5 h-3.5" /> : idx + 1}
                      </span>
                      <span className="flex-1 min-w-0 flex flex-col gap-2.5">
                        {isRepeat && (
                          <span className="text-[11px] font-medium text-primary">
                            {isArabic
                              ? `🔁 تكرار للقسم ${parentIdx + 1}`
                              : `🔁 ${parentIdx + 1}. bölümün tekrarı`}
                          </span>
                        )}
                        {seg.isBlank && (
                          <span className="text-[11px] font-medium text-accent-amber">
                            {isArabic ? "✚ قسم مُضاف يدويًا" : "✚ Elle eklenen bölüm"}
                          </span>
                        )}
                        {resolved.arabicText && (
                          <span
                            className={`block break-words ${arabicFont === "qcf2" ? "text-[1.3rem] sm:text-[1.63rem]" : "text-2xl sm:text-3xl"} text-foreground my-2 px-0.5`}
                            style={{
                              fontFamily: resolved.page ? `'${arabicFontFamilyPrefix}${resolved.page}'` : undefined,
                              lineHeight: "2.4",
                            }}
                            dir="rtl"
                          >
                            {resolved.arabicText}
                          </span>
                        )}
                        <textarea
                          value={resolved.translation_text}
                          onChange={(e) => !isRepeat && updateTranslationText(seg.id, e.target.value)}
                          readOnly={isRepeat}
                          // Auto-grows to fit however many lines the translation
                          // needs (no cap at ~5 lines, no inner scrollbar) --
                          // re-measured on every render via the ref callback so
                          // it also reacts to text changes coming from splits/
                          // merges, not just direct typing.
                          ref={(el) => {
                            if (el) {
                              el.style.height = "auto";
                              el.style.height = `${el.scrollHeight}px`;
                            }
                          }}
                          rows={1}
                          dir={isArabic ? "rtl" : "ltr"}
                          style={{ fontFamily: translationFontFamily }}
                          placeholder={isArabic ? "اكتب نص الترجمة لهذا القسم..." : "Bu bölümün çeviri metnini yazın..."}
                          title={isRepeat ? (isArabic ? "عدّل النص من القسم الأصلي" : "Metni orijinal bölümden düzenleyin") : undefined}
                          className={`translation-textarea w-full resize-none overflow-hidden rounded-lg border border-transparent bg-transparent px-1 py-0.5 text-[13px] sm:text-sm hover:border-border focus:outline-none transition-colors ${
                            isRepeat ? "text-muted-foreground/70 cursor-not-allowed" : "text-muted-foreground focus:border-primary focus:bg-background"
                          }`}
                        />
                      </span>
                    </div>

                    {/* Controls row: time on one side, buttons grouped by
                        function on the other, wrapping onto extra lines
                        (flex-wrap) instead of overflowing/cramming on
                        narrow (phone) screens. */}
                    <div className="flex flex-wrap items-center justify-between gap-y-1.5 gap-x-2 border-t border-border/60 pt-2">
                      <span className="text-[11px] sm:text-xs text-muted-foreground whitespace-nowrap font-mono">
                        {formatTime(bounds.start)} → {formatTime(bounds.end)}
                      </span>
                      <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
                        {/* Reorder: compact stacked stepper instead of two
                            full-size circular buttons side by side. */}
                        <div className="flex flex-col overflow-hidden rounded-lg border border-border">
                          <button
                            onClick={() => moveSegment(seg.id, -1)}
                            disabled={idx === 0}
                            className="flex items-center justify-center w-6 h-4 text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                            title={isArabic ? "نقل لأعلى" : "Yukarı taşı"}
                          >
                            <ChevronUpIcon className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => moveSegment(seg.id, 1)}
                            disabled={idx === localSegments.length - 1}
                            className="flex items-center justify-center w-6 h-4 border-t border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                            title={isArabic ? "نقل لأسفل" : "Aşağı taşı"}
                          >
                            <ChevronDownIcon className="w-3.5 h-3.5" />
                          </button>
                        </div>

                        <span className="mx-1 h-5 w-px bg-border" />

                        <button
                          onClick={() => playSegment(seg.id)}
                          className="flex-shrink-0 flex items-center justify-center w-7 h-7 rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                          title={isArabic ? "تشغيل هذا القسم" : "Bu bölümü oynat"}
                        >
                          {playingId === seg.id ? <PauseIcon className="w-3.5 h-3.5" /> : <PlayIcon className="w-3.5 h-3.5" />}
                        </button>
                        <button
                          onClick={() => duplicateSegment(seg.id)}
                          disabled={!canDuplicate}
                          className="flex-shrink-0 flex items-center justify-center w-7 h-7 rounded-full border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          title={isArabic ? "تكرار هذا القسم (نفس النص، توقيت مستقل)" : "Bu bölümü tekrarla (aynı metin, bağımsız zamanlama)"}
                        >
                          <DocumentDuplicateIcon className="w-3.5 h-3.5" />
                        </button>

                        <span className="mx-1 h-5 w-px bg-border" />

                        <button
                          onClick={() => splitSegment(seg.id)}
                          disabled={!canSplit}
                          className="flex-shrink-0 flex items-center justify-center w-7 h-7 rounded-full border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          title={
                            hasDependentRepeats
                              ? (isArabic ? "لا يمكن تقسيم قسم له تكرار — احذف التكرار أولاً" : "Tekrarı olan bir bölüm ayrılamaz — önce tekrarı silin")
                              : (isArabic ? "تقسيم هذا القسم إلى قسمين" : "Bu bölümü ikiye ayır")
                          }
                        >
                          <ScissorsIcon className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => returnWordToNext(seg.id)}
                          disabled={!canShiftWord}
                          className="flex-shrink-0 flex items-center justify-center w-7 h-7 rounded-full border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          title={isArabic ? "إرجاع كلمة (إلى القسم التالي)" : "Kelime geri ver (sonraki bölüme)"}
                        >
                          <MinusCircleIcon className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => addWordFromNext(seg.id)}
                          disabled={!canShiftWord}
                          className="flex-shrink-0 flex items-center justify-center w-7 h-7 rounded-full border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          title={isArabic ? "إضافة كلمة (من القسم التالي)" : "Kelime ekle (sonraki bölümden)"}
                        >
                          <PlusCircleIcon className="w-3.5 h-3.5" />
                        </button>

                        {(isRepeat || seg.isBlank) && (
                          <button
                            onClick={() => removeSegment(seg.id)}
                            className="flex-shrink-0 flex items-center justify-center w-7 h-7 rounded-full border border-accent-red/30 text-accent-red hover:bg-accent-red-bg/60 transition-colors"
                            title={
                              isRepeat
                                ? (isArabic ? "حذف هذا التكرار" : "Bu tekrarı sil")
                                : (isArabic ? "حذف هذا القسم" : "Bu bölümü sil")
                            }
                          >
                            <TrashIcon className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 sm:gap-3 mt-6">
            <button
              onClick={onCancel}
              className="px-4 sm:px-5 py-2 sm:py-2.5 rounded-lg sm:rounded-xl border border-border bg-background text-foreground hover:bg-border transition-colors font-medium sm:font-bold text-sm"
            >
              {isArabic ? "إلغاء" : "İptal"}
            </button>
            <button
              onClick={handleConfirm}
              disabled={!isReady}
              className="flex items-center justify-center gap-1.5 sm:gap-2 px-4 sm:px-6 py-2 sm:py-2.5 rounded-lg sm:rounded-xl bg-primary text-white hover:bg-primary-dark transition-all disabled:opacity-50 shadow-lg shadow-primary/25 font-semibold sm:font-bold text-sm"
            >
              <CheckIcon className="w-4 h-4 sm:w-5 sm:h-5" />
              <span>{isArabic ? "حفظ التوقيت" : "Zamanlamayı Kaydet"}</span>
            </button>
          </div>
        </div>
      </div>
  );
}
