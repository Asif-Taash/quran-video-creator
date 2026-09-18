"use client";

import React, { useEffect } from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  Loop,
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
import { ARABIC_FONT_OPTIONS, TRANSLATION_FONT_OPTIONS, type ArabicFontKey, type QuranVideoProps, type TranslationFontKey, type VerseMapping } from "./types";

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

const FONT_TRANSLITERATION_PATH = "fonts/video-fonts/Sansita-Bold.ttf";
const FONT_TRANSLITERATION_FAMILY = "Sansita";

const FONT_TRANSLATION_PATH = "fonts/video-fonts/Aileron-Thin.otf";
const FONT_TRANSLATION_FAMILY = "Aileron Thin";

// Every selectable translation font (see TRANSLATION_FONT_OPTIONS in
// types.ts, whose keys this mirrors exactly), self-hosted the same way as
// every other font in this file -- see PageFontStyles, which declares a
// @font-face for each entry unconditionally, same as it already does for
// e.g. FONT_UTHMANIC_HAFS_FAMILY regardless of whether that one's picked.
// All three new ones (Inter/Noto Sans/Poppins) were fetched as a
// Turkish-alphabet-scoped WOFF2 subset (covers Ç ç Ğ ğ İ ı Ö ö Ş ş Ü ü)
// specifically because the translation text is Turkish.
const TRANSLATION_FONT_FILES: Record<
  TranslationFontKey,
  { path: string; format: "opentype" | "woff2"; weight: number }
> = {
  aileron: { path: FONT_TRANSLATION_PATH, format: "opentype", weight: 300 },
  inter: { path: "fonts/video-fonts/Inter-Regular.woff2", format: "woff2", weight: 400 },
  notosans: { path: "fonts/video-fonts/NotoSans-Regular.woff2", format: "woff2", weight: 400 },
  poppins: { path: "fonts/video-fonts/Poppins-Regular.woff2", format: "woff2", weight: 400 },
};

const TRANSLATION_FONT_SIZE = 24;
const TRANSLATION_LINE_HEIGHT = 1.625;
const TRANSLATION_COLOR = "white";
const TRANSLATION_MARGIN_TOP = 10;
// Default/fallback family string -- used wherever a translationFont prop
// hasn't been resolved yet (module-level references only; the actual
// component always resolves its own from the translationFont prop, see
// resolvedTranslationFontFamily below).
const TRANSLATION_FONT_FAMILY = `${FONT_TRANSLATION_FAMILY}, Arial, sans-serif`;
// Fixed family name for a user-uploaded translation font (translationFont
// === "custom") -- unlike the built-in TRANSLATION_FONT_FILES registry,
// there's exactly one of these per project, so one constant name is
// enough; PageFontStyles declares its @font-face only when a URL is
// actually present.
const CUSTOM_TRANSLATION_FONT_FAMILY = "CustomTranslationFont";

const TEXT_SHADOW = "0 1px 2px rgba(0,0,0,0.6), 0 0 6px rgba(0,0,0,0.4)";
const TEXT_SHADOW_STRONG = "0 2px 4px rgba(0,0,0,0.7), 0 0 12px rgba(0,0,0,0.4)";

const ANIMATION_FADE_DURATION_FRAMES = Math.round(0.7 * FPS);

const CROSSFADE_DURATION_FRAMES = Math.round(0.3 * FPS);

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

// Splits `total` items across `numLines` lines with counts that never
// increase from one line to the next (e.g. total=10, numLines=3 -> [4,3,3],
// never [3,3,4]) -- the front-loaded remainder guarantees this by
// construction for any input, no search/heuristic needed. Shared by
// formatInvertedPyramid (translation) and formatArabicVerse below; both
// need the SAME "first line is always the longest" guarantee.
function distributeCountsNonIncreasing(total: number, numLines: number): number[] {
  const base = Math.floor(total / numLines);
  const remainder = total - base * numLines;
  return Array.from({ length: numLines }, (_, i) => base + (i < remainder ? 1 : 0));
}

// Distributes `words` across the fewest non-increasing-count lines (see
// distributeCountsNonIncreasing) that fit `maxLineChars` per line, starting
// the search at `startNumLines` and growing by one at a time until every
// line fits (or there's one line per word, the most it could ever take).
// `firstLineExtraLength` is only charged against the FIRST line's budget --
// used for the ayah-number prefix ("26. ") on a segment's very first line.
// Shared by both formatInvertedPyramid branches below: the automatic
// whole-text pyramid, and each individual chunk of a manually-broken one --
// so a manual chunk that's still too long for the current width/scale (e.g.
// after the user later narrows the box) gets exactly the same overflow
// protection the fully-automatic path already had, instead of silently
// running past the edge of the box.
function wrapWordsToFit(words: string[], maxLineChars: number, firstLineExtraLength: number, startNumLines: number): string[] {
  if (words.length === 0) return [""];
  let numLines = Math.max(1, Math.min(startNumLines, words.length));
  let lines: string[];
  while (true) {
    const counts = distributeCountsNonIncreasing(words.length, numLines);
    let idx = 0;
    lines = counts.map((count) => {
      const line = words.slice(idx, idx + count).join(" ");
      idx += count;
      return line;
    });
    const fits = (lines[0].length + firstLineExtraLength) <= maxLineChars && lines.slice(1).every((l) => l.length <= maxLineChars);
    if (fits || numLines >= words.length) break;
    numLines++;
  }
  return lines;
}

function formatInvertedPyramid(text: string, forceTwoLines = true, textScale = 1, prefixLength = 0, textWidthScale = 1): React.ReactNode {
  if (!text) return null;

  // Maximum allowed characters per visual line to completely avoid native browser
  // wrapping. textWidthScale (user-draggable, see VideoPreviewPlayer's width
  // handles) narrows OR widens this independently of textScale (font size) --
  // 1 is the original/default width, matching the translation <div>'s own
  // width below exactly so the character budget and the visible box never
  // disagree. No artificial ceiling below the actual word count: narrowed
  // far enough, every word can end up on its own line.
  const MAX_LINE_CHARS = Math.floor((48 * textWidthScale) / textScale);

  let lines: string[];

  if (text.includes("\n")) {
    // The user manually placed one or more line breaks (SegmentTimingEditor's
    // translation textarea -- a plain <textarea>, so Enter already lands a
    // real "\n" in translation_text; this is the only place that actually
    // reads it). Each manually-separated chunk stays its OWN line-group
    // verbatim -- none of the "collapse short text to one line"/"always at
    // least 2 lines" pyramid aesthetics below apply, since the user has
    // already made that call explicitly. A chunk still gets wrapped into
    // MORE lines via wrapWordsToFit if it's too long to fit on one at the
    // CURRENT width/scale (e.g. the box was narrowed after the break was
    // placed) -- manual control over where lines split, not an exemption
    // from ever overflowing the box.
    const chunks = text.split("\n");
    lines = chunks.flatMap((chunk, i) => {
      const chunkWords = chunk.split(" ").filter(Boolean);
      return wrapWordsToFit(chunkWords, MAX_LINE_CHARS, i === 0 ? prefixLength : 0, 1);
    });
  } else {
    const words = text.split(" ");

    // Don't force two lines if the text is very short -- but only at/above
    // the original width. Once the user has deliberately narrowed the box
    // (textWidthScale < 1, dragged via VideoPreviewPlayer's width handles),
    // even originally-short text must be free to respond by wrapping into
    // more lines -- that's the entire point of the control. Dragging back out
    // to the original width restores this exact original behavior.
    if (forceTwoLines && textWidthScale >= 1 && (text.length < 30 || words.length <= 4)) {
      forceTwoLines = false;
    }

    if (words.length <= 4 && forceTwoLines === false) return text;

    const totalChars = text.length + prefixLength;
    const MAX_LINES = words.length;

    let numLines = Math.ceil(totalChars / MAX_LINE_CHARS);
    // The "always at least 2 lines" pyramid look is the DEFAULT-width
    // aesthetic (this function's whole reason for existing) -- only enforced
    // at/below the original width. Widened past it, text that now actually
    // fits within the (larger) budget is free to collapse back down, even to
    // a single line -- that's the entire point of the widen control.
    if (forceTwoLines && textWidthScale <= 1 && numLines < 2) numLines = 2;
    if (!forceTwoLines && numLines < 2) return text;
    numLines = Math.max(1, Math.min(numLines, MAX_LINES, words.length));

    lines = wrapWordsToFit(words, MAX_LINE_CHARS, prefixLength, numLines);
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

function formatArabicVerse(text: string, arabicWidthScale = 1): React.ReactNode {
  if (!text) return null;
  const words = text.split(" ");

  const totalWords = words.length;
  // A single line fits about 6 to 7 PUA words on mobile before wrapping
  // natively. arabicWidthScale (user-draggable, see VideoPreviewPlayer's
  // Arabic width handles) narrows OR widens this independently of the
  // translation's own width control -- 1 is the original/default width, and
  // it's no longer clamped to never exceed that: widened past it (up to
  // render/route.ts's own safe ceiling), more words can fit per line, even
  // collapsing the whole verse onto one.
  const baseMaxWordsPerLine = 8;
  const maxWordsPerLine = Math.max(2, Math.round(baseMaxWordsPerLine * arabicWidthScale));

  // "Return as a single line" is the original, unchanged behavior at/above
  // the default width -- exactly like formatInvertedPyramid's identical
  // check for the translation. Below it, even an originally-short verse
  // must respond to narrowing. Above it, a verse that wouldn't have fit at
  // the default width can now qualify too, since maxWordsPerLine itself
  // grew with the widening.
  if (totalWords <= maxWordsPerLine && arabicWidthScale >= 1) {
    return text;
  }

  // No artificial ceiling below the actual word count -- narrowed far
  // enough, every word can end up on its own line.
  const MAX_LINES = totalWords;
  let numLines = Math.min(MAX_LINES, Math.ceil(totalWords / maxWordsPerLine));
  // Same DEFAULT-width-only "at least 2 lines" floor as the translation --
  // only below/at the original width, so widening can still collapse a
  // verse all the way down to one line once it fits.
  if (arabicWidthScale <= 1) numLines = Math.max(2, numLines);
  numLines = Math.max(1, numLines);

  // Word counts are always non-increasing line to line (first line longest)
  // by construction -- see distributeCountsNonIncreasing above
  // (formatInvertedPyramid uses the exact same guarantee for the
  // translation). If a line still exceeds maxWordsPerLine after
  // distributing, add one more line and redistribute, up to MAX_LINES.
  let lines: string[];
  while (true) {
    const counts = distributeCountsNonIncreasing(totalWords, numLines);
    let idx = 0;
    lines = counts.map((count) => {
      const line = words.slice(idx, idx + count).join(" ");
      idx += count;
      return line;
    });
    if (counts[0] <= maxWordsPerLine || numLines >= Math.min(MAX_LINES, totalWords)) break;
    numLines++;
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
  arabicFont = "qcf2",
  showNumber = true,
  compact = false,
  segmentKey,
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
}) {
  const frame = useCurrentFrame();
  const maxFadeIn = Math.min(Math.round(0.6 * 30), Math.floor(durationInFrames * 0.45));
  const maxFadeOut = Math.min(Math.round(0.6 * 30), Math.floor(durationInFrames * 0.45));

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
            fontFamily: page ? (arabicFont === "qcf1" ? `'pv1-${page}'` : `'p${page}'`) : VERSE_FONT_FAMILY_FALLBACK,
            fontSize: resolvedVerseFontSize,
            fontWeight: VERSE_FONT_WEIGHT,
            lineHeight: VERSE_LINE_HEIGHT,
            textShadow: TEXT_SHADOW,
            width: `${Math.round(arabicWidthScale * 100)}%`,
          }}
        >
          {formatArabicVerse(text, arabicWidthScale)}
        </div>
        {translation ? (
          <div
            dir="ltr"
            data-text-block="translation"
            data-segment-key={segmentKey}
            style={{
              textAlign: "center",
              color: TRANSLATION_COLOR,
              fontFamily: translationFontFamily,
              fontSize: Math.round(TRANSLATION_FONT_SIZE * translationTextScale),
              lineHeight: TRANSLATION_LINE_HEIGHT,
              marginTop: TRANSLATION_MARGIN_TOP,
              width: `${Math.round(translationWidthScale * 100)}%`,
            }}
          >
            {showNumber && `${verseId}. `}{formatInvertedPyramid(translation, true, translationTextScale, showNumber ? `${verseId}. `.length : 0, translationWidthScale)}
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
      {/* Top half for Arabic */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
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
            fontFamily: page ? (arabicFont === "qcf1" ? `'pv1-${page}'` : `'p${page}'`) : VERSE_FONT_FAMILY_FALLBACK,
            fontSize: resolvedVerseFontSize,
            fontWeight: VERSE_FONT_WEIGHT,
            lineHeight: VERSE_LINE_HEIGHT,
            textShadow: TEXT_SHADOW,
            width: `${Math.round(arabicWidthScale * 100)}%`,
          }}
        >
          {formatArabicVerse(text, arabicWidthScale)}
        </div>
      </div>

      {/* Bottom half for Translation */}
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
            dir="ltr"
            data-text-block="translation"
            data-segment-key={segmentKey}
            style={{
              textAlign: "center",
              color: TRANSLATION_COLOR,
              fontFamily: translationFontFamily,
              fontSize: Math.round(TRANSLATION_FONT_SIZE * translationTextScale),
              lineHeight: TRANSLATION_LINE_HEIGHT,
              marginTop: TRANSLATION_MARGIN_TOP,
              width: `${Math.round(translationWidthScale * 100)}%`,
            }}
          >
            {showNumber && `${verseId}. `}{formatInvertedPyramid(translation, true, translationTextScale, showNumber ? `${verseId}. `.length : 0, translationWidthScale)}
          </div>
        ) : null}
      </div>
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
      const { family } = TRANSLATION_FONT_OPTIONS[key];
      const { path, format, weight } = TRANSLATION_FONT_FILES[key];
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

export function QuranVideo({
  surahNameArabic,
  surahNameTransliteration,
  backgroundImagePath,
  backgroundVideoPath,
  backgroundVideoDurationInFrames,
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
  arabicFont = "qcf2",
}: QuranVideoProps) {
  // Resolved ONCE here from the translationFont prop (see
  // TRANSLATION_FONT_FILES) and threaded down to every place that used to
  // reference the module-level TRANSLATION_FONT_FAMILY constant directly --
  // that constant now only exists as the fallback default. "custom" (a
  // user-uploaded font, see PageFontStyles' own @font-face for it) falls
  // back to the original Aileron family whenever no file has actually been
  // uploaded yet -- e.g. right after picking "custom" in the UI but before
  // the upload finishes -- rather than resolving to a family nothing
  // declared, which would silently show the browser's plain default font.
  const resolvedTranslationFontFamily =
    translationFont === "custom" && customTranslationFontUrl
      ? `${CUSTOM_TRANSLATION_FONT_FAMILY}, Arial, sans-serif`
      : `${TRANSLATION_FONT_OPTIONS[translationFont === "custom" ? "aileron" : translationFont].family}, Arial, sans-serif`;
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

  useEffect(() => {
    const fontHandle = delayRender("Loading Quran video fonts");
    Promise.all([
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
      document.fonts.load(
        `${Math.round(TRANSLATION_FONT_SIZE * effectiveTranslationTextScale)}px "${
          translationFont === "custom" && customTranslationFontUrl
            ? CUSTOM_TRANSLATION_FONT_FAMILY
            : TRANSLATION_FONT_OPTIONS[translationFont === "custom" ? "aileron" : translationFont].family
        }"`
      ),
      document.fonts.ready,
    ])
      .catch(() => undefined)
      .finally(() => continueRender(fontHandle));
  }, [
    verses,
    effectiveTextScale,
    effectiveArabicTextScale,
    effectiveTranslationTextScale,
    translationFont,
    customTranslationFontUrl,
    arabicFont,
  ]);

  const frame = useCurrentFrame();
  const headerFadeInEnd = ANIMATION_FADE_DURATION_FRAMES;
  const headerFadeOutStart = totalDurationInFrames - ANIMATION_FADE_DURATION_FRAMES;
  const headerOpacity = interpolate(
    frame,
    [0, headerFadeInEnd, headerFadeOutStart, totalDurationInFrames],
    [0, 0.5, 0.5, 0],
    { easing: easeInOut, extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  let startFrame = 0;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <PageFontStyles verses={verses} customTranslationFontUrl={customTranslationFontUrl} />

      {backgroundVideoPath ? (
        <AbsoluteFill>
          {/* Loop needs the video's own natural length to replay it seamlessly
              instead of freezing on its last frame once the (audio-driven)
              total duration outlasts it -- and works just as correctly when
              the video is instead LONGER than the total duration, since it
              then simply never completes its first cycle. Older
              drafts/renders saved before backgroundVideoDurationInFrames
              existed fall back to the full timeline length, i.e. no looping
              (the best that's possible without re-probing the file). */}
          <Loop durationInFrames={backgroundVideoDurationInFrames || totalDurationInFrames}>
            <OffthreadVideo
              src={getAssetUrl(backgroundVideoPath)}
              muted
              onError={handleMediaError("background video", getAssetUrl(backgroundVideoPath))}
              style={{
                position: "absolute",
                width: "100%",
                height: "100%",
                objectFit: "cover",
                opacity: 0.8,
              }}
            />
          </Loop>
        </AbsoluteFill>
      ) : backgroundImagePath ? (
        <AbsoluteFill>
          <Img
            src={getAssetUrl(backgroundImagePath)}
            onError={handleImageError("background image", getAssetUrl(backgroundImagePath))}
            style={{
              position: "absolute",
              width: "100%",
              height: "100%",
              objectFit: "cover",
              opacity: 0.8,
            }}
          />
        </AbsoluteFill>
      ) : null}

      {globalAudioPath ? (
        <Audio
          src={getAssetUrl(globalAudioPath)}
          onError={handleMediaError("audio", getAssetUrl(globalAudioPath))}
        />
      ) : null}

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
            durationInFrames={d}
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

              return mappings.map((mapping, idx) => {
                const totalWords = mappings.reduce((sum, m) => sum + m.word_count, 0);
                const previousWords = mappings.slice(0, idx).reduce((sum, m) => sum + m.word_count, 0);

                const allWords = arabicVerseText.trim().split(/\s+/);

                // Proportional fallback (used only when real per-word audio
                // timing isn't available for this verse, e.g. custom audio
                // that wasn't aligned by the backend).
                let chunkStartFrame = Math.round((previousWords / totalWords) * d);
                let chunkDuration = idx === mappings.length - 1
                  ? d - chunkStartFrame
                  : Math.round((mapping.word_count / totalWords) * d);

                const startWordIdx = previousWords;
                const endWordIdx = previousWords + mapping.word_count - 1;

                if (
                  (!globalAudioPath || isAudioExtracted) &&
                  verse.wordTimings &&
                  endWordIdx < verse.wordTimings.length
                ) {
                  // Direct index lookup: mapping.word_count is a count of REAL
                  // Uthmani words, and wordTimings is aligned/ordered the same
                  // way by the backend's forced alignment — no text matching
                  // needed, so there's nothing here that can silently drift or
                  // lock onto the wrong occurrence of a repeated word.
                  const startMs = verse.wordTimings[startWordIdx].start;
                  // This segment's OWN last word end — not the next segment's
                  // start. Any natural pause between segments is simply not
                  // covered by either segment's Sequence, so the text
                  // disappears the instant the last letter is pronounced
                  // instead of lingering through the silence until the next
                  // segment begins.
                  const endMs = verse.wordTimings[endWordIdx].end;

                  chunkStartFrame = Math.round((startMs / 1000) * 30); // FPS is 30
                  chunkDuration = Math.max(1, Math.round(((endMs - startMs) / 1000) * 30));
                }

                // Manual override from the waveform-based SegmentTimingEditor
                // takes absolute priority over everything above — the user
                // heard the audio directly and placed this boundary
                // themselves, so no automatic computation (word-timing
                // lookup or proportional fallback) should second-guess it.
                // Already verse-relative milliseconds by the time it reaches
                // here (render/route.ts normalizes it the same way as
                // wordTimings before building this prop).
                if (typeof mapping.start_ms === "number" && typeof mapping.end_ms === "number") {
                  chunkStartFrame = Math.round((mapping.start_ms / 1000) * 30);
                  chunkDuration = Math.max(1, Math.round(((mapping.end_ms - mapping.start_ms) / 1000) * 30));
                }

                // SegmentTimingEditor already resolved and validated this
                // exact segment's Arabic text -- trusted verbatim for EVERY
                // segment (not just "repeat" ones) so what renders always
                // matches what the editor showed. The cumulative word/glyph-
                // token slicing below is used only as a fallback for
                // segments saved before this field existed, since that math
                // can drift on a long, multi-part ayah and leave the LAST
                // segment's chunk empty (see its own comment further down).
                let chunkText: string;
                if (typeof mapping.arabic_text === "string" && mapping.arabic_text.length > 0) {
                  chunkText = mapping.arabic_text;
                } else {
                  // Convert the real-word range [startWordIdx, endWordIdx] into a
                  // QCF glyph-token range using puaTokenCounts, since `text` is
                  // page-glyph text where one real word can span >1 whitespace
                  // token. Falls back to a 1:1 assumption when unavailable.
                  let puaStart = startWordIdx;
                  let puaEnd = previousWords + mapping.word_count;
                  if (arabicVersePuaTokenCounts && arabicVersePuaTokenCounts.length === totalWords) {
                    puaStart = arabicVersePuaTokenCounts.slice(0, startWordIdx).reduce((a, b) => a + b, 0);
                    puaEnd = puaStart + arabicVersePuaTokenCounts.slice(startWordIdx, startWordIdx + mapping.word_count).reduce((a, b) => a + b, 0);
                  }
                  // Trailing QCF glyph tokens (waqf marks, the ayah-number
                  // marker) sit past totalWords in both the naive fallback and
                  // any undercounted puaTokenCounts map -- always let the LAST
                  // segment of a split ayah reach the true end of allWords so
                  // it never renders without its ayah-ending number glyph.
                  // Fused onto the last real word with no separating space
                  // (matching Mushaf typesetting, and keeping it from being
                  // treated as its own wrappable "word" by VerseScene's
                  // line-breaking, which would isolate it on its own line).
                  const coreWords = allWords.slice(puaStart, puaEnd);
                  let chunkWords = coreWords;
                  if (idx === mappings.length - 1) {
                    const trailing = allWords.slice(puaEnd, allWords.length);
                    if (trailing.length > 0) {
                      chunkWords = [...coreWords.slice(0, -1), (coreWords[coreWords.length - 1] ?? "") + trailing.join("")];
                    }
                  }
                  chunkText = chunkWords.join(" ");
                  // The 1:1 real-word-to-glyph-token assumption right above
                  // is never guaranteed for qcf1 (puaTokenCounts, the thing
                  // that would make this exact, is deliberately never
                  // computed for it -- see this file's own comment on that).
                  // For a segment deep enough into a long, multi-part ayah,
                  // enough drift between the two counts can push the sliced
                  // range past the end of allWords entirely, producing a
                  // blank chunkText instead of merely a slightly wrong one.
                  // Showing the WHOLE verse's text for that one segment
                  // (still correctly qcf1, still readable) is a far smaller
                  // fault than showing nothing at all.
                  if (isQcf1 && chunkText.trim().length === 0) {
                    chunkText = arabicVerseText;
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
                      showNumber={mapping.isFirstOfAyah ?? idx === 0}
                      segmentKey={segmentKey}
                      compact={!isPortrait}
                    />
                  </Sequence>
                );
              });
            })()}
          </Sequence>
        );
      })}

      <AbsoluteFill
        style={{
          alignItems: "center",
          paddingTop: HEADER_PADDING_TOP,
          color: "white",
          fontFamily: resolvedTranslationFontFamily,
          opacity: headerOpacity,
        }}
      >
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
          {surahNameArabic}
        </div>
        {surahNameTransliteration ? (
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
            {surahNameTransliteration} SURESİ
          </div>
        ) : null}
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
