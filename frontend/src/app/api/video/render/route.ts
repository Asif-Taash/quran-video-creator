import { NextResponse } from "next/server";
import crypto from "crypto";
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
import { DEFAULT_RECITER_ID, RECITER_ARABIC_NAMES, RECITER_DISPLAY_NAMES, getReciter } from "@/lib/reciterNames";
import { stripAudioInPlace } from "@/lib/silentVideo";
import { parseFile } from "music-metadata";
import {
  ARABIC_FONT_OPTIONS,
  ASPECT_RATIO_DIMENSIONS,
  BACKGROUND_BLUR_MAX,
  BACKGROUND_DIM_MAX,
  DEFAULT_BACKGROUND_DIM,
  DEFAULT_WORD_HIGHLIGHT_COLOR,
  QUALITY_BITRATE,
  QUALITY_SHORT_SIDE,
  QUALITY_TIMEOUT_MULTIPLIER,
  TRANSLATION_FONT_OPTIONS,
  qualityScale,
  type ArabicFontKey,
  type AspectRatio,
  type QualityTier,
  type QuranVideoProps,
  type QuranVerse,
  type TranslationFontKey,
} from "@/remotion/types";
import { buildVerseTimeline, holdWordsThroughRepeats, repeatWordWindows, shiftReadingsToTrim, shiftWordsToTrim } from "@/remotion/timing";
import type { VideoConfig } from "remotion";
import { getSurahWordMap } from "@/lib/quranWordMap";
import { formatVerseGroupPrefix, getTranslationOption, isRtlTranslation } from "@/lib/translationOptions";
import { surahEnglishName } from "@/lib/surahEnglishNames";
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

const formatNumber = (num: number) => num.toString().padStart(3, "0");

// null when the reciter has no per-ayah set (see reciterNames.ts' everyAyahDir).
function audioUrlFor(reciterId: string, surahId: number, verseId: number): string | null {
  const dir = getReciter(reciterId)?.everyAyahDir;
  return dir ? `https://everyayah.com/data/${dir}/${formatNumber(surahId)}${formatNumber(verseId)}.mp3` : null;
}

function removeTashkeel(text: string): string {
  return text.replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u08D4-\u08FF]/g, "");
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Saves an uploaded file under a name derived from its content, so the
// same background/audio/font re-sent with every render (the client always
// re-uploads for a real render) is stored once instead of as a fresh
// timestamped copy each time -- that piled up 170 copies (158 MB) of a
// handful of backgrounds. `prepare` runs once, on a new file only, against a
// private temp path that is renamed into place afterward, so two requests
// carrying the same file can't trip over each other's half-written copy.
// Throwing from `prepare` (e.g. not a valid image) discards the upload.
async function saveUploadOnce(
  file: File,
  subdir: string,
  prefix: string,
  defaultExtension: string,
  prepare?: (tempPath: string) => Promise<void>
): Promise<{ filename: string; absolutePath: string }> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 32);
  // The extension comes from the client's own filename -- only a short
  // alphanumeric one is kept (see the execFile note on ffprobe below).
  const rawExtension = path.extname(file.name).toLowerCase();
  const extension = /^\.[a-z0-9]{1,5}$/.test(rawExtension) ? rawExtension : defaultExtension;
  const filename = `${prefix}-${hash}${extension}`;
  const uploadsDir = path.join(process.cwd(), "public", "render-assets", subdir);
  const absolutePath = path.join(uploadsDir, filename);

  if (!(await fileExists(absolutePath))) {
    await fs.mkdir(uploadsDir, { recursive: true });
    const tempPath = path.join(uploadsDir, `${prefix}-${hash}-${crypto.randomUUID()}.upload${extension}`);
    await fs.writeFile(tempPath, buffer);
    try {
      await prepare?.(tempPath);
      await fs.rename(tempPath, absolutePath);
    } catch (err) {
      await fs.unlink(tempPath).catch(() => undefined);
      throw err;
    }
  }
  return { filename, absolutePath };
}

const IMAGE_MAGIC_BYTES = [
  [0xff, 0xd8, 0xff],              // JPEG
  [0x89, 0x50, 0x4e, 0x47],         // PNG
  [0x47, 0x49, 0x46],               // GIF
  [0x52, 0x49, 0x46, 0x46],         // WEBP
];

class InvalidUploadError extends Error {}

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

  // Assigned synchronously (no await before it), so concurrent callers --
  // a preview's warm-up and a render -- share one build.
  if (!bundlePromise) {
    const buildStartedAt = Date.now();
    bundlePromise = import("@remotion/bundler").then(({ bundle }) => bundle({
      entryPoint: path.join(process.cwd(), "src", "remotion", "index.ts"),
      publicDir: path.join(process.cwd(), "public"),
      // Linked, not copied: public/ also holds every user upload, draft and
      // gallery video, and each copy (~0.5 GB and growing) was left behind
      // in /tmp on every rebundle.
      symlinkPublicDir: true,
    })).then((url) => {
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
  // Assigned synchronously, like bundlePromise, so concurrent callers can't
  // each launch a browser.
  if (!cachedBrowserPromise) {
    cachedBrowserPromise = import("@remotion/renderer").then(({ openBrowser }) => openBrowser("chrome", {
      chromiumOptions: RENDER_CHROMIUM_OPTIONS,
    })).catch((err) => {
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
  options: Omit<Parameters<typeof import("@remotion/renderer")["renderMedia"]>[0], "puppeteerInstance">,
  isCancelled: () => boolean
) {
  const { renderMedia } = await import("@remotion/renderer");
  try {
    const browser = await getBrowserInstance();
    return await renderMedia({ ...options, puppeteerInstance: browser });
  } catch (err) {
    // A cancelled render rejects too -- that's not a dead browser.
    if (isCancelled()) throw err;
    console.error(
      "[Video Render] renderMedia failed on the cached browser instance -- discarding it and retrying once with a fresh one:",
      err
    );
    cachedBrowserPromise = null;
    const browser = await getBrowserInstance();
    return await renderMedia({ ...options, puppeteerInstance: browser });
  }
}

// Real (non-preview) renders in flight, keyed by the renderId the client
// sends: GET reports one's progress (the download button shows it) and
// DELETE cancels one -- VideoCreatorForm cancels a background auto-save
// render of OLDER settings the moment the user asks for a download, instead
// of making them wait out a whole render nobody needs anymore. Kept on
// globalThis so a dev-mode recompile of this module mid-render can't orphan
// a job. A DELETE can beat its own POST here (the upload still in transit),
// hence cancelledEarly.
type RenderJob = {
  stage: "preparing" | "rendering" | "saving";
  progress: number;
  etaMs: number | null;
  cancelled: boolean;
  cancel: () => void;
};
const renderRegistry = ((globalThis as { __quranRenderRegistry?: unknown }).__quranRenderRegistry ??= {
  jobs: new Map<string, RenderJob>(),
  cancelledEarly: new Set<string>(),
}) as { jobs: Map<string, RenderJob>; cancelledEarly: Set<string> };

const RENDER_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

class RenderCancelledError extends Error {}

function cancelledResponse() {
  return NextResponse.json({ error: "Render cancelled", cancelled: true }, { status: 409 });
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const job = renderRegistry.jobs.get(id);
  if (!job) {
    return NextResponse.json({ error: "Unknown render" }, { status: 404 });
  }
  return NextResponse.json({ stage: job.stage, progress: job.progress, etaMs: job.etaMs });
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!RENDER_ID_PATTERN.test(id)) {
    return NextResponse.json({ error: "Invalid render id" }, { status: 400 });
  }
  const job = renderRegistry.jobs.get(id);
  if (job) {
    job.cancelled = true;
    job.cancel();
  } else {
    renderRegistry.cancelledEarly.add(id);
    setTimeout(() => renderRegistry.cancelledEarly.delete(id), 5 * 60_000);
  }
  return NextResponse.json({ success: true });
}

// Every real render now writes its own file (named by its renderId), so two
// renders of the same ayah range -- two users, or a background auto-save
// and a download -- can no longer overwrite each other's video mid-download.
// public/renders is a 512 MB tmpfs (docker-compose.yml), so before each
// render only the few newest finished files are kept, and nothing older than
// an hour; the gallery keeps its own persistent copy anyway.
const KEEP_RECENT_RENDERS = 3;
const RENDER_FILE_TTL_MS = 60 * 60_000;

async function pruneOldRenders() {
  const entries = await fs.readdir(RENDERS_DIR, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".mp4"))
      .map(async (entry) => {
        const filePath = path.join(RENDERS_DIR, entry.name);
        const stat = await fs.stat(filePath).catch(() => null);
        return { filePath, mtimeMs: stat?.mtimeMs ?? 0 };
      })
  );
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const cutoff = Date.now() - RENDER_FILE_TTL_MS;
  await Promise.all(
    files
      .filter((file, index) => index >= KEEP_RECENT_RENDERS || file.mtimeMs < cutoff)
      .map((file) => fs.unlink(file.filePath).catch(() => undefined))
  );
}

export async function POST(req: Request) {
  // Array to keep track of files to delete after rendering
  const tempFilesToCleanup: string[] = [];
  // Declared here (not inside the try block) so the "finally" cleanup guard
  // below can see it too.
  let mode: string | null = null;
  // Set for a real render only -- see renderRegistry.
  let renderJobId: string | null = null;
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
      console.log(`[Video Render] Segmentation loaded for ${segmentationData.length} ayah(s)`);
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

    const reciterId = (formData.get("reciterId") as string | null) || DEFAULT_RECITER_ID;
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
    // Absent (older client/draft) means the original look -- see
    // QuranVideoProps.backgroundDim.
    const backgroundDimRaw = Number(formData.get("backgroundDim"));
    const backgroundDim = formData.has("backgroundDim") && Number.isFinite(backgroundDimRaw)
      ? Math.max(0, Math.min(BACKGROUND_DIM_MAX, backgroundDimRaw))
      : DEFAULT_BACKGROUND_DIM;
    const backgroundBlur = Math.max(0, Math.min(BACKGROUND_BLUR_MAX, Number(formData.get("backgroundBlur")) || 0));
    const backgroundZoom = formData.get("backgroundZoom") === "true";
    const wordHighlight = formData.get("wordHighlight") === "true";
    const requestedHighlightColor = formData.get("wordHighlightColor") as string | null;
    const wordHighlightColor =
      requestedHighlightColor && /^#[0-9a-fA-F]{6}$/.test(requestedHighlightColor)
        ? requestedHighlightColor
        : DEFAULT_WORD_HIGHLIGHT_COLOR;
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
      requestedQuality && requestedQuality in QUALITY_SHORT_SIDE
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

    let renderJob: RenderJob | null = null;
    let cancelSignal: import("@remotion/renderer").CancelSignal | undefined;
    if (mode !== "preview") {
      const requestedRenderId = formData.get("renderId");
      renderJobId =
        typeof requestedRenderId === "string" && RENDER_ID_PATTERN.test(requestedRenderId)
          ? requestedRenderId
          : crypto.randomUUID();
      if (renderRegistry.cancelledEarly.delete(renderJobId)) {
        renderJobId = null;
        return cancelledResponse();
      }
      const { makeCancelSignal } = await import("@remotion/renderer");
      const signal = makeCancelSignal();
      cancelSignal = signal.cancelSignal;
      renderJob = { stage: "preparing", progress: 0, etaMs: null, cancelled: false, cancel: signal.cancel };
      renderRegistry.jobs.set(renderJobId, renderJob);
    }
    const throwIfCancelled = () => {
      if (renderJob?.cancelled) throw new RenderCancelledError();
    };

    if (!getReciter(reciterId)) {
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
    // Edition ids/sources come from the same translationOptions module the
    // client picker uses, so every edition it offers renders here too (an
    // unknown id used to silently fall back to diyanet_eski's text).
    const LOCAL_TRANSLATIONS: Record<string, Record<string, string>> = {
      "diyanet_yeni": diyanetYeniData,
      "ahmet_varol": ahmetVarolData,
    };
    const translationOption = getTranslationOption(translationId);

    const isNoneTranslation = translationId === "none" || !translationOption;
    const translationCacheKey = `${translationId}:${surahId}`;
    let translationMap = translationCache.get(translationCacheKey) ?? new Map<number, string>();

    if (!isNoneTranslation && translationOption && !translationCache.has(translationCacheKey)) {
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
        const { source, ref } = translationOption;
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
    // -- skips re-sending an identical file on every single reload. Only
    // meaningful when no fresh `bgImage` file is present.
    const existingBackgroundImagePath = formData.get("existingBackgroundImagePath") as string | null;
    let backgroundImagePath: string | null = null;

    if (bgImage && bgImage.size > 0) {
      let filename: string;
      try {
        ({ filename } = await saveUploadOnce(bgImage, "backgrounds", "bg", ".jpg", async (tempPath) => {
          const fileBuffer = await fs.readFile(tempPath);
          if (!IMAGE_MAGIC_BYTES.some((header) => header.every((byte, i) => fileBuffer[i] === byte))) {
            throw new InvalidUploadError("not an image");
          }
        }));
      } catch (err) {
        if (!(err instanceof InvalidUploadError)) throw err;
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
      let filename: string;
      try {
        // Background videos are always silent (see lib/silentVideo.ts) --
        // also fails here for a file ffmpeg can't read, i.e. not a video.
        const saved = await saveUploadOnce(bgVideo, "backgrounds", "bg", ".mp4", stripAudioInPlace);
        filename = saved.filename;
        // execFile (argument array), NOT execAsync's shell string -- the
        // path's extension comes from the uploaded file's own name (see
        // saveUploadOnce), so it must never be pasted into a string a shell
        // re-parses.
        const { stdout } = await execFileAsync("ffprobe", [
          "-v", "error",
          "-show_entries", "format=duration",
          "-of", "default=noprint_wrappers=1:nokey=1",
          saved.absolutePath,
        ]);
        const durationSeconds = parseFloat(stdout.trim());
        if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
          await fs.unlink(saved.absolutePath).catch(() => undefined);
          throw new Error("ffprobe returned no usable duration");
        }
        backgroundVideoDurationInFrames = Math.round(durationSeconds * FPS);
      } catch (err) {
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
      const { filename } = await saveUploadOnce(customTranslationFont, "fonts", "font", ".ttf");
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
      const { filename, absolutePath } = await saveUploadOnce(customAudio, "custom-audio", "custom", ".mp3");
      globalAudioPath = `/api/serve-audio?file=render-assets/custom-audio/${filename}`;
      globalAudioDurationInFrames = await estimateAudioDurationInFrames(absolutePath);
    }

    const selectedVerses = localSurah.verses.filter((verse) => verse.id >= startVerse && verse.id <= endVerse);

    // The real-word <-> PUA-glyph-token map slices `text` by real-word
    // ranges, which only verses with a segmentation applied need (puaTokenCounts)
    // -- unsegmented verses render as a single block. Word highlighting also
    // needs it to find each recited word's glyphs, for every verse
    // (highlightGlyphCounts, which leaves the slicing alone).
    const segmentedAyahIds = selectedVerses
      .filter((verse) => segmentationData.some((s) => s.surah === surahId && s.ayah === verse.id))
      .map((verse) => verse.id);
    const wordMapAyahIds = wordHighlight ? selectedVerses.map((verse) => verse.id) : segmentedAyahIds;
    let puaWordMapByAyah: Record<number, { realWordCount: number; puaTokenCounts: number[] }> = {};
    if (wordMapAyahIds.length > 0) {
      try {
        const targetPuaTotals: Record<number, number> = {};
        for (const verse of selectedVerses) {
          if (wordMapAyahIds.includes(verse.id)) {
            targetPuaTotals[verse.id] = verse.text.trim().split(/\s+/).length;
          }
        }
        puaWordMapByAyah = await getSurahWordMap(surahId, wordMapAyahIds, targetPuaTotals);
      } catch (e) {
        console.warn("[Video Render] Failed to fetch real-word/PUA word map:", e);
      }
    }

    const shortReciterKey = getReciter(reciterId)?.backendKey || "mishary";

    let wordTimingsData: any = null;
    let extractionData: any = null;
    let apiExtracted = false;
    // The timing below came from the client's own preparedJsonData and trim,
    // which lets the live preview re-time itself without asking again (see
    // the preview response).
    let usedPreparedTiming = false;

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

            // Shift JSON word timings by trimStart -- the reading path too,
            // which holdWordsThroughRepeats compares with the words.
            if (wordTimingsData && wordTimingsData.verses) {
              for (const ayah in wordTimingsData.verses) {
                const verseTiming = wordTimingsData.verses[ayah];
                verseTiming.words = shiftWordsToTrim(verseTiming.words || [], trimStart * 1000);
              }
              wordTimingsData.readings = shiftReadingsToTrim(wordTimingsData.readings, trimStart * 1000);
            }
            apiExtracted = true;
            usedPreparedTiming = true;
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
          usedPreparedTiming = true;
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

    // The per-ayah fallback below needs a per-ayah set for THIS reciter;
    // without one, fail clearly rather than render silence or another voice.
    if (!globalAudioPath && !getReciter(reciterId)?.everyAyahDir) {
      return NextResponse.json(
        { error: "Audio extraction for this reciter is unavailable right now. Please try again in a moment." },
        { status: 502 }
      );
    }

    // Calculate total character count for proportional duration assignment if using custom audio
    let totalCharsAllVerses = 0;
    if (globalAudioPath && !apiExtracted) {
      for (const verse of selectedVerses) {
        const apiAyah = apiAyahByNumber.get(verse.id);
        const arabicText = fixMojibake(apiAyah?.text_arabic || verse.text);
        // The DB's stored text is Turkish -- only a fallback for a Turkish
        // edition, never for an English/Arabic one.
        const defaultTranslation = translationOption?.language === "tr" ? fixMojibake(apiAyah?.text_turkish || "") : "";
        const translationText = isNoneTranslation ? "" : (translationMap.get(verse.id) || defaultTranslation);
        totalCharsAllVerses += arabicText.length + translationText.length;
      }
    }

    // With aligned word timing for every selected ayah, where each ayah and
    // each of its chunks sits is the shared rule in remotion/timing.ts --
    // the same one the live preview re-times itself with on every edit, so
    // preview and export can't drift apart. null (some ayah without timing)
    // falls back to the older per-verse logic below.
    // A repeat inside a part keeps its words current (see holdWordsThroughRepeats).
    const heldWords = holdWordsThroughRepeats(
      selectedVerses.map((verse) => ({ id: verse.id, words: wordTimingsData?.verses?.[verse.id]?.words ?? [] })),
      wordTimingsData?.readings
    );
    const wordRepeats = repeatWordWindows(selectedVerses.map((verse) => verse.id), wordTimingsData?.readings);
    const timeline = apiExtracted && globalAudioPath
      ? buildVerseTimeline(
          selectedVerses.map((verse) => ({
            id: verse.id,
            words: heldWords.get(verse.id) ?? [],
            mappings: segmentationData.find((s) => s.surah === surahId && s.ayah === verse.id)?.mappings,
            repeats: wordRepeats.get(verse.id),
          })),
          { trimStartMs: trimStart * 1000, fps: FPS, totalFrames: globalAudioDurationInFrames }
        )
      : null;

    // Fallback when `timeline` is null. Precompute the effective start
    // boundary (in wordTimingsData's ms coordinate space, i.e. after any
    // trimStart shift) for every selected verse. A manually-dragged boundary from SegmentTimingEditor -- saved
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

    let verses: QuranVerse[] = await Promise.all(
      selectedVerses.map(async (verse, index) => {
        // The ayah's first appearance on the timeline (see remotion/timing.ts);
        // the others are added after this map.
        const firstAppearance = timeline?.find((t) => t.verseIndex === index);
        const apiAyah = apiAyahByNumber.get(verse.id);
        const arabicText = fixMojibake(apiAyah?.text_arabic || verse.text);
        // The DB's stored text is Turkish -- only a fallback for a Turkish
        // edition, never for an English/Arabic one.
        const defaultTranslation = translationOption?.language === "tr" ? fixMojibake(apiAyah?.text_turkish || "") : "";
        const translationText = isNoneTranslation ? "" : (translationMap.get(verse.id) || defaultTranslation);

        let audioRelPath = "";
        let durationInFrames = 0;
        let localAudioFile = "";

        if (globalAudioPath) {
          audioRelPath = globalAudioPath;

          if (firstAppearance) {
            durationInFrames = firstAppearance.durationInFrames;
          } else if (apiExtracted && wordTimingsData?.verses?.[verse.id]?.words) {
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
            if (!audioUrl) throw new Error(`No per-ayah audio for reciter ${reciterId}`);
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

        let wordTimings: any[] | undefined;
        if (firstAppearance) {
          wordTimings = firstAppearance.wordTimings;
        } else if (wordTimingsData && wordTimingsData.verses && wordTimingsData.verses[verse.id]) {
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

        const puaWordMap = segmentedAyahIds.includes(verse.id) ? puaWordMapByAyah[verse.id] : undefined;
        const highlightWordMap = wordHighlight ? puaWordMapByAyah[verse.id] : undefined;

        // Manual per-segment timing overrides (from SegmentTimingEditor) are
        // stored in the SAME raw, un-normalized coordinate space as
        // preparedJsonData/wordTimingsData (i.e. relative to the prepared
        // clip before any trim). Apply the exact same trimStart shift and
        // per-verse verseStartMs normalization wordTimings just went
        // through above, so QuranVideo.tsx can treat start_ms/end_ms as
        // already verse-relative, matching wordTimings' own coordinate
        // space, with no further conversion needed at render time.
        let mappings = firstAppearance ? firstAppearance.mappings : matchingSegmentation?.mappings;
        if (!timeline && mappings && apiExtracted && wordTimingsData?.verses?.[verse.id]?.words?.length) {
          const verseStartMs = verseBoundaryMs[index] ?? (index === 0 ? 0 : wordTimingsData.verses[verse.id].words[0].start);
          mappings = mappings.map((m: any) => ({
            ...m,
            ...(typeof m.start_ms === "number" ? { start_ms: m.start_ms - trimStart * 1000 - verseStartMs } : {}),
            ...(typeof m.end_ms === "number" ? { end_ms: m.end_ms - trimStart * 1000 - verseStartMs } : {}),
          }));
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
          ...(highlightWordMap ? { highlightGlyphCounts: highlightWordMap.puaTokenCounts } : {}),
        };

        return verseData;
      })
    );

    // One entry per appearance: an ayah the reciter went back to after the
    // next one began appears again (remotion/timing.ts), with its own
    // duration, word timing and visible chunks.
    if (timeline) {
      verses = timeline.map((t) => {
        const verse = verses[t.verseIndex];
        return {
          ...verse,
          durationInFrames: t.durationInFrames,
          wordTimings: t.wordTimings as QuranVerse["wordTimings"],
          ...(t.wordRepeats ? { wordRepeats: t.wordRepeats } : {}),
          ...(t.mappings ? { mappings: t.mappings as QuranVerse["mappings"] } : {}),
        };
      });
    }

    // Fix up last verse duration if using custom audio to perfectly match
    // global duration (`timeline` already sized it).
    if (globalAudioPath && verses.length > 0 && !timeline) {
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
    // The video's language: its translation's, or (no translation) the
    // translation picker's language the client sends as videoLanguage.
    const requestedVideoLanguage = formData.get("videoLanguage");
    const videoLanguage =
      translationOption?.language ??
      (requestedVideoLanguage === "en" || requestedVideoLanguage === "ar" ? requestedVideoLanguage : "tr");
    const surahNameTransliteration = fixMojibake(apiSurah?.name_turkish || localSurah.transliteration).toLocaleUpperCase("tr-TR");
    const surahTitle =
      videoLanguage === "ar"
        ? ""
        : videoLanguage === "en"
          ? `SURAH ${(surahEnglishName(surahId) ?? localSurah.transliteration).toUpperCase()}`
          : `${surahNameTransliteration} SURESİ`;
    // An Arabic video shows the reciter's name in surahTitle's place (the
    // client sends "" when the user turned it off or left it blank).
    const reciterName = videoLanguage === "ar" ? String(formData.get("reciterName") ?? "").trim().slice(0, 80) : "";
    const inputProps: QuranVideoProps = {
      surahNameArabic: fixMojibake(removeTashkeel(apiSurah?.name_arabic || localSurah.name)),
      surahNameTransliteration,
      surahTitle,
      ...(reciterName ? { reciterName } : {}),
      backgroundImagePath,
      backgroundVideoPath,
      backgroundVideoDurationInFrames,
      backgroundDim,
      backgroundBlur,
      backgroundZoom,
      wordHighlight,
      wordHighlightColor,
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
      ...(isRtlTranslation(translationId) ? { translationRtl: true } : {}),
    };

    if (mode === "preview") {
      // A download usually follows the preview, so have the Remotion bundle
      // (a cold webpack build, ~10 s) and the headless browser ready by then.
      if (!cachedServeUrl) void getServeUrl().catch(() => undefined);
      if (!cachedBrowserPromise) void getBrowserInstance().catch(() => undefined);

      // `timing` tells the client these props were timed from its own
      // preparedJsonData cut at trimStartMs, so it can re-time them itself
      // (remotion/timing.ts) on every segmentation edit instead of waiting
      // for another round trip. Absent when the server had to time them
      // from anything else (e.g. the prepared file is gone).
      return NextResponse.json({
        success: true,
        inputProps,
        ...(timeline && usedPreparedTiming ? { timing: { trimStartMs: trimStart * 1000 } } : {}),
      });
    }

    const filename = `${surahId}-${startVerse}-${endVerse}-${renderJobId}.mp4`;
    const outputLocation = path.join(RENDERS_DIR, filename);
    await fs.mkdir(RENDERS_DIR, { recursive: true });
    await pruneOldRenders();

    throwIfCancelled();
    const serveUrl = await getServeUrl();
    throwIfCancelled();
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
      scale: qualityScale(quality, aspectRatio),
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
      cancelSignal,
      onProgress: ({ progress, renderEstimatedTime }) => {
        if (!renderJob) return;
        renderJob.stage = "rendering";
        renderJob.progress = progress;
        renderJob.etaMs = renderEstimatedTime > 0 ? renderEstimatedTime : null;
      },
    }, () => Boolean(renderJob?.cancelled));
    throwIfCancelled();
    if (renderJob) {
      renderJob.stage = "saving";
      renderJob.progress = 1;
    }

    // Best-effort copy into the persistent gallery -- outputLocation itself
    // lives in the ephemeral public/renders tmpfs (wiped on container
    // restart, pruned by later renders -- see pruneOldRenders), so
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
          reciterName: RECITER_ARABIC_NAMES[reciterId],
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
    if (error instanceof RenderCancelledError || (renderJobId && renderRegistry.jobs.get(renderJobId)?.cancelled)) {
      console.log(`[Video Render] Render ${renderJobId} cancelled`);
      return cancelledResponse();
    }
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

    if (renderJobId) renderRegistry.jobs.delete(renderJobId);

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
