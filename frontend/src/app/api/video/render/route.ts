import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { exec, execFile } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
import quranData from "@/data/quran.json";
import quranQcfV1Data from "@/data/quran-qcf-v1.json";
import diyanetYeniData from "@/data/translations/diyanet_yeni.json";
import ahmetVarolData from "@/data/translations/ahmet_varol.json";
import { fixMojibake } from "@/lib/textEncoding";
import { RECITER_DISPLAY_NAMES } from "@/lib/reciterNames";
import { parseFile } from "music-metadata";
import {
  ARABIC_FONT_OPTIONS,
  ASPECT_RATIO_DIMENSIONS,
  QUALITY_BITRATE,
  QUALITY_SCALE,
  QUALITY_TIMEOUT_MULTIPLIER,
  TRANSLATION_FONT_OPTIONS,
  type ArabicFontKey,
  type AspectRatio,
  type QualityTier,
  type QuranVideoProps,
  type QuranVerse,
  type TranslationFontKey,
} from "@/remotion/types";
import type { VideoConfig } from "remotion";
import { getSurahWordMap } from "@/lib/quranWordMap";
import { saveToGallery } from "@/lib/videoGallery";
import { getSession } from "@/lib/auth/session";



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

// QCF v1 (2005 print) PUA text, fetched once from quran.com's public API
// into quran-qcf-v1.json (see the fetch script in this file's own git
// history) -- keyed by "surah:ayah" for O(1) lookup per verse below.
// Deliberately a flat Map built once at module load, not per-request.
const qcfV1TextBySurahAyah = new Map<string, { text: string; page: number }>(
  (quranQcfV1Data as { id: number; verses: { id: number; text: string; page: number }[] }[]).flatMap((surah) =>
    surah.verses.map((v) => [`${surah.id}:${v.id}`, { text: v.text, page: v.page }] as const)
  )
);

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

function safeUploadName(name: string, defaultExtension = ".jpg") {
  const extension = path.extname(name).toLowerCase() || defaultExtension;
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

// A surah's Arabic/Turkish verse text never changes, but was being
// re-fetched from the backend on every single request -- including every
// live-preview reload triggered by a pure text/timing edit -- adding a full
// network round-trip to each one for no reason. Cached module-scope, same
// pattern as translationCache below.
const apiSurahCache = new Map<number, ApiSurah | null>();

async function fetchApiSurah(surahId: number): Promise<ApiSurah | null> {
  if (apiSurahCache.has(surahId)) {
    return apiSurahCache.get(surahId)!;
  }

  const baseUrl = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:8000";

  try {
    const response = await fetch(`${baseUrl}/api/surahs/${surahId}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      apiSurahCache.set(surahId, null);
      return null;
    }

    const data = await response.json();
    apiSurahCache.set(surahId, data);
    return data;
  } catch {
    // Not cached -- a transient network failure shouldn't be remembered as
    // "this surah has no data" forever.
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
// Timestamp (Date.now(), NOT an mtime) of when cachedServeUrl's bundle()
// call was STARTED -- compared against remotionSourceChangedSince below so
// an edit made mid-bundle is never missed (see its own "started, not
// finished" comment).
let cachedServeUrlBuiltAt = 0;
let bundlePromise: Promise<string> | null = null;

// Everything the actual Remotion composition needs lives entirely under
// src/remotion/ (QuranVideo.tsx, types.ts, Root.tsx, index.ts -- verified:
// none of them import anything outside this folder, only "remotion"/"react"
// and each other), so this is the one directory whose mtimes actually
// matter for deciding whether the bundled output below is still current.
const REMOTION_SRC_DIR = path.join(process.cwd(), "src", "remotion");

// Cheap recursive "did anything under src/remotion change since we last
// bundled" check -- a handful of fs.stat calls, nowhere near the cost of
// bundle() itself (a real webpack/esbuild build) -- so this can safely run
// on every single render without adding meaningful latency, while still
// picking up a local edit to QuranVideo.tsx/types.ts on the very next render
// with no server restart needed. See getServeUrl below for why this exists:
// without it, the bundle would either have to be blindly re-run on every
// render (correct but slow -- costs a full rebuild on every single "تنزيل
// الفيديو" click and background auto-save) or cached forever (fast but
// silently stale the moment this file is edited).
async function remotionSourceChangedSince(timestampMs: number): Promise<boolean> {
  async function walk(dir: string): Promise<boolean> {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // Directory vanished/unreadable -- can't prove it's unchanged.
      return true;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (await walk(fullPath)) return true;
      } else {
        const stat = await fs.stat(fullPath).catch(() => null);
        if (!stat || stat.mtimeMs > timestampMs) return true;
      }
    }
    return false;
  }

  try {
    return await walk(REMOTION_SRC_DIR);
  } catch {
    // Anything unexpected here -- assume changed. Paying for one avoidable
    // rebundle is a far smaller cost than silently serving stale code.
    return true;
  }
}

// A surah's translation text never changes, but was being re-fetched from an
// external API (acikkuran/tanzil/alquran.cloud) on every single request --
// including every live-preview reload, adding a full network round-trip to
// each one for no reason. Cached here (module-scope, same pattern as
// cachedServeUrl above) keyed by translation+surah, populated once.
const translationCache = new Map<string, Map<number, string>>();

async function getServeUrl() {
  // Reused across every render this server process ever does (a "تنزيل
  // الفيديو" click OR VideoCreatorForm's background auto-save) instead of
  // re-running bundle() -- a real webpack/esbuild build, seconds of pure
  // overhead having NOTHING to do with the video's own length -- on every
  // single one. Previously this cache was unconditionally thrown away at
  // the end of every request (see this function's own git history), which
  // defeated it completely; the mtime check below is what makes it safe to
  // actually keep instead, by catching a real source edit on its own.
  if (cachedServeUrl && !(await remotionSourceChangedSince(cachedServeUrlBuiltAt))) {
    return cachedServeUrl;
  }

  if (!bundlePromise) {
    const buildStartedAt = Date.now();
    const { bundle } = await import("@remotion/bundler");
    bundlePromise = bundle({
      entryPoint: path.join(process.cwd(), "src", "remotion", "index.ts"),
      publicDir: path.join(process.cwd(), "public"),
    }).then((url) => {
      // Recorded as the moment bundling STARTED, not finished -- an edit
      // landing while bundle() was still running must still count as
      // "changed since", even though this exact run might already have
      // picked it up, so the worst case is one avoidable extra rebundle
      // rather than silently serving stale code. See
      // remotionSourceChangedSince's own comment.
      cachedServeUrlBuiltAt = buildStartedAt;
      return url;
    });
  }

  try {
    cachedServeUrl = await bundlePromise;
    return cachedServeUrl;
  } finally {
    bundlePromise = null;
  }
}

// Shared by both openBrowser (below) and the renderMedia call at the bottom
// of this file, so the actual render always runs inside a context matching
// how the persistent instance was launched.
const RENDER_CHROMIUM_OPTIONS = {
  disableWebSecurity: true,
  gl: "angle" as const,
};

// A fresh headless Chromium normally launches from scratch on every single
// renderMedia() call -- real, measurable startup overhead (typically
// somewhere around half a second to a couple of seconds) that has nothing
// to do with the video's own length, paid again on every "تنزيل الفيديو"
// click AND every background auto-save render now that those happen
// routinely. Kept alive here instead and reused across every render this
// server process ever does -- same "populate once, keep for the process's
// lifetime" pattern as cachedServeUrl/translationCache/apiSurahCache.
let cachedBrowserPromise: ReturnType<
  typeof import("@remotion/renderer")["openBrowser"]
> | null = null;

async function getBrowserInstance() {
  if (!cachedBrowserPromise) {
    const { openBrowser } = await import("@remotion/renderer");
    cachedBrowserPromise = openBrowser("chrome", {
      chromiumOptions: RENDER_CHROMIUM_OPTIONS,
    }).catch((err) => {
      // The LAUNCH itself failed -- don't cache a rejected promise forever,
      // the next render should get a genuine fresh attempt instead of
      // reusing this same failure indefinitely.
      cachedBrowserPromise = null;
      throw err;
    });
  }
  return cachedBrowserPromise;
}

// renderMedia() wrapper that reuses the one persistent browser instance
// above instead of launching a new one every time. If the cached instance
// has died between renders (crashed, got OOM-killed, disconnected) the
// render attempt against it throws -- caught here, the dead instance is
// discarded, and the SAME render is retried exactly once against a freshly
// launched one, so a single dead browser can't turn into a hard failure for
// whichever render happens to hit it first.
async function renderMediaWithPersistentBrowser(
  options: Omit<Parameters<typeof import("@remotion/renderer")["renderMedia"]>[0], "puppeteerInstance">
) {
  const { renderMedia } = await import("@remotion/renderer");
  try {
    const browser = await getBrowserInstance();
    return await renderMedia({ ...options, puppeteerInstance: browser });
  } catch (err) {
    console.error(
      "[Video Render] renderMedia failed on the cached browser instance -- discarding it and retrying once with a fresh one:",
      err
    );
    cachedBrowserPromise = null;
    const browser = await getBrowserInstance();
    return await renderMedia({ ...options, puppeteerInstance: browser });
  }
}

export async function POST(req: Request) {
  // Array to keep track of files to delete after rendering
  const tempFilesToCleanup: string[] = [];
  // Declared here (not inside the try block) so the "finally" cleanup guard
  // below can see it too.
  let mode: string | null = null;
  // A logged-out request still renders and downloads normally -- it's only
  // used below to decide whether this render also gets persisted to the
  // (per-user, login-gated) gallery.
  const session = await getSession();
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
    // Only ever present for a real (non-preview) render -- see
    // VideoCreatorForm's buildRenderFormData/executeVideoRender. Lets the
    // resulting gallery entry link back to the exact draft that produced
    // it, so GalleryGrid.tsx's Edit button can restore it later.
    const draftId = formData.get("draftId") as string | null;

    if (!Number.isInteger(surahId) || !Number.isInteger(startVerse) || !Number.isInteger(endVerse)) {
      return NextResponse.json({ error: "Invalid video options" }, { status: 400 });
    }

    const reciterId = (formData.get("reciterId") || "mishary_alafasy") as keyof typeof RECITERS;
    const translationId = formData.get("translationId") as string || "diyanet_yeni";
    const textScale = Math.max(0.5, Math.min(3, Number(formData.get("textScale")) || 1));
    // Arabic verse and translation each have their own independent
    // size/width, set directly on the live preview (VideoPreviewPlayer's two
    // separate slider/drag-handle pairs) -- see QuranVideo.tsx. The
    // *WidthScale upper bound (kept in sync with VideoPreviewPlayer.tsx's
    // own MAX_WIDTH_SCALE) is the largest value that still keeps the text
    // block inside the video frame on EVERY aspect ratio -- landscape has
    // the least spare margin around CONTAINER_PADDING of the three, and
    // 1.04 is safely under what even it can take before the box would start
    // extending past the actual frame edge. Below 1 forces more line
    // breaks; above 1 (up to that cap) lets already-short-enough lines
    // collapse back down, even merging into a single line -- see
    // formatInvertedPyramid/formatArabicVerse.
    const arabicTextScale = Math.max(0.5, Math.min(3, Number(formData.get("arabicTextScale")) || textScale));
    const arabicWidthScale = Math.max(0.4, Math.min(1.04, Number(formData.get("arabicWidthScale")) || 1));
    const translationTextScale = Math.max(0.5, Math.min(3, Number(formData.get("translationTextScale")) || textScale));
    const translationWidthScale = Math.max(0.4, Math.min(1.04, Number(formData.get("translationWidthScale")) || 1));
    const requestedAspectRatio = formData.get("aspectRatio") as string | null;
    const aspectRatio: AspectRatio =
      requestedAspectRatio && requestedAspectRatio in ASPECT_RATIO_DIMENSIONS
        ? (requestedAspectRatio as AspectRatio)
        : "portrait";
    // Defaults to "720p" -- exactly today's only-ever output size -- so an
    // older client that never sends this field renders identically to
    // before this feature existed.
    const requestedQuality = formData.get("quality") as string | null;
    const quality: QualityTier =
      requestedQuality && requestedQuality in QUALITY_SCALE
        ? (requestedQuality as QualityTier)
        : "720p";
    const requestedTranslationFont = formData.get("translationFont") as string | null;
    // "custom" is deliberately not a TRANSLATION_FONT_OPTIONS key (there's
    // no fixed family for it -- see customTranslationFontUrl below), so it
    // needs its own explicit allowance here alongside the registry check.
    const translationFont: TranslationFontKey | "custom" =
      requestedTranslationFont === "custom" || (requestedTranslationFont && requestedTranslationFont in TRANSLATION_FONT_OPTIONS)
        ? (requestedTranslationFont as TranslationFontKey | "custom")
        : "aileron";
    const requestedArabicFont = formData.get("arabicFont") as string | null;
    const arabicFont: ArabicFontKey =
      requestedArabicFont && requestedArabicFont in ARABIC_FONT_OPTIONS
        ? (requestedArabicFont as ArabicFontKey)
        : "qcf2";
    // "preview" short-circuits right after inputProps is built below, before
    // bundle()/renderMedia() -- lets the client feed the exact same props
    // straight into an in-browser <Player> (@remotion/player) instead of
    // waiting on a full server-side render, while reusing 100% of this
    // function's data-assembly logic so preview and final render can never
    // drift apart.
    mode = formData.get("mode") as string | null;

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

    // Fetch specific translation if required.
    // diyanet_yeni and ahmet_varol are bundled locally (LOCAL_TRANSLATIONS
    // below) rather than fetched from api.acikkuran.com -- that subdomain
    // has been down (DNS NXDOMAIN) since at least Aug 2026, a known,
    // still-unresolved outage: https://github.com/acik-kuran/acikkuran-api/issues/20.
    // The bundled JSON was scraped once from acikkuran.com's still-live
    // Markdown pages (same source, same verified word-for-word text,
    // verified against the actual official Diyanet meal including its
    // "(2-4)" verse-grouping notation) by
    // frontend/scripts/build-acikkuran-translations.mjs.
    // fawazahmed0/quran-api (tanzil.net-sourced) is only used for
    // diyanet_eski, since acikkuran has no separate Eski edition. "elmalili"
    // uses api.alquran.cloud's tr.yazir edition -- concretely observed
    // (Al-Furqan 25:27-29) that acikkuran's ref 14 is the old-Ottoman-Turkish
    // 1935 printing (not the modern standardized edition), and
    // tanzil.net/fawazahmed0's tur-elmalilihamdiya has its quotation marks
    // offset by one verse boundary for passages of continuous quoted speech.
    // Must stay in sync with TRANSLATION_OPTIONS in
    // frontend/src/lib/TranslationContext.tsx.
    const LOCAL_TRANSLATIONS: Record<string, Record<string, string>> = {
      "diyanet_yeni": diyanetYeniData,
      "ahmet_varol": ahmetVarolData,
    };
    const TRANSLATION_SOURCES: Record<string, { source: "tanzil" | "alquran"; ref: string }> = {
      "diyanet_eski": { source: "tanzil", ref: "tur-diyanetisleri" },
      "elmalili": { source: "alquran", ref: "tr.yazir" },
    };

    // Açık Kuran prefixes a translation shared across several verses with a
    // range like "(2-4)" — the official site itself displays this as
    // "2,3,4." (comma-separated verse numbers), so reformat to match. Keep in
    // sync with the identical helper in frontend/src/lib/TranslationContext.tsx.
    const formatVerseGroupPrefix = (text: string): string =>
      text.replace(/^\((\d+)-(\d+)\)\s*/, (match, start, end) => {
        const from = parseInt(start, 10);
        const to = parseInt(end, 10);
        if (isNaN(from) || isNaN(to) || to < from) return match;
        const numbers: number[] = [];
        for (let n = from; n <= to; n++) numbers.push(n);
        return `${numbers.join(",")}. `;
      });

    const isNoneTranslation = translationId === "none";
    const translationCacheKey = `${translationId}:${surahId}`;
    let translationMap = translationCache.get(translationCacheKey) ?? new Map<number, string>();

    if (!isNoneTranslation && !translationCache.has(translationCacheKey)) {
      if (LOCAL_TRANSLATIONS[translationId]) {
        const data = LOCAL_TRANSLATIONS[translationId];
        const prefix = `${surahId}:`;
        for (const [key, text] of Object.entries(data)) {
          if (key.startsWith(prefix)) {
            translationMap.set(parseInt(key.slice(prefix.length), 10), text);
          }
        }
        translationCache.set(translationCacheKey, translationMap);
      } else {
        const { source, ref } = TRANSLATION_SOURCES[translationId] || TRANSLATION_SOURCES["diyanet_eski"];
        try {
          if (source === "alquran") {
            const res = await fetch(`https://api.alquran.cloud/v1/surah/${surahId}/${ref}`);
            if (res.ok) {
              const data = await res.json();
              (data.data?.ayahs || []).forEach((a: { numberInSurah: number; text: string }) => {
                translationMap.set(a.numberInSurah, formatVerseGroupPrefix(a.text));
              });
            }
          } else {
            const res = await fetch(`https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions/${ref}.min.json`);
            if (res.ok) {
              const data = await res.json();
              (data.quran || []).forEach((v: { chapter: number; verse: number; text: string }) => {
                if (v.chapter === surahId) {
                  translationMap.set(v.verse, v.text);
                }
              });
            }
          }
          translationCache.set(translationCacheKey, translationMap);
        } catch (err) {
          console.error("Failed to fetch translation:", err);
        }
      }
    }

    const bgImage = formData.get("bgImage") as File | null;
    // Set by the client instead of re-sending the same File when a preview
    // reload was triggered by something unrelated (translation/timing edit)
    // -- avoids rewriting an identical file to disk under a new timestamped
    // name on every single reload. Only meaningful when no fresh `bgImage`
    // file is present.
    const existingBackgroundImagePath = formData.get("existingBackgroundImagePath") as string | null;
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

      backgroundImagePath = `/api/serve-audio?file=render-assets/backgrounds/${filename}`;
    } else if (existingBackgroundImagePath) {
      backgroundImagePath = existingBackgroundImagePath;
    }

    // Video background -- mirrors the bgImage handling above, plus an
    // ffprobe duration probe (also doubles as validation: a file ffprobe
    // can't read isn't a video Remotion can render either) so QuranVideo.tsx
    // can loop it seamlessly instead of freezing on its last frame.
    const bgVideo = formData.get("bgVideo") as File | null;
    const existingBackgroundVideoPath = formData.get("existingBackgroundVideoPath") as string | null;
    const existingBackgroundVideoDurationInFrames = formData.get("existingBackgroundVideoDurationInFrames") as string | null;
    let backgroundVideoPath: string | null = null;
    let backgroundVideoDurationInFrames: number | null = null;

    if (bgVideo && bgVideo.size > 0) {
      const buffer = Buffer.from(await bgVideo.arrayBuffer());
      const uploadsDir = path.join(process.cwd(), "public", "render-assets", "backgrounds");
      await fs.mkdir(uploadsDir, { recursive: true });

      const filename = safeUploadName(bgVideo.name, ".mp4");
      const absolutePath = path.join(uploadsDir, filename);
      await fs.writeFile(absolutePath, buffer);

      try {
        // execFile (argument array), NOT execAsync's shell string -- unlike
        // every other path/filename interpolated into a shell command
        // elsewhere in this file, `filename` here is built from the
        // uploaded file's OWN extension (safeUploadName -> path.extname on
        // attacker-controlled bgVideo.name), so it must never be pasted into
        // a string a shell re-parses.
        const { stdout } = await execFileAsync("ffprobe", [
          "-v", "error",
          "-show_entries", "format=duration",
          "-of", "default=noprint_wrappers=1:nokey=1",
          absolutePath,
        ]);
        const durationSeconds = parseFloat(stdout.trim());
        if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
          throw new Error("ffprobe returned no usable duration");
        }
        backgroundVideoDurationInFrames = Math.round(durationSeconds * FPS);
      } catch (err) {
        await fs.unlink(absolutePath).catch(() => undefined);
        console.error("Failed to probe uploaded background video:", err);
        return NextResponse.json({ error: "Uploaded file is not a valid video" }, { status: 400 });
      }

      backgroundVideoPath = `/api/serve-audio?file=render-assets/backgrounds/${filename}`;
    } else if (existingBackgroundVideoPath) {
      backgroundVideoPath = existingBackgroundVideoPath;
      backgroundVideoDurationInFrames = existingBackgroundVideoDurationInFrames
        ? Number(existingBackgroundVideoDurationInFrames)
        : null;
    }

    // User-supplied translation font (only meaningful when translationFont
    // is "custom") -- mirrors bgImage/bgVideo's own upload-or-reuse pattern
    // above: a fresh file is saved once and re-served by URL from then on,
    // and a preview reload not caused by a new upload just resends the
    // already-resolved URL instead of re-uploading the identical file.
    // Deliberately NOT magic-byte-validated the way bgImage is -- font
    // formats (ttf/otf/woff/woff2) don't share one simple common header the
    // way images do, and an actually-invalid file just fails to load as a
    // font client-side (silently falls back to sans-serif for that one
    // detail), not a rendering error.
    const customTranslationFont = formData.get("customTranslationFont") as File | null;
    const existingCustomTranslationFontUrl = formData.get("existingCustomTranslationFontUrl") as string | null;
    let customTranslationFontUrl: string | null = null;

    if (customTranslationFont && customTranslationFont.size > 0) {
      const uploadsDir = path.join(process.cwd(), "public", "render-assets", "fonts");
      await fs.mkdir(uploadsDir, { recursive: true });
      const filename = safeUploadName(customTranslationFont.name, ".ttf").replace(/^bg-/, "font-");
      const absolutePath = path.join(uploadsDir, filename);
      await fs.writeFile(absolutePath, Buffer.from(await customTranslationFont.arrayBuffer()));
      customTranslationFontUrl = `/api/serve-audio?file=render-assets/fonts/${filename}`;
    } else if (existingCustomTranslationFontUrl) {
      customTranslationFontUrl = existingCustomTranslationFontUrl;
    }

    const customAudio = formData.get("customAudio") as File | null;
    const usePreparedAudio = formData.get("usePreparedAudio") === "true";
    const preparedAudioLocalPath = formData.get("preparedAudioLocalPath") as string;
    const preparedJsonStr = formData.get("preparedJsonData") as string;
    // let, not const -- reset to 0 below if preparedAudioLocalPath turned
    // out to be gone (see preparedAudioFileExists): these boundaries were
    // measured against THAT specific file's own timeline, and silently
    // keeping them while falling back to a freshly (re-)extracted, untrimmed
    // clip would desync the on-screen text from the actual audio -- it would
    // switch verses as if trimStart seconds had been cut from the front,
    // while the audio itself still plays from true position 0.
    let trimStart = Number(formData.get("trimStart")) || 0;
    let trimEnd = Number(formData.get("trimEnd")) || 0;
    let globalAudioPath: string | null = null;
    let globalAudioDurationInFrames = 0;

    // preparedAudioLocalPath lives under public/renders/temp_audio -- the
    // EPHEMERAL tmpfs (see RENDERS_DIR's own comment / docker-compose.yml),
    // wiped on every container restart. render/route.ts itself only ever
    // WRITES into it, but VideoCreatorForm's autosaveDraft persists this
    // exact absolute path into the (long-lived) draft JSON and keeps
    // re-sending it unchanged on every later render/preview once that draft
    // is resumed (e.g. GalleryGrid.tsx's Edit button, possibly long after
    // the container that wrote it was last restarted). Left unchecked, the
    // ffmpeg trim below throws on a vanished file ("Failed to trim audio
    // using FFmpeg") -- and even without trimming,
    // estimateAudioDurationInFrames's own fs.stat fallback throws too --
    // turning "reopen an old saved project" into a hard render failure
    // instead of gracefully falling back to a fresh extraction the way a
    // brand-new project would. Checked once, up front, so every branch
    // below treats a vanished prepared file exactly like it was never
    // provided at all.
    const preparedAudioFileExists =
      usePreparedAudio && preparedAudioLocalPath ? await fileExists(preparedAudioLocalPath) : false;
    if (usePreparedAudio && preparedAudioLocalPath && !preparedAudioFileExists) {
      console.warn(
        `[Video Render] preparedAudioLocalPath no longer exists on disk (container restart or cleanup?) -- falling back to a fresh extraction: ${preparedAudioLocalPath}`
      );
      // The fresh extraction below is the full, untrimmed clip -- a manual
      // trim made against the vanished file no longer has anything
      // meaningful to apply to (see trimStart/trimEnd's own comment above).
      trimStart = 0;
      trimEnd = 0;
    }

    // Writing/estimating-duration for the raw customAudio upload is wasted
    // work whenever the prepared-audio branch below will fire instead --
    // that branch (Step 3's already-prepared/aligned audio) always
    // overwrites globalAudioPath/globalAudioDurationInFrames
    // unconditionally when its full condition is met, so this block's
    // result would be discarded 100% of the time in that case. Skipping it
    // avoids a redundant disk write + music-metadata parse on every preview
    // reload once the user has moved past the "prepare audio" step. Mirrors
    // the exact condition of that branch (not just `usePreparedAudio` alone)
    // so this can never skip the write in a case where that branch DOESN'T
    // end up firing and this file was actually needed as a fallback.
    const willUsePreparedAudioBranch = preparedAudioFileExists && !!preparedJsonStr;
    if (!willUsePreparedAudioBranch && customAudio && customAudio.size > 0) {
      const buffer = Buffer.from(await customAudio.arrayBuffer());
      const uploadsDir = path.join(process.cwd(), "public", "render-assets", "custom-audio");
      await fs.mkdir(uploadsDir, { recursive: true });

      const extension = path.extname(customAudio.name).toLowerCase() || ".mp3";
      const filename = `custom-${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`;
      const absolutePath = path.join(uploadsDir, filename);
      await fs.writeFile(absolutePath, buffer);

      globalAudioPath = `/api/serve-audio?file=render-assets/custom-audio/${filename}`;
      globalAudioDurationInFrames = await estimateAudioDurationInFrames(absolutePath);
    }

    const selectedVerses = localSurah.verses.filter((verse) => verse.id >= startVerse && verse.id <= endVerse);

    // Only fetch/derive the real-word <-> PUA-glyph-token map for verses that
    // actually have a segmentation applied — unsegmented verses render as a
    // single block and never need to slice `text` by real-word ranges.
    const segmentedAyahIds = selectedVerses
      .filter((verse) => segmentationData.some((s) => s.surah === surahId && s.ayah === verse.id))
      .map((verse) => verse.id);
    let puaWordMapByAyah: Record<number, { realWordCount: number; puaTokenCounts: number[] }> = {};
    if (segmentedAyahIds.length > 0) {
      try {
        const targetPuaTotals: Record<number, number> = {};
        for (const verse of selectedVerses) {
          if (segmentedAyahIds.includes(verse.id)) {
            targetPuaTotals[verse.id] = verse.text.trim().split(/\s+/).length;
          }
        }
        puaWordMapByAyah = await getSurahWordMap(surahId, segmentedAyahIds, targetPuaTotals);
      } catch (e) {
        console.warn("[Video Render] Failed to fetch real-word/PUA word map:", e);
      }
    }

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

      if (preparedAudioFileExists && preparedJsonStr) {
        wordTimingsData = JSON.parse(preparedJsonStr);

        if (trimStart > 0 || trimEnd > 0) {
          console.log(`[Video Render] Using prepared audio and trimming from ${trimStart}s to ${trimEnd}s...`);
          const uploadsDir = path.join(process.cwd(), "public", "render-assets", "trimmed-audio");
          await fs.mkdir(uploadsDir, { recursive: true });
          // Deterministic filename (source file + exact trim boundaries)
          // instead of a Date.now()/random one -- every preview reload
          // triggered by an UNRELATED edit (translation, background,
          // segmentation, box size/width, aspect ratio...) re-enters this
          // same branch with the SAME trim values whenever the user has
          // trimmed audio at all, and a fresh random name every time made
          // globalAudioPath change on every single preview, which VideoCreatorForm
          // reads as a real audio-source swap and bumps previewVersion --
          // forcing VideoPreviewPlayer to fully remount and reset playback
          // to frame 0. This is the actual cause of "any edit resets the
          // video" whenever trimming is active. A stable name means repeat
          // requests with unchanged trim boundaries resolve to the exact
          // same URL, so no remount -- and the existence check below skips
          // the redundant ffmpeg re-encode too.
          const sourceBasename = path
            .basename(preparedAudioLocalPath, path.extname(preparedAudioLocalPath))
            .replace(/[^a-zA-Z0-9_-]/g, "_");
          const trimmedFilename = `trimmed-${sourceBasename}-${trimStart.toFixed(2)}-${trimEnd.toFixed(2)}.mp3`;
          const trimmedAbsolutePath = path.join(uploadsDir, trimmedFilename);

          try {
            const alreadyTrimmed = await fs
              .access(trimmedAbsolutePath)
              .then(() => true)
              .catch(() => false);

            if (!alreadyTrimmed) {
              const toArg = trimEnd > 0 ? `-to ${trimEnd}` : "";
              // Stream copy instead of re-encoding (libmp3lame): "-ss" lands at
              // the exact same position either way (output seeking, same as
              // before), so trim precision is unaffected -- this only skips a
              // redundant decode+re-encode pass, which is both faster (a real
              // render no longer pays for an unnecessary lossy MP3 re-encode
              // step) and avoids the quality loss of double-compressing audio
              // that's already MP3. Applies to the real render too, not just
              // preview -- there's no tradeoff being made here, only upside.
              await execAsync(`ffmpeg -y -i "${preparedAudioLocalPath}" -ss ${trimStart} ${toArg} -c:a copy "${trimmedAbsolutePath}"`);
            }

            // We must serve it relative to the public folder
            globalAudioPath = `/api/serve-audio?file=render-assets/trimmed-audio/${trimmedFilename}`;
            globalAudioDurationInFrames = await estimateAudioDurationInFrames(trimmedAbsolutePath);
            // Real renders still clean this up afterward (preview mode never
            // does, see the mode === "preview" guard around tempFilesToCleanup
            // below) -- harmless either way since the filename is now stable
            // and content-addressed rather than single-use.
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

          globalAudioPath = `/api/serve-audio?file=${relativeServePath}`;
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
              globalAudioPath = `/api/serve-audio?file=${mp3RelPath}&t=${Date.now()}`;
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

            globalAudioPath = `/api/serve-audio?file=${mp3RelPath}&t=${Date.now()}`;
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

    // Precompute the effective start boundary (in wordTimingsData's ms
    // coordinate space, i.e. after any trimStart shift) for every selected
    // verse. A manually-dragged boundary from SegmentTimingEditor -- saved
    // on BOTH sides of the boundary by its linked dragging -- takes
    // priority over the word-timing-derived "next verse's first word"
    // default, since the user heard the audio and placed it there
    // deliberately. QuranVideo's cumulative Sequence `from` positions are
    // entirely driven by each verse's durationInFrames, so honoring the
    // override here is enough to move where the on-screen text switches
    // from one verse to the next -- it has no effect on audio playback
    // (globalAudioPath plays independently/continuously, unsliced).
    const verseBoundaryMs: (number | null)[] = selectedVerses.map((verse, index) => {
      if (index === 0) return 0;
      const prevVerse = selectedVerses[index - 1];
      const curSeg = segmentationData.find((s) => s.surah === surahId && s.ayah === verse.id);
      const curFirstMapping = curSeg?.mappings?.[0];
      if (typeof curFirstMapping?.start_ms === "number") {
        return curFirstMapping.start_ms - trimStart * 1000;
      }
      const prevSeg = segmentationData.find((s) => s.surah === surahId && s.ayah === prevVerse.id);
      const prevLastMapping = prevSeg?.mappings?.[prevSeg.mappings.length - 1];
      if (typeof prevLastMapping?.end_ms === "number") {
        return prevLastMapping.end_ms - trimStart * 1000;
      }
      return wordTimingsData?.verses?.[verse.id]?.words?.[0]?.start ?? null;
    });

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
            const startMs = verseBoundaryMs[index] ?? (index === 0 ? 0 : timings[0].start);

            const nextBoundaryMs = index < selectedVerses.length - 1 ? verseBoundaryMs[index + 1] : null;

            if (nextBoundaryMs !== null) {
              durationInFrames = Math.max(1, Math.round(((nextBoundaryMs - startMs) / 1000) * FPS));
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
            audioRelPath = `/api/serve-audio?file=${audioRelPathToSave}`;
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
            // Same logic as duration calculation: first verse start is 0,
            // or a manually-dragged boundary from SegmentTimingEditor if set.
            const verseStartMs = verseBoundaryMs[index] ?? (index === 0 ? 0 : wordTimingsData.verses[verse.id].words[0].start);
            for (const w of wordTimings) {
              w.start -= verseStartMs;
              w.end -= verseStartMs;
            }
          }
        }

        const puaWordMap = puaWordMapByAyah[verse.id];

        // Manual per-segment timing overrides (from SegmentTimingEditor) are
        // stored in the SAME raw, un-normalized coordinate space as
        // preparedJsonData/wordTimingsData (i.e. relative to the prepared
        // clip before any trim). Apply the exact same trimStart shift and
        // per-verse verseStartMs normalization wordTimings just went
        // through above, so QuranVideo.tsx can treat start_ms/end_ms as
        // already verse-relative, matching wordTimings' own coordinate
        // space, with no further conversion needed at render time.
        let mappings = matchingSegmentation?.mappings;
        if (mappings && apiExtracted && wordTimingsData?.verses?.[verse.id]?.words?.length) {
          const verseStartMs = verseBoundaryMs[index] ?? (index === 0 ? 0 : wordTimingsData.verses[verse.id].words[0].start);
          mappings = mappings.map((m: any) =>
            typeof m.start_ms === "number" && typeof m.end_ms === "number"
              ? {
                  ...m,
                  start_ms: m.start_ms - trimStart * 1000 - verseStartMs,
                  end_ms: m.end_ms - trimStart * 1000 - verseStartMs,
                }
              : m
          );
        }

        // Always attached regardless of the CURRENTLY selected arabicFont --
        // same reasoning as translationFont's own fields -- so switching the
        // choice in the live preview is instant and client-side only, no
        // server round-trip needed.
        const qcfV1 = qcfV1TextBySurahAyah.get(`${surahId}:${verse.id}`);

        const verseData: QuranVerse = {
          id: verse.id,
          text: arabicText,
          translation: translationText,
          audioPath: audioRelPath,
          durationInFrames,
          page: verse.page,
          ...(qcfV1 ? { textV1: qcfV1.text, pageV1: qcfV1.page } : {}),
          ...(mappings ? { mappings } : {}),
          ...(wordTimings ? { wordTimings } : {}),
          ...(puaWordMap ? { puaTokenCounts: puaWordMap.puaTokenCounts } : {}),
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
      backgroundVideoPath,
      backgroundVideoDurationInFrames,
      globalAudioPath,
      isAudioExtracted: apiExtracted,
      verses,
      totalDurationInFrames,
      textScale,
      arabicTextScale,
      arabicWidthScale,
      translationTextScale,
      translationWidthScale,
      aspectRatio,
      translationFont,
      arabicFont,
      ...(customTranslationFontUrl ? { customTranslationFontUrl } : {}),
    };

    if (mode === "preview") {
      return NextResponse.json({ success: true, inputProps });
    }

    const filename = `${surahId}-${startVerse}-${endVerse}.mp4`;
    const outputLocation = path.join(RENDERS_DIR, filename);
    await fs.mkdir(RENDERS_DIR, { recursive: true });

    const serveUrl = await getServeUrl();
    const { width: videoWidth, height: videoHeight } = ASPECT_RATIO_DIMENSIONS[aspectRatio];

    const composition: VideoConfig = {
      id: "QuranVideo",
      width: videoWidth,
      height: videoHeight,
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

    await renderMediaWithPersistentBrowser({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation,
      inputProps,
      overwrite: true,
      // Scales the OUTPUT resolution only -- the composition's own
      // width/height (and every hand-tuned px constant that reads them via
      // useVideoConfig() in QuranVideo.tsx) stay exactly as ASPECT_RATIO_
      // DIMENSIONS defines them, regardless of quality tier.
      scale: QUALITY_SCALE[quality],
      timeoutInMilliseconds: 600000 * QUALITY_TIMEOUT_MULTIPLIER[quality],
      videoBitrate: QUALITY_BITRATE[quality],
      x264Preset: "ultrafast",
      imageFormat: "jpeg",
      jpegQuality: 85,
      concurrency: 8,

      chromiumOptions: RENDER_CHROMIUM_OPTIONS,
      onBrowserLog: (log) => {
        console.log(`[Chromium ${log.type}]`, log.text);
      },
    });

    // Best-effort copy into the persistent gallery -- outputLocation itself
    // lives in the ephemeral public/renders tmpfs (wiped on container
    // restart, overwritten by the next render of this same verse range), so
    // this is what lets the user come back later and still find/download a
    // video they made before. Never let a failure here fail the render the
    // user is actively waiting on. Skipped entirely for a logged-out
    // request -- the gallery is login-gated, so an anonymous render is
    // downloaded once here and never persisted anywhere.
    if (session) {
      try {
        await saveToGallery(outputLocation, {
          userId: session.id,
          surahNameArabic: inputProps.surahNameArabic,
          surahNameTransliteration: inputProps.surahNameTransliteration,
          startVerse,
          endVerse,
          reciterName: RECITERS[reciterId].name,
          reciterNameLatin: RECITER_DISPLAY_NAMES[reciterId],
          aspectRatio,
          ...(draftId ? { draftId } : {}),
        });
      } catch (err) {
        console.error("[Video Render] Failed to save to gallery:", err);
      }
    }

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
    // cachedServeUrl is deliberately NOT reset here anymore -- see
    // getServeUrl's own comment for why blindly wiping it on every request
    // used to defeat the whole point of caching it; staleness is now
    // detected on its own via remotionSourceChangedSince instead.

    // Cleanup temporary files -- SKIPPED for a preview request, since its
    // response (containing URLs pointing at these exact files) is returned
    // to the browser before this "finally" runs, not after renderMedia has
    // already read them like the real render path. Deleting them here would
    // 404 the audio the split second <Player> tries to load it.
    for (const filePath of mode === "preview" ? [] : tempFilesToCleanup) {
      try {
        await fs.unlink(filePath);
        console.log(`[Cleanup] Deleted temporary file: ${filePath}`);
      } catch (err) {
        console.error(`[Cleanup Error] Failed to delete ${filePath}:`, err);
      }
    }
  }
}
