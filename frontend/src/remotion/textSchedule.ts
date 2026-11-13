// When each chunk of text is on screen, and how faded it is -- the one copy
// of these rules. QuranVideo draws the video with them, and the timing
// editor's live preview (SegmentTimingEditor) shows its text with them, so
// the two can never disagree (the user, 2026-11-11: the editor used to switch
// text exactly at each boundary, 0.8 s later than the video).
import { interpolate } from "remotion";
import type { ArabicFontKey, QuranVerse, VerseMapping } from "./types";
import { voicedSpan } from "./timing";

// How long a chunk of text takes to fade in or out.
export const TEXT_FADE_FRAMES = Math.round(0.6 * 30);
// How long before the reciter starts a chunk it STARTS fading in. Was the
// whole fade plus 0.2 s (0.8 s, so it was fully visible before his first
// word: the user, 2026-10-28); the user set it to 0.1 s on 2026-11-11 with
// the fades themselves unchanged, after the timing editor started drawing
// each boundary where its text starts to show. Done by drawing the whole
// text track this much earlier than the audio (word highlighting adds it
// back, see buildWordWindows' call); each chunk stays until the next one
// starts fading in (see placeVerseChunks). Only with one continuous audio
// track (globalAudioPath): the per-ayah fallback keeps each ayah's audio
// inside its own Sequence, which must not move.
export const TEXT_LEAD_FRAMES = Math.round(0.1 * 30);

export function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

// A chunk's opacity `frame` frames into its own time on screen
// (durationInFrames long): fades in, holds, fades out.
export function chunkOpacity(frame: number, durationInFrames: number): number {
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

  return interpolate(
    frame,
    [0, fadeInEnd, fadeOutStart, durationInFrames],
    [0, 1, 1, 0],
    {
      easing: easeInOut,
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }
  );
}

// The Arabic text a verse is shown in for the chosen script. isQcf1 also
// requires verse.textV1 to be a REAL, non-empty string, not just qcf1 being
// the selected font -- quran-qcf-v1.json (fetched from quran.com) doesn't
// necessarily have complete coverage for every single ayah, and
// `textV1 ?? verse.text` alone only guards against it being missing
// entirely, not an empty string. Left unguarded, an ayah with an empty
// textV1 would render literally nothing ("the ayah doesn't show at all when
// I pick the old font"). Falling back to v2 for BOTH text and page keeps
// them a matched pair (see QuranVideo).
export function isQcf1Verse(verse: QuranVerse, arabicFont: ArabicFontKey): boolean {
  return arabicFont === "qcf1" && Boolean(verse.textV1);
}

// The chunks a verse is shown in. Every verse goes through the same
// per-mapping path: one with no real segmentation gets a single synthetic
// mapping spanning its whole text/translation, so its box has its own
// `${verse.id}:0` segmentKey and resize slot like any other segment (see
// VerseMapping in types.ts). With wordTimings present, that one mapping
// resolves to the verse's [first word start, last word end]; without, to the
// whole Sequence.
export function verseDisplayMappings(verse: QuranVerse, arabicVerseText: string): VerseMapping[] {
  return verse.mappings && verse.mappings.length > 0
    ? verse.mappings
    : [
        {
          part: 1,
          translation_text: verse.translation,
          // arabic_text set explicitly (verbatim, untruncated full verse)
          // rather than left to the word-range derivation, which assumes
          // real words map 1:1 onto glyph tokens whenever puaTokenCounts
          // isn't available and would chop off the verse's tail here (QCF
          // glyph tokens routinely outnumber real words).
          arabic_text: arabicVerseText,
          // wordTimings.length (exact real-word count) when available, so
          // the wordTimings lookup still resolves the tight
          // [firstStart, lastEnd] window -- otherwise this number no longer
          // affects anything, so the glyph-token count is just a placeholder.
          word_count: verse.wordTimings?.length ?? arabicVerseText.trim().split(/\s+/).length,
        },
      ];
}

// A "repeat" mapping (repeat_of_part set) re-displays an EARLIER mapping's
// own words -- it doesn't consume any NEW words of the ayah, so it counts 0
// here, matching VideoCreatorForm's buildTimingEditorSegments. Counting it
// anyway pushed every mapping after a repeat that many words too far forward.
export function realWordCount(m: VerseMapping): number {
  return typeof m.repeat_of_part === "number" ? 0 : m.word_count;
}

export interface ChunkWindow {
  // Frames on the verse's own Sequence, on the audio's time.
  chunkStartFrame: number;
  chunkDuration: number;
  startWordIdx: number;
  endWordIdx: number;
  isRepeatMapping: boolean;
  hasWordTiming: boolean;
}

// When mapping i's chunk is voiced, in frames on its verse's own Sequence
// (`d` frames long), on the audio's time. `useWordTiming`: the verse's
// wordTimings are on this video's audio (!globalAudioPath || isAudioExtracted).
export function chunkWindow(
  verse: QuranVerse,
  mappings: VerseMapping[],
  d: number,
  i: number,
  useWordTiming: boolean
): ChunkWindow {
  const m = mappings[i];
  const totalWords = mappings.reduce((sum, x) => sum + realWordCount(x), 0);
  const previousWords = mappings.slice(0, i).reduce((sum, x) => sum + realWordCount(x), 0);
  // Proportional fallback (used only when real per-word audio timing isn't
  // available for this verse, e.g. custom audio that wasn't aligned by the
  // backend). realWordCount keeps every share summing to exactly 1 across
  // the ayah; a repeat gets 0 share here, but in practice it always carries
  // its own start_ms/end_ms, which win below.
  let chunkStartFrame = Math.round((previousWords / totalWords) * d);
  let chunkDuration = i === mappings.length - 1
    ? d - chunkStartFrame
    : Math.round((realWordCount(m) / totalWords) * d);

  const startWordIdx = previousWords;
  const endWordIdx = previousWords + m.word_count - 1;
  const isRepeatMapping = typeof m.repeat_of_part === "number";

  // When the chunk is on screen -- the rule shared with render/route.ts and
  // the live preview (see ./timing): from the reciter's onset of its first
  // voiced word to the end of its last one, so a waqf sign at either edge
  // doesn't shift it. Direct index lookup: word_count counts REAL Uthmani
  // words, the same tokens wordTimings is aligned to. A repeat re-shows
  // earlier words, so it has no words of its own to time by.
  let startMs: number | undefined;
  let endMs: number | undefined;
  const hasWordTiming =
    useWordTiming &&
    !!verse.wordTimings &&
    endWordIdx < verse.wordTimings.length;
  if (!isRepeatMapping && hasWordTiming && verse.wordTimings) {
    const span = voicedSpan(verse.wordTimings, startWordIdx, endWordIdx);
    startMs = span?.start ?? verse.wordTimings[startWordIdx].start;
    endMs = span?.end ?? verse.wordTimings[endWordIdx].end;
  }
  // A boundary the user moved in SegmentTimingEditor wins over the words,
  // each edge on its own (render/route.ts keeps only the moved ones, already
  // verse-relative ms).
  if (typeof m.start_ms === "number") startMs = m.start_ms;
  if (typeof m.end_ms === "number") endMs = m.end_ms;
  if (startMs !== undefined || endMs !== undefined) {
    const startFrame = startMs !== undefined ? Math.round((startMs / 1000) * 30) : chunkStartFrame; // FPS is 30
    const endFrame = endMs !== undefined ? Math.round((endMs / 1000) * 30) : chunkStartFrame + chunkDuration;
    chunkStartFrame = startFrame;
    chunkDuration = Math.max(1, endFrame - startFrame);
  }
  return { chunkStartFrame, chunkDuration, startWordIdx, endWordIdx, isRepeatMapping, hasWordTiming };
}

export interface ChunkPlacement {
  // Where the chunk's own Sequence sits on its verse's Sequence (on the TEXT
  // track, which runs textLeadFrames ahead of the audio) and how long it is.
  chunkStartFrame: number;
  chunkDuration: number;
  // When the chunk is voiced (chunkWindow), unchanged.
  window: ChunkWindow;
}

// Every mapping's chunk on its verse's Sequence; null for a hidden one.
// `from` is the verse's place on the text track.
export function placeVerseChunks(
  verse: QuranVerse,
  mappings: VerseMapping[],
  opts: { from: number; d: number; isLast: boolean; textLeadFrames: number; useWordTiming: boolean }
): (ChunkPlacement | null)[] {
  const { from, d, isLast, textLeadFrames, useWordTiming } = opts;
  return mappings.map((mapping, idx) => {
    // Shown by another appearance of this ayah (see remotion/timing.ts).
    if (mapping.hidden) return null;
    const window = chunkWindow(verse, mappings, d, idx, useWordTiming);
    // Never before the video's first frame: a chunk the reciter starts less
    // than textLeadFrames into the video -- the first one, when the trim
    // leaves little silence before it -- would otherwise be mostly faded in
    // already on frame 0, popping up instead of fading in. It fades in from
    // the first frame instead, at the same speed as every other chunk.
    const chunkStartFrame = Math.max(window.chunkStartFrame, textLeadFrames - from);
    // The text track runs textLeadFrames ahead of the audio (see
    // TEXT_LEAD_FRAMES), so this chunk -- placed at its audio start -- shows
    // from textLeadFrames before it, fading in to be fully visible as the
    // reciter starts. It stays on screen until the next chunk on screen --
    // of this ayah, or the next ayah, whose Sequence starts where this one
    // ends -- starts fading in: its fade-out ends right there. The screen is
    // never blank between two chunks, pause or not, and never shows two at
    // once -- only the fades themselves change it (the user, 2026-10-28).
    // The video's last chunk ends with its last word, never past the end of
    // the video, which the trim may put before the words' own timing ends
    // (a recording that repeats its last ayahs, trimmed to keep one
    // recitation).
    const verseEnd = isLast ? d + textLeadFrames : d;
    const nextShown = mappings.findIndex((m, j) => j > idx && !m.hidden);
    const displayEnd =
      nextShown >= 0
        ? Math.min(Math.max(chunkStartFrame + 1, chunkWindow(verse, mappings, d, nextShown, useWordTiming).chunkStartFrame), verseEnd)
        : isLast
          ? Math.min(chunkStartFrame + window.chunkDuration + textLeadFrames, verseEnd)
          : Math.max(chunkStartFrame + 1, verseEnd);
    const chunkDuration = Math.max(1, displayEnd - chunkStartFrame);
    return { chunkStartFrame, chunkDuration, window };
  });
}

// One chunk as the finished video shows it, in frames of the video itself.
export interface TextScheduleEntry {
  verseId: number;
  part: number;
  // On screen over [visibleFrom, endFrame); its opacity at video frame f is
  // chunkOpacity(f - startFrame, durationInFrames). Its verse's Sequence
  // cuts it at either end: visibleFrom is later than startFrame when the
  // chunk starts before its verse (a boundary dragged that far), endFrame
  // earlier than startFrame + durationInFrames when the verse ends first.
  startFrame: number;
  visibleFrom: number;
  endFrame: number;
  durationInFrames: number;
  // When its own words are recited (or the boundaries the user set).
  audioStartFrame: number;
  audioEndFrame: number;
}

// The whole video's text, chunk by chunk, laid out exactly as QuranVideo lays
// it out: verses back to back, the text track textLeadFrames ahead of the audio.
export function buildTextSchedule(props: {
  verses: QuranVerse[];
  globalAudioPath?: string | null;
  isAudioExtracted?: boolean;
  arabicFont?: ArabicFontKey;
}): TextScheduleEntry[] {
  const { verses, globalAudioPath, isAudioExtracted, arabicFont = "qcf2" } = props;
  const textLeadFrames = globalAudioPath ? TEXT_LEAD_FRAMES : 0;
  const useWordTiming = !globalAudioPath || !!isAudioExtracted;
  const entries: TextScheduleEntry[] = [];
  let from = 0;
  verses.forEach((verse, i) => {
    const d = verse.durationInFrames;
    const isLast = i === verses.length - 1;
    const arabicVerseText = isQcf1Verse(verse, arabicFont) ? verse.textV1! : verse.text;
    const mappings = verseDisplayMappings(verse, arabicVerseText);
    const verseSequenceStart = from - textLeadFrames;
    const verseSequenceEnd = verseSequenceStart + (isLast ? d + textLeadFrames : d);
    placeVerseChunks(verse, mappings, { from, d, isLast, textLeadFrames, useWordTiming }).forEach((p, idx) => {
      if (!p) return;
      const startFrame = from + p.chunkStartFrame - textLeadFrames;
      entries.push({
        verseId: verse.id,
        part: mappings[idx].part,
        startFrame,
        visibleFrom: Math.max(startFrame, verseSequenceStart),
        endFrame: Math.min(startFrame + p.chunkDuration, verseSequenceEnd),
        durationInFrames: p.chunkDuration,
        audioStartFrame: from + p.window.chunkStartFrame,
        audioEndFrame: from + p.window.chunkStartFrame + p.window.chunkDuration,
      });
    });
    from += d;
  });
  return entries;
}
