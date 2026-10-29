"use client";

import React, { useEffect, useState } from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  continueRender,
  delayRender,
  getRemotionEnvironment,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  ARABIC_FONT_OPTIONS,
  BACKGROUND_BLUR_MAX,
  BACKGROUND_DIM_MAX,
  DEFAULT_BACKGROUND_DIM,
  DEFAULT_WORD_HIGHLIGHT_COLOR,
  TRANSLATION_FONT_OPTIONS,
  resolveTranslationFont,
  translationFontStack,
  type ArabicFontKey,
  type QuranVideoProps,
  type TranslationFontKey,
  type VerseMapping,
  type WordTiming,
} from "./types";
import { isFontUsable, measureSpaceWidth, measureTokenWidths, resolveFontCss } from "./textMeasure";
import { buildPyramidLines } from "./pyramidLines";
import { voicedSpan } from "./timing";

const FPS = 30;
const CONTAINER_PADDING = 32;

const SURAH_NAME_FONT_SIZE = 50;
const SURAH_NAME_FONT_WEIGHT = 700;
const SURAH_NAME_LINE_HEIGHT = 1.625;

const TRANSLITERATION_FONT_SIZE = 45;
const TRANSLITERATION_FONT_WEIGHT = 500;
const TRANSLITERATION_LINE_HEIGHT = 1.4;
const TRANSLITERATION_COLOR = "white";
const TRANSLITERATION_LETTER_SPACING = "0.05em";
const TRANSLITERATION_MARGIN_TOP = 20;
// The reciter's name (an Arabic video's second header line, see
// QuranVideoProps.reciterName), in Amiri Bold -- a Naskh, the classic
// partner of the surah name's Ruqaa. Ruqaa itself stacks some letter pairs
// vertically ("لعـ"), which broke short names: "أحمد العجمي" read
// "أحمد ا لعجمي".
const RECITER_NAME_FONT_SIZE = 34;
const RECITER_NAME_FONT_WEIGHT = 700;
const RECITER_NAME_LINE_HEIGHT = 1.5;
const RECITER_NAME_MARGIN_TOP = 14;

const HEADER_PADDING_TOP = 32;

const VERSE_FONT_SIZE = 48;
const VERSE_FONT_WEIGHT = 500;
const VERSE_LINE_HEIGHT = 2.0;
const VERSE_FONT_FAMILY_FALLBACK = "'KFGQPC Uthman Taha Naskh', 'Amiri Quran', 'Scheherazade New', 'Noto Naskh Arabic', serif";

const FONT_KFGQPC_PATH = "fonts/UthmanTN1 Ver10.otf";
const FONT_KFGQPC_FAMILY = "KFGQPC Uthman Taha Naskh";
const FONT_UTHMANIC_HAFS_PATH = "fonts/uthmanic_hafs_v20.ttf";
const FONT_UTHMANIC_HAFS_FAMILY = "Uthmanic Hafs";
const FONT_PUA_DIR = "fonts/2013/QCF2BSMLfonts/QCF2";
// The OLD QCF v1 (2005 King Fahd Complex print) per-page PUA font set --
// font FILES provided directly (not fetched by us, unlike the v1 TEXT data
// in quran-qcf-v1.json/QuranVerse.textV1, which came from quran.com's
// public API). Family name deliberately "pv1-${page}", NOT "p${page}" --
// v1 and v2 use completely different PUA codepoints for the same page
// number, so they need distinct, non-colliding font-family names to
// coexist (both are always declared, see PageFontStyles, so switching
// arabicFont is instant/client-side like every other style toggle here).
const FONT_PUA_V1_DIR = "fonts/2005/QCF_BSML.fonts/QCF_P";

const FONT_SURAH_NAME_PATH = "fonts/video-fonts/Ruqaa.ttf";
const FONT_SURAH_NAME_FAMILY = "Ruqaa";

const FONT_RECITER_NAME_PATH = "fonts/video-fonts/Tajawal-Bold.ttf";
// Not "Tajawal": that family is the regular-weight tafsir font (TRANSLATION_FONT_OPTIONS).
const FONT_RECITER_NAME_FAMILY = "Tajawal Header";

const FONT_TRANSLITERATION_PATH = "fonts/video-fonts/Sansita-Bold.ttf";
const FONT_TRANSLITERATION_FAMILY = "Sansita";

// Every selectable translation font (files, weights, which languages each
// covers) is defined once in TRANSLATION_FONT_OPTIONS in types.ts;
// PageFontStyles declares a @font-face for each entry unconditionally, same
// as it already does for e.g. FONT_UTHMANIC_HAFS_FAMILY regardless of
// whether that one's picked.

const TRANSLATION_FONT_SIZE = 24;
const TRANSLATION_LINE_HEIGHT = 1.625;
const TRANSLATION_COLOR = "white";
const TRANSLATION_MARGIN_TOP = 10;
// Default/fallback family string -- used wherever a translationFont prop
// hasn't been resolved yet (module-level references only; the actual
// component always resolves its own from the translationFont prop, see
// resolvedTranslationFontFamily below).
const TRANSLATION_FONT_FAMILY = `${TRANSLATION_FONT_OPTIONS.aileron.family}, Arial, sans-serif`;
// Fixed family name for a user-uploaded translation font (translationFont
// === "custom") -- unlike the built-in TRANSLATION_FONT_OPTIONS registry,
// there's exactly one of these per project, so one constant name is
// enough; PageFontStyles declares its @font-face only when a URL is
// actually present.
const CUSTOM_TRANSLATION_FONT_FAMILY = "CustomTranslationFont";

// The verse-number prefix in front of a translation: "12. ".
function verseNumberPrefix(verseId: number): string {
  return `${verseId}. `;
}

const TEXT_SHADOW = "0 1px 2px rgba(0,0,0,0.6), 0 0 6px rgba(0,0,0,0.4)";
const TEXT_SHADOW_STRONG = "0 2px 4px rgba(0,0,0,0.7), 0 0 12px rgba(0,0,0,0.4)";

const ANIMATION_FADE_DURATION_FRAMES = Math.round(0.7 * FPS);

const CROSSFADE_DURATION_FRAMES = Math.round(0.3 * FPS);

// How long a chunk of text takes to fade in or out.
const TEXT_FADE_FRAMES = Math.round(0.6 * FPS);
// How long before the reciter starts a chunk it is already fully visible.
// Fully visible exactly at his first word still read as the voice coming
// first (the user, 2026-10-28): a word's audible start -- a hamza, a breath
// -- precedes its aligned onset slightly, and frames round it later still.
const TEXT_EARLY_FRAMES = Math.round(0.2 * FPS);
// A fade-in that only STARTS when the reciter does reads as late -- the eye
// only registers the text about halfway through it -- so each chunk starts
// fading in this much BEFORE its first word, and is fully visible just
// before the reciter starts it. Done by drawing the whole text track this much
// earlier than the audio (word highlighting adds it back, see
// buildWordWindows' call); each chunk stays until the next one starts
// fading in (see the chunk loop). Only with one continuous audio track (globalAudioPath): the
// per-ayah fallback keeps each ayah's audio inside its own Sequence, which
// must not move.
const TEXT_LEAD_FRAMES = TEXT_FADE_FRAMES + TEXT_EARLY_FRAMES;

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

function getAssetUrl(path: string | undefined | null): string {
  if (!path) return "";
  if (path.startsWith("http://") || path.startsWith("https://") || path.startsWith("file://")) {
    return path;
  }
  // blob: URLs (VideoCreatorForm's optimistic local background preview,
  // URL.createObjectURL()) are only ever handed to this component while
  // rendering live in the user's own browser tab -- never during a
  // server-side export -- so they always resolve correctly as-is; passing
  // one through staticFile() would percent-encode/mangle it like any other
  // non-file-path string.
  if (path.startsWith("blob:")) {
    return path;
  }
  // Our own /api/serve-audio?file=... routes (backgrounds, prepared/trimmed
  // audio) are root-relative -- correct as-is when this renders inside the
  // Player in an actual browser tab (desktop, LAN, or a Tailscale hostname
  // alike: it resolves against whatever origin the page was really loaded
  // from). But a real server-side export runs this same component inside
  // headless Chromium navigated to Remotion's OWN bundle-serving page (a
  // different, ephemeral origin) -- there, the same relative path would
  // 404, so it needs an explicit same-machine absolute URL instead. That
  // export always happens on this very container/machine regardless of
  // which device the user is on, so localhost is safe here (never sent to
  // the end user's browser). Note staticFile() is NOT used for these --
  // it's meant for literal filenames and percent-encodes `?`/`=`, breaking
  // the query string these routes rely on.
  if (path.startsWith("/")) {
    return getRemotionEnvironment().isRendering ? `http://localhost:3000${path}` : path;
  }
  return staticFile(path);
}

// A single failed media asset -- a background image/video that got cleaned
// up from disk, a stale prepared-audio path, a hiccup from the extraction
// backend -- must never take down the WHOLE render/preview with it.
// <Audio>/<OffthreadVideo> re-throw a failed load by default, which aborts
// the entire composition unless given their own onError; every one of them
// below is wired to this same "log it, keep going" handler instead, so the
// one affected element just renders silent/blank for its own segment while
// everything else keeps playing/rendering normally.
function handleMediaError(assetKind: string, src: string) {
  return (error: Error) => {
    console.error(`[QuranVideo] Failed to load ${assetKind}, continuing without it: ${src}`, error);
  };
}

// <Img> takes a plain native onError (a browser SyntheticEvent, not a
// Remotion Error) -- same "log it, keep going" reasoning as
// handleMediaError above, just a different event shape.
function handleImageError(assetKind: string, src: string) {
  return () => {
    console.error(`[QuranVideo] Failed to load ${assetKind}, continuing without it: ${src}`);
  };
}

function formatInvertedPyramid(
  text: string,
  forceTwoLines = true,
  prefixText = "",
  textWidthScale = 1,
  fontCss = "",
  maxLineWidthPx = 0
): React.ReactNode {
  if (!text) return null;

  // maxLineWidthPx is the translation <div>'s own 100%-width box (see its
  // `width: ${translationWidthScale*100}%` style right below) -- multiplying
  // by textWidthScale here reproduces that exact same box, so the pixel
  // budget and the visible box can never disagree. Font size no longer needs
  // to divide anything here (unlike the old MAX_LINE_CHARS formula): it's
  // already baked into fontCss's own px size, so every measured token width
  // already reflects it directly.
  const lineBudget = maxLineWidthPx * textWidthScale;
  const spaceWidth = measureSpaceWidth(fontCss);
  const prefixWidthPx = prefixText ? measureTokenWidths([prefixText], fontCss)[0] : 0;

  let lines: string[];

  if (text.includes("\n")) {
    // The user manually placed one or more line breaks (SegmentTimingEditor's
    // translation textarea -- a plain <textarea>, so Enter already lands a
    // real "\n" in translation_text; this is the only place that actually
    // reads it). Each manually-separated chunk stays its OWN line-group
    // verbatim -- none of the "collapse short text to one line"/"always at
    // least 2 lines" pyramid aesthetics below apply, since the user has
    // already made that call explicitly. A chunk still gets wrapped into
    // MORE lines via buildPyramidLines if it's too wide to fit on one at the
    // CURRENT width/scale (e.g. the box was narrowed after the break was
    // placed) -- manual control over where lines split, not an exemption
    // from ever overflowing the box.
    const chunks = text.split("\n");
    lines = chunks.flatMap((chunk, i) => {
      const chunkWords = chunk.split(" ").filter(Boolean);
      const widths = measureTokenWidths(chunkWords, fontCss);
      return buildPyramidLines(chunkWords, widths, spaceWidth, lineBudget, i === 0 ? prefixWidthPx : 0, 1);
    });
  } else {
    const words = text.split(" ");

    // Don't force two lines if the text is very short -- but only at/above
    // the original width. Once the user has deliberately narrowed the box
    // (textWidthScale < 1, dragged via VideoPreviewPlayer's width handles),
    // even originally-short text must be free to respond by wrapping into
    // more lines -- that's the entire point of the control. Dragging back out
    // to the original width restores this exact original behavior. This
    // short-text gate is a stylistic call (an inherently short phrase forced
    // into two lines looks off), orthogonal to the width-fit math below --
    // intentionally left on the original character/word-count heuristic.
    if (forceTwoLines && textWidthScale >= 1 && (text.length < 30 || words.length <= 4)) {
      forceTwoLines = false;
    }

    if (words.length <= 4 && forceTwoLines === false) return text;

    const widths = measureTokenWidths(words, fontCss);
    const totalWidthPx =
      widths.reduce((a, b) => a + b, 0) + spaceWidth * Math.max(0, words.length - 1) + prefixWidthPx;
    const MAX_LINES = words.length;

    let numLines = Math.ceil(totalWidthPx / lineBudget);
    // The "always at least 2 lines" pyramid look is the DEFAULT-width
    // aesthetic (this function's whole reason for existing) -- only enforced
    // at/below the original width. Widened past it, text that now actually
    // fits within the (larger) budget is free to collapse back down, even to
    // a single line -- that's the entire point of the widen control.
    if (forceTwoLines && textWidthScale <= 1 && numLines < 2) numLines = 2;
    if (!forceTwoLines && numLines < 2) return text;
    numLines = Math.max(1, Math.min(numLines, MAX_LINES, words.length));

    lines = buildPyramidLines(words, widths, spaceWidth, lineBudget, prefixWidthPx, numLines);
  }

  return (
    <>
      {lines.map((line, index) => (
        <React.Fragment key={index}>
          {line}
          {index < lines.length - 1 && <br />}
        </React.Fragment>
      ))}
    </>
  );
}

// The word being recited (see QuranVideoProps.wordHighlight): positions in
// the verse text's space-separated glyph tokens -- the same tokens
// formatArabicVerse builds its lines from -- to draw in `color`.
type ArabicHighlight = { tokens: ReadonlySet<number>; color: string };

// One line's text, with any highlighted tokens wrapped in a colored span.
// Only the color changes, so the measured line widths stay valid.
function renderArabicLine(line: string, firstTokenIdx: number, highlight?: ArabicHighlight): React.ReactNode {
  if (!highlight || highlight.tokens.size === 0) return line;
  return line.split(" ").map((token, i) => (
    <React.Fragment key={i}>
      {i > 0 && " "}
      {highlight.tokens.has(firstTokenIdx + i) ? <span style={{ color: highlight.color }}>{token}</span> : token}
    </React.Fragment>
  ));
}

function formatArabicVerse(
  text: string,
  arabicWidthScale = 1,
  fontCss = "",
  maxLineWidthPx = 0,
  manualBreakAfterTokens: number[] = [],
  highlight?: ArabicHighlight
): React.ReactNode {
  if (!text) return null;
  const words = text.split(" ");
  const spaceWidth = measureSpaceWidth(fontCss);
  // arabicWidthScale (user-draggable, see VideoPreviewPlayer's Arabic width
  // handles) narrows OR widens this independently of the translation's own
  // width control -- 1 is the original/default width (the Arabic <div>'s
  // own 100%-width box, see its `width: ${arabicWidthScale*100}%` style
  // right below), and it's not clamped to never exceed that: widened past it
  // (up to render/route.ts's own safe ceiling), more words can fit per line,
  // even collapsing the whole verse onto one.
  const lineBudget = maxLineWidthPx * arabicWidthScale;

  let lines: string[];

  if (manualBreakAfterTokens.length > 0) {
    // Mirrors formatInvertedPyramid's "\n" handling below: user-forced
    // boundaries (see VerseMapping.arabic_manual_break_after_words) define
    // independent chunks that never merge back together, each only further
    // sub-wrapped by the automatic algorithm if it's still too wide for the
    // current box on its own. Indices are real-word based and already
    // converted to token positions by the caller (real-word indices survive
    // an arabicFont/qcf1<->qcf2 switch; raw token positions don't, since the
    // two PUA encodings aren't 1:1).
    const sortedBreaks = [...new Set(manualBreakAfterTokens)].sort((a, b) => a - b);
    const chunks: string[][] = [];
    let start = 0;
    for (const breakAfter of sortedBreaks) {
      const end = Math.min(words.length - 1, breakAfter);
      if (end >= start) {
        chunks.push(words.slice(start, end + 1));
        start = end + 1;
      }
    }
    if (start < words.length) chunks.push(words.slice(start));

    lines = chunks.flatMap((chunkWords) => {
      const widths = measureTokenWidths(chunkWords, fontCss);
      return buildPyramidLines(chunkWords, widths, spaceWidth, lineBudget, 0, 1);
    });
  } else {
    const totalWords = words.length;
    const widths = measureTokenWidths(words, fontCss);
    const totalWidthPx = widths.reduce((a, b) => a + b, 0) + spaceWidth * Math.max(0, totalWords - 1);

    // "Return as a single line" is the original, unchanged behavior at/above
    // the default width -- exactly like formatInvertedPyramid's identical
    // check for the translation. Below it, even an originally-short verse
    // must respond to narrowing.
    if (totalWidthPx <= lineBudget && arabicWidthScale >= 1) {
      return renderArabicLine(text, 0, highlight);
    }

    // No artificial ceiling below the actual word count -- narrowed far
    // enough, every word can end up on its own line.
    const MAX_LINES = totalWords;
    let numLines = Math.min(MAX_LINES, Math.ceil(totalWidthPx / lineBudget));
    // Same DEFAULT-width-only "at least 2 lines" floor as the translation --
    // only below/at the original width, so widening can still collapse a
    // verse all the way down to one line once it fits.
    if (arabicWidthScale <= 1) numLines = Math.max(2, numLines);
    numLines = Math.max(1, numLines);

    lines = buildPyramidLines(words, widths, spaceWidth, lineBudget, 0, numLines);
  }

  const lineStartTokens: number[] = [];
  lines.reduce((start, line) => {
    lineStartTokens.push(start);
    return start + line.split(" ").length;
  }, 0);

  return (
    <>
      {lines.map((line, index) => (
        <React.Fragment key={index}>
          {renderArabicLine(line, lineStartTokens[index], highlight)}
          {index < lines.length - 1 && <br />}
        </React.Fragment>
      ))}
    </>
  );
}

// One recited word's on-screen window inside a VerseScene: local frames of
// its Sequence, and which of the scene's glyph tokens it covers.
type WordWindow = { start: number; end: number; tokens: number[] };

// A word stays lit until the next one starts, but not through a long
// pause after it.
const WORD_HIGHLIGHT_HOLD_FRAMES = 9;

// Letters (incl. alef wasla); a timed "word" without any is a standalone
// waqf/pause mark, which lights up together with the word before it.
const ARABIC_LETTER_RE = /[\u0621-\u064A\u0671-\u06D3]/;

const sumOf = (values: number[]) => values.reduce((a, b) => a + b, 0);

// The word windows for one displayed segment: which of its glyph tokens
// each recited word covers, timed in the segment Sequence's local frames.
// The segment shows verse glyph tokens [tokenStart, tokenEnd) -- the same
// range QuranVideo's deriveChunkWords slices (any trailing glyphs fused
// onto its last token don't add tokens). glyphCounts maps tokens back to
// real words (one entry per word in wordTimings); null means 1:1. Every
// later reading of a word (wordRepeats) lights the same glyphs again.
function buildWordWindows({
  wordTimings,
  wordRepeats,
  firstWord,
  lastWord,
  tokenStart,
  tokenEnd,
  glyphCounts,
  chunkStartFrame,
  fps,
}: {
  wordTimings: WordTiming[];
  wordRepeats?: { i: number; start: number; end: number }[];
  firstWord: number;
  lastWord: number;
  tokenStart: number;
  tokenEnd: number;
  glyphCounts: number[] | null;
  chunkStartFrame: number;
  fps: number;
}): WordWindow[] {
  const wordOfToken: number[] = [];
  if (glyphCounts) glyphCounts.forEach((count, w) => { for (let k = 0; k < count; k++) wordOfToken.push(w); });
  const toFrame = (ms: number) => Math.round((ms / 1000) * fps) - chunkStartFrame;

  const windows: WordWindow[] = [];
  const windowOfWord = new Map<number, WordWindow>();
  let lastWindowWord = -1;
  for (let g = tokenStart; g < tokenEnd; g++) {
    const w = glyphCounts ? wordOfToken[g] : Math.min(g, lastWord);
    if (w === undefined || w < firstWord || w > lastWord || !wordTimings[w]) continue;
    const localToken = g - tokenStart;
    const current = windows[windows.length - 1];
    if (w === lastWindowWord && current) {
      current.tokens.push(localToken);
      continue;
    }
    if (current && !ARABIC_LETTER_RE.test(wordTimings[w].w)) {
      current.tokens.push(localToken);
      lastWindowWord = w;
      continue;
    }
    const window = { start: toFrame(wordTimings[w].start), end: toFrame(wordTimings[w].end), tokens: [localToken] };
    windows.push(window);
    windowOfWord.set(w, window);
    lastWindowWord = w;
  }
  if (!wordRepeats?.length) return windows;
  for (const r of wordRepeats) {
    const window = windowOfWord.get(r.i);
    if (window) windows.push({ start: toFrame(r.start), end: toFrame(r.end), tokens: window.tokens });
  }
  // activeWordTokens takes the latest window that has started.
  return windows.sort((a, b) => a.start - b.start);
}

function activeWordTokens(windows: WordWindow[] | undefined, frame: number): ReadonlySet<number> | null {
  if (!windows || windows.length === 0) return null;
  for (let i = windows.length - 1; i >= 0; i--) {
    const w = windows[i];
    if (w.start > frame) continue;
    const next = windows[i + 1];
    const until = Math.min(next ? next.start : Infinity, w.end + WORD_HIGHLIGHT_HOLD_FRAMES);
    return frame < until ? new Set(w.tokens) : null;
  }
  return null;
}

function VerseScene({
  text,
  translation,
  verseId,
  durationInFrames,
  page,
  textScale = 1,
  arabicTextScale = 1,
  arabicWidthScale = 1,
  translationTextScale = 1,
  translationWidthScale = 1,
  translationFontFamily = TRANSLATION_FONT_FAMILY,
  translationRtl = false,
  arabicFont = "qcf2",
  showNumber = true,
  compact = false,
  hasTranslation = true,
  segmentKey,
  wordWindows,
  wordHighlightColor = DEFAULT_WORD_HIGHLIGHT_COLOR,
}: {
  text: string;
  translation: string;
  verseId: number;
  durationInFrames: number;
  page?: number;
  // Which per-page PUA font family naming scheme `page` belongs to -- see
  // FONT_PUA_V1_DIR's own comment for why v1/v2 need distinct family names
  // even for the same page number.
  arabicFont?: ArabicFontKey;
  // Identifies exactly which displayed segment this is (verse id + mapping
  // index, or undefined for the no-mappings whole-verse fallback) --
  // stamped onto the Arabic/translation divs below as data-segment-key so
  // VideoPreviewPlayer.tsx can tell which segment is currently on screen
  // and resize just that one. See VerseMapping's own per-segment scale
  // fields in types.ts.
  segmentKey?: string;
  // Used ONLY for the compact-mode header-reserve calculation below (must
  // match the actual header's own effectiveTextScale, computed once in
  // QuranVideo and passed straight through here) -- the verse/translation
  // text itself always uses its own independent scale below, never this.
  textScale?: number;
  // Fully independent of each other and of textScale above -- each text
  // block has its own size and line-wrap-width control (see
  // VideoPreviewPlayer's two separate slider/drag-handle pairs). 1 = the
  // shared original/default for both. See types.ts.
  arabicTextScale?: number;
  arabicWidthScale?: number;
  translationTextScale?: number;
  translationWidthScale?: number;
  // Already-resolved CSS font-family string (e.g. "Inter, Arial,
  // sans-serif") -- QuranVideo resolves this ONCE from the translationFont
  // prop (see TRANSLATION_FONT_FILES) and passes it straight through,
  // falling back to the original Aileron family if omitted.
  translationFontFamily?: string;
  // An Arabic tafsir: lay the translation out right-to-left with
  // Arabic-Indic verse numbers (translationFontFamily is already the Arabic
  // translation font in that case, see QuranVideo).
  translationRtl?: boolean;
  showNumber?: boolean;
  // Portrait (the original, unchanged layout) splits the screen into two
  // tall flex:1 halves, each pushing its text to the FAR edge (Arabic
  // bottom-aligned in the top half, translation top-aligned in the bottom
  // half) -- deliberate for a 1280px-tall canvas, since it puts the text
  // near vertical center with generous breathing room above/below. On a
  // landscape or square canvas (much shorter), the exact same two-half
  // split instead leaves most of each half empty and the text stranded far
  // from center, tiny and floating (reported against a real render) -- so
  // those ratios use this "compact" mode instead: both blocks centered
  // together as one group with a small gap between them.
  compact?: boolean;
  // False when the whole video has no translation at all ("no translation"
  // picked): portrait then centers the Arabic in the full frame instead of
  // leaving it bottom-aligned above an always-empty translation half.
  // Video-wide rather than read off this segment's own `translation`, so
  // a translated video whose one segment happens to have no text doesn't
  // jump that segment's Arabic to a different height.
  hasTranslation?: boolean;
  // Set only while word highlighting is on and this segment has aligned
  // word timing -- see QuranVideoProps.wordHighlight.
  wordWindows?: WordWindow[];
  wordHighlightColor?: string;
}) {
  const frame = useCurrentFrame();
  const highlightTokens = activeWordTokens(wordWindows, frame);
  const arabicHighlight: ArabicHighlight | undefined = highlightTokens
    ? { tokens: highlightTokens, color: wordHighlightColor }
    : undefined;
  const maxFadeIn = Math.min(TEXT_FADE_FRAMES, Math.floor(durationInFrames * 0.45));
  const maxFadeOut = Math.min(TEXT_FADE_FRAMES, Math.floor(durationInFrames * 0.45));

  let fadeInEnd = maxFadeIn;
  let fadeOutStart = durationInFrames - maxFadeOut;

  if (fadeInEnd === 0) fadeInEnd = 0.1;
  if (fadeOutStart === durationInFrames) fadeOutStart = durationInFrames - 0.1;
  if (fadeInEnd >= fadeOutStart) {
    fadeInEnd = durationInFrames * 0.49;
    fadeOutStart = durationInFrames * 0.51;
  }

  const opacity = interpolate(
    frame,
    [0, fadeInEnd, fadeOutStart, durationInFrames],
    [0, 1, 1, 0],
    {
      easing: easeInOut,
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }
  );

  // See ARABIC_FONT_OPTIONS' own sizeMultiplier comment in types.ts -- qcf1
  // needs a bit of a boost to visually match qcf2 at the "same" size.
  const resolvedVerseFontSize = Math.round(
    VERSE_FONT_SIZE * arabicTextScale * ARABIC_FONT_OPTIONS[arabicFont].sizeMultiplier
  );

  // The actual pixel width of the AbsoluteFill's content box below (its
  // CONTAINER_PADDING is horizontal-only) -- this is the true 100% both
  // text divs' own `width: ${...WidthScale*100}%` style resolves against,
  // so feeding it straight into formatArabicVerse/formatInvertedPyramid's
  // pixel budget reproduces the exact box being rendered, no separate
  // empirically-tuned constant needed.
  const { width: canvasWidth } = useVideoConfig();
  const contentWidthPx = canvasWidth - CONTAINER_PADDING * 2;

  const arabicFontFamily = page ? (arabicFont === "qcf1" ? `'pv1-${page}'` : `'p${page}'`) : VERSE_FONT_FAMILY_FALLBACK;
  const arabicFontCss = resolveFontCss(arabicFontFamily, resolvedVerseFontSize, VERSE_FONT_WEIGHT);
  const resolvedTranslationFontSize = Math.round(TRANSLATION_FONT_SIZE * translationTextScale);
  const translationFontCss = resolveFontCss(translationFontFamily, resolvedTranslationFontSize);

  // The parent's `fontsReady` prop is a coarse, whole-video bulk-preload
  // signal that can go stale under re-entrant effect runs, and treats a
  // genuinely REJECTED font load the same as a successful one (see its own
  // comment in QuranVideo's font-preload effect) -- reported as this exact
  // explosion still recurring, for a still-loaded-fine font resource,
  // after that effect's own Promise.all -> Promise.allSettled fix. This is
  // the actual per-render decision instead: isFontUsable reads the
  // browser's LIVE font cache fresh, synchronously, every single render --
  // no memory of past load attempts to go stale. Deliberately NOT ANDed
  // with the `fontsReady` prop (unlike an earlier version) -- that prop's
  // own effect still briefly flips false on legitimate font-identity
  // changes (a different arabicFont, a new page), and ANDing it in here
  // meant every one of those brief flips hid the text even though
  // isFontUsable alone already correctly kept saying "still fine" for a
  // font that was never actually affected, reported as the verse/
  // translation text flickering out and back in on unrelated changes.
  // isFontUsable alone is authoritative and needs no such help. Needs no
  // dedicated polling loop either: VerseScene already calls
  // useCurrentFrame() below, so it re-renders on every video frame during
  // playback, re-checking this fresh up to 30x/sec until it naturally
  // comes back true; the effect further down only covers the paused-on-
  // mount case, where nothing else would otherwise trigger a re-render
  // once the font finishes loading.
  const arabicReady = isFontUsable(arabicFontCss);
  const translationReady = isFontUsable(translationFontCss);
  // An Arabic tafsir goes without it: the user found the number beside it
  // out of place there.
  const translationNumberPrefix = showNumber && !translationRtl ? verseNumberPrefix(verseId) : "";
  const [, forceFontRecheck] = useState(0);
  useEffect(() => {
    if (arabicReady && translationReady) return;
    let cancelled = false;
    Promise.allSettled([document.fonts.load(arabicFontCss), document.fonts.load(translationFontCss)]).then(() => {
      if (!cancelled) forceFontRecheck((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [arabicReady, translationReady, arabicFontCss, translationFontCss]);

  if (compact) {
    // Reserves the same vertical space the header (surah name +
    // transliteration, rendered separately by QuranVideo below) actually
    // occupies at this same textScale, so centering happens in the space
    // BELOW it instead of across the full frame height. Without this, a
    // long unsegmented verse (many wrapped lines) grows tall enough that
    // its centered block reaches up far enough to overlap the header text
    // -- confirmed by rendering a long-verse test still before this fix.
    const headerReserve = Math.round(
      (HEADER_PADDING_TOP +
        SURAH_NAME_FONT_SIZE * SURAH_NAME_LINE_HEIGHT +
        TRANSLITERATION_MARGIN_TOP +
        TRANSLITERATION_FONT_SIZE * TRANSLITERATION_LINE_HEIGHT) *
        textScale
    );
    return (
      <AbsoluteFill
        style={{
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          opacity,
          padding: `0 ${CONTAINER_PADDING}px`,
          paddingTop: headerReserve,
        }}
      >
        <div
          dir="rtl"
          data-text-block="arabic"
          data-segment-key={segmentKey}
          style={{
            textAlign: "center",
            color: "white",
            fontFamily: arabicFontFamily,
            fontSize: resolvedVerseFontSize,
            fontWeight: VERSE_FONT_WEIGHT,
            lineHeight: VERSE_LINE_HEIGHT,
            textShadow: TEXT_SHADOW,
            width: `${Math.round(arabicWidthScale * 100)}%`,
          }}
        >
          {arabicReady ? formatArabicVerse(text, arabicWidthScale, arabicFontCss, contentWidthPx, [], arabicHighlight) : null}
        </div>
        {translation ? (
          <div
            dir={translationRtl ? "rtl" : "ltr"}
            data-text-block="translation"
            data-segment-key={segmentKey}
            style={{
              textAlign: "center",
              color: TRANSLATION_COLOR,
              fontFamily: translationFontFamily,
              fontSize: resolvedTranslationFontSize,
              lineHeight: TRANSLATION_LINE_HEIGHT,
              marginTop: TRANSLATION_MARGIN_TOP,
              width: `${Math.round(translationWidthScale * 100)}%`,
            }}
          >
            {translationReady ? (
              <>
                {translationNumberPrefix}
                {formatInvertedPyramid(translation, true, translationNumberPrefix, translationWidthScale, translationFontCss, contentWidthPx)}
              </>
            ) : null}
          </div>
        ) : null}
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill
      style={{
        flexDirection: "column",
        opacity,
        padding: `0 ${CONTAINER_PADDING}px`,
      }}
    >
      {/* Top half for Arabic -- the whole frame, centered, without a translation */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: hasTranslation ? "flex-end" : "center",
          alignItems: "center",
          paddingBottom: "0px",
        }}
      >
        <div
          dir="rtl"
          data-text-block="arabic"
          data-segment-key={segmentKey}
          style={{
            textAlign: "center",
            color: "white",
            fontFamily: arabicFontFamily,
            fontSize: resolvedVerseFontSize,
            fontWeight: VERSE_FONT_WEIGHT,
            lineHeight: VERSE_LINE_HEIGHT,
            textShadow: TEXT_SHADOW,
            width: `${Math.round(arabicWidthScale * 100)}%`,
          }}
        >
          {arabicReady ? formatArabicVerse(text, arabicWidthScale, arabicFontCss, contentWidthPx, [], arabicHighlight) : null}
        </div>
      </div>

      {/* Bottom half for Translation */}
      {hasTranslation ? (
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-start",
            alignItems: "center",
            paddingTop: "0px",
          }}
        >
          {translation ? (
            <div
              dir={translationRtl ? "rtl" : "ltr"}
              data-text-block="translation"
              data-segment-key={segmentKey}
              style={{
                textAlign: "center",
                color: TRANSLATION_COLOR,
                fontFamily: translationFontFamily,
                fontSize: resolvedTranslationFontSize,
                lineHeight: TRANSLATION_LINE_HEIGHT,
                marginTop: TRANSLATION_MARGIN_TOP,
                width: `${Math.round(translationWidthScale * 100)}%`,
              }}
            >
              {translationReady ? (
                <>
                  {translationNumberPrefix}
                  {formatInvertedPyramid(translation, true, translationNumberPrefix, translationWidthScale, translationFontCss, contentWidthPx)}
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </AbsoluteFill>
  );
}

// Guesses the CSS @font-face format() keyword from a font URL's own
// extension (works fine here even though the URL is really a
// /api/serve-audio?file=... query string, not a plain path -- the
// filename+extension is still the very last thing in the string either
// way). Defaults to "truetype" for anything unrecognized rather than
// omitting format() entirely, which some browsers refuse to load without.
function guessFontFormat(url: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(url);
  const ext = match?.[1]?.toLowerCase();
  if (ext === "otf") return "opentype";
  if (ext === "woff") return "woff";
  if (ext === "woff2") return "woff2";
  return "truetype";
}

function PageFontStyles({
  verses,
  customTranslationFontUrl,
}: {
  verses: QuranVideoProps["verses"];
  customTranslationFontUrl?: string;
}) {
  const pages = Array.from(
    new Set(verses.map((v) => v.page).filter(Boolean) as number[])
  );
  const fontFaces = pages
    .map(
      (page) => `
      @font-face {
        font-family: 'p${page}';
        src: url("${staticFile(`${FONT_PUA_DIR}${String(page).padStart(3, "0")}.ttf`)}") format("truetype");
        font-weight: 500;
        font-style: normal;
        font-display: swap;
      }
    `
    )
    .join("\n");

  // Same as above but for QCF v1 (see FONT_PUA_V1_DIR's own comment) --
  // declared unconditionally from pageV1 regardless of which arabicFont is
  // CURRENTLY selected, same reasoning as translationFontFaces below, so
  // switching is instant/client-side with no reload.
  const pagesV1 = Array.from(
    new Set(verses.map((v) => v.pageV1).filter(Boolean) as number[])
  );
  const fontFacesV1 = pagesV1
    .map(
      (page) => `
      @font-face {
        font-family: 'pv1-${page}';
        src: url("${staticFile(`${FONT_PUA_V1_DIR}${String(page).padStart(3, "0")}.ttf`)}") format("truetype");
        font-weight: 500;
        font-style: normal;
        font-display: swap;
      }
    `
    )
    .join("\n");

  // One @font-face per selectable translation font (see
  // TRANSLATION_FONT_OPTIONS/TRANSLATION_FONT_FILES) -- declared
  // unconditionally regardless of which one is actually picked, same as
  // every other font below (e.g. FONT_UTHMANIC_HAFS_FAMILY is declared here
  // too even though nothing currently selects it).
  const translationFontFaces = (Object.keys(TRANSLATION_FONT_OPTIONS) as TranslationFontKey[])
    .map((key) => {
      const { family, file: path, format, weight } = TRANSLATION_FONT_OPTIONS[key];
      return `
      @font-face {
        font-family: "${family}";
        src: url("${staticFile(path)}") format("${format}");
        font-weight: ${weight};
        font-display: swap;
      }
    `;
    })
    .join("\n");

  // The user-uploaded translation font, if any -- resolved through
  // getAssetUrl the same way verse audio/background assets already are, so
  // it loads correctly both live in the browser preview (a relative
  // /api/serve-audio path) and during the actual server-side render (needs
  // an absolute same-machine URL instead, see getAssetUrl's own comment).
  const customTranslationFontFace = customTranslationFontUrl
    ? `
      @font-face {
        font-family: "${CUSTOM_TRANSLATION_FONT_FAMILY}";
        src: url("${getAssetUrl(customTranslationFontUrl)}") format("${guessFontFormat(customTranslationFontUrl)}");
        font-weight: 400;
        font-display: swap;
      }
    `
    : "";

  return (
    <style>{`
      @font-face {
        font-family: "${FONT_KFGQPC_FAMILY}";
        src: url("${staticFile(FONT_KFGQPC_PATH)}") format("opentype");
        font-weight: 400;
        font-style: normal;
        font-display: swap;
      }
      @font-face {
        font-family: "${FONT_KFGQPC_FAMILY}";
        src: url("${staticFile(FONT_KFGQPC_PATH)}") format("opentype");
        font-weight: 500;
        font-style: normal;
        font-display: swap;
      }
      @font-face {
        font-family: "${FONT_UTHMANIC_HAFS_FAMILY}";
        src: url("${staticFile(FONT_UTHMANIC_HAFS_PATH)}") format("truetype");
        font-weight: 400;
        font-style: normal;
        font-display: swap;
      }
      @font-face {
        font-family: "${FONT_SURAH_NAME_FAMILY}";
        src: url("${staticFile(FONT_SURAH_NAME_PATH)}") format("truetype");
        font-display: swap;
      }
      @font-face {
        font-family: "${FONT_TRANSLITERATION_FAMILY}";
        src: url("${staticFile(FONT_TRANSLITERATION_PATH)}") format("truetype");
        font-weight: 700;
        font-display: swap;
      }
      @font-face {
        font-family: "${FONT_RECITER_NAME_FAMILY}";
        src: url("${staticFile(FONT_RECITER_NAME_PATH)}") format("truetype");
        font-weight: 700;
        font-display: swap;
      }
      ${translationFontFaces}
      ${fontFaces}
      ${fontFacesV1}
      ${customTranslationFontFace}
      body {
        text-rendering: auto;
        font-feature-settings: "kern" 1;
      }
    `}</style>
  );
}

// A background video shorter than the recitation repeats -- but instead of
// jumping from its last frame back to its first, each repeat starts
// BACKGROUND_CROSSFADE_FRAMES before the previous one ends and fades in on
// top of it, so the seam dissolves. A Sequence only mounts its children
// inside its own window (premountFor mounts the next copy a little early so
// its file is already loaded when its fade starts), so at most two copies
// play at once however long the video is.
const BACKGROUND_CROSSFADE_FRAMES = 30;

function CrossfadeIn({ frames, children }: { frames: number; children: React.ReactNode }) {
  const frame = useCurrentFrame();
  const opacity =
    frames > 0 ? interpolate(frame, [0, frames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
}

function LoopingBackgroundVideo({
  src,
  clipFrames,
  totalFrames,
  style,
  onError,
}: {
  src: string;
  // The clip's own length; null (older drafts/renders saved before it was
  // probed) plays it once, unlooped -- the best possible without it.
  clipFrames: number | null;
  totalFrames: number;
  style: React.CSSProperties;
  onError: React.ComponentProps<typeof OffthreadVideo>["onError"];
}) {
  // Never audible: the recitation is the only sound. The file itself has no
  // audio track either (lib/silentVideo.ts). pauseWhenBuffering off: a
  // repeat loading in must never stall the recitation.
  const video = <OffthreadVideo src={src} muted volume={0} pauseWhenBuffering={false} onError={onError} style={style} />;
  if (!clipFrames || clipFrames >= totalFrames) return video;

  const crossfade = Math.min(BACKGROUND_CROSSFADE_FRAMES, Math.floor(clipFrames / 4));
  const period = clipFrames - crossfade;
  const copies = Math.ceil(totalFrames / period);
  return (
    <>
      {Array.from({ length: copies }, (_, k) => (
        <Sequence key={k} from={k * period} durationInFrames={clipFrames} premountFor={crossfade + 15}>
          <CrossfadeIn frames={k === 0 ? 0 : crossfade}>{video}</CrossfadeIn>
        </Sequence>
      ))}
    </>
  );
}

export function QuranVideo({
  surahNameArabic,
  surahNameTransliteration,
  surahTitle,
  reciterName,
  backgroundImagePath,
  backgroundVideoPath,
  backgroundVideoDurationInFrames,
  backgroundDim = DEFAULT_BACKGROUND_DIM,
  backgroundBlur = 0,
  backgroundZoom = false,
  wordHighlight = false,
  wordHighlightColor = DEFAULT_WORD_HIGHLIGHT_COLOR,
  globalAudioPath,
  isAudioExtracted,
  verses,
  totalDurationInFrames,
  textScale = 1,
  // Each defaults to the shared textScale/1 when not explicitly set, so an
  // older saved draft/render with only textScale (or nothing at all) looks
  // exactly as it always did. See VideoPreviewPlayer's two independent
  // slider/drag-handle pairs for how a user sets these directly.
  arabicTextScale = textScale,
  arabicWidthScale = 1,
  translationTextScale = textScale,
  translationWidthScale = 1,
  translationFont = "aileron",
  customTranslationFontUrl,
  translationRtl = false,
  arabicFont = "qcf2",
}: QuranVideoProps) {
  // Which fonts can render the translation depends on its script (see
  // TRANSLATION_FONT_OPTIONS' `languages`); "tr" stands in for any
  // Latin-script translation, since every Latin font covers English too.
  const translationScript = translationRtl ? "ar" : "tr";
  // Resolved ONCE here from the translationFont prop and threaded down to
  // every place that used to reference the module-level
  // TRANSLATION_FONT_FAMILY constant directly -- that constant now only
  // exists as the fallback default. resolveTranslationFont falls back to the
  // script's default font when the chosen one can't render it (e.g. a Latin
  // font saved on a project that has since switched to an Arabic tafsir), or
  // when "custom" (a user-uploaded font, see PageFontStyles' own @font-face
  // for it) has no file yet -- e.g. right after picking "custom" in the UI
  // but before the upload finishes -- rather than resolving to a family
  // nothing declared, which would silently show the browser's plain default.
  const effectiveTranslationFont = resolveTranslationFont(translationFont, translationScript, Boolean(customTranslationFontUrl));
  const resolvedTranslationFontFamily = translationFontStack(effectiveTranslationFont, translationScript, CUSTOM_TRANSLATION_FONT_FAMILY);
  const latinSurahTitle = surahTitle ?? (surahNameTransliteration ? `${surahNameTransliteration} SURESİ` : "");
  // "No translation" leaves every verse's text (and every segment's) empty --
  // see VerseScene's hasTranslation.
  const hasTranslation = verses.some(
    (verse) => Boolean(verse.translation) || Boolean(verse.mappings?.some((mapping) => mapping.translation_text))
  );
  // A delayRender() handle can only ever be continued once -- grabbing it
  // just once at mount (the previous `useState(() => delayRender(...))`
  // pattern) meant only the FIRST render was ever actually gated behind
  // font-loading; every later prop update reused that same, already-spent
  // handle, so continueRender on it was a no-op and the frame rendered
  // immediately regardless of whether the (possibly different-page, e.g.
  // navigating to an ayah on a different QCF page) fonts had finished
  // loading yet. Never surfaced before because a real render/preview used
  // to always mount this component fresh -- but the live preview now keeps
  // one mounted instance alive and feeds it new verses as the user changes
  // things, which exposed it as a real, visible glitch (a page's ayah-marker
  // glyph or other custom glyphs briefly showing a fallback font). Creating
  // a fresh handle inside the effect itself, every time the font-relevant
  // props change, re-gates each such change correctly instead of just the
  // first one.
  // The composition's actual pixel dimensions vary by aspectRatio (see
  // ASPECT_RATIO_DIMENSIONS in types.ts) -- every font-size/spacing constant
  // below was tuned by eye against the 720x1280 portrait canvas. Portrait
  // itself is untouched (dimensionScale is always exactly 1 there, since
  // 720x1280 IS that baseline). Landscape/square instead render VerseScene
  // in "compact" mode (both text blocks centered together as one group,
  // see VerseScene above) rather than naively shrinking the original
  // two-half layout -- that first attempt (scaling by
  // min(width/720, height/1280), i.e. down to ~0.56x on landscape) left
  // text tiny and stranded in mostly-empty space, confirmed against a real
  // render. Compact mode needs much less vertical headroom than the
  // two-half layout was budgeted for, so it can afford a visibly larger,
  // better-fitting scale -- height/900 (not height/1280) as the vertical
  // budget, capped so square/landscape never get disproportionately larger
  // than portrait's own baseline.
  const { width: canvasWidth, height: canvasHeight } = useVideoConfig();
  const isPortrait = canvasWidth === 720 && canvasHeight === 1280;
  const dimensionScale = isPortrait
    ? 1
    : Math.min(canvasWidth / 720, canvasHeight / 900, 1.15);
  const effectiveTextScale = textScale * dimensionScale;
  const effectiveArabicTextScale = arabicTextScale * dimensionScale;
  const effectiveTranslationTextScale = translationTextScale * dimensionScale;

  const effectiveVerseFontSize = Math.round(
    VERSE_FONT_SIZE * effectiveArabicTextScale * ARABIC_FONT_OPTIONS[arabicFont].sizeMultiplier
  );

  // Gates formatArabicVerse/formatInvertedPyramid's canvas-based width
  // measurement (see textMeasure.ts) on the SAME font-load completion this
  // effect already tracks below -- canvas.measureText silently falls back
  // to a generic system font for any face that hasn't finished loading yet,
  // so measuring before this flips true produces wildly wrong widths (an
  // ayah briefly exploding into one word per line on first mount, since
  // React's initial render runs before this effect even starts, let alone
  // before the fonts it kicks off actually finish). VerseScene falls back
  // to plain, unwrapped text while this is false; the moment it flips true,
  // the resulting re-render measures for real and lays out correctly.
  const [fontsReady, setFontsReady] = useState(false);

  useEffect(() => {
    setFontsReady(false);
    const fontHandle = delayRender("Loading Quran video fonts");
    // allSettled, not all() -- a plain Promise.all rejects (and moves on)
    // the instant the FIRST entry in this array rejects, without waiting
    // for whichever other page/verse font loads are still genuinely
    // in-flight at that moment. Since this array covers every page across
    // the WHOLE video (not just the verse on screen right now), a single
    // transient failure on any one of them used to flip fontsReady (and
    // release Remotion's own delayRender gate) early -- before later
    // verses' own fonts had actually finished -- so canvas measurement for
    // THOSE verses ran against a still-loading/fallback font (wrong, often
    // much wider, glyph metrics), reported as ordinary short words
    // suddenly exploding one per line well into playback, not just on
    // first mount. allSettled always waits for every entry to finish, pass
    // or fail, before this .then runs.
    Promise.allSettled([
      document.fonts.load(`${effectiveVerseFontSize}px "${FONT_KFGQPC_FAMILY}"`),
      ...verses.map((v) => {
        // Preload whichever page/family the CURRENTLY selected arabicFont
        // actually needs -- the other one still loads fine on demand
        // (font-display: swap) the moment the user switches to it.
        const page = arabicFont === "qcf1" ? v.pageV1 ?? v.page : v.page;
        const family = arabicFont === "qcf1" ? `pv1-${page}` : `p${page}`;
        return page ? document.fonts.load(`${effectiveVerseFontSize}px '${family}'`) : Promise.resolve();
      }),
      document.fonts.load(`${Math.round(SURAH_NAME_FONT_SIZE * effectiveTextScale)}px "${FONT_SURAH_NAME_FAMILY}"`),
      document.fonts.load(`${Math.round(TRANSLITERATION_FONT_SIZE * effectiveTextScale)}px "${FONT_TRANSLITERATION_FAMILY}"`),
      document.fonts.load(`${RECITER_NAME_FONT_WEIGHT} ${Math.round(RECITER_NAME_FONT_SIZE * effectiveTextScale)}px "${FONT_RECITER_NAME_FAMILY}"`),
      document.fonts.load(
        `${Math.round(TRANSLATION_FONT_SIZE * effectiveTranslationTextScale)}px "${
          effectiveTranslationFont === "custom"
            ? CUSTOM_TRANSLATION_FONT_FAMILY
            : TRANSLATION_FONT_OPTIONS[effectiveTranslationFont].family
        }"`
      ),
      document.fonts.ready,
    ]).then(() => {
      continueRender(fontHandle);
      setFontsReady(true);
    });
    // effectiveTextScale/effectiveArabicTextScale/effectiveTranslationTextScale
    // deliberately NOT in the dependency list below -- a font FACE's
    // availability never depends on the pixel size it's requested at (only
    // family/weight/style), so re-running this whole bulk preload (and
    // synchronously flipping fontsReady back to false at its very top,
    // however briefly) on every text-SIZE drag tick was pure churn with no
    // correctness benefit, and it's exactly what was cascading into
    // arabicReady/translationReady below going false and back on every
    // tick -- reported as the verse/translation text visibly flickering
    // out and back in while dragging a size or width slider. Still
    // correctly re-runs on anything that actually changes WHICH font
    // families are needed (a different arabicFont/translationFont/custom
    // upload, or new verses covering new Mushaf pages).
  }, [verses, translationFont, customTranslationFontUrl, translationRtl, arabicFont]);

  // Same authoritative-per-render pattern as VerseScene's arabicReady/
  // translationReady below (see its own comment) -- the header's own two
  // lines use different, un-measured-but-still-font-dependent fonts, and
  // were exactly what was visibly overlapping/garbled in the reported
  // screenshot whenever the bulk fontsReady state above went stale-true. No
  // dedicated polling needed during playback either: useCurrentFrame right
  // below already re-renders this component every frame.
  const surahNameFontCss = resolveFontCss(
    FONT_SURAH_NAME_FAMILY,
    Math.round(SURAH_NAME_FONT_SIZE * effectiveTextScale),
    SURAH_NAME_FONT_WEIGHT
  );
  const transliterationFontCss = resolveFontCss(
    FONT_TRANSLITERATION_FAMILY,
    Math.round(TRANSLITERATION_FONT_SIZE * effectiveTextScale),
    TRANSLITERATION_FONT_WEIGHT
  );
  const reciterNameFontCss = resolveFontCss(
    FONT_RECITER_NAME_FAMILY,
    Math.round(RECITER_NAME_FONT_SIZE * effectiveTextScale),
    RECITER_NAME_FONT_WEIGHT
  );
  const headerFontsReady =
    isFontUsable(surahNameFontCss) &&
    isFontUsable(transliterationFontCss) &&
    (!reciterName || isFontUsable(reciterNameFontCss));
  const [, forceHeaderFontRecheck] = useState(0);
  useEffect(() => {
    if (headerFontsReady) return;
    let cancelled = false;
    Promise.allSettled([
      document.fonts.load(surahNameFontCss),
      document.fonts.load(transliterationFontCss),
      document.fonts.load(reciterNameFontCss),
    ]).then(() => {
      if (!cancelled) forceHeaderFontRecheck((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [headerFontsReady, surahNameFontCss, transliterationFontCss, reciterNameFontCss]);

  const frame = useCurrentFrame();
  const headerFadeInEnd = ANIMATION_FADE_DURATION_FRAMES;
  const headerFadeOutStart = totalDurationInFrames - ANIMATION_FADE_DURATION_FRAMES;
  const headerOpacity = interpolate(
    frame,
    [0, headerFadeInEnd, headerFadeOutStart, totalDurationInFrames],
    [0, 0.5, 0.5, 0],
    { easing: easeInOut, extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Background look (see QuranVideoProps.backgroundDim/Blur/Zoom). A blur
  // fades the layer's own edges toward transparent, so the layer is scaled
  // up just enough to push that fringe off-canvas; the zoom pushes in ~12%
  // linearly over the whole video.
  const bgDim = Math.max(0, Math.min(BACKGROUND_DIM_MAX, backgroundDim));
  const bgBlur = Math.max(0, Math.min(BACKGROUND_BLUR_MAX, backgroundBlur));
  const bgBlurBleed = bgBlur > 0 ? 1 + (4 * bgBlur) / Math.min(canvasWidth, canvasHeight) : 1;
  const bgZoom = backgroundZoom
    ? interpolate(frame, [0, Math.max(1, totalDurationInFrames - 1)], [1, 1.12], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : 1;
  const bgScale = bgBlurBleed * bgZoom;
  const backgroundMediaStyle: React.CSSProperties = {
    position: "absolute",
    width: "100%",
    height: "100%",
    objectFit: "cover",
    ...(bgBlur > 0 ? { filter: `blur(${bgBlur}px)` } : {}),
    ...(bgScale !== 1 ? { transform: `scale(${bgScale})` } : {}),
  };

  let startFrame = 0;
  const textLeadFrames = globalAudioPath ? TEXT_LEAD_FRAMES : 0;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <PageFontStyles verses={verses} customTranslationFontUrl={customTranslationFontUrl} />

      {backgroundVideoPath ? (
        <AbsoluteFill>
          <LoopingBackgroundVideo
            src={getAssetUrl(backgroundVideoPath)}
            clipFrames={backgroundVideoDurationInFrames ?? null}
            totalFrames={totalDurationInFrames}
            style={backgroundMediaStyle}
            onError={handleMediaError("background video", getAssetUrl(backgroundVideoPath))}
          />
        </AbsoluteFill>
      ) : backgroundImagePath ? (
        <AbsoluteFill>
          <Img
            src={getAssetUrl(backgroundImagePath)}
            onError={handleImageError("background image", getAssetUrl(backgroundImagePath))}
            style={backgroundMediaStyle}
          />
        </AbsoluteFill>
      ) : null}
      {/* Darkening as one black layer over the whole background (the same
          result as the media's own opacity over the black base) -- so two
          crossfading video copies can't add up to a brighter frame. */}
      {(backgroundVideoPath || backgroundImagePath) && bgDim > 0 ? (
        <AbsoluteFill style={{ backgroundColor: "#000", opacity: bgDim }} />
      ) : null}

      {globalAudioPath ? (
        <Audio
          src={getAssetUrl(globalAudioPath)}
          onError={handleMediaError("audio", getAssetUrl(globalAudioPath))}
        />
      ) : null}

      {/* The text track, drawn textLeadFrames ahead of the audio -- see
          TEXT_LEAD_FRAMES. */}
      <Sequence from={-textLeadFrames} layout="none">
      {verses.map((verse, i) => {
        const from = startFrame;
        startFrame += verse.durationInFrames;
        const d = verse.durationInFrames;
        const isFirst = i === 0;
        const isLast = i === verses.length - 1;
        const shortAudio = d <= CROSSFADE_DURATION_FRAMES * 2;

        // Resolved ONCE per verse from the arabicFont prop -- textV1/pageV1
        // are always present alongside text/page regardless of which is
        // CURRENTLY selected (see their own declaration in types.ts), so
        // switching arabicFont is instant/client-side, same as
        // translationFont. puaTokenCounts is deliberately NOT carried over
        // for v1 -- see its own comment in types.ts, this falls back to the
        // existing 1:1 real-word assumption below instead.
        //
        // isQcf1 also requires verse.textV1 to be a REAL, non-empty string,
        // not just qcf1 being the selected font -- quran-qcf-v1.json (fetched
        // from quran.com) doesn't necessarily have complete coverage for
        // every single ayah, and `textV1 ?? verse.text` alone only guards
        // against it being missing entirely, not an empty string (`??` is
        // nullish-only). Left unguarded, an ayah with an empty textV1 would
        // still take the qcf1 branch, rendering literally nothing -- reported
        // as "the ayah doesn't show at all when I pick the old font". Falling
        // back to v2 for BOTH text and page/font-family (not just the text)
        // keeps them a matched pair -- v1 PUA codepoints under a 'p{page}'
        // (v2) font, or vice versa, would render as garbled tofu, not
        // readable text, which is no better than the blank box this fixes.
        const isQcf1 = arabicFont === "qcf1" && Boolean(verse.textV1);
        const arabicVerseText = isQcf1 ? verse.textV1! : verse.text;
        const arabicVersePage = isQcf1 ? (verse.pageV1 ?? verse.page) : verse.page;
        const arabicVersePuaTokenCounts = isQcf1 ? undefined : verse.puaTokenCounts;

        return (
          <Sequence
            key={`${verse.id}-${from}`}
            from={from}
            durationInFrames={isLast ? d + textLeadFrames : d}
          >
            {globalAudioPath ? null : (
              <Audio
                src={getAssetUrl(verse.audioPath)}
                onError={handleMediaError(`verse ${verse.id} audio`, getAssetUrl(verse.audioPath))}
                volume={(f) => {
                  if (shortAudio) return 1;
                  if (!isFirst && f < CROSSFADE_DURATION_FRAMES) {
                    return f / CROSSFADE_DURATION_FRAMES;
                  }
                  if (!isLast && f >= d - CROSSFADE_DURATION_FRAMES) {
                    return (d - f) / CROSSFADE_DURATION_FRAMES;
                  }
                  return 1;
                }}
              />
            )}

            {(() => {
              // Every verse renders through this SAME per-mapping path now --
              // one with no real segmentation (verse.mappings unset/empty)
              // gets a single synthetic mapping spanning its whole
              // text/translation, instead of the separate "whole verse"
              // branch this used to be. That old branch passed no
              // segmentKey at all, so a never-segmented verse's box had no
              // segment identity of its own: resizing it fell all the way
              // back to the shared, video-wide arabicTextScale/etc. prop --
              // which every OTHER never-segmented verse (and every segment
              // that had never been individually resized) was ALSO reading
              // as its own fallback, so one box's drag visibly resized all
              // of them at once (reported: dragging one ayah's box changed
              // "the rest of the parts of the ayah, or the other ayat"
              // too). A real mapping -- even this synthetic one -- gets its
              // own `${verse.id}:0` segmentKey and its own
              // arabicTextScale/arabicWidthScale/translationTextScale/
              // translationWidthScale override slot exactly like any other
              // segment (see VerseMapping in types.ts), so every box is
              // now genuinely independent. The synthetic mapping's timing
              // (computed below, same as any real mapping) resolves
              // identically to what the old whole-verse branch used to
              // show: with wordTimings present, a single mapping spanning
              // ALL words reduces to the exact same [firstStart, lastEnd]
              // window; without it, both fall back to the same [0, d]
              // whole-Sequence window.
              const mappings: VerseMapping[] =
                verse.mappings && verse.mappings.length > 0
                  ? verse.mappings
                  : [
                      {
                        part: 1,
                        translation_text: verse.translation,
                        // arabic_text set explicitly (verbatim, untruncated
                        // full verse) rather than left to the word-range
                        // derivation below -- that derivation slices
                        // arabicVerseText assuming word_count real WORDS
                        // map 1:1 onto glyph TOKENS whenever
                        // arabicVersePuaTokenCounts isn't available, which
                        // would silently chop off the verse's tail here
                        // (QCF glyph tokens routinely outnumber real words).
                        arabic_text: arabicVerseText,
                        // wordTimings.length (exact real-word count) when
                        // available so the wordTimings-based lookup below
                        // still resolves the exact same tight
                        // [firstStart, lastEnd] window the old whole-verse
                        // branch computed directly -- otherwise this number
                        // no longer affects anything (arabic_text above
                        // already bypasses the word-range math it would
                        // have driven), so the glyph-token count is just a
                        // reasonable placeholder.
                        word_count: verse.wordTimings?.length ?? arabicVerseText.trim().split(/\s+/).length,
                      },
                    ];

              // A "repeat" mapping (repeat_of_part set) re-displays an
              // EARLIER mapping's own words -- it doesn't consume any NEW
              // words of the ayah, so its word_count must be excluded here
              // (contributes 0), matching VideoCreatorForm.tsx's own
              // buildTimingEditorSegments (see its identical comment).
              // Counting it anyway inflated totalWords and pushed every
              // mapping AFTER a repeat that many words too far forward,
              // slicing the wrong (too-far-into-the-verse, often near-empty)
              // range for their Arabic text -- reported as a segment right
              // after a repeated one showing only its last word or two.
              const realWordCount = (m: VerseMapping) => (typeof m.repeat_of_part === "number" ? 0 : m.word_count);

              const totalWords = mappings.reduce((sum, m) => sum + realWordCount(m), 0);
              // When mapping i's chunk is on screen, in frames on this
              // ayah's own Sequence (on the audio's time).
              const chunkWindow = (i: number) => {
                const m = mappings[i];
                const previousWords = mappings.slice(0, i).reduce((sum, x) => sum + realWordCount(x), 0);
                // Proportional fallback (used only when real per-word audio
                // timing isn't available for this verse, e.g. custom audio
                // that wasn't aligned by the backend). Uses realWordCount
                // here too -- not mapping.word_count -- so every mapping's
                // own share of `d` still sums to exactly 1 across the whole
                // ayah (a repeat's raw word_count would otherwise double-
                // count time already given to its source, over-allocating
                // past `d`). A repeat effectively gets 0 share in this
                // fallback-only path; in practice it always carries its own
                // manual start_ms/end_ms anyway (see below), which takes
                // absolute priority over this proportional guess regardless.
                let chunkStartFrame = Math.round((previousWords / totalWords) * d);
                let chunkDuration = i === mappings.length - 1
                  ? d - chunkStartFrame
                  : Math.round((realWordCount(m) / totalWords) * d);

                const startWordIdx = previousWords;
                const endWordIdx = previousWords + m.word_count - 1;
                const isRepeatMapping = typeof m.repeat_of_part === "number";

                // When the chunk is on screen -- the rule shared with
                // render/route.ts and the live preview (see ./timing): from
                // the reciter's onset of its first voiced word to the end of
                // its last one, so a pause between chunks shows no text and a
                // waqf sign at either edge doesn't shift it. Direct index
                // lookup: word_count counts REAL Uthmani words, the same
                // tokens wordTimings is aligned to. A repeat re-shows earlier
                // words, so it has no words of its own to time by.
                let startMs: number | undefined;
                let endMs: number | undefined;
                const hasWordTiming =
                  (!globalAudioPath || isAudioExtracted) &&
                  !!verse.wordTimings &&
                  endWordIdx < verse.wordTimings.length;
                if (!isRepeatMapping && hasWordTiming && verse.wordTimings) {
                  const span = voicedSpan(verse.wordTimings, startWordIdx, endWordIdx);
                  startMs = span?.start ?? verse.wordTimings[startWordIdx].start;
                  endMs = span?.end ?? verse.wordTimings[endWordIdx].end;
                }
                // A boundary the user moved in SegmentTimingEditor wins over
                // the words, each edge on its own (render/route.ts keeps only
                // the moved ones, already verse-relative ms).
                if (typeof m.start_ms === "number") startMs = m.start_ms;
                if (typeof m.end_ms === "number") endMs = m.end_ms;
                if (startMs !== undefined || endMs !== undefined) {
                  const startFrame = startMs !== undefined ? Math.round((startMs / 1000) * 30) : chunkStartFrame; // FPS is 30
                  const endFrame = endMs !== undefined ? Math.round((endMs / 1000) * 30) : chunkStartFrame + chunkDuration;
                  chunkStartFrame = startFrame;
                  chunkDuration = Math.max(1, endFrame - startFrame);
                }
                return { chunkStartFrame, chunkDuration, startWordIdx, endWordIdx, isRepeatMapping, hasWordTiming };
              };

              return mappings.map((mapping, idx) => {
                // Shown by another appearance of this ayah (see remotion/timing.ts).
                if (mapping.hidden) return null;
                const allWords = arabicVerseText.trim().split(/\s+/);
                const chunkTiming = chunkWindow(idx);
                const { startWordIdx, isRepeatMapping } = chunkTiming;
                // Never before the video's first frame (`from` is this ayah's
                // place on the text track): a chunk the reciter starts less
                // than textLeadFrames into the video -- the first one, when
                // the trim leaves little silence before it -- would otherwise
                // be mostly faded in already on frame 0, popping up instead
                // of fading in. It fades in from the first frame instead, at
                // the same speed as every other chunk.
                const chunkStartFrame = Math.max(chunkTiming.chunkStartFrame, textLeadFrames - from);
                // The text track runs textLeadFrames ahead of the audio (see
                // TEXT_LEAD_FRAMES), so this Sequence -- placed at the
                // chunk's audio start -- shows from textLeadFrames before
                // it, fading in to be fully visible as the reciter starts.
                // It stays on screen until the next chunk on screen -- of
                // this ayah, or the next ayah, whose Sequence starts where
                // this one ends -- starts fading in: its fade-out ends right
                // there. The screen is never blank between two chunks, pause
                // or not, and never shows two at once -- only the fades
                // themselves change it (the user, 2026-10-28). The video's
                // last chunk ends with its last word, never past the end of
                // the video, which the trim may put before the words' own
                // timing ends (a recording that repeats its last ayahs,
                // trimmed to keep one recitation).
                const verseEnd = isLast ? d + textLeadFrames : d;
                const nextShown = mappings.findIndex((m, j) => j > idx && !m.hidden);
                const displayEnd =
                  nextShown >= 0
                    ? Math.min(Math.max(chunkStartFrame + 1, chunkWindow(nextShown).chunkStartFrame), verseEnd)
                    : isLast
                      ? Math.min(chunkStartFrame + chunkTiming.chunkDuration + textLeadFrames, verseEnd)
                      : Math.max(chunkStartFrame + 1, verseEnd);
                const chunkDuration = Math.max(1, displayEnd - chunkStartFrame);

                // SegmentTimingEditor saved a frozen `arabic_text` snapshot
                // for this segment once, but it's locked into whichever QCF
                // encoding (arabicFont) was selected at save time -- trusted
                // verbatim, it rendered garbled glyphs the instant the user
                // later switched arabicFont (right encoding for the font it
                // was saved under, wrong one for whatever's picked now).
                // Every mapping -- including "repeat" ones, which used to be
                // the one exception that still trusted the frozen snapshot,
                // since a repeat re-shows an EARLIER segment's words rather
                // than the "next" sequential range the cumulative word_count
                // math below assumes -- now instead re-derives its text live
                // from arabicVerseText (already resolved for the CURRENTLY
                // selected arabicFont, see isQcf1 above). A repeat just
                // borrows its SOURCE part's own word range (the mapping
                // `repeat_of_part` points at) instead of its own sequential
                // position, through the exact same real-word -> QCF glyph-
                // token slicing every other segment already uses -- so no
                // frozen text needs to be trusted at all anymore, and a
                // repeat survives a later font switch exactly like every
                // other segment already did. Convert a real-word range into
                // a QCF glyph-token range using puaTokenCounts, since `text`
                // is page-glyph text where one real word can span >1
                // whitespace token; falls back to a 1:1 assumption when
                // unavailable.
                const deriveChunkWords = (rangeStartWordIdx: number, rangeWordCount: number, attachTrailing: boolean): string => {
                  let puaStart = rangeStartWordIdx;
                  let puaEnd = rangeStartWordIdx + rangeWordCount;
                  if (arabicVersePuaTokenCounts && arabicVersePuaTokenCounts.length === totalWords) {
                    puaStart = arabicVersePuaTokenCounts.slice(0, rangeStartWordIdx).reduce((a, b) => a + b, 0);
                    puaEnd = puaStart + arabicVersePuaTokenCounts.slice(rangeStartWordIdx, rangeStartWordIdx + rangeWordCount).reduce((a, b) => a + b, 0);
                  }
                  const coreWords = allWords.slice(puaStart, puaEnd);
                  let rangeWords = coreWords;
                  // Trailing QCF glyph tokens (waqf marks, the ayah-number
                  // marker) sit past totalWords in both the naive fallback and
                  // any undercounted puaTokenCounts map -- a segment whose
                  // words reach the ayah's end reaches the true end of
                  // allWords too, so it never renders without its
                  // ayah-ending number glyph. Requested only for such a range
                  // (see caller below): one ending mid-verse would get most
                  // of the rest of the verse fused onto it.
                  // Fused onto the last real word with no separating space
                  // (matching Mushaf typesetting, and keeping it from being
                  // treated as its own wrappable "word" by VerseScene's
                  // line-breaking, which would isolate it on its own line).
                  if (attachTrailing) {
                    const trailing = allWords.slice(puaEnd, allWords.length);
                    if (trailing.length > 0) {
                      rangeWords = [...coreWords.slice(0, -1), (coreWords[coreWords.length - 1] ?? "") + trailing.join("")];
                    }
                  }
                  let result = rangeWords.join(" ");
                  // The 1:1 real-word-to-glyph-token assumption above is
                  // never guaranteed for qcf1 (puaTokenCounts, the thing
                  // that would make this exact, is deliberately never
                  // computed for it -- see this file's own comment on that).
                  // For a segment deep enough into a long, multi-part ayah,
                  // enough drift between the two counts can push the sliced
                  // range past the end of allWords entirely, producing a
                  // blank result instead of merely a slightly wrong one.
                  // Showing the WHOLE verse's text for that one segment
                  // (still correctly qcf1, still readable) is a far smaller
                  // fault than showing nothing at all.
                  if (isQcf1 && result.trim().length === 0) {
                    result = arabicVerseText;
                  }
                  return result;
                };

                // The ayah-number marker goes on every segment whose words
                // reach the ayah's end -- an original or a repeat of one --
                // the same rule as VideoCreatorForm's sliceArabicForWordRange
                // (the timing editor). It used to go on the LAST mapping
                // only, which a repeat never is allowed to take: a copied
                // whole ayah then showed the number on neither copy.
                const reachesAyahEnd = (rangeStartWordIdx: number, rangeWordCount: number) =>
                  rangeStartWordIdx + rangeWordCount >= totalWords;
                let chunkText: string;
                // The real words the shown text holds: a repeat's are its
                // source part's (null: unknown, no highlight).
                let shownWords: { start: number; count: number } | null = { start: startWordIdx, count: mapping.word_count };
                if (isRepeatMapping) {
                  shownWords = null;
                  const sourceIdx = mappings.findIndex((m) => m.part === mapping.repeat_of_part);
                  if (sourceIdx !== -1) {
                    const sourcePreviousWords = mappings.slice(0, sourceIdx).reduce((sum, m) => sum + realWordCount(m), 0);
                    const sourceWordCount = mappings[sourceIdx].word_count;
                    shownWords = { start: sourcePreviousWords, count: sourceWordCount };
                    chunkText = deriveChunkWords(sourcePreviousWords, sourceWordCount, reachesAyahEnd(sourcePreviousWords, sourceWordCount));
                  } else if (typeof mapping.arabic_text === "string" && mapping.arabic_text.length > 0) {
                    // Source part no longer exists (segmentation re-split/
                    // merged since this repeat was created) -- fall back to
                    // whatever was last saved rather than showing nothing,
                    // same tolerance this field always had before this fix.
                    chunkText = mapping.arabic_text;
                  } else {
                    chunkText = arabicVerseText;
                  }
                } else {
                  chunkText = deriveChunkWords(startWordIdx, mapping.word_count, reachesAyahEnd(startWordIdx, mapping.word_count));
                }

                // Word highlighting (see QuranVideoProps.wordHighlight). A
                // repeat lights its source part's words, through their later
                // readings (wordRepeats). The glyph range
                // is the one deriveChunkWords sliced; it's only trusted when
                // the shown text has exactly that many tokens, so a
                // highlight can never land on the wrong glyphs. The old
                // (qcf1) script is only mapped where its glyph tokens line
                // up with the new script's, which the counts describe.
                let wordWindows: WordWindow[] | undefined;
                const highlightWords =
                  shownWords &&
                  (!globalAudioPath || isAudioExtracted) &&
                  verse.wordTimings &&
                  shownWords.start + shownWords.count - 1 < verse.wordTimings.length
                    ? shownWords
                    : null;
                if (wordHighlight && highlightWords && verse.wordTimings) {
                  const firstWord = highlightWords.start;
                  const wordCount = highlightWords.count;
                  const slicingCounts =
                    arabicVersePuaTokenCounts && arabicVersePuaTokenCounts.length === totalWords ? arabicVersePuaTokenCounts : null;
                  const tokenStart = slicingCounts ? sumOf(slicingCounts.slice(0, firstWord)) : firstWord;
                  const tokenEnd = Math.min(
                    allWords.length,
                    slicingCounts
                      ? tokenStart + sumOf(slicingCounts.slice(firstWord, firstWord + wordCount))
                      : firstWord + wordCount
                  );
                  const newScriptTokenCount = verse.text.trim().split(/\s+/).length;
                  const scriptsLineUp = allWords.length === newScriptTokenCount;
                  const candidateCounts = verse.puaTokenCounts ?? verse.highlightGlyphCounts;
                  const glyphCounts =
                    scriptsLineUp &&
                    candidateCounts &&
                    candidateCounts.length === verse.wordTimings.length &&
                    sumOf(candidateCounts) === newScriptTokenCount
                      ? candidateCounts
                      : null;
                  if (
                    (glyphCounts || !isQcf1) &&
                    tokenEnd > tokenStart &&
                    chunkText.split(" ").length === tokenEnd - tokenStart
                  ) {
                    wordWindows = buildWordWindows({
                      wordTimings: verse.wordTimings,
                      wordRepeats: verse.wordRepeats,
                      firstWord,
                      lastWord: firstWord + wordCount - 1,
                      tokenStart,
                      tokenEnd,
                      glyphCounts,
                      // The text track runs textLeadFrames ahead of the
                      // audio; the highlight must stay on the audio's time.
                      chunkStartFrame: chunkStartFrame - textLeadFrames,
                      fps: 30,
                    });
                  }
                }

                // Per-segment overrides (see VerseMapping in types.ts) fall
                // back to this verse's own global scale -- itself already
                // falling back to textScale -- so a segment that's never
                // been individually resized renders identically to before
                // this feature existed. dimensionScale applied the same
                // way as the global effective*Scale values above.
                const segmentKey = `${verse.id}:${idx}`;
                const effectiveMappingArabicTextScale =
                  (mapping.arabicTextScale ?? arabicTextScale) * dimensionScale;
                const effectiveMappingTranslationTextScale =
                  (mapping.translationTextScale ?? translationTextScale) * dimensionScale;
                const mappingArabicWidthScale = mapping.arabicWidthScale ?? arabicWidthScale;
                const mappingTranslationWidthScale = mapping.translationWidthScale ?? translationWidthScale;

                return (
                  <Sequence
                    key={`chunk-${verse.id}-${idx}`}
                    from={chunkStartFrame}
                    durationInFrames={chunkDuration}
                  >
                    <VerseScene
                      text={chunkText}
                      translation={mapping.translation_text}
                      verseId={verse.id}
                      durationInFrames={chunkDuration}
                      page={arabicVersePage}
                      arabicFont={arabicFont}
                      textScale={effectiveTextScale}
                      arabicTextScale={effectiveMappingArabicTextScale}
                      arabicWidthScale={mappingArabicWidthScale}
                      translationTextScale={effectiveMappingTranslationTextScale}
                      translationWidthScale={mappingTranslationWidthScale}
                      translationFontFamily={resolvedTranslationFontFamily}
                      translationRtl={translationRtl}
                      showNumber={mapping.isFirstOfAyah ?? idx === 0}
                      segmentKey={segmentKey}
                      compact={!isPortrait}
                      hasTranslation={hasTranslation}
                      wordWindows={wordWindows}
                      wordHighlightColor={wordHighlightColor}
                    />
                  </Sequence>
                );
              });
            })()}
          </Sequence>
        );
      })}
      </Sequence>

      <AbsoluteFill
        style={{
          alignItems: "center",
          // Without a second line (an Arabic video with no reciter name),
          // the Arabic name moves down by half the Latin line's height so it
          // sits centered where the two-line header used to, rather than
          // leaving a gap under it.
          paddingTop: latinSurahTitle || reciterName
            ? HEADER_PADDING_TOP
            : HEADER_PADDING_TOP +
              (TRANSLITERATION_MARGIN_TOP +
                Math.round(TRANSLITERATION_FONT_SIZE * effectiveTextScale) * TRANSLITERATION_LINE_HEIGHT) /
                2,
          color: "white",
          fontFamily: resolvedTranslationFontFamily,
          opacity: headerOpacity,
        }}
      >
        {headerFontsReady ? (
          <div
            dir="rtl"
            style={{
              fontSize: Math.round(SURAH_NAME_FONT_SIZE * effectiveTextScale),
              fontWeight: SURAH_NAME_FONT_WEIGHT,
              lineHeight: SURAH_NAME_LINE_HEIGHT,
              fontFamily: FONT_SURAH_NAME_FAMILY,
              textShadow: TEXT_SHADOW_STRONG,
            }}
          >
            سورة {surahNameArabic}
          </div>
        ) : null}
        {headerFontsReady && reciterName ? (
          <div
            dir="rtl"
            style={{
              fontSize: Math.round(RECITER_NAME_FONT_SIZE * effectiveTextScale),
              fontWeight: RECITER_NAME_FONT_WEIGHT,
              lineHeight: RECITER_NAME_LINE_HEIGHT,
              fontFamily: FONT_RECITER_NAME_FAMILY,
              color: TRANSLITERATION_COLOR,
              marginTop: RECITER_NAME_MARGIN_TOP,
              textShadow: TEXT_SHADOW_STRONG,
            }}
          >
            {reciterName}
          </div>
        ) : headerFontsReady && latinSurahTitle ? (
          <div
            style={{
              fontSize: Math.round(TRANSLITERATION_FONT_SIZE * effectiveTextScale),
              fontWeight: TRANSLITERATION_FONT_WEIGHT,
              lineHeight: TRANSLITERATION_LINE_HEIGHT,
              fontFamily: FONT_TRANSLITERATION_FAMILY,
              color: TRANSLITERATION_COLOR,
              letterSpacing: TRANSLITERATION_LETTER_SPACING,
              marginTop: TRANSLITERATION_MARGIN_TOP,
              textShadow: TEXT_SHADOW_STRONG,
            }}
          >
            {latinSurahTitle}
          </div>
        ) : null}
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
