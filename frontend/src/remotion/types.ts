export type VerseMapping = {
  part: number;
  translation_text: string;
  // Count of REAL Uthmani words (not QCF glyph tokens) this segment covers —
  // indexes directly into wordTimings, which is aligned the same way.
  word_count: number;
  // A boundary the user moved in the waveform-based SegmentTimingEditor --
  // overrides the word-derived edge on its own side only (see
  // remotion/timing.ts for the rule). As saved, both are on the untrimmed
  // prepared clip's timeline and set together; in the props QuranVideo.tsx
  // receives they are verse-relative milliseconds (same space as
  // wordTimings), and only the edges that differ from the words remain.
  start_ms?: number;
  end_ms?: number;
  // Explicit, already-resolved Arabic text for this segment, straight from
  // SegmentTimingEditor -- saved for reference/debugging, but frozen in
  // whichever QCF encoding was selected at save time, so trusting it
  // verbatim after a LATER arabicFont switch renders garbled glyphs (right
  // encoding for the font it was saved under, wrong one for whatever's
  // picked now). Both QuranVideo.tsx and VideoCreatorForm.tsx's
  // buildTimingEditorSegments deliberately IGNORE this for every segment,
  // including "repeat" ones (repeat_of_part below) -- a repeat used to be
  // the one exception that still trusted this snapshot, since it re-
  // displays an EARLIER segment's exact words rather than the "next"
  // sequential range the cumulative word_count math assumes, but both now
  // instead re-derive live from the SOURCE part's own word range (the one
  // repeat_of_part points at), through the exact same real-word -> QCF
  // glyph-token slicing every other segment already used -- reported as
  // "a repeated/duplicated segment shows garbage after switching to the
  // old font", fixed the same way the original non-repeat version of this
  // bug was. Only falls back to this frozen field (then to the repeat's
  // OWN, generally wrong, range) if the source part no longer exists --
  // e.g. the segmentation was re-split/merged since the repeat was made.
  arabic_text?: string;
  // Which EARLIER segment (1-based `part` number, same ayah) this one is a
  // "repeat" of -- see arabic_text above. Set once by
  // VideoCreatorForm.tsx's handleSaveTimingEditor from SegmentTimingEditor's
  // own repeatOfId, translated into a part number stable across the
  // session-local ids SegmentTimingEditor regenerates on every reopen.
  repeat_of_part?: number;
  // Not shown in this appearance of the ayah: when the reciter goes back to
  // an ayah after the next one began, the ayah appears again and each
  // appearance shows only its own chunks (set by remotion/timing.ts).
  hidden?: boolean;
  // Whether this segment displays the ayah number before its translation.
  // Tied to the segment's own content/origin (set once when the segment is
  // first created, then carried through duplicate/split/merge in
  // SegmentTimingEditor) rather than recomputed from array position -- a
  // duplicated "first chunk of the ayah" segment must keep showing the
  // number no matter where it ends up in the timeline. Falls back to
  // `idx === 0` in QuranVideo.tsx for older saved data that predates this
  // field.
  isFirstOfAyah?: boolean;
  // Per-SEGMENT size/width overrides -- each displayed segment (this exact
  // mapping, shown for its own Sequence window in QuranVideo.tsx) can be
  // resized completely independently of every other segment, including
  // other segments of the SAME ayah. Set via VideoPreviewPlayer's
  // hover-to-select box (which now edits whichever segment is on screen at
  // the moment you drag, not a single video-wide value) and read back by
  // QuranVideo.tsx, falling back to the top-level QuranVideoProps fields of
  // the same name (themselves falling back to `textScale`) when a segment
  // has never been individually resized -- so older saved data with no
  // per-segment overrides at all renders exactly as it always did.
  arabicTextScale?: number;
  arabicWidthScale?: number;
  translationTextScale?: number;
  translationWidthScale?: number;
};

export type WordTiming = {
  w: string;
  start: number;
  end: number;
};

export type QuranVerse = {
  id: number;
  text: string;
  translation: string;
  durationInFrames: number;
  audioPath: string;
  page?: number;
  // Parallel Arabic text/page in the OLD QCF v1 PUA encoding (2005 King
  // Fahd Complex print) -- a completely different set of PUA codepoints
  // from `text`/`page` above (QCF v2, 2013), needing its own font per page
  // (see ARABIC_FONT_OPTIONS/QuranVideo.tsx's ARABIC_FONT_V1_DIR). Always
  // populated alongside text/page (not just when arabicFont picks it) so
  // switching the choice in the live preview is instant, client-side only
  // -- same reasoning as translationFont. Sourced from quran.com's public
  // API (code_v1), fetched once into quran-qcf-v1.json; the actual QCF v1
  // font FILES are self-hosted separately (provided directly, see
  // public/fonts/2005/QCF_BSML.fonts).
  textV1?: string;
  pageV1?: number;
  mappings?: VerseMapping[];
  wordTimings?: WordTiming[];
  // Every later reading of a word (the reciter went back), on wordTimings'
  // timeline: `i` indexes wordTimings. Only the word highlight uses them.
  wordRepeats?: { i: number; start: number; end: number }[];
  // Per-real-word count of QCF v2 glyph tokens in `text` (same order as
  // wordTimings). Lets a real-word range from `mappings` be converted into
  // the glyph-token range needed to slice `text` for display. Deliberately
  // NOT computed/used for textV1 -- QuranVideo.tsx falls back to its
  // existing 1:1 real-word assumption for that case (same tolerant path
  // already used whenever this is unavailable for v2 too).
  puaTokenCounts?: number[];
  // The same per-real-word glyph-token counts, but sent for EVERY verse
  // (not just split ones) while word highlighting is on, and used ONLY to
  // map the word being recited onto the glyphs on screen. Kept apart from
  // puaTokenCounts because that one also decides how a verse's text is
  // sliced, and setting it on an unsplit verse would change its layout
  // (the ayah-number glyph would stop being fused onto the last word).
  highlightGlyphCounts?: number[];
  absoluteStartFrame?: number;
};

export const DEFAULT_BACKGROUND_DIM = 0.2;
export const WORD_HIGHLIGHT_COLORS = ["#F2C14E", "#6EE7B7", "#7DD3FC", "#FDA4AF"] as const;
export const DEFAULT_WORD_HIGHLIGHT_COLOR = WORD_HIGHLIGHT_COLORS[0];
export const BACKGROUND_DIM_MAX = 0.85;
export const BACKGROUND_BLUR_MAX = 24;

export type AspectRatio = "portrait" | "landscape" | "square";

// Single source of truth for the pixel dimensions behind each aspect ratio --
// shared by Root.tsx (calculateMetadata), render/route.ts (renderMedia's
// composition) and VideoPreviewPlayer.tsx (the live <Player>) so all three
// can never drift apart on what e.g. "landscape" actually measures.
export const ASPECT_RATIO_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  portrait: { width: 720, height: 1280 },
  landscape: { width: 1280, height: 720 },
  square: { width: 1080, height: 1080 },
};

// Output quality tiers, from worst to 4K. Deliberately implemented as a
// uniform multiplier applied on top of ASPECT_RATIO_DIMENSIONS via
// renderMedia's own `scale` option (see render/route.ts) rather than by
// changing the composition's width/height directly -- every font-size/
// line-wrap constant in QuranVideo.tsx is tuned in real pixels against
// useVideoConfig()'s canvas size, so scaling the *output* instead of the
// *composition* keeps that math (and the live preview, which never sees
// `quality` at all) completely untouched. "720p" (the default) is scale 1
// for portrait/landscape; square's 1080x1080 canvas scales down to it (see
// qualityScale below).
export type QualityTier =
  | "144p"
  | "240p"
  | "360p"
  | "480p"
  | "720p"
  | "1080p"
  | "1440p"
  | "2160p";

// The tier names the output's SHORT side, like YouTube's labels: 1080p is
// 1080x1920 portrait, 1920x1080 landscape and 1080x1080 square. A plain
// 1080/720 multiplier applied to square's 1080x1080 canvas used to export
// 1620x1620 -- 2.25x the pixels the label promised, and as much slower.
export const QUALITY_SHORT_SIDE: Record<QualityTier, number> = {
  "144p": 144,
  "240p": 240,
  "360p": 360,
  "480p": 480,
  "720p": 720,
  "1080p": 1080,
  "1440p": 1440,
  "2160p": 2160,
};

export function qualityScale(quality: QualityTier, aspectRatio: AspectRatio): number {
  const { width, height } = ASPECT_RATIO_DIMENSIONS[aspectRatio];
  return QUALITY_SHORT_SIDE[quality] / Math.min(width, height);
}

// Real-world (YouTube-style) upload bitrate guides, not a pure quadratic
// function of pixel count -- keeps 4K's file size reasonable instead of
// exploding just because it has 9x the pixels of 720p.
export const QUALITY_BITRATE: Record<QualityTier, string> = {
  "144p": "150K",
  "240p": "400K",
  "360p": "800K",
  "480p": "1.5M",
  "720p": "3M",
  "1080p": "5M",
  "1440p": "10M",
  "2160p": "20M",
};

// Multiplies the base render timeout -- higher tiers take noticeably longer
// to rasterize (headless Chromium) and encode (libx264 is CPU-only here,
// there's no GPU-accelerated encode path), independent of clip length.
export const QUALITY_TIMEOUT_MULTIPLIER: Record<QualityTier, number> = {
  "144p": 1,
  "240p": 1,
  "360p": 1,
  "480p": 1,
  "720p": 1,
  "1080p": 1.5,
  "1440p": 2,
  "2160p": 3,
};

export const QUALITY_TIER_OPTIONS: { value: QualityTier; label: string }[] = [
  { value: "144p", label: "144p" },
  { value: "240p", label: "240p" },
  { value: "360p", label: "360p" },
  { value: "480p", label: "480p" },
  { value: "720p", label: "720p" },
  { value: "1080p", label: "1080p" },
  { value: "1440p", label: "1440p (2K)" },
  { value: "2160p", label: "2160p (4K)" },
];

export type QuranVideoProps = {
  surahNameArabic: string;
  surahNameTransliteration: string;
  // The Latin line under the Arabic surah name, already in the video's
  // language ("YÛNUS SURESİ", "SURAH YUNUS"); "" hides it (an Arabic video,
  // where the Arabic name above already says it). Omitted on projects saved
  // before this existed, which keep the original Turkish line.
  surahTitle?: string;
  // An Arabic video's second header line: the reciter's name, in Arabic,
  // where other languages show surahTitle (which is "" for Arabic). Absent
  // or "" keeps the Arabic surah name alone and centered.
  reciterName?: string;
  backgroundImagePath: string | null;
  // When set, takes priority over backgroundImagePath and is rendered
  // muted/looped instead (see QuranVideo.tsx). backgroundVideoDurationInFrames
  // is the video's own natural length (probed server-side via ffprobe in
  // render/route.ts) -- required to loop it seamlessly with Remotion's
  // <Loop> rather than just letting it freeze on its last frame once shorter
  // than the audio-driven total duration.
  backgroundVideoPath?: string | null;
  backgroundVideoDurationInFrames?: number | null;
  // How the background image/video is shown, set in Step2Background.tsx.
  // backgroundDim darkens it (0 = untouched, BACKGROUND_DIM_MAX = nearly
  // black) and defaults to 0.2 -- the original fixed 0.8 opacity over black,
  // so older drafts/renders look exactly as before. backgroundBlur is a CSS
  // blur radius in composition pixels (renderMedia's quality `scale` grows
  // it with everything else). backgroundZoom slowly pushes in over the
  // whole video (a Ken Burns move) -- mostly for still images.
  backgroundDim?: number;
  backgroundBlur?: number;
  backgroundZoom?: boolean;
  // Draws the Arabic word currently being recited in wordHighlightColor
  // (needs aligned word timing, i.e. a built-in reciter or an aligned
  // upload). Off by default, so older drafts/renders look as before.
  wordHighlight?: boolean;
  wordHighlightColor?: string;
  globalAudioPath?: string | null;
  isAudioExtracted?: boolean;
  verses: QuranVerse[];
  totalDurationInFrames: number;
  // General/legacy scale -- still drives the surah-name/transliteration
  // header's size (not independently controllable), and is the fallback
  // default for arabicTextScale/translationTextScale below when they're
  // unset, so an older saved draft/render with only this field (or nothing
  // at all) looks exactly as it always did.
  textScale?: number;
  // Fully independent of each other -- the Arabic verse and the translation
  // each get their own size and line-wrap-width control, set directly on
  // the live preview (VideoPreviewPlayer's two separate slider/drag-handle
  // pairs). 1 = original/default for both. The *WidthScale fields narrow
  // only that block's own box/line-wrap budget; capped at 1 in
  // render/route.ts (can only ever force MORE line breaks than the
  // default, never risk new overflow by exceeding it).
  arabicTextScale?: number;
  arabicWidthScale?: number;
  translationTextScale?: number;
  translationWidthScale?: number;
  // Defaults to "portrait" everywhere it's read (Root.tsx, QuranVideo.tsx,
  // render/route.ts, VideoPreviewPlayer.tsx) so older saved drafts/data
  // without this field keep rendering exactly as before.
  aspectRatio?: AspectRatio;
  // Which translation font to use -- one of TRANSLATION_FONT_OPTIONS' keys,
  // or "custom" to use a user-uploaded font file instead (see
  // customTranslationFontUrl below). Defaults to "aileron" (the original,
  // only-ever font) everywhere it's read, same reasoning as aspectRatio
  // above.
  translationFont?: TranslationFontKey | "custom";
  // The uploaded font file's URL, only meaningful when translationFont is
  // "custom" -- resolved through QuranVideo.tsx's own getAssetUrl the same
  // way background images/custom audio already are, so it works both live
  // in the browser preview and during the actual server-side render.
  customTranslationFontUrl?: string;
  // The selected translation is right-to-left (an Arabic tafsir, see
  // translationOptions.ts). Its text then renders RTL, in translationFont if
  // that's one of the Arabic fonts (see TRANSLATION_FONT_OPTIONS' languages),
  // otherwise in the default Arabic one.
  translationRtl?: boolean;
  // Which Arabic verse script/font to use -- one of ARABIC_FONT_OPTIONS'
  // keys below. Defaults to "qcf2" (the original, only-ever font -- 2013
  // King Fahd Complex print) everywhere it's read, same reasoning as
  // aspectRatio above.
  arabicFont?: ArabicFontKey;
};

// Languages a translation font can serve -- the same set as
// translationOptions.ts' TranslationLanguage (kept local so this
// Remotion-side module doesn't import app code).
export type TranslationFontLanguage = "tr" | "en" | "ar";

// The full set of translation fonts QuranVideo.tsx knows how to render, each
// self-hosted under public/ (`file`) and declared by PageFontStyles /
// Step1SurahVerse.tsx. `languages` is which translation languages the font's
// glyphs actually cover (checked with fc-query against Turkish letters
// Ç ç Ğ ğ İ ı Ö ö Ş ş Ü ü, basic Latin, and Arabic letters/digits/
// punctuation), so the font picker only offers fonts that can render the
// selected translation. The Latin fonts are Turkish-alphabet-scoped WOFF2
// subsets (enough for English too); the Arabic ones are SIL OFL 1.1 fonts
// from the Google Fonts repository. `weight` is the CSS font-weight value,
// a range for variable fonts.
export const TRANSLATION_FONT_OPTIONS = {
  aileron: { label: "Aileron", family: "Aileron Thin", file: "fonts/video-fonts/Aileron-Thin.otf", format: "opentype", weight: "300", languages: ["tr", "en"] },
  inter: { label: "Inter", family: "Inter", file: "fonts/video-fonts/Inter-Regular.woff2", format: "woff2", weight: "400", languages: ["tr", "en"] },
  notosans: { label: "Noto Sans", family: "Noto Sans", file: "fonts/video-fonts/NotoSans-Regular.woff2", format: "woff2", weight: "400", languages: ["tr", "en"] },
  poppins: { label: "Poppins", family: "Poppins", file: "fonts/video-fonts/Poppins-Regular.woff2", format: "woff2", weight: "400", languages: ["tr", "en"] },
  naskh: { label: "Noto Naskh Arabic", family: "Noto Naskh Arabic", file: "fonts/video-fonts/NotoNaskhArabic.ttf", format: "truetype", weight: "400 700", languages: ["ar"] },
  amiri: { label: "Amiri", family: "Amiri", file: "fonts/video-fonts/Amiri-Regular.ttf", format: "truetype", weight: "400", languages: ["ar"] },
  cairo: { label: "Cairo", family: "Cairo", file: "fonts/video-fonts/Cairo.ttf", format: "truetype", weight: "200 1000", languages: ["ar"] },
  tajawal: { label: "Tajawal", family: "Tajawal", file: "fonts/video-fonts/Tajawal-Regular.ttf", format: "truetype", weight: "400", languages: ["ar"] },
} as const;

export const DEFAULT_TRANSLATION_FONT: Record<TranslationFontLanguage, TranslationFontKey> = {
  tr: "aileron",
  en: "aileron",
  ar: "naskh",
};

export function translationFontSupports(font: TranslationFontKey, language: TranslationFontLanguage): boolean {
  return (TRANSLATION_FONT_OPTIONS[font].languages as readonly TranslationFontLanguage[]).includes(language);
}

// The font a translation in `language` actually renders in: the chosen one
// when it covers that language's letters, otherwise the language's default
// (e.g. a project saved with a Latin font before switching to an Arabic
// tafsir). A custom upload is trusted as-is -- unless no file has been
// uploaded yet, in which case there's nothing to render with.
export function resolveTranslationFont(
  font: TranslationFontKey | "custom",
  language: TranslationFontLanguage,
  hasCustomFile: boolean
): TranslationFontKey | "custom" {
  if (font === "custom") return hasCustomFile ? "custom" : DEFAULT_TRANSLATION_FONT[language];
  return translationFontSupports(font, language) ? font : DEFAULT_TRANSLATION_FONT[language];
}

// CSS font-family stack for a resolved translation font, with a fallback in
// the same script (an Arabic font must never fall back to a Latin one).
export function translationFontStack(
  font: TranslationFontKey | "custom",
  language: TranslationFontLanguage,
  customFamily: string
): string {
  const fallback = language === "ar" ? `${TRANSLATION_FONT_OPTIONS.naskh.family}, serif` : "Arial, sans-serif";
  const family = font === "custom" ? customFamily : TRANSLATION_FONT_OPTIONS[font].family;
  return `${family}, ${fallback}`;
}

// The two Arabic verse scripts QuranVideo.tsx can render -- "qcf2" is the
// original, only-ever one (2013 King Fahd Complex print, PUA text in
// QuranVerse.text/page); "qcf1" is the older 2005 print (PUA text in
// QuranVerse.textV1/pageV1 -- a COMPLETELY DIFFERENT PUA codepoint scheme,
// not just a different font file, so it needs its own text source, not
// just a font swap). Both font sets are always self-hosted/declared (see
// PageFontStyles) regardless of which is picked, so switching is instant
// client-side, same as TRANSLATION_FONT_OPTIONS above.
// sizeMultiplier: the qcf1 (2005) print's glyphs render visibly smaller
// than qcf2 (2013)'s at the same font-size, so its verse text is scaled up
// a bit here to read as roughly the same size instead of looking shrunken
// next to the default -- applied everywhere the verse font-size is set
// (QuranVideo.tsx's VERSE_FONT_SIZE and Step1SurahVerse.tsx's preview box).
export const ARABIC_FONT_OPTIONS = {
  qcf2: { labelAr: "الخط الجديد", labelTr: "Yeni Yazı Tipi (2013)", labelEn: "New Script (2013)", sizeMultiplier: 1 },
  qcf1: { labelAr: "الخط القديم", labelTr: "Eski Yazı Tipi (2005)", labelEn: "Old Script (2005)", sizeMultiplier: 1.15 },
} as const;

export type ArabicFontKey = keyof typeof ARABIC_FONT_OPTIONS;

export type TranslationFontKey = keyof typeof TRANSLATION_FONT_OPTIONS;
