import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);
import quranData from "@/data/quran.json";
import { fixMojibake } from "@/lib/textEncoding";
import { parseFile } from "music-metadata";
import type { QuranVideoProps, QuranVerse } from "@/remotion/types";
import type { VideoConfig } from "remotion";



export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LocalVerse = {
  id: number;
  text: string;
  page?: number;
};

type LocalSurah = {
  id: number;
  name: string;
  transliteration: string;
  total_verses: number;
  verses: LocalVerse[];
};

type ApiAyah = {
  ayah_number: number;
  text_arabic: string;
  text_turkish: string;
};

type ApiSurah = {
  id: number;
  name_arabic: string;
  name_turkish: string;
  name_transliteration: string;
  ayahs: ApiAyah[];
};

const FPS = 30;
const RENDERS_DIR = path.join(process.cwd(), "public", "renders");
const RECITERS = {
  mishary_alafasy: {
    name: "مشاري راشد العفاسي",
    audioBaseUrl: "https://everyayah.com/data/Alafasy_128kbps",
  },
  maher_muaiqly: {
    name: "ماهر المعيقلي",
    audioBaseUrl: "https://everyayah.com/data/Maher_AlMuaiqly_64kbps",
  },
  ahmed_ajmi: {
    name: "أحمد العجمي",
    audioBaseUrl: "https://everyayah.com/data/Ahmed_ibn_Ali_al-Ajamy_128kbps_ketaballah.net",
  },
  yasser_dosari: {
    name: "ياسر الدوسري",
    audioBaseUrl: "https://everyayah.com/data/Yasser_Ad-Dussary_128kbps",
  },
  abdullah_mousa: {
    name: "عبدالله الموسى",
    audioBaseUrl: "https://everyayah.com/data/Alafasy_128kbps", // fallback dummy, uses python extraction natively
  },
  raad_alkurdi: {
    name: "رعد محمد الكردي",
    audioBaseUrl: "https://everyayah.com/data/Alafasy_128kbps", // fallback dummy, uses python extraction natively
  },
} as const;

const formatNumber = (num: number) => num.toString().padStart(3, "0");

function audioUrlFor(reciterId: keyof typeof RECITERS, surahId: number, verseId: number) {
  return `${RECITERS[reciterId].audioBaseUrl}/${formatNumber(surahId)}${formatNumber(verseId)}.mp3`;
}

function removeTashkeel(text: string): string {
  return text.replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u08D4-\u08FF]/g, "");
}

function safeUploadName(name: string) {
  const extension = path.extname(name).toLowerCase() || ".jpg";
  return `bg-${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`;
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fetchApiSurah(surahId: number): Promise<ApiSurah | null> {
  const baseUrl = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:8000";

  try {
    const response = await fetch(`${baseUrl}/api/surahs/${surahId}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    return response.json();
  } catch {
    return null;
  }
}

async function downloadAudioToPublic(audioUrl: string, audioPath: string) {
  const absolutePath = path.join(process.cwd(), "public", audioPath);

  if (await fileExists(absolutePath)) {
    return absolutePath;
  }

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(audioUrl, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "User-Agent": "KuranNuruVideoRenderer/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to download audio ${audioUrl}: HTTP ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(absolutePath, buffer);
    return absolutePath;
  } finally {
    clearTimeout(timeout);
  }
}

async function estimateAudioDurationInFrames(localAudioFile: string) {
  try {
    const metadata = await parseFile(localAudioFile);
    const seconds = metadata.format.duration;
    if (seconds && seconds > 0) {
      return Math.max(1, Math.ceil(seconds * FPS));
    }
  } catch {
    console.warn(`music-metadata failed for ${localAudioFile}, falling back to file-size heuristic`);
  }

  const stats = await fs.stat(localAudioFile);
  const fileSizeBytes = stats.size;
  const bitrateBytesPerSec = 16000;
  const seconds = fileSizeBytes / bitrateBytesPerSec;
  return Math.max(1, Math.ceil((seconds + 0.25) * FPS));
}

let cachedServeUrl: string | null = null;
let bundlePromise: Promise<string> | null = null;

async function getServeUrl() {
  if (cachedServeUrl) return cachedServeUrl;

  if (!bundlePromise) {
    const { bundle } = await import("@remotion/bundler");
    bundlePromise = bundle({
      entryPoint: path.join(process.cwd(), "src", "remotion", "index.ts"),
      publicDir: path.join(process.cwd(), "public"),
    });
  }

  try {
    cachedServeUrl = await bundlePromise;
    return cachedServeUrl;
  } finally {
    bundlePromise = null;
  }
}

export async function POST(req: Request) {
  // Array to keep track of files to delete after rendering
  const tempFilesToCleanup: string[] = [];
  try {
    const formData = await req.formData();

    let segmentationData: any[] = [];
    try {
      console.log("[Video Render] Attempting to read temp_segmentation.json");
      const tempFilePath = path.join(process.cwd(), "src", "data", "temp_segmentation.json");
      const fileContent = await fs.readFile(tempFilePath, "utf8");
      segmentationData = JSON.parse(fileContent);
      console.log(`[Video Render] Temp file exists: true`);
      console.log(`[Video Render] Temp file content: ${JSON.stringify(segmentationData, null, 2)}`);
    } catch {
      console.log(`[Video Render] Temp file exists: false`);
    }

    const surahId = Number(formData.get("surahId"));
    const startVerse = Number(formData.get("startVerse"));
    const endVerse = Number(formData.get("endVerse"));

    if (!Number.isInteger(surahId) || !Number.isInteger(startVerse) || !Number.isInteger(endVerse)) {
      return NextResponse.json({ error: "Invalid video options" }, { status: 400 });
    }

    const reciterId = (formData.get("reciterId") || "mishary_alafasy") as keyof typeof RECITERS;
    const translationId = formData.get("translationId") as string || "diyanet_yeni";
    const textScale = Math.max(0.5, Math.min(3, Number(formData.get("textScale")) || 1));

    if (!RECITERS[reciterId]) {
      return NextResponse.json({ error: "Unsupported reciter" }, { status: 400 });
    }

    const localSurahs = quranData as LocalSurah[];
    const localSurah = localSurahs.find((item) => item.id === surahId);

    if (!localSurah || startVerse < 1 || endVerse < startVerse || endVerse > localSurah.total_verses) {
      return NextResponse.json({ error: "Invalid surah or verse range" }, { status: 400 });
    }

    const apiSurah = await fetchApiSurah(surahId);
    const apiAyahByNumber = new Map(
      apiSurah?.ayahs.map((ayah) => [ayah.ayah_number, ayah]) || []
    );

    // Fetch specific translation if required
    const TRANSLATION_RESOURCES: Record<string, number> = {
      "diyanet_yeni": 77,
      "diyanet_eski": 77,
      "ahmet_varol": 124,
      "elmalili": 52,
    };

    const translationMap = new Map<number, string>();
    const isNoneTranslation = translationId === "none";

    if (!isNoneTranslation) {
      const resourceId = TRANSLATION_RESOURCES[translationId] || 77;
      try {
        const res = await fetch(`https://api.quran.com/api/v4/verses/by_chapter/${surahId}?translations=${resourceId}&per_page=300`);
        if (res.ok) {
          const data = await res.json();
          if (data.verses) {
            data.verses.forEach((v: any) => {
              if (v.translations && v.translations.length > 0) {
                const verseNum = parseInt(v.verse_key.split(":")[1]);
                translationMap.set(verseNum, v.translations[0].text.replace(/<[^>]+>/g, ''));
              }
            });
          }
        }
      } catch (err) {
        console.error("Failed to fetch translation:", err);
      }
    }

    const bgImage = formData.get("bgImage") as File | null;
    let backgroundImagePath: string | null = null;

    if (bgImage && bgImage.size > 0) {
      const buffer = Buffer.from(await bgImage.arrayBuffer());
      const uploadsDir = path.join(process.cwd(), "public", "render-assets", "backgrounds");
      await fs.mkdir(uploadsDir, { recursive: true });

      const filename = safeUploadName(bgImage.name);
      const absolutePath = path.join(uploadsDir, filename);
      await fs.writeFile(absolutePath, buffer);

      const validHeaders = [
        [0xff, 0xd8, 0xff],              // JPEG
        [0x89, 0x50, 0x4e, 0x47],         // PNG
        [0x47, 0x49, 0x46],               // GIF
        [0x52, 0x49, 0x46, 0x46],         // WEBP
      ];
      const fileBuffer = await fs.readFile(absolutePath);
      const isValid = validHeaders.some((header) =>
        header.every((byte, i) => fileBuffer[i] === byte)
      );
      if (!isValid) {
        await fs.unlink(absolutePath);
        return NextResponse.json({ error: "Uploaded file is not a valid image (JPEG, PNG, GIF, or WebP)" }, { status: 400 });
      }

      backgroundImagePath = `http://localhost:3000/api/serve-audio?file=render-assets/backgrounds/${filename}`;
    }

    const customAudio = formData.get("customAudio") as File | null;
    const usePreparedAudio = formData.get("usePreparedAudio") === "true";
    const preparedAudioLocalPath = formData.get("preparedAudioLocalPath") as string;
    const preparedJsonStr = formData.get("preparedJsonData") as string;
    const trimStart = Number(formData.get("trimStart")) || 0;
    const trimEnd = Number(formData.get("trimEnd")) || 0;
    let globalAudioPath: string | null = null;
    let globalAudioDurationInFrames = 0;

    if (customAudio && customAudio.size > 0) {
      const buffer = Buffer.from(await customAudio.arrayBuffer());
      const uploadsDir = path.join(process.cwd(), "public", "render-assets", "custom-audio");
      await fs.mkdir(uploadsDir, { recursive: true });

      const extension = path.extname(customAudio.name).toLowerCase() || ".mp3";
      const filename = `custom-${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`;
      const absolutePath = path.join(uploadsDir, filename);
      await fs.writeFile(absolutePath, buffer);

      globalAudioPath = `http://localhost:3000/api/serve-audio?file=render-assets/custom-audio/${filename}`;
      globalAudioDurationInFrames = await estimateAudioDurationInFrames(absolutePath);
    }

    const selectedVerses = localSurah.verses.filter((verse) => verse.id >= startVerse && verse.id <= endVerse);

    const RECITER_KEYS: Record<string, string> = {
      mishary_alafasy: "mishary",
      maher_muaiqly: "maher",
      ahmed_ajmi: "ajmi",
      yasser_dosari: "yasser",
      abdullah_mousa: "mousa",
      raad_alkurdi: "raad_alkurdi"
    };
    const shortReciterKey = RECITER_KEYS[reciterId as string] || "mishary";

    let wordTimingsData: any = null;
    let extractionData: any = null;
    let apiExtracted = false;

    // 1. Call Backend API for Precise Extraction OR Custom Audio Alignment
    try {
      const baseUrl = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:8000";

      if (usePreparedAudio && preparedAudioLocalPath && preparedJsonStr) {
        wordTimingsData = JSON.parse(preparedJsonStr);

        if (trimStart > 0 || trimEnd > 0) {
          console.log(`[Video Render] Using prepared audio and trimming from ${trimStart}s to ${trimEnd}s...`);
          const uploadsDir = path.join(process.cwd(), "public", "render-assets", "trimmed-audio");
          await fs.mkdir(uploadsDir, { recursive: true });
          const trimmedFilename = `trimmed-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`;
          const trimmedAbsolutePath = path.join(uploadsDir, trimmedFilename);

          try {
            const toArg = trimEnd > 0 ? `-to ${trimEnd}` : "";
            await execAsync(`ffmpeg -y -i "${preparedAudioLocalPath}" -ss ${trimStart} ${toArg} -c:a libmp3lame -q:a 2 "${trimmedAbsolutePath}"`);

            // We must serve it relative to the public folder
            globalAudioPath = `http://localhost:3000/api/serve-audio?file=render-assets/trimmed-audio/${trimmedFilename}`;
            globalAudioDurationInFrames = await estimateAudioDurationInFrames(trimmedAbsolutePath);
            tempFilesToCleanup.push(trimmedAbsolutePath);

            // Shift JSON word timings by trimStart
            if (wordTimingsData && wordTimingsData.verses) {
              for (const ayah in wordTimingsData.verses) {
                const words = wordTimingsData.verses[ayah].words || [];
                for (let i = 0; i < words.length; i++) {
                  const word = words[i];
                  word.start = Math.max(0, word.start - (trimStart * 1000));
                  word.end = Math.max(0, word.end - (trimStart * 1000));
                }
              }
            }
            apiExtracted = true;
            console.log("[Video Render] Successfully trimmed prepared audio");
          } catch (err) {
            console.error("[Video Render] FFmpeg trim error:", err);
            return NextResponse.json({ error: "Failed to trim audio using FFmpeg" }, { status: 500 });
          }
        } else {
          // No trimming required, use the prepared audio directly
          console.log(`[Video Render] Using prepared audio without trimming...`);
          // We must map absolute path back to a relative serve path
          // The preparedAudioLocalPath is typically something like /app/public/renders/temp_audio/macro_...
          const relativePathMatch = preparedAudioLocalPath.match(/public[/\\](.*)/);
          const relativeServePath = relativePathMatch ? relativePathMatch[1].replace(/\\/g, '/') : path.basename(preparedAudioLocalPath);

          globalAudioPath = `http://localhost:3000/api/serve-audio?file=${relativeServePath}`;
          globalAudioDurationInFrames = await estimateAudioDurationInFrames(preparedAudioLocalPath);
          apiExtracted = true;
        }
      } else if (globalAudioPath && customAudio) {
        console.log(`[Video Render] Requesting custom audio alignment from backend for ${surahId}:${startVerse}-${endVerse}...`);

        const backendFormData = new FormData();
        backendFormData.append("surah", surahId.toString());
        backendFormData.append("start", startVerse.toString());
        backendFormData.append("end", endVerse.toString());
        backendFormData.append("audio_file", customAudio);

        const extractRes = await fetch(`${baseUrl}/api/extraction/custom`, {
          method: "POST",
          body: backendFormData,
        });

        if (extractRes.ok) {
          extractionData = await extractRes.json();
          console.log("[Video Render] Successfully aligned custom audio");

          if (extractionData.success) {
            if (extractionData.mp3_filename) {
              const mp3Url = `${baseUrl}/api/extraction/download/${extractionData.mp3_filename}`;
              const mp3RelPath = `renders/temp_audio/${extractionData.mp3_filename}`;
              const localMp3Path = await downloadAudioToPublic(mp3Url, mp3RelPath);
              tempFilesToCleanup.push(localMp3Path);
              globalAudioPath = `http://localhost:3000/api/serve-audio?file=${mp3RelPath}&t=${Date.now()}`;
              globalAudioDurationInFrames = await estimateAudioDurationInFrames(localMp3Path);
            }

            const jsonUrl = `${baseUrl}/api/extraction/download/${extractionData.json_filename}`;
            const jsonRes = await fetch(jsonUrl);
            if (jsonRes.ok) {
              wordTimingsData = await jsonRes.json();
            }

            // Schedule backend cleanup (fire and forget)
            setTimeout(() => {
              if (extractionData.mp3_filename) {
                fetch(`${baseUrl}/api/extraction/${extractionData.mp3_filename}`, { method: 'DELETE' }).catch(() => { });
              }
              fetch(`${baseUrl}/api/extraction/${extractionData.json_filename}`, { method: 'DELETE' }).catch(() => { });
            }, 5000);

            apiExtracted = true;
          }
        } else {
          console.error("[Video Render] Failed to align custom audio", await extractRes.text());
        }
      } else if (!globalAudioPath) {
        console.log(`[Video Render] Requesting precise extraction from backend for ${shortReciterKey} ${surahId}:${startVerse}-${endVerse}...`);

        const extractRes = await fetch(`${baseUrl}/api/extraction/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            surah: surahId,
            start: startVerse,
            end: endVerse,
            reciter: shortReciterKey
          }),
        });

        if (extractRes.ok) {
          extractionData = await extractRes.json();
          console.log("[Video Render] Successfully extracted precise clip");

          if (extractionData.success) {
            const mp3Url = `${baseUrl}/api/extraction/download/${extractionData.mp3_filename}`;
            const mp3RelPath = `renders/temp_audio/${extractionData.mp3_filename}`;

            // Download MP3
            const localMp3Path = await downloadAudioToPublic(mp3Url, mp3RelPath);
            tempFilesToCleanup.push(localMp3Path);

            // Download JSON
            const jsonUrl = `${baseUrl}/api/extraction/download/${extractionData.json_filename}`;
            const jsonRes = await fetch(jsonUrl);
            if (jsonRes.ok) {
              wordTimingsData = await jsonRes.json();
            }

            // Schedule backend cleanup (fire and forget)
            setTimeout(() => {
              fetch(`${baseUrl}/api/extraction/${extractionData.mp3_filename}`, { method: 'DELETE' }).catch(() => { });
              fetch(`${baseUrl}/api/extraction/${extractionData.json_filename}`, { method: 'DELETE' }).catch(() => { });
            }, 5000);

            globalAudioPath = `http://localhost:3000/api/serve-audio?file=${mp3RelPath}&t=${Date.now()}`;
            globalAudioDurationInFrames = await estimateAudioDurationInFrames(localMp3Path);
            apiExtracted = true;
          }
        } else {
          console.error("[Video Render] Failed to extract precise clip", await extractRes.text());
        }
      }
    } catch (e) {
      console.error("[Video Render] Error calling extraction API", e);
    }

    // Fallback if API fails or custom audio used
    if (!apiExtracted && !wordTimingsData) {
      try {
        const tsPath = path.join(process.cwd(), "src", "data", "timestamps", shortReciterKey, `${surahId}.json`);
        const tsContent = await fs.readFile(tsPath, "utf8");
        wordTimingsData = JSON.parse(tsContent);
        console.log(`[Video Render] Loaded word timestamps for ${shortReciterKey} Surah ${surahId}`);
      } catch {
        console.log(`[Video Render] No word timestamps found for ${shortReciterKey} Surah ${surahId}`);
      }
    }

    // Calculate total character count for proportional duration assignment if using custom audio
    let totalCharsAllVerses = 0;
    if (globalAudioPath && !apiExtracted) {
      for (const verse of selectedVerses) {
        const apiAyah = apiAyahByNumber.get(verse.id);
        const arabicText = fixMojibake(apiAyah?.text_arabic || verse.text);
        const defaultTranslation = fixMojibake(apiAyah?.text_turkish || "");
        const translationText = isNoneTranslation ? "" : (translationMap.get(verse.id) || defaultTranslation);
        totalCharsAllVerses += arabicText.length + translationText.length;
      }
    }

    const verses: QuranVerse[] = await Promise.all(
      selectedVerses.map(async (verse, index) => {
        const apiAyah = apiAyahByNumber.get(verse.id);
        const arabicText = fixMojibake(apiAyah?.text_arabic || verse.text);
        const defaultTranslation = fixMojibake(apiAyah?.text_turkish || "");
        const translationText = isNoneTranslation ? "" : (translationMap.get(verse.id) || defaultTranslation);

        let audioRelPath = "";
        let durationInFrames = 0;
        let localAudioFile = "";

        if (globalAudioPath) {
          audioRelPath = globalAudioPath;

          if (apiExtracted && wordTimingsData?.verses?.[verse.id]?.words) {
            const timings = wordTimingsData.verses[verse.id].words;
            // For the very first verse, start from 0 to include any initial audio silence
            const startMs = index === 0 ? 0 : timings[0].start;

            const nextVerseId = index < selectedVerses.length - 1 ? selectedVerses[index + 1].id : null;
            const nextTimings = nextVerseId ? wordTimingsData.verses[nextVerseId]?.words : null;

            if (nextTimings && nextTimings.length > 0) {
              const endMs = nextTimings[0].start;
              durationInFrames = Math.max(1, Math.round(((endMs - startMs) / 1000) * FPS));
            } else {
              // For the last verse, duration is determined later by post-processing
              durationInFrames = Math.max(1, Math.round(((timings[timings.length - 1].end - startMs) / 1000) * FPS));
            }
          } else {
            // Proportionally assign duration based on character count
            const verseChars = arabicText.length + translationText.length;
            const proportion = totalCharsAllVerses > 0 ? verseChars / totalCharsAllVerses : 1 / selectedVerses.length;

            if (index === selectedVerses.length - 1) {
              durationInFrames = Math.max(1, Math.round(globalAudioDurationInFrames * proportion));
            } else {
              durationInFrames = Math.max(1, Math.round(globalAudioDurationInFrames * proportion));
            }
          }
        } else {
          const audioRelPathToSave = `renders/temp_audio/${reciterId}_${formatNumber(surahId)}_${formatNumber(verse.id)}.mp3`;
          const audioUrl = audioUrlFor(reciterId, surahId, verse.id);
          try {
            localAudioFile = await downloadAudioToPublic(audioUrl, audioRelPathToSave);
            audioRelPath = `http://localhost:3000/api/serve-audio?file=${audioRelPathToSave}`;
            durationInFrames = await estimateAudioDurationInFrames(localAudioFile);
            tempFilesToCleanup.push(localAudioFile);
          } catch (error) {
            console.error(`[Audio Fallback] Failed to download or process audio for ${audioUrl}:`, error);
            // Fallback: Estimate duration based on word count (approx 1 second per word)
            const wordCount = arabicText.split(" ").length;
            durationInFrames = Math.max(FPS * 3, wordCount * FPS);
          }
        }

        const matchingSegmentation = segmentationData.find((s) => s.surah === surahId && s.ayah === verse.id);
        if (matchingSegmentation) {
          console.log(`[Video Render] Match found for surah ${surahId} ayah ${verse.id}: true`);
        } else {
          console.log(`[Video Render] Match found for surah ${surahId} ayah ${verse.id}: false`);
        }

        let wordTimings: any[] | undefined;
        if (wordTimingsData && wordTimingsData.verses && wordTimingsData.verses[verse.id]) {
          // Deep clone to avoid modifying shared cache (if any)
          wordTimings = JSON.parse(JSON.stringify(wordTimingsData.verses[verse.id].words));

          // Normalize start times to be relative to the start of the verse sequence!
          if (apiExtracted && wordTimings && wordTimings.length > 0) {
            // Same logic as duration calculation: first verse start is 0
            const verseStartMs = index === 0 ? 0 : wordTimingsData.verses[verse.id].words[0].start;
            for (let w of wordTimings) {
              w.start -= verseStartMs;
              w.end -= verseStartMs;
            }
          }
        }

        const verseData: QuranVerse = {
          id: verse.id,
          text: arabicText,
          translation: translationText,
          audioPath: audioRelPath,
          durationInFrames,
          page: verse.page,
          ...(matchingSegmentation && matchingSegmentation.mappings ? { mappings: matchingSegmentation.mappings } : {}),
          ...(wordTimings ? { wordTimings } : {}),
        };

        console.log(`[Video Render] Verse data: ${JSON.stringify(verseData, null, 2)}`);

        return verseData;
      })
    );

    // Fix up last verse duration if using custom audio to perfectly match global duration
    if (globalAudioPath && verses.length > 0) {
      const currentTotal = verses.reduce((sum, v) => sum + v.durationInFrames, 0);
      const diff = globalAudioDurationInFrames - currentTotal;
      if (diff !== 0) {
        verses[verses.length - 1].durationInFrames += diff;
        if (verses[verses.length - 1].durationInFrames < 1) {
          verses[verses.length - 1].durationInFrames = 1;
        }
        // Also extend the last word's end time so it stays highlighted during trailing repetitions
        const lastVerse = verses[verses.length - 1];
        if (diff > 0 && lastVerse.wordTimings && lastVerse.wordTimings.length > 0) {
          const lastWord = lastVerse.wordTimings[lastVerse.wordTimings.length - 1];
          const diffMs = (diff / FPS) * 1000;
          lastWord.end += diffMs;
        }
      }
    }
    
    // Ensure the totalDurationInFrames exactly matches globalAudioDurationInFrames when applicable
    let totalDurationInFrames = verses.reduce((sum, verse) => sum + verse.durationInFrames, 0);
    if (globalAudioPath) {
      totalDurationInFrames = globalAudioDurationInFrames;
    }
    const inputProps: QuranVideoProps = {
      surahNameArabic: fixMojibake(removeTashkeel(apiSurah?.name_arabic || localSurah.name)),
      surahNameTransliteration: fixMojibake(apiSurah?.name_turkish || localSurah.transliteration).toLocaleUpperCase("tr-TR"),
      backgroundImagePath,
      globalAudioPath,
      isAudioExtracted: apiExtracted,
      verses,
      totalDurationInFrames,
      textScale,
    };

    const filename = `${surahId}-${startVerse}-${endVerse}.mp4`;
    const outputLocation = path.join(RENDERS_DIR, filename);
    await fs.mkdir(RENDERS_DIR, { recursive: true });

    const { renderMedia } = await import("@remotion/renderer");

    const serveUrl = await getServeUrl();

    const composition: VideoConfig = {
      id: "QuranVideo",
      width: 720,
      height: 1280,
      fps: 30,
      durationInFrames: totalDurationInFrames,
      defaultProps: inputProps as Record<string, unknown>,
      props: inputProps as Record<string, unknown>,
      defaultCodec: "h264",
      defaultOutName: "out.mp4",
      defaultVideoImageFormat: "png",
      defaultPixelFormat: null,
      defaultProResProfile: null,
      defaultSampleRate: null,
    };

    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation,
      inputProps,
      overwrite: true,
      timeoutInMilliseconds: 600000,
      videoBitrate: "3M",
      x264Preset: "ultrafast",
      imageFormat: "jpeg",
      jpegQuality: 85,
      concurrency: 8,

      chromiumOptions: {
        disableWebSecurity: true,
        enableGpu: true,
        gl: "angle",
      },
      onBrowserLog: (log) => {
        console.log(`[Chromium ${log.type}]`, log.text);
      },
    });

    return NextResponse.json({
      success: true,
      status: "completed",
      videoUrl: `/api/video/download/${filename}`,
    });
  } catch (error) {
    console.error("Video render API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create video" },
      { status: 500 }
    );
  } finally {
    cachedServeUrl = null;

    // Cleanup temporary files
    for (const filePath of tempFilesToCleanup) {
      try {
        await fs.unlink(filePath);
        console.log(`[Cleanup] Deleted temporary file: ${filePath}`);
      } catch (err) {
        console.error(`[Cleanup Error] Failed to delete ${filePath}:`, err);
      }
    }
  }
}
