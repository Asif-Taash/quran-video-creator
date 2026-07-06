"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownTrayIcon,
  CloudArrowUpIcon,
  MusicalNoteIcon,
  PhotoIcon,
  VideoCameraIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import DropdownSelect from "@/components/ui/DropdownSelect";
import { useLanguage } from "@/lib/LanguageContext";
import { fixMojibake } from "@/lib/textEncoding";
import quranData from "@/data/quran.json";

import TranslationSelector from "@/components/quran/TranslationSelector";
import { useTranslationContext } from "@/lib/TranslationContext";
import ManualSegmentationEditor from "./ManualSegmentationEditor";
import AudioTrimmer from "./AudioTrimmer";
import { BackgroundStyle, VideoState } from "@/types/video";




interface Verse {
  id: number;
  text: string;
  translation?: string;
  page?: number;
}

interface Surah {
  id: number;
  name: string;
  transliteration: string;
  total_verses: number;
  verses: Verse[];
}

type RenderState = "idle" | "rendering" | "done" | "error";

interface ApiAyah {
  ayah_number: number;
  text_arabic: string;
  text_turkish: string;
}

interface ApiSurah {
  id: number;
  name_arabic: string;
  name_turkish: string;
  name_transliteration: string;
  ayahs: ApiAyah[];
}

export default function VideoCreatorForm() {
  const { language } = useLanguage();
  const isArabic = language === "ar";
  const surahs = quranData as Surah[];
  const { selectedTranslation, setSelectedTranslationId, getTranslation, fetchSurahTranslations } = useTranslationContext();

  const [selectedSurah, setSelectedSurah] = useState<Surah | null>(null);
  const [selectedApiSurah, setSelectedApiSurah] = useState<ApiSurah | null>(null);
  const [selectedReciter, setSelectedReciter] = useState<string>("mishary_alafasy");
  const [startVerse, setStartVerse] = useState<number | null>(null);
  const [endVerse, setEndVerse] = useState<number | null>(null);
  const [bgImage, setBgImage] = useState<File | null>(null);
  const [bgPreview, setBgPreview] = useState<string | null>(null);
  const [renderState, setRenderState] = useState<RenderState>("idle");
  const [surahTurkishNames, setSurahTurkishNames] = useState<Map<number, string>>(
    new Map(surahs.map((s) => [s.id, s.transliteration]))
  );
  const [renderError, setRenderError] = useState("");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isGeneratingBg, setIsGeneratingBg] = useState(false);
  const [customAudio, setCustomAudio] = useState<File | null>(null);
  const [audioSourceMode, setAudioSourceMode] = useState<"reciter" | "custom">("reciter");

  const [segmentationProgress, setSegmentationProgress] = useState<string | null>(null);
  const [showManualEditor, setShowManualEditor] = useState(false);
  const [pendingSegmentationData, setPendingSegmentationData] = useState<any[]>([]);

  const [showAudioTrimmer, setShowAudioTrimmer] = useState(false);
  const [preparedAudioUrl, setPreparedAudioUrl] = useState<string | null>(null);
  const [preparedAudioLocalPath, setPreparedAudioLocalPath] = useState<string | null>(null);
  const [preparedJsonData, setPreparedJsonData] = useState<any>(null);
  const [audioTrimStart, setAudioTrimStart] = useState<number>(0);
  const [audioTrimEnd, setAudioTrimEnd] = useState<number>(0);
  const [isPreparingAudio, setIsPreparingAudio] = useState(false);
  const [audioProgressStage, setAudioProgressStage] = useState<string | null>(null);
  const [isTrimming, setIsTrimming] = useState(false);
  // The URL of the final trimmed audio for inline playback preview
  const [trimmedPreviewUrl, setTrimmedPreviewUrl] = useState<string | null>(null);

  const handlePrepareAudio = async () => {
    if (!selectedSurah || startVerse === null || endVerse === null) return;
    
    // If we already have prepared audio (meaning parameters haven't changed), just reopen the trimmer
    if (preparedAudioUrl) {
      setShowAudioTrimmer(true);
      return;
    }
    
    setIsPreparingAudio(true);
    setAudioProgressStage(isArabic ? "⬇️ تحميل الملف الصوتي..." : "⬇️ Ses dosyası indiriliyor...");
    try {
      const formData = new FormData();
      formData.append("surahId", selectedSurah.id.toString());
      formData.append("startVerse", startVerse.toString());
      formData.append("endVerse", endVerse.toString());
      formData.append("reciterId", selectedReciter);
      if (audioSourceMode === "custom" && customAudio) {
        formData.append("customAudio", customAudio);
      }
      // Add 10.0s padding so the user can use the AudioTrimmer UI to expand the selection if needed
      formData.append("padSeconds", "10.0");

      setAudioProgressStage(isArabic ? "🔍 تحليل الموجات الصوتية..." : "🔍 Ses dalgaları analiz ediliyor...");

      const res = await fetch("/api/video/prepare-audio", {
        method: "POST",
        body: formData,
      });

      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setAudioProgressStage(isArabic ? "✂️ جاري تجهيز النتيجة..." : "✂️ Sonuç hazırlanıyor...");
          
          // Calculate default trim bounds so that if the user skips the trimmer, the padding is still trimmed out
          let defaultRegionStart = 0;
          let defaultRegionEnd = 0;
          if (data.wordTimingsData && data.wordTimingsData.verses) {
            let minStart = Infinity;
            let maxEnd = 0;
            Object.values(data.wordTimingsData.verses).forEach((v: any) => {
              v.words?.forEach((w: any) => {
                if (w.start < minStart) minStart = w.start;
                if (w.end > maxEnd) maxEnd = w.end;
              });
            });
            if (minStart !== Infinity) {
              defaultRegionStart = Math.max(0, (minStart / 1000) - 0.25);
              defaultRegionEnd = (maxEnd / 1000) + 0.25;
            }
          }
          
          setAudioTrimStart(defaultRegionStart);
          setAudioTrimEnd(defaultRegionEnd);
          
          setPreparedAudioUrl(data.audioUrl);
          setPreparedAudioLocalPath(data.localAudioPath);
          setPreparedJsonData(data.wordTimingsData);
          setTrimmedPreviewUrl(null);
          setShowAudioTrimmer(true);
        } else {
          alert(data.error);
        }
      } else {
        const errData = await res.json().catch(() => null);
        if (errData && errData.error) {
          alert(errData.error);
        } else {
          alert(isArabic ? "فشل تجهيز الصوت. حدث خطأ في الخادم." : "Ses hazırlanamadı. Sunucu hatası.");
        }
      }
    } catch (e) {
      console.error(e);
      alert(isArabic ? "حدث خطأ أثناء الاتصال بالخادم" : "Sunucuya bağlanırken hata oluştu");
    } finally {
      setIsPreparingAudio(false);
      setAudioProgressStage(null);
    }
  };

  const handleAudioTrimConfirm = async (trimStart: number, trimEnd: number) => {
    setAudioTrimStart(trimStart);
    setAudioTrimEnd(trimEnd);
    setShowAudioTrimmer(false);

    if ((trimStart > 0 || trimEnd > 0) && preparedAudioLocalPath) {
      setIsTrimming(true);
      try {
        const res = await fetch("/api/video/trim-audio", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            audioPath: preparedAudioLocalPath,
            trimStart,
            trimEnd,
            wordTimingsData: preparedJsonData,
          }),
        });

        if (res.ok) {
          const data = await res.json();
          if (data.success) {
            // Only update the preview URL. Do NOT overwrite the original prepared data, 
            // so the trimmer handles stay correct and the video generator can perform the final cut.
            setTrimmedPreviewUrl(data.audioUrl);
          }
        } else {
          console.error("Trim failed", await res.text());
        }
      } catch (err) {
        console.error("Trim API error:", err);
      } finally {
        setIsTrimming(false);
      }
    } else {
      setTrimmedPreviewUrl(preparedAudioUrl);
    }
  };


  const executeVideoRender = async (segmentationData: any[] | null = null) => {
    try {
      if (segmentationData && segmentationData.length > 0) {
        setSegmentationProgress(
          isArabic ? "جاري تطبيق التقسيم..." : "Bölümleme uygulanıyor..."
        );

        const applyRes = await fetch("/api/segmentation/apply", {
          method: "POST",
          body: JSON.stringify(segmentationData),
          headers: { "Content-Type": "application/json" },
        });

        if (!applyRes.ok) {
          const applyData = await applyRes.json();
          console.warn(`[UI] Failed to apply segmentation: ${applyData.error}. Continuing without segmentation.`);
          await fetch("/api/segmentation/clear", { method: "POST" }).catch(() => {});
        } else {
          console.log(`[UI] Successfully applied segmentation for ${segmentationData.length} verses`);
        }
      }

      setSegmentationProgress(null);

      // Build form data and render video
      const formData = new FormData();
      if (!selectedSurah || !startVerse || !endVerse) throw new Error("Missing required fields");
      formData.append("surahId", String(selectedSurah.id));
      formData.append("startVerse", String(startVerse));
      formData.append("endVerse", String(endVerse));

      if (audioSourceMode === "custom" && customAudio) {
        formData.append("customAudio", customAudio);
        formData.append("reciterId", selectedReciter);
      } else {
        formData.append("reciterId", selectedReciter);
      }

      if (bgImage) {
        formData.append("bgImage", bgImage);
      }
      if (selectedTranslation) {
        formData.append("translationId", selectedTranslation.id);
      }

      if (preparedAudioUrl) {
        formData.append("usePreparedAudio", "true");
        if (preparedAudioLocalPath) formData.append("preparedAudioLocalPath", preparedAudioLocalPath);
        if (preparedJsonData) formData.append("preparedJsonData", JSON.stringify(preparedJsonData));
        if (audioTrimStart > 0 || audioTrimEnd > 0) {
          formData.append("trimStart", String(audioTrimStart));
          formData.append("trimEnd", String(audioTrimEnd));
        }
      }

      console.log("[UI] Sending payload:", Object.fromEntries(formData.entries()));

      const response = await fetch("/api/video/render", {
        method: "POST",
        body: formData,
      });
      const data = await response.json();

      if (!response.ok || !data.videoUrl) {
        throw new Error(data.error || "Video render failed");
      }

      setVideoUrl(`${data.videoUrl}?t=${Date.now()}`);
      setRenderState("done");
    } catch (error) {
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
            const apiAyah = selectedApiSurah?.ayahs.find((ayah) => ayah.ayah_number === verse.id);
            const fallbackTranslation = fixMojibake(apiAyah?.text_turkish || "");
            
            return {
              ...verse,
              text: fixMojibake(apiAyah?.text_arabic || verse.text),
              translation: getTranslation(selectedSurah.id, verse.id, fallbackTranslation),
              page: verse.page,
            };
          })
      : [];

  const canGenerate = Boolean(
    renderState !== "rendering" && 
    selectedSurah && startVerse && endVerse && 
    preparedAudioUrl !== null
  );

  // Reset prepared audio if user changes audio-related selection (NOT background)
  useEffect(() => {
    setPreparedAudioUrl(null);
    setPreparedAudioLocalPath(null);
    setPreparedJsonData(null);
    setAudioTrimStart(0);
    setAudioTrimEnd(0);
    setTrimmedPreviewUrl(null);
    setVideoUrl(null);
    setRenderState("idle");
  }, [selectedSurah, startVerse, endVerse, selectedReciter, customAudio, audioSourceMode]);

  // Cleanup generated temp files on initial page load
  useEffect(() => {
    fetch("/api/video/cleanup", { method: "DELETE" })
      .catch(err => console.warn("Failed to cleanup on mount", err));
  }, []);

  useEffect(() => {
    const baseUrl = process.env.NEXT_PUBLIC_API_URL || "/backend";
    fetch(`${baseUrl}/surahs/`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && Array.isArray(data)) {
          setSurahTurkishNames(
            new Map(data.map((s: { id: number; name_turkish: string }) => [s.id, s.name_turkish]))
          );
        }
      })
      .catch(() => {});
      
    // Default to "none" in the Video Creator
    setSelectedTranslationId("none");
  }, [setSelectedTranslationId]);

  const handleSurahChange = async (surahId: number | string) => {
    surahId = Number(surahId);
    const surah = surahs.find((item) => item.id === surahId) || null;
    setSelectedSurah(surah);
    setSelectedApiSurah(null);
    setStartVerse(null);
    setEndVerse(null);
    setVideoUrl(null);
    setRenderError("");
    setRenderState("idle");

    if (!surah) return;

    try {
      const baseUrl = process.env.NEXT_PUBLIC_API_URL || "/backend";
      const response = await fetch(`${baseUrl}/surahs/${surahId}`);
      if (response.ok) {
        setSelectedApiSurah(await response.json());
      }
      
      // Fetch dynamic translations for the selected surah
      await fetchSurahTranslations(surah.id);
      
    } catch {
      setSelectedApiSurah(null);
    }
  };

  useEffect(() => {
    if (selectedSurah) {
      fetchSurahTranslations(selectedSurah.id);
    }
  }, [selectedSurah?.id, selectedTranslation.id, fetchSurahTranslations]);

  const handleStartVerseChange = (verse: number | string) => {
    let num = Number(verse);
    if (isNaN(num) || num < 1) num = 1;
    if (selectedSurah && num > selectedSurah.total_verses) num = selectedSurah.total_verses;
    setStartVerse(num);
    setEndVerse(num);
    setVideoUrl(null);
    setRenderError("");
    setRenderState("idle");
  };

  const handleAddNextVerse = () => {
    if (!selectedSurah || endVerse === null) return;
    if (endVerse < selectedSurah.total_verses) {
      setEndVerse(endVerse + 1);
    }
    setVideoUrl(null);
    setRenderError("");
    setRenderState("idle");
  };

  const handleRemoveLastVerse = () => {
    if (startVerse === null || endVerse === null) return;
    if (endVerse > startVerse) {
      setEndVerse(endVerse - 1);
    }
    setVideoUrl(null);
    setRenderError("");
    setRenderState("idle");
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (bgPreview) {
      URL.revokeObjectURL(bgPreview);
    }

    setBgImage(file);
    setBgPreview(URL.createObjectURL(file));
    setVideoUrl(null);
    setRenderState("idle");
  };

  const removeImage = () => {
    if (bgPreview) {
      URL.revokeObjectURL(bgPreview);
    }
    setBgImage(null);
    setBgPreview(null);
    setVideoUrl(null);
    setRenderState("idle");
  };

  const LONG_VERSE_THRESHOLD = 7; // Only segment verses with more than 7 Arabic words

  const handleSegmentLongVerses = async () => {
    if (!selectedSurah || selectedVersesContent.length === 0) return;

    const segmentationResults = [];
      setSegmentationProgress(isArabic ? "جاري تقسيم الآيات..." : "Ayetler bölümleniyor...");

    for (const verse of selectedVersesContent) {
      const arabicWordCount = verse.text.trim().split(/\s+/).length;
      const translation = verse.translation || "";

      if (!translation.trim()) continue;

      let gotAutoSegmentation = false;

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
            }),
          });

          if (segRes.ok) {
            const segData = await segRes.json();
            if (segData.success && segData.mappings && segData.mappings.length > 1) {
              segmentationResults.push({
                surah: selectedSurah.id,
                ayah: verse.id,
                mappings: segData.mappings,
              });
              gotAutoSegmentation = true;
            }
          }
        } catch (err) {
          console.warn(`[UI] Auto-segmentation error for verse ${verse.id}:`, err);
        }
      }

      // If AI didn't segment it (too short, failed, or returned 1 segment), add as a single block
      // so the user can still manually divide it in the editor.
      if (!gotAutoSegmentation) {
        segmentationResults.push({
          surah: selectedSurah.id,
          ayah: verse.id,
          mappings: [
            {
              part: 1,
              translation_text: translation,
              arabic_unit_count: arabicWordCount,
            },
          ],
        });
      }
    }

    if (segmentationResults.length > 0) {
      setPendingSegmentationData(segmentationResults);
    } else {
      alert(isArabic ? "لم يتم العثور على ترجمات للآيات المحددة." : "Seçili ayetler için çeviri bulunamadı.");
    }
    setSegmentationProgress(null);
  };

  const handleClearSegmentation = async () => {
    setPendingSegmentationData([]);
    await fetch("/api/segmentation/clear", { method: "POST" }).catch(() => {});
  };

  const handleGenerateVideo = async () => {
    if (!selectedSurah || !startVerse || !endVerse) return;

    setRenderState("rendering");
    setRenderError("");
    setVideoUrl(null);
    setSegmentationProgress(null);

    try {
      await executeVideoRender(pendingSegmentationData.length > 0 ? pendingSegmentationData : null);
    } catch (error) {
      setRenderError(error instanceof Error ? error.message : "تعذر إنشاء الفيديو");
      setRenderState("error");
      setSegmentationProgress(null);
    }
  };

  const handleGenerateBg = async () => {
    setIsGeneratingBg(true);
    setRenderError("");
    try {
      // Each prompt describes a unique scene but all share the same core aesthetic:
      // - Very dark, deep navy/indigo night sky taking up 70-80% of the frame
      // - Subtle scattered stars (not dramatic milky way)
      // - Landscape elements as dark silhouettes at the bottom third only
      // - Minimal, clean, serene composition
      // - Real photography feel, not fantasy or over-processed
      const sceneryOptions = [
        "dark silhouetted mountain ridge at the bottom of frame against a vast deep navy blue night sky with subtle scattered stars, minimalist landscape photography, very dark and moody",
        "dark silhouetted coastal cliffs and ocean shoreline at bottom of frame, vast deep dark blue night sky above with faint stars, misty atmosphere, real photograph, serene and minimal",
        "snow-capped mountain peaks silhouetted at the very bottom of frame, enormous deep indigo night sky with sparse subtle stars, slight purple-pink gradient at horizon, real landscape photograph",
        "single dark tree silhouette in bottom corner of frame, vast completely dark night sky filling most of the image, very faint scattered stars, extremely minimal and moody, real photograph",
        "dark rolling hills silhouetted at the bottom of frame, vast deep navy night sky with a small thin crescent moon, no clouds, very dark and minimal, real night photograph",
        "dark mountain range silhouette at the bottom third, huge deep dark blue sky above with sparse tiny stars, subtle dark blue to black gradient, clean minimal composition, real photograph",
        "dark forest treeline silhouette at the very bottom of frame, enormous deep dark indigo night sky, very few faint stars scattered, extremely dark and serene, real night photograph",
        "dark rocky coastline silhouette at bottom, calm dark ocean reflecting deep navy night sky, faint stars above, misty layers between mountains, moody real photograph",
        "jagged dark mountain peaks at bottom of frame with slight snow, vast deep dark blue-black sky above, barely visible stars, subtle horizon glow, real landscape night photograph",
        "dark pine forest silhouette at bottom corner, vast deep navy-black night sky, one or two bright stars visible, extremely dark and peaceful, minimalist real photograph",
        "dark sand dunes silhouetted at bottom of frame, enormous deep dark indigo sky with scattered faint stars, very minimal, no moon, real night desert photograph",
        "dark volcanic mountain silhouette at bottom, vast deep navy night sky fading to black at top, subtle warm glow at far horizon, sparse stars, real photograph",
        "layered dark mountain ridges silhouetted at bottom creating depth, vast deep dark blue night sky above, subtle atmospheric haze between layers, faint stars, real photograph",
        "dark cliff edge with single small tree silhouette at bottom of frame, vast deep dark navy sky, thin crescent moon small in upper area, extremely minimal real photograph",
        "dark meadow with distant treeline silhouette at bottom, enormous deep indigo-black night sky, very faint milky stars, peaceful and serene, real night landscape photograph"
      ];
      const randomScenery = sceneryOptions[Math.floor(Math.random() * sceneryOptions.length)];
      const prompt = `${randomScenery}, vertical portrait 9:16 aspect ratio, ultra dark tones, deep navy and black color palette, no text no watermark, 4K high resolution, shot on Sony A7III, long exposure night photography, ISO 3200, f/2.8, clean sharp image, variation ${Date.now()}`;
      const response = await fetch("/api/ai/generate-background", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await response.json();
      if (!response.ok) {
         throw new Error(data.error || "Failed to generate background");
      }
      
      // Fetch the image from the URL and create a File object so it works with the existing flow
      const imgRes = await fetch(data.imageUrl);
      const blob = await imgRes.blob();
      const file = new File([blob], `ai-bg-${Date.now()}.jpg`, { type: blob.type });
      
      if (bgPreview) {
        URL.revokeObjectURL(bgPreview);
      }
      setBgImage(file);
      setBgPreview(URL.createObjectURL(file));
      setVideoUrl(null);
      setRenderState("idle");
    } catch (err) {
      setRenderError(err instanceof Error ? err.message : "تعذر توليد الخلفية");
    } finally {
      setIsGeneratingBg(false);
    }
  };

  const handleCustomAudioUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCustomAudio(file);
    setVideoUrl(null);
    setRenderState("idle");
  };

  const removeCustomAudio = () => {
    setCustomAudio(null);
    setVideoUrl(null);
    setRenderState("idle");
  };



  return (
    <>
      <div className="mx-auto max-w-5xl space-y-8" dir={isArabic ? "rtl" : "ltr"}>
      <div className="text-center space-y-2">
        <h1 className="text-3xl font-bold text-gradient-gold">
          {isArabic ? "صانع الفيديو القرآني" : "Kuran Videosu Oluşturucu"}
        </h1>
        <p className="text-muted-foreground">
          {isArabic
            ? "اختر السورة والآيات والخلفية والقارئ، ثم أنشئ فيديو جاهزًا للتحميل."
            : "Sureyi, ayetleri, arka planı ve kariyi seçip indirilebilir video oluşturun."}
        </p>
      </div>

      <div className="mx-auto max-w-3xl">
        <div className="bg-surface border border-border rounded-2xl p-6 md:p-8 space-y-8 shadow-sm">
          <section className="space-y-4">
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm text-primary">
                1
              </span>
              {isArabic ? "اختيار السورة والآيات" : "Sure ve Ayet Seçimi"}
            </h2>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <DropdownSelect
                label={isArabic ? "السورة" : "Sure"}
                placeholder={isArabic ? "اختر السورة..." : "Sure seçin..."}
                options={surahs.map((surah) => {
                  const turkishName = surahTurkishNames.get(surah.id);
                  let label: string;
                  if (isArabic) {
                    label = `سورة ${fixMojibake(surah.name)}`;
                  } else if (turkishName) {
                    label = `${fixMojibake(turkishName)} Suresi`;
                  } else {
                    label = `${fixMojibake(surah.transliteration)} Suresi`;
                  }
                  return {
                    value: String(surah.id),
                    label,
                  };
                })}
                value={selectedSurah ? String(selectedSurah.id) : null}
                onChange={(val) => {
                  const surah = surahs.find((s) => String(s.id) === val);
                  setSelectedSurah(surah || null);
                  if (surah) {
                    setStartVerse(1);
                    setEndVerse(1);
                  }
                }}
                isRtl={isArabic}
                showNumberBadge
                disabled={false}
                enableSearch={true}
                searchPlaceholder={isArabic ? "ابحث عن سورة..." : "Sure ara..."}
              />

              <div className="space-y-1.5 flex flex-col justify-end">
                <label className="text-sm font-medium text-foreground">
                  {isArabic ? "الترجمة" : "Çeviri"}
                </label>
                <div className="h-[50px] flex items-center w-full">
                  <TranslationSelector className="w-full" forceShow={true} />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">
                  {isArabic ? "الآية الأولى" : "İlk Ayet"}
                </label>
                <input
                  type="number"
                  min={1}
                  max={selectedSurah?.total_verses ?? 1}
                  value={startVerse ?? ""}
                  onChange={(e) => {
                    const val = e.target.valueAsNumber;
                    if (!isNaN(val)) {
                      let num = Number(val);
                      if (isNaN(num) || num < 1) num = 1;
                      if (selectedSurah && num > selectedSurah.total_verses) num = selectedSurah.total_verses;
                      setStartVerse(num);
                      setEndVerse(num);
                      setVideoUrl(null);
                      setRenderError("");
                      setRenderState("idle");
                    } else if (e.target.value === "") {
                      setStartVerse(null);
                      setEndVerse(null);
                    }
                  }}
                  disabled={!selectedSurah}
                  placeholder={
                    selectedSurah
                      ? (isArabic ? "رقم الآية..." : "Ayet numarası...")
                      : (isArabic ? "أولاً اختر السورة" : "Önce sure seçin")
                  }
                  className="w-full h-[50px] rounded-xl border border-border bg-background px-4 py-2.5 text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
                  dir={isArabic ? "rtl" : "ltr"}
                />
              </div>
            </div>

            {startVerse && endVerse && selectedSurah && (
              <div className="mt-6 space-y-5 rounded-2xl border border-border/50 bg-gradient-to-br from-surface/80 to-background p-5 shadow-inner-soft backdrop-blur-sm transition-all duration-300">
                <div className="flex flex-wrap gap-2.5">
                  {versesArray.map((verse) => (
                    <span 
                      key={verse} 
                      className="inline-flex items-center rounded-full border border-primary/20 bg-primary/5 px-3.5 py-1.5 text-sm font-medium text-primary shadow-sm transition-all hover:bg-primary/10"
                    >
                      {isArabic ? fixMojibake(selectedSurah.name) : fixMojibake(selectedSurah.transliteration)}: {verse}
                    </span>
                  ))}
                </div>

                <div className="flex flex-wrap justify-center gap-3">
                  <button
                    type="button"
                    onClick={handleAddNextVerse}
                    disabled={endVerse >= selectedSurah.total_verses}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-primary/10 px-4 py-2 text-sm font-medium text-primary transition-all hover:bg-primary/20 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    + {isArabic ? "أضف الآية التالية" : "Sonraki Ayeti Ekle"}
                  </button>
                  <button
                    type="button"
                    onClick={handleRemoveLastVerse}
                    disabled={endVerse <= startVerse}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-red-500/10 px-4 py-2 text-sm font-medium text-red-500 transition-all hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    - {isArabic ? "إزالة آخر آية" : "Son Ayeti Kaldır"}
                  </button>
                </div>
                
                {/* Segmentation Buttons */}
                <div className="flex flex-wrap justify-center gap-3 mt-4 pt-4 border-t border-border/50">
                  {pendingSegmentationData.length > 0 ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setShowManualEditor(true)}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-600 transition-all hover:bg-emerald-500/20 shadow-sm"
                      >
                        {isArabic ? "تعديل التقسيم" : "Bölümlemeyi Düzenle"}
                      </button>
                      <button
                        type="button"
                        onClick={handleClearSegmentation}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-red-500/10 px-4 py-2 text-sm font-medium text-red-500 transition-all hover:bg-red-500/20 shadow-sm"
                      >
                        {isArabic ? "حذف التقسيم" : "Bölümlemeyi Temizle"}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={handleSegmentLongVerses}
                      disabled={segmentationProgress !== null}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-primary/10 px-4 py-2 text-sm font-medium text-primary transition-all hover:bg-primary/20 disabled:opacity-50 shadow-sm"
                    >
                      {segmentationProgress ? (
                        <>
                          <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          {segmentationProgress}
                        </>
                      ) : (
                        isArabic ? "تقسيم الآيات الطويلة (اختياري)" : "Uzun Ayetleri Bölümle (İsteğe bağlı)"
                      )}
                    </button>
                  )}
                </div>
              </div>
            )}
          </section>

          <hr className="border-border" />

          <section className="space-y-4">
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm text-primary">
                2
              </span>
              {isArabic ? "الخلفية الاختيارية" : "İsteğe Bağlı Arka Plan"}
            </h2>

            <div 
              className="group relative flex min-h-[220px] w-full flex-col items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed border-border/60 bg-gradient-to-b from-surface/30 to-background/50 p-6 transition-all duration-500 hover:border-primary/40 hover:bg-surface/50"
              onClick={(e) => {
                // Only open lightbox if clicking the container area (not buttons/labels)
                const target = e.target as HTMLElement;
                if (bgPreview && !target.closest('button') && !target.closest('label')) {
                  window.open(bgPreview, '_blank');
                }
              }}
              style={{ cursor: bgPreview ? 'pointer' : 'default' }}
            >
              {bgPreview ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={bgPreview} alt="" className="absolute inset-0 h-full w-full object-cover opacity-60 transition-transform duration-700 group-hover:scale-105" />
                  <div className="absolute inset-0 bg-black/20 backdrop-blur-[2px] transition-opacity duration-500 group-hover:bg-black/40" />
                  
                  {/* Hint text for clicking to preview */}
                  <p className="relative z-10 text-xs text-white/70 mb-3 pointer-events-none">
                    {isArabic ? "اضغط على الصورة لعرضها بالحجم الكامل" : "Tam boyut önizleme için resme tıklayın"}
                  </p>

                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); removeImage(); }}
                    className="relative z-10 inline-flex items-center gap-2 rounded-full border border-white/20 bg-black/60 px-5 py-2.5 text-sm font-medium text-white shadow-xl backdrop-blur-md transition-all duration-300 hover:-translate-y-0.5 hover:border-red-500 hover:bg-red-500 hover:shadow-[0_0_20px_rgba(239,68,68,0.4)]"
                  >
                    <XMarkIcon className="h-4 w-4 transition-transform duration-300 group-hover:rotate-90" />
                    {isArabic ? "إزالة الصورة" : "Resmi Kaldır"}
                  </button>
                </>
              ) : (
                <div className="relative z-10 flex flex-col items-center space-y-4 text-center">
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 text-primary shadow-inner transition-transform duration-500 group-hover:scale-110">
                    <PhotoIcon className="h-8 w-8" />
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-base font-semibold tracking-tight text-foreground transition-colors duration-300 group-hover:text-primary">
                      {isArabic ? "ارفع صورة لتكون خلفية الفيديو" : "Video arka planı için resim yükleyin"}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {isArabic ? "عند عدم اختيار صورة سيتم استخدام خلفية سوداء." : "Resim seçilmezse siyah arka plan kullanılır."}
                    </p>
                  </div>
                  <label className="mt-2 inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-6 py-2.5 text-sm font-medium text-primary transition-all duration-300 hover:-translate-y-0.5 hover:bg-primary hover:text-white hover:shadow-glow">
                    {isArabic ? "اختر صورة" : "Resim Seç"}
                    <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
                  </label>
                  <button
                    type="button"
                    onClick={handleGenerateBg}
                    disabled={isGeneratingBg}
                    className="mt-2 inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-primary/20 bg-primary/10 px-6 py-2.5 text-sm font-medium text-primary transition-all duration-300 hover:-translate-y-0.5 hover:bg-primary/20 hover:shadow-glow disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isGeneratingBg ? (
                      <>
                        <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        {isArabic ? "جاري التوليد..." : "Oluşturuluyor..."}
                      </>
                    ) : (
                      <>
                        {isArabic ? "توليد بالذكاء الاصطناعي" : "AI ile Arka Plan Oluştur"}
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          </section>

          <hr className="border-border" />

          <section className="space-y-4">
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm text-primary">
                3
              </span>
              {isArabic ? "الصوت" : "Ses"}
            </h2>

            <div className="flex flex-col gap-4">
              <div className="flex p-1 bg-primary/5 rounded-xl border border-primary/10 mb-2 relative">
                <button
                  type="button"
                  onClick={() => setAudioSourceMode("reciter")}
                  className={`flex-1 flex items-center justify-center py-2.5 px-4 text-sm font-medium rounded-lg transition-all duration-300 relative z-10 ${
                    audioSourceMode === "reciter" 
                      ? "bg-background text-primary shadow-sm border border-primary/20" 
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {isArabic ? "اختر قارئ" : "Kari Seç"}
                </button>
                <button
                  type="button"
                  onClick={() => setAudioSourceMode("custom")}
                  className={`flex-1 flex items-center justify-center py-2.5 px-4 text-sm font-medium rounded-lg transition-all duration-300 relative z-10 ${
                    audioSourceMode === "custom" 
                      ? "bg-background text-primary shadow-sm border border-primary/20" 
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {isArabic ? "رفع ملف صوتي" : "Kendi Sesini Yükle"}
                </button>
              </div>

              {audioSourceMode === "reciter" ? (
                <DropdownSelect
                  placeholder={isArabic ? "مشاري راشد العفاسي" : "Mishary Rashed Alafasy"}
                  options={[
                    { value: "mishary_alafasy", label: isArabic ? "مشاري راشد العفاسي" : "Mishary Rashed Alafasy" },
                    { value: "maher_muaiqly", label: isArabic ? "ماهر المعيقلي" : "Maher Al-Muaiqly" },
                    { value: "ahmed_ajmi", label: isArabic ? "أحمد العجمي" : "Ahmed Al-Ajmi" },
                    { value: "yasser_dosari", label: isArabic ? "ياسر الدوسري" : "Yasser Al-Dosari" },
                    { value: "abdullah_mousa", label: isArabic ? "عبدالله الموسى" : "Abdullah Al-Mousa" },
                    { value: "raad_alkurdi", label: isArabic ? "رعد محمد الكردي" : "Raad Mohammad Al Kurdi" },
                  ]}
                  value={selectedReciter}
                  onChange={(val) => {
                    setSelectedReciter(val as string);
                    setPreparedAudioUrl(null);
                    setPreparedAudioLocalPath(null);
                    setPreparedJsonData(null);
                    setTrimmedPreviewUrl(null);
                    setVideoUrl(null);
                    setRenderState("idle");
                  }}
                  isRtl={isArabic}
                />
              ) : (
                <div className="w-full">
                   {customAudio ? (
                     <>
                       <div className={`w-full flex items-center justify-between gap-3 rounded-2xl border border-border bg-background px-5 py-3.5 shadow-sm text-sm font-medium transition-all duration-300 ${isArabic ? 'text-right' : 'text-left'}`} dir={isArabic ? 'rtl' : 'ltr'}>
                          <div className="flex items-center gap-3 overflow-hidden">
                            <MusicalNoteIcon className="h-5 w-5 text-primary flex-shrink-0" />
                            <span className="truncate">
                              {customAudio.name}
                            </span>
                          </div>
                          <button 
                            type="button" 
                            onClick={removeCustomAudio}
                            className="text-foreground/40 hover:text-red-500 hover:bg-red-50 p-1.5 rounded-lg transition-colors flex-shrink-0"
                            title={isArabic ? "حذف" : "Sil"}
                          >
                             <XMarkIcon className="h-5 w-5" />
                          </button>
                       </div>
                       <audio controls src={URL.createObjectURL(customAudio)} className="w-full mt-3 h-10 rounded-lg outline-none" />
                     </>
                   ) : (
                     <label className={`w-full flex items-center justify-between gap-3 rounded-2xl border border-border bg-background px-5 py-3.5 shadow-sm hover:border-primary/30 hover:shadow-md text-sm font-medium transition-all duration-300 cursor-pointer ${isArabic ? 'text-right' : 'text-left'}`} dir={isArabic ? 'rtl' : 'ltr'}>
                        <span className="opacity-50 truncate">
                          {isArabic ? "تصفح لاختيار ملف صوتي مخصص..." : "Özel bir ses dosyası seçin..."}
                        </span>
                        <div className="flex items-center gap-2 flex-shrink-0">
                           <CloudArrowUpIcon className="w-5 h-5 text-foreground/40" />
                        </div>
                        <input type="file" accept="audio/*" className="hidden" onChange={handleCustomAudioUpload} />
                     </label>
                   )}
                </div>
              )}
            </div>
          </section>

          <div className="mt-4 pt-4 border-t border-border/50">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex-1">
                <h4 className="text-sm font-medium text-foreground">
                  {isArabic ? "تجهيز وتعديل الصوت (إلزامي)" : "Sesi Hazırla ve Düzenle (Zorunlu)"}
                </h4>
                <p className="text-xs text-muted-foreground mt-1">
                  {isArabic 
                    ? "استخدم هذه الميزة لسماع الصوت وقص أطرافه بدقة إذا كانت هناك كلمات مقطوعة." 
                    : "Kesilmiş kelimeler varsa sesin uçlarını hassas bir şekilde kesmek veya uzatmak için bu özelliği kullanın."}
                </p>
                {/* Multi-stage progress indicator */}
                {isPreparingAudio && audioProgressStage && (
                  <p className="text-xs text-primary font-medium mt-1.5 flex items-center gap-1.5">
                    <svg className="animate-spin h-3.5 w-3.5 text-primary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                    {audioProgressStage}
                  </p>
                )}
                {isTrimming && (
                  <p className="text-xs text-primary font-medium mt-1.5 flex items-center gap-1.5">
                    <svg className="animate-spin h-3.5 w-3.5 text-primary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                    {isArabic ? "✂️ جاري قص الصوت..." : "✂️ Ses kesiliyor..."}
                  </p>
                )}
                {preparedAudioUrl && !isPreparingAudio && !isTrimming && (
                  <p className="text-xs text-emerald-500 font-medium mt-1">
                    {isArabic ? "✅ تم تجهيز وتعديل الصوت بنجاح" : "✅ Ses başarıyla hazırlandı ve düzenlendi"}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={handlePrepareAudio}
                disabled={isPreparingAudio || isTrimming || !selectedSurah || startVerse === null || endVerse === null}
                className="w-full sm:w-auto px-4 py-2.5 sm:py-2 text-sm rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 flex-shrink-0"
              >
                {isPreparingAudio ? (
                  <>
                    <svg className="animate-spin h-4 w-4 text-primary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                    <span>{isArabic ? "جاري التجهيز..." : "Hazırlanıyor..."}</span>
                  </>
                ) : (
                  <span>{isArabic ? (preparedAudioUrl ? "تعديل الصوت" : "تجهيز وتعديل الصوت") : (preparedAudioUrl ? "Sesi Düzenle" : "Sesi Hazırla")}</span>
                )}
              </button>
            </div>

            {/* Inline audio preview player after trimming */}
            {trimmedPreviewUrl && !isPreparingAudio && !isTrimming && (
              <div className="mt-3 p-3 rounded-xl bg-background border border-border">
                <div className="flex items-center gap-2 mb-2">
                  <MusicalNoteIcon className="h-4 w-4 text-primary" />
                  <span className="text-xs font-medium text-foreground">
                    {isArabic ? "معاينة الصوت النهائي:" : "Son ses önizlemesi:"}
                  </span>
                </div>
                <audio 
                  controls 
                  src={trimmedPreviewUrl} 
                  className="w-full h-10 rounded-lg outline-none" 
                  preload="auto"
                />
              </div>
            )}
          </div>

          <div className="grid gap-3 pt-2 sm:grid-cols-2">
            {/* Auto-Segment Toggle */}
            
            <button
              type="button"
              onClick={handleGenerateVideo}
              disabled={!canGenerate}
              className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-primary to-primary-dark py-4 font-bold text-white shadow-lg transition-all hover:shadow-primary/25 disabled:opacity-50 sm:col-span-2"
            >
              <VideoCameraIcon className="h-6 w-6" />
              {renderState === "rendering"
                ? isArabic
                  ? "جاري إنشاء الفيديو..."
                  : "Video oluşturuluyor..."
                : !preparedAudioUrl
                  ? isArabic
                    ? "يجب تجهيز الصوت أولاً"
                    : "Önce Sesi Hazırlayın"
                  : isArabic
                    ? "إنشاء الفيديو"
                    : "Videoyu Oluştur"}
            </button>
          </div>

          {renderState === "error" && (
            <p className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">
              {isArabic ? "حدث خطأ أثناء إنشاء الفيديو: " : "Video oluşturulurken hata oluştu: "}
              {renderError}
            </p>
          )}

          {videoUrl && (
            <div className="space-y-3 rounded-2xl border border-border bg-surface p-4">
              <video src={videoUrl} controls className="w-full rounded-xl bg-black" />
              <div className="flex gap-2">
                <a
                  href={videoUrl}
                  download
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 font-bold text-white transition hover:bg-primary-dark"
                >
                  <ArrowDownTrayIcon className="h-5 w-5" />
                  {isArabic ? "تحميل الفيديو" : "Videoyu İndir"}
                </a>
              </div>
            </div>
          )}
        </div>
      </div>



    </div>

      {showManualEditor && pendingSegmentationData.length > 0 && (
        <ManualSegmentationEditor
          isOpen={showManualEditor}
          onClose={() => setShowManualEditor(false)}
          segmentationData={pendingSegmentationData}
          verses={selectedVersesContent.map(v => ({ id: v.id, text: v.text, page: v.page, translation: v.translation || "" }))}
          isArabic={isArabic}
          onConfirm={(adjustedData) => {
            setPendingSegmentationData(adjustedData);
            setShowManualEditor(false);
          }}
        />
      )}

      {showAudioTrimmer && preparedAudioUrl && (
        (() => {
          let defaultRegionStart = 4.0;
          let defaultRegionEnd: number | null = null;
          
          if (audioTrimEnd > 0) {
            defaultRegionStart = audioTrimStart;
            defaultRegionEnd = audioTrimEnd;
          } else if (preparedJsonData && preparedJsonData.verses) {
            let minStart = Infinity;
            let maxEnd = 0;
            Object.values(preparedJsonData.verses).forEach((v: any) => {
              v.words?.forEach((w: any) => {
                if (w.start < minStart) minStart = w.start;
                if (w.end > maxEnd) maxEnd = w.end;
              });
            });
            if (minStart !== Infinity) {
              defaultRegionStart = Math.max(0, (minStart / 1000) - 0.25);
              defaultRegionEnd = (maxEnd / 1000) + 0.25;
            }
          }
          
          return (
            <AudioTrimmer
              audioUrl={preparedAudioUrl}
              defaultRegionStart={defaultRegionStart}
              defaultRegionEnd={defaultRegionEnd}
              isArabic={isArabic}
              onCancel={() => setShowAudioTrimmer(false)}
              onConfirm={handleAudioTrimConfirm}
            />
          );
        })()
      )}
    </>
  );
}
