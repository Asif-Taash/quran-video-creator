"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import { PlayIcon, PauseIcon, CheckIcon, XMarkIcon } from "@heroicons/react/24/solid";

interface AudioTrimmerProps {
  audioUrl: string;
  defaultRegionStart: number;
  defaultRegionEnd: number | null;
  onConfirm: (trimStart: number, trimEnd: number) => void;
  onCancel: () => void;
  isArabic: boolean;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return mins > 0 ? `${mins}:${String(secs).padStart(2, "0")}.${ms}` : `${secs}.${ms}`;
}

export default function AudioTrimmer({
  audioUrl,
  defaultRegionStart,
  defaultRegionEnd,
  onConfirm,
  onCancel,
  isArabic,
}: AudioTrimmerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [wavesurfer, setWavesurfer] = useState<WaveSurfer | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const regionRef = useRef<any>(null);
  const [regionDuration, setRegionDuration] = useState<number>(0);
  const [totalDuration, setTotalDuration] = useState<number>(0);

  const [zoom, setZoom] = useState<number>(0);

  const updateRegionDuration = useCallback(() => {
    if (regionRef.current) {
      const { start, end } = regionRef.current;
      setRegionDuration(end - start);
    }
  }, []);

  useEffect(() => {
    if (wavesurfer && isReady) {
      wavesurfer.zoom(zoom);
    }
  }, [zoom, wavesurfer, isReady]);

  useEffect(() => {
    if (!containerRef.current) return;

    // We use a warm/golden tone to match the project's typical 'primary' colors
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: "rgba(180, 140, 70, 0.3)",
      progressColor: "rgba(180, 130, 50, 0.9)",
      cursorColor: "#000",
      cursorWidth: 3,
      barWidth: 2,
      barGap: 2,
      barRadius: 2,
      height: 120,
      normalize: true,
    });

    const regions = ws.registerPlugin(RegionsPlugin.create());

    ws.on("ready", () => {
      setIsReady(true);
      const duration = ws.getDuration();
      setTotalDuration(duration);
      
      const r = regions.addRegion({
        start: defaultRegionStart,
        end: defaultRegionEnd !== null ? defaultRegionEnd : Math.max(defaultRegionStart + 0.5, duration - defaultRegionStart),
        color: "rgba(180, 140, 70, 0.15)", // Subtle golden overlay
        drag: false, // Prevent dragging the whole region, only edges
        resize: true,
      });
      regionRef.current = r;
      setRegionDuration(r.end - r.start);

      // Listen for region updates (when user drags edges)
      r.on("update-end", () => {
        updateRegionDuration();
      });
    });

    ws.on("play", () => setIsPlaying(true));
    ws.on("pause", () => setIsPlaying(false));

    // Handle AbortError that occurs in React StrictMode when component unmounts quickly
    ws.load(audioUrl).catch((err) => {
      if (err.name !== 'AbortError') {
        console.error("WaveSurfer load error:", err);
      }
    });
    setWavesurfer(ws);

    return () => {
      ws.destroy();
    };
  }, [audioUrl, defaultRegionStart, defaultRegionEnd, updateRegionDuration]);

  const playRegion = () => {
    if (!wavesurfer || !regionRef.current) return;
    if (isPlaying) {
      wavesurfer.pause();
    } else {
      // Play only the selected region
      regionRef.current.play();
    }
  };

  const playAll = () => {
    if (!wavesurfer) return;
    if (isPlaying) {
      wavesurfer.pause();
    } else {
      wavesurfer.play();
    }
  };

  const handleConfirm = () => {
    if (!regionRef.current) return;
    const { start, end } = regionRef.current;
    onConfirm(start, end);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-0 sm:p-4">
      <div className="bg-surface w-full max-w-3xl border-0 sm:border border-border rounded-none sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col h-[100dvh] sm:h-auto" dir={isArabic ? "rtl" : "ltr"}>
        <div className="p-4 sm:p-5 border-b border-border flex items-center justify-between bg-surface">
          <h2 className="text-lg sm:text-xl font-bold text-foreground">
            {isArabic ? "تعديل أطراف الصوت" : "Sesi Düzenle"}
          </h2>
          <button onClick={onCancel} className="text-muted-foreground hover:text-foreground transition-colors bg-background p-2 rounded-full border border-border">
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-6 flex-1 flex flex-col justify-center sm:block overflow-y-auto">
          <p className="text-xs sm:text-sm text-muted-foreground mb-6">
            {isArabic
              ? "قم بسحب أطراف التحديد لتحديد بداية ونهاية الصوت بدقة. المساحة المظللة هي ما سيتم استخدامه في الفيديو."
              : "Sesin başlangıcını ve bitişini belirlemek için kenarları sürükleyin. Gölgeli alan videoda kullanılacaktır."}
          </p>

          {!isReady && (
            <div className="h-[120px] flex items-center justify-center bg-background rounded-xl border border-border animate-pulse">
              <span className="text-sm font-medium text-muted-foreground">
                {isArabic ? "جاري تحميل الموجات الصوتية..." : "Ses dalgaları yükleniyor..."}
              </span>
            </div>
          )}

          <div
            ref={containerRef}
            className={`w-full bg-background rounded-xl border border-border p-2 overflow-hidden transition-opacity duration-300 ${isReady ? 'opacity-100' : 'opacity-0 hidden'}`}
          />

          {/* Zoom Slider */}
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
            </div>
          )}

          {/* Duration info badge */}
          {isReady && (
            <div className="flex items-center justify-center gap-4 mt-3">
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/20 text-xs sm:text-sm font-medium text-primary">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {isArabic ? "المدة المحددة:" : "Seçili süre:"}{" "}
                <span className="font-bold">{formatTime(regionDuration)}</span>
              </div>
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-muted/50 border border-border text-xs sm:text-sm font-medium text-muted-foreground">
                {isArabic ? "الإجمالي:" : "Toplam:"}{" "}
                <span className="font-bold">{formatTime(totalDuration)}</span>
              </div>
            </div>
          )}

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between mt-4 sm:mt-6 gap-3 sm:gap-4">
            <div className="flex items-center justify-center gap-2">
              {/* Play selected region only */}
              <button
                onClick={playRegion}
                disabled={!isReady}
                className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 sm:py-2.5 rounded-lg sm:rounded-xl bg-primary text-white hover:bg-primary-dark transition-colors disabled:opacity-50 font-semibold sm:font-bold text-sm shadow-md"
              >
                {isPlaying ? <PauseIcon className="w-4 h-4 sm:w-5 sm:h-5" /> : <PlayIcon className="w-4 h-4 sm:w-5 sm:h-5" />}
                <span>{isPlaying ? (isArabic ? "إيقاف" : "Durdur") : (isArabic ? "تشغيل المحدد" : "Seçimi Oynat")}</span>
              </button>
              {/* Play full audio */}
              <button
                onClick={playAll}
                disabled={!isReady}
                className="flex items-center justify-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 rounded-lg sm:rounded-xl border border-border text-muted-foreground hover:text-foreground hover:bg-background transition-colors disabled:opacity-50 font-medium text-sm"
              >
                {isArabic ? "الكل" : "Tümü"}
              </button>
            </div>

            <div className="flex items-center gap-2 sm:gap-3">
              <button
                onClick={onCancel}
                className="flex-1 sm:flex-none px-4 sm:px-5 py-2 sm:py-2.5 rounded-lg sm:rounded-xl border border-border bg-background text-foreground hover:bg-border transition-colors font-medium sm:font-bold text-center text-sm"
              >
                {isArabic ? "إلغاء" : "İptal"}
              </button>
              <button
                onClick={handleConfirm}
                disabled={!isReady}
                className="flex-[2] sm:flex-none flex items-center justify-center gap-1.5 sm:gap-2 px-4 sm:px-6 py-2 sm:py-2.5 rounded-lg sm:rounded-xl bg-primary text-white hover:bg-primary-dark transition-all disabled:opacity-50 shadow-lg shadow-primary/25 font-semibold sm:font-bold text-sm"
              >
                <CheckIcon className="w-4 h-4 sm:w-5 sm:h-5" />
                <span>{isArabic ? "اعتماد الصوت" : "Sesi Onayla"}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
