"use client";

import React from "react";
import { Composition } from "remotion";
import { QuranVideo } from "./QuranVideo";
import type { QuranVideoProps } from "./types";

const defaultProps: QuranVideoProps = {
  surahNameArabic: "الفاتحة",
  surahNameTransliteration: "Al-Fatihah",
  backgroundImagePath: null,
  totalDurationInFrames: 210,
  verses: [
    {
      id: 1,
      text: "بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ",
      translation: "Rahman ve Rahim olan Allah'ın adıyla.",
      durationInFrames: 210,
      audioPath: "render-assets/audio/001001.mp3",
    },
  ],
};

export function RemotionRoot() {
  return (
    <Composition
      id="QuranVideo"
      component={QuranVideo}
      durationInFrames={defaultProps.totalDurationInFrames}
      fps={30}
      width={720}
      height={1280}
      defaultProps={defaultProps}
      calculateMetadata={({ props }) => ({
        durationInFrames: Math.max(30, props.totalDurationInFrames),
        fps: 30,
        width: 720,
        height: 1280,
      })}
    />
  );
}
