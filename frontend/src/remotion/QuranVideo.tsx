"use client";

import React, { useEffect, useState } from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  continueRender,
  delayRender,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import type { QuranVideoProps } from "./types";

const FPS = 30;
const CONTAINER_PADDING = 32;

const BG_SCALE = 1.04;

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

const VERSE_FONT_SIZE = 42;
const VERSE_FONT_WEIGHT = 500;
const VERSE_LINE_HEIGHT = 2.0;
const VERSE_FONT_FAMILY_FALLBACK = "'KFGQPC Uthman Taha Naskh', 'Amiri Quran', 'Scheherazade New', 'Noto Naskh Arabic', serif";

const FONT_KFGQPC_PATH = "fonts/UthmanTN1 Ver10.otf";
const FONT_KFGQPC_FAMILY = "KFGQPC Uthman Taha Naskh";
const FONT_UTHMANIC_HAFS_PATH = "fonts/uthmanic_hafs_v20.ttf";
const FONT_UTHMANIC_HAFS_FAMILY = "Uthmanic Hafs";
const FONT_PUA_DIR = "fonts/2013/QCF2BSMLfonts/QCF2";

const FONT_SURAH_NAME_PATH = "fonts/video-fonts/Ruqaa.ttf";
const FONT_SURAH_NAME_FAMILY = "Ruqaa";

const FONT_TRANSLITERATION_PATH = "fonts/video-fonts/Sansita-Bold.ttf";
const FONT_TRANSLITERATION_FAMILY = "Sansita";

const FONT_TRANSLATION_PATH = "fonts/video-fonts/Aileron-Thin.otf";
const FONT_TRANSLATION_FAMILY = "Aileron Thin";

const TRANSLATION_FONT_SIZE = 30;
const TRANSLATION_LINE_HEIGHT = 1.625;
const TRANSLATION_COLOR = "white";
const TRANSLATION_MARGIN_TOP = 10;
const TRANSLATION_FONT_FAMILY = `${FONT_TRANSLATION_FAMILY}, Arial, sans-serif`;

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
  return staticFile(path);
}

function formatInvertedPyramid(text: string, forceTwoLines = true, textScale = 1, prefixLength = 0): React.ReactNode {
  if (!text) return null;
  const words = text.split(" ");
  
  // Don't force two lines if the text is very short
  if (forceTwoLines && (text.length < 30 || words.length <= 4)) {
    forceTwoLines = false;
  }
  
  if (words.length <= 4 && forceTwoLines === false) return text;

  const totalChars = text.length + prefixLength;
  // Maximum allowed characters per visual line to completely avoid native browser wrapping
  const MAX_LINE_CHARS = Math.floor(52 / textScale);

  let numLines = Math.ceil(totalChars / MAX_LINE_CHARS);
  if (forceTwoLines && numLines < 2) numLines = 2;
  if (!forceTwoLines && numLines < 2) return text;
  
  if (numLines > 4) numLines = 4; // safety cap

  let bestLines: string[] = [];
  let bestScore = Infinity;

  // Helper function to get length of a slice of words
  const getLen = (start: number, end: number, isFirstLine = false) => {
    let len = isFirstLine ? prefixLength : 0;
    for (let i = start; i <= end; i++) len += words[i].length;
    return len + (end - start); // add spaces
  };

  if (numLines === 2) {
    const targetL1 = totalChars * 0.55;
    const targetL2 = totalChars * 0.45;
    
    // Try all single split points
    for (let i = 0; i < words.length - 1; i++) {
      const l1 = getLen(0, i, true);
      const l2 = getLen(i + 1, words.length - 1, false);
      
      if (l1 <= MAX_LINE_CHARS && l2 <= MAX_LINE_CHARS) {
        let score = Math.abs(l1 - targetL1) + Math.abs(l2 - targetL2);
        // Soft penalty if it doesn't form a pyramid
        if (l2 > l1) score += (l2 - l1) * 2;
        
        if (score < bestScore) {
          bestScore = score;
          bestLines = [words.slice(0, i + 1).join(" "), words.slice(i + 1).join(" ")];
        }
      }
    }
  } else if (numLines === 3) {
    const targetL1 = totalChars * 0.40;
    const targetL2 = totalChars * 0.33;
    const targetL3 = totalChars * 0.27;
    
    // Try all two split points
    for (let i = 0; i < words.length - 2; i++) {
      for (let j = i + 1; j < words.length - 1; j++) {
        const l1 = getLen(0, i, true);
        const l2 = getLen(i + 1, j, false);
        const l3 = getLen(j + 1, words.length - 1, false);
        
        if (l1 <= MAX_LINE_CHARS && l2 <= MAX_LINE_CHARS && l3 <= MAX_LINE_CHARS) {
          let score = Math.abs(l1 - targetL1) + Math.abs(l2 - targetL2) + Math.abs(l3 - targetL3);
          // Soft penalty to encourage L1 >= L2 >= L3
          if (l2 > l1) score += (l2 - l1) * 2;
          if (l3 > l2) score += (l3 - l2) * 2;
          
          if (score < bestScore) {
            bestScore = score;
            bestLines = [
              words.slice(0, i + 1).join(" "),
              words.slice(i + 1, j + 1).join(" "),
              words.slice(j + 1).join(" ")
            ];
          }
        }
      }
    }
  }

  // Fallback if no perfect pyramid was mathematically possible (e.g. huge words)
  // We use a simple greedy fill, but still forcing L1 >= L2 >= L3 where possible
  if (bestLines.length === 0) {
    bestLines = Array(numLines).fill("");
    let currentWordIdx = 0;
    let targetRatio = numLines === 2 ? 0.55 : 0.45;
    
    for (let lineIdx = 0; lineIdx < numLines; lineIdx++) {
      if (lineIdx === numLines - 1) {
        bestLines[lineIdx] = words.slice(currentWordIdx).join(" ");
        break;
      }
      
      let remainingChars = getLen(currentWordIdx, words.length - 1);
      let targetLength = remainingChars * (lineIdx === 0 ? targetRatio : 0.60);
      
      while (currentWordIdx < words.length) {
        const currentLineLen = bestLines[lineIdx].length;
        if (currentLineLen > 0 && currentLineLen + 1 + words[currentWordIdx].length > MAX_LINE_CHARS) {
          break;
        }
        bestLines[lineIdx] += (currentLineLen > 0 ? " " : "") + words[currentWordIdx];
        currentWordIdx++;
        if (bestLines[lineIdx].length >= targetLength) break;
      }
    }
  }

  return (
    <>
      {bestLines.map((line, index) => (
        <React.Fragment key={index}>
          {line}
          {index < bestLines.length - 1 && <br />}
        </React.Fragment>
      ))}
    </>
  );
}

function formatArabicVerse(text: string): React.ReactNode {
  if (!text) return null;
  const words = text.split(" ");
  
  const totalWords = words.length;
  // A single line fits about 6 to 7 PUA words on mobile before wrapping natively
  const maxWordsPerLine = 8; 
  
  if (totalWords <= 8) {
    return text;
  }
  
  let numLines = Math.ceil(totalWords / maxWordsPerLine); // fallback roughly
  if (totalWords <= 13) numLines = 2;
  else if (totalWords <= 20) numLines = 3;
  else if (totalWords <= 27) numLines = 4;
  else numLines = 5;
  
  const lines: string[] = Array(numLines).fill("");
  let currentWords = 0;

  const targets: number[] = [];
  if (numLines === 2) {
    // 53% top, 47% bottom (e.g. 13 words -> 7 top, 6 bottom)
    targets.push(Math.ceil(totalWords * 0.53));
  } else if (numLines === 3) {
    // 38% top, 33% mid, 29% bottom (e.g. 15 words -> 6 top, 5 mid, 4 bottom)
    targets.push(Math.ceil(totalWords * 0.38));
    targets.push(targets[0] + Math.ceil(totalWords * 0.33));
  } else {
    for (let i = 1; i < numLines; i++) {
      targets.push(Math.ceil((totalWords / numLines) * i));
    }
  }

  let lineIdx = 0;
  for (let i = 0; i < words.length; i++) {
    if (lineIdx < numLines - 1) {
      if (currentWords >= targets[lineIdx]) {
        lineIdx++;
      }
    }
    
    // Safety check so we don't exceed maxWordsPerLine and cause browser to native-wrap
    const wordsInCurrentLine = lines[lineIdx].split(" ").filter(Boolean).length;
    if (lineIdx < numLines - 1 && wordsInCurrentLine >= maxWordsPerLine) {
      lineIdx++;
    }

    lines[lineIdx] += (lines[lineIdx].length > 0 ? " " : "") + words[i];
    currentWords++;
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
  showNumber = true,
}: {
  text: string;
  translation: string;
  verseId: number;
  durationInFrames: number;
  page?: number;
  textScale?: number;
  showNumber?: boolean;
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
          style={{
            textAlign: "center",
            color: "white",
            fontFamily: page ? `'p${page}'` : VERSE_FONT_FAMILY_FALLBACK,
            fontSize: Math.round(VERSE_FONT_SIZE * textScale),
            fontWeight: VERSE_FONT_WEIGHT,
            lineHeight: VERSE_LINE_HEIGHT,
            textShadow: TEXT_SHADOW,
          }}
        >
          {formatArabicVerse(text)}
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
            style={{
              textAlign: "center",
              color: TRANSLATION_COLOR,
              fontFamily: TRANSLATION_FONT_FAMILY,
              fontSize: Math.round(TRANSLATION_FONT_SIZE * textScale),
              lineHeight: TRANSLATION_LINE_HEIGHT,
              marginTop: TRANSLATION_MARGIN_TOP,
              width: "100%",
            }}
          >
            {showNumber && `${verseId}. `}{formatInvertedPyramid(translation, true, textScale, showNumber ? `${verseId}. `.length : 0)}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
}

function PageFontStyles({ verses }: { verses: QuranVideoProps["verses"] }) {
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
        font-family: "${FONT_TRANSLATION_FAMILY}";
        src: url("${staticFile(FONT_TRANSLATION_PATH)}") format("opentype");
        font-weight: 300;
        font-display: swap;
      }
      ${fontFaces}
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
  globalAudioPath,
  isAudioExtracted,
  verses,
  totalDurationInFrames,
  textScale = 1,
}: QuranVideoProps) {
  const [fontHandle] = useState(() => delayRender("Loading Quran video fonts"));

  useEffect(() => {
    Promise.all([
      document.fonts.load(`${Math.round(VERSE_FONT_SIZE * textScale)}px "${FONT_KFGQPC_FAMILY}"`),
      ...verses.map((v) =>
        v.page
          ? document.fonts.load(`${Math.round(VERSE_FONT_SIZE * textScale)}px 'p${v.page}'`)
          : Promise.resolve()
      ),
      document.fonts.load(`${Math.round(SURAH_NAME_FONT_SIZE * textScale)}px "${FONT_SURAH_NAME_FAMILY}"`),
      document.fonts.load(`${Math.round(TRANSLITERATION_FONT_SIZE * textScale)}px "${FONT_TRANSLITERATION_FAMILY}"`),
      document.fonts.load(`${Math.round(TRANSLATION_FONT_SIZE * textScale)}px "${FONT_TRANSLATION_FAMILY}"`),
      document.fonts.ready,
    ])
      .catch(() => undefined)
      .finally(() => continueRender(fontHandle));
  }, [fontHandle, verses, textScale]);

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
      <PageFontStyles verses={verses} />

      {backgroundImagePath ? (
        <AbsoluteFill>
          <Img
            src={getAssetUrl(backgroundImagePath)}
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
        <Audio src={getAssetUrl(globalAudioPath)} />
      ) : null}

      {verses.map((verse, i) => {
        const from = startFrame;
        startFrame += verse.durationInFrames;
        const d = verse.durationInFrames;
        const isFirst = i === 0;
        const isLast = i === verses.length - 1;
        const shortAudio = d <= CROSSFADE_DURATION_FRAMES * 2;

        return (
          <Sequence
            key={`${verse.id}-${from}`}
            from={from}
            durationInFrames={d}
          >
            {globalAudioPath ? null : (
              <Audio
                src={getAssetUrl(verse.audioPath)}
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

            {(!verse.mappings || verse.mappings.length === 0) ? (
              <VerseScene
                text={verse.text}
                translation={verse.translation}
                verseId={verse.id}
                durationInFrames={d}
                page={verse.page}
                textScale={textScale}
              />
            ) : (
              verse.mappings.map((mapping, idx) => {
                const totalUnits = verse.mappings!.reduce((sum, m) => sum + m.arabic_unit_count, 0);
                const previousUnits = verse.mappings!.slice(0, idx).reduce((sum, m) => sum + m.arabic_unit_count, 0);

                const allWords = verse.text.trim().split(/\s+/);

                let chunkStartFrame = Math.round((previousUnits / totalUnits) * d);
                let chunkDuration = idx === verse.mappings!.length - 1
                  ? d - chunkStartFrame
                  : Math.round((mapping.arabic_unit_count / totalUnits) * d);

                if ((!globalAudioPath || isAudioExtracted) && verse.wordTimings && verse.wordTimings.length > 0) {
                  // Robust word matching (Text-Matching) to avoid index shifting caused by Whisper skipping/merging words.
                  const cleanArabic = (str: string) => {
                    return (str || "")
                      .replace(/[\u0617-\u061A\u064B-\u0652\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED]/g, "") // remove tashkeel
                      .replace(/[^\w\s\u0600-\u06FF]/g, "") // remove punctuation
                      .replace(/\s+/g, ""); // remove spaces
                  };

                  const timingsAligned = new Array(allWords.length).fill(null);
                  let tIdx = 0;
                  let matchedCount = 0;
                  for (let i = 0; i < allWords.length; i++) {
                    const wordClean = cleanArabic(allWords[i]);
                    // Skip null/empty strings
                    if (!wordClean) continue;
                    
                    for (let lookAhead = 0; lookAhead <= 2; lookAhead++) {
                      if (tIdx + lookAhead < verse.wordTimings.length) {
                        const timingClean = cleanArabic(verse.wordTimings[tIdx + lookAhead].w);
                        if (timingClean === wordClean || timingClean.includes(wordClean) || wordClean.includes(timingClean)) {
                          // Base match found
                          let matchedTiming = { ...verse.wordTimings[tIdx + lookAhead] };
                          let consumed = 1;
                          
                          // If Whisper split a long word (e.g. "الضالين" -> "الضا", "لين"), 
                          // try to consume the next Whisper fragments to capture the full audio duration.
                          let accumulatedText = timingClean;
                          while (
                            accumulatedText.length < wordClean.length && 
                            tIdx + lookAhead + consumed < verse.wordTimings.length
                          ) {
                            const nextFragmentClean = cleanArabic(verse.wordTimings[tIdx + lookAhead + consumed].w);
                            const remainingExpected = wordClean.substring(accumulatedText.length);
                            
                            // Only consume if the next Whisper fragment actually matches the remaining expected text!
                            if (remainingExpected.startsWith(nextFragmentClean) || nextFragmentClean.includes(remainingExpected)) {
                                accumulatedText += nextFragmentClean;
                                matchedTiming.end = verse.wordTimings[tIdx + lookAhead + consumed].end;
                                consumed++;
                            } else {
                                // Whisper skipped the remaining part and moved to another word. Break to avoid eating the next word!
                                break;
                            }
                          }

                          timingsAligned[i] = matchedTiming;
                          tIdx = tIdx + lookAhead + consumed; // Advance pointer past all consumed fragments
                          foundMatch = true;
                          matchedCount++;
                          break;
                        }
                      }
                    }
                    if (!foundMatch) {
                      // If we didn't find a match, we just leave it null. It will be backfilled later.
                    }
                  }

                  // Backfill nulls (skipped words) with nearest valid timing
                  for (let i = 0; i < timingsAligned.length; i++) {
                    if (timingsAligned[i] === null) {
                      if (i > 0 && timingsAligned[i - 1]) {
                        timingsAligned[i] = { ...timingsAligned[i - 1] };
                      } else {
                        let nextValid = verse.wordTimings[0];
                        for (let j = i + 1; j < timingsAligned.length; j++) {
                          if (timingsAligned[j]) { nextValid = timingsAligned[j]; break; }
                        }
                        timingsAligned[i] = { ...nextValid };
                      }
                    }
                  }

                  const startWordIdx = previousUnits;
                  const endWordIdx = Math.min(previousUnits + mapping.arabic_unit_count - 1, allWords.length - 1);

                  // Only apply word timings if we actually matched at least one word
                  if (matchedCount > 0 && startWordIdx < timingsAligned.length) {
                    const startMs = timingsAligned[startWordIdx].start;
                    
                    let nextStartMs = timingsAligned[endWordIdx].end; // Fallback
                    if (endWordIdx + 1 < timingsAligned.length) {
                       nextStartMs = timingsAligned[endWordIdx + 1].start;
                    }

                    chunkStartFrame = Math.round((startMs / 1000) * 30); // FPS is 30
                    chunkDuration = Math.max(1, Math.round(((nextStartMs - startMs) / 1000) * 30));

                    if (idx === verse.mappings!.length - 1) {
                      chunkDuration = Math.max(1, d - chunkStartFrame);
                    }
                  }
                }

                const chunkText = allWords.slice(previousUnits, previousUnits + mapping.arabic_unit_count).join(" ");

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
                      page={verse.page}
                      textScale={textScale}
                      showNumber={idx === 0}
                    />
                  </Sequence>
                );
              })
            )}
          </Sequence>
        );
      })}

      <AbsoluteFill
        style={{
          alignItems: "center",
          paddingTop: HEADER_PADDING_TOP,
          color: "white",
          fontFamily: TRANSLATION_FONT_FAMILY,
          opacity: headerOpacity,
        }}
      >
        <div
          dir="rtl"
          style={{
            fontSize: Math.round(SURAH_NAME_FONT_SIZE * textScale),
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
              fontSize: Math.round(TRANSLITERATION_FONT_SIZE * textScale),
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
