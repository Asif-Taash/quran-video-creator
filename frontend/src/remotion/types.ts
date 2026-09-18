export type VerseMapping = {
  part: number;
  translation_text: string;
  // Count of REAL Uthmani words (not QCF glyph tokens) this segment covers —
  // indexes directly into wordTimings, which is aligned the same way.
  word_count: number;
  // Manual timing override set via the waveform-based SegmentTimingEditor —
  // when present, takes absolute priority over any wordTimings/word_count-
  // derived timing for this segment. Verse-relative milliseconds (same
  // coordinate space wordTimings ends up in after render/route.ts's
  // normalization), NOT raw prepared-audio-clip-relative milliseconds.
  start_ms?: number;
  end_ms?: number;
  // Explicit, already-resolved Arabic text for this segment, straight from
  // SegmentTimingEditor. Only trusted VERBATIM for a "repeat" segment (see
  // repeat_of_part below) -- that's the one case cumulative word_count math
  // can't reconstruct at all (a repeat intentionally re-displays an EARLIER
  // segment's exact words, not the "next" sequential range). For every
  // OTHER segment, QuranVideo.tsx/buildTimingEditorSegments deliberately
  // IGNORE this and always re-derive the word range live instead, even
  // though it's saved here too -- this text is frozen in whichever QCF
  // encoding was selected at save time, so trusting it verbatim after a
  // LATER arabicFont switch rendered garbled glyphs (right encoding for the
  // font it was saved under, wrong one for whatever's picked now), reported
  // as "the old font's ayah shows garbage after switching to the new one,
  // even inside the timing editor". Re-deriving live has no such problem --
  // it always slices whichever of verse.text/textV1 matches the CURRENTLY
  // selected font.
  arabic_text?: string;
  // Which EARLIER segment (1-based `part` number, same ayah) this one is a
  // "repeat" of -- see arabic_text above. Set once by
  // VideoCreatorForm.tsx's handleSaveTimingEditor from SegmentTimingEditor's
  // own repeatOfId, translated into a part number stable across the
  // session-local ids SegmentTimingEditor regenerates on every reopen.
  repeat_of_part?: number;
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
  // Per-real-word count of QCF v2 glyph tokens in `text` (same order as
  // wordTimings). Lets a real-word range from `mappings` be converted into
  // the glyph-token range needed to slice `text` for display. Deliberately
  // NOT computed/used for textV1 -- QuranVideo.tsx falls back to its
  // existing 1:1 real-word assumption for that case (same tolerant path
  // already used whenever this is unavailable for v2 too).
  puaTokenCounts?: number[];
  absoluteStartFrame?: number;
};

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
// `quality` at all) completely untouched. "720p" is scale 1 -- exactly
// today's only-ever output size for every aspect ratio -- so it's the
// default and changes nothing for an existing draft/render.
export type QualityTier =
  | "144p"
  | "240p"
  | "360p"
  | "480p"
  | "720p"
  | "1080p"
  | "1440p"
  | "2160p";

export const QUALITY_SCALE: Record<QualityTier, number> = {
  "144p": 144 / 720,
  "240p": 240 / 720,
  "360p": 360 / 720,
  "480p": 480 / 720,
  "720p": 1,
  "1080p": 1080 / 720,
  "1440p": 1440 / 720,
  "2160p": 2160 / 720,
};

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
  backgroundImagePath: string | null;
  // When set, takes priority over backgroundImagePath and is rendered
  // muted/looped instead (see QuranVideo.tsx). backgroundVideoDurationInFrames
  // is the video's own natural length (probed server-side via ffprobe in
  // render/route.ts) -- required to loop it seamlessly with Remotion's
  // <Loop> rather than just letting it freeze on its last frame once shorter
  // than the audio-driven total duration.
  backgroundVideoPath?: string | null;
  backgroundVideoDurationInFrames?: number | null;
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
  // Which Arabic verse script/font to use -- one of ARABIC_FONT_OPTIONS'
  // keys below. Defaults to "qcf2" (the original, only-ever font -- 2013
  // King Fahd Complex print) everywhere it's read, same reasoning as
  // aspectRatio above.
  arabicFont?: ArabicFontKey;
};

// The full set of translation fonts QuranVideo.tsx knows how to render --
// each self-hosted the same way as every other font in this project (see
// PageFontStyles), all confirmed to cover the Turkish alphabet (Ç ç Ğ ğ İ ı
// Ö ö Ş ş Ü ü) since the translation text is Turkish. Shared here (not just
// declared inline in QuranVideo.tsx) so VideoPreviewPlayer.tsx's font
// picker can offer exactly these choices without duplicating the list.
export const TRANSLATION_FONT_OPTIONS = {
  aileron: { label: "Aileron", family: "Aileron Thin" },
  inter: { label: "Inter", family: "Inter" },
  notosans: { label: "Noto Sans", family: "Noto Sans" },
  poppins: { label: "Poppins", family: "Poppins" },
} as const;

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
  qcf2: { labelAr: "الخط الجديد", labelTr: "Yeni Yazı Tipi (2013)", sizeMultiplier: 1 },
  qcf1: { labelAr: "الخط القديم", labelTr: "Eski Yazı Tipi (2005)", sizeMultiplier: 1.15 },
} as const;

export type ArabicFontKey = keyof typeof ARABIC_FONT_OPTIONS;

export type TranslationFontKey = keyof typeof TRANSLATION_FONT_OPTIONS;
