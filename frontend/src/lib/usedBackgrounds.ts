// Server-only: the backgrounds that went into an exported video. The user
// publishes every video they export, and the same picture in two published
// videos is a rights problem, so the background library never offers one of
// these again (the user, 2026-11-13). That holds when it comes back under the
// same stock id and when it comes back under another id: Pixabay often
// carries one picture several times. A background the user uploaded counts
// too.
//
// A used background is recognised two ways:
// - Its stock key ("pixabay-video-123"). The key comes from the uploaded
//   file's name: BackgroundPicker names a pick "<provider>-<id>.<ext>", and
//   VideoCreatorForm adds "-hd" to the upscaled copy. A reopened project's
//   file is named "draft-bg.*", so the drafts route records which key each
//   saved file came from (rememberStockSource).
// - Its picture. The exported file is fingerprinted (the photo plus its
//   mirror image, or a video's frames at 1 fps) and compared with every
//   library thumbnail's fingerprint. See vision.py fingerprint() for the
//   measured distances.
//
// Fails closed:
// - A search shows no result whose thumbnail has no fingerprint.
// - If the backend can't fingerprint an export's background (it is down), a
//   copy of the file is kept until it can.
//
// The record is stored in src/data/used-backgrounds.json, next to the
// drafts and git-ignored. If the file is missing it is rebuilt from the
// backgrounds of every project in "مشاريعي", exported or not: projects saved
// before export copies existed (2026-11-08) may have been published too.
import crypto from "crypto";
import { execFile } from "child_process";
import { createReadStream } from "fs";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import { DRAFTS_DIR, readDraft } from "@/lib/draftStore";
import { fingerprintImages } from "@/lib/natureCheck";

const execFileAsync = promisify(execFile);

const REGISTRY_PATH = path.join(process.cwd(), "src", "data", "used-backgrounds.json");
const PENDING_DIR = path.join(process.cwd(), "src", "data", "used-backgrounds-pending");
const PUBLIC_DIR = path.join(process.cwd(), "public");
const DRAFT_FILES_DIR = path.join(PUBLIC_DIR, "render-assets", "drafts");

// Out of 256 bits, the largest difference still counted as the same
// picture. Measured: the same picture differs by 0-20 for photos and
// mostly 0-32 for a video's frames; different pictures never differed by
// less than 80.
const SAME_PICTURE_MAX_DISTANCE = 56;
// A video is fingerprinted at 1 fps, up to this many frames.
const VIDEO_FRAME_LIMIT = 90;
// File-to-key records kept for reopened projects (oldest dropped first).
const SOURCES_MAX = 5000;
// A pending fingerprint is retried at most this often.
const PENDING_RETRY_MS = 60_000;
const FINGERPRINT = /^[0-9a-f]{64}$/;

type Kind = "image" | "video";

type UsedEntry = {
  at: string;
  kind: Kind;
  // First 32 hex digits of the file's SHA-256: the name render-assets gives
  // an upload (bg-<sha>.jpg), so an export of the same file again is
  // recognised without fingerprinting it.
  sha: string;
  keys: string[];
  hashes: string[];
  // File name in PENDING_DIR, while the fingerprint is still to be taken.
  pending?: string;
  via: "export" | "backfill";
};

type Registry = {
  version: 1;
  used: UsedEntry[];
  // sha (as above) of a file saved in a project -> the stock key it came
  // from.
  sources: Record<string, string>;
};

type Compiled = {
  ino: number;
  mtimeMs: number;
  size: number;
  keys: Set<string>;
  // Every fingerprint as 8 consecutive 32-bit words.
  words: Uint32Array;
  pending: boolean;
};

// On globalThis: each API route is its own bundle in dev mode, and they
// must share one queue of registry writes.
const state = ((globalThis as { __usedBackgrounds?: unknown }).__usedBackgrounds ??= {
  chain: Promise.resolve(),
  compiled: null,
  lastPendingRetry: 0,
}) as { chain: Promise<unknown>; compiled: Compiled | null; lastPendingRetry: number };

export async function fileSha(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex").slice(0, 32);
}

const STOCK_NAME = /^(pexels|pixabay)-(\d+)(?:-hd)?\.[a-z0-9]{1,5}$/i;

function stockKeyFromName(name: string, kind: Kind): string | null {
  const match = STOCK_NAME.exec(name);
  return match ? `${match[1].toLowerCase()}-${kind === "image" ? "photo" : "video"}-${match[2]}` : null;
}

async function fingerprintFile(filePath: string, kind: Kind): Promise<string[]> {
  if (kind === "image") return fingerprintImages([await fs.readFile(filePath)], true);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "used-bg-"));
  try {
    await execFileAsync("ffmpeg", [
      "-v", "error", "-i", filePath,
      "-vf", "fps=1,scale=320:-2", "-frames:v", String(VIDEO_FRAME_LIMIT),
      path.join(dir, "f%03d.jpg"),
    ]);
    const frames = (await fs.readdir(dir)).filter((n) => n.endsWith(".jpg")).sort();
    if (frames.length === 0) throw new Error("No frames could be read");
    return fingerprintImages(await Promise.all(frames.map((n) => fs.readFile(path.join(dir, n)))), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function readRegistry(): Promise<Registry | null> {
  let raw: string;
  try {
    raw = await fs.readFile(REGISTRY_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  // A damaged file throws: then the library shows nothing rather than
  // pictures it can no longer tell apart from used ones.
  const data = JSON.parse(raw);
  return {
    version: 1,
    used: Array.isArray(data.used) ? data.used : [],
    sources: data.sources && typeof data.sources === "object" ? data.sources : {},
  };
}

async function writeRegistry(registry: Registry) {
  const tempPath = `${REGISTRY_PATH}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify(registry, null, 1));
    await fs.rename(tempPath, REGISTRY_PATH);
  } catch (err) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw err;
  }
}

// Every change goes through here, one at a time.
function withRegistry<T>(change: (registry: Registry) => Promise<T>): Promise<T> {
  const run = state.chain.then(async () => {
    const registry = (await readRegistry()) ?? (await rebuildFromProjects());
    const result = await change(registry);
    await writeRegistry(registry);
    return result;
  });
  state.chain = run.catch(() => undefined);
  return run;
}

async function newEntry(filePath: string, kind: Kind, sha: string, keys: string[], via: UsedEntry["via"]): Promise<UsedEntry> {
  const entry: UsedEntry = { at: new Date().toISOString(), kind, sha, keys, hashes: [], via };
  try {
    entry.hashes = await fingerprintFile(filePath, kind);
  } catch (err) {
    console.warn(`[UsedBackgrounds] Could not fingerprint ${path.basename(filePath)} yet, keeping a copy to retry:`, err);
    const ext = path.extname(filePath).toLowerCase();
    const pending = `${sha}${/^\.[a-z0-9]{1,5}$/.test(ext) ? ext : kind === "image" ? ".jpg" : ".mp4"}`;
    await fs.mkdir(PENDING_DIR, { recursive: true });
    await fs.copyFile(filePath, path.join(PENDING_DIR, pending));
    entry.pending = pending;
  }
  return entry;
}

// A project's file URL is /api/serve-audio?file=render-assets/drafts/<id>/<name>.
function draftFilePath(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const match = /[?&]file=([^&]+)/.exec(url);
  if (!match) return null;
  const filePath = path.resolve(PUBLIC_DIR, decodeURIComponent(match[1]));
  return filePath.startsWith(DRAFT_FILES_DIR + path.sep) ? filePath : null;
}

async function rebuildFromProjects(): Promise<Registry> {
  const registry: Registry = { version: 1, used: [], sources: {} };
  const names = await fs.readdir(DRAFTS_DIR).catch(() => [] as string[]);
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const draft = await readDraft(name.slice(0, -".json".length));
    if (!draft) continue;
    for (const [field, kind] of [["background", "image"], ["backgroundVideo", "video"]] as const) {
      const filePath = draftFilePath((draft[field] as { url?: unknown } | undefined)?.url);
      if (!filePath) continue;
      const sha = await fileSha(filePath).catch(() => null);
      if (!sha || registry.used.some((e) => e.sha === sha)) continue;
      registry.used.push(await newEntry(filePath, kind, sha, [], "backfill"));
    }
  }
  console.log(`[UsedBackgrounds] Rebuilt from the saved projects: ${registry.used.length} backgrounds.`);
  return registry;
}

async function retryPending(registry: Registry) {
  for (const entry of registry.used) {
    if (!entry.pending) continue;
    const filePath = path.join(PENDING_DIR, path.basename(entry.pending));
    if (!(await fs.stat(filePath).catch(() => null))) {
      // Its copy is gone: nothing left to fingerprint (its key still counts).
      delete entry.pending;
      continue;
    }
    try {
      entry.hashes = await fingerprintFile(filePath, entry.kind);
    } catch (err) {
      console.warn("[UsedBackgrounds] Fingerprint retry failed:", err);
      return;
    }
    delete entry.pending;
    await fs.unlink(filePath).catch(() => undefined);
  }
}

// Called after an export finished. `sha` is the upload's own (the file on
// disk may differ: a video's audio is stripped after upload). Never throws
// into the caller's way -- callers don't wait for it.
export function recordUsedBackground(file: { path: string; kind: Kind; name: string; sha: string }): Promise<void> {
  return withRegistry(async (registry) => {
    const key = stockKeyFromName(file.name, file.kind) ?? registry.sources[file.sha] ?? null;
    const existing = registry.used.find((e) => e.sha === file.sha);
    if (existing) {
      if (key && !existing.keys.includes(key)) existing.keys.push(key);
      return;
    }
    registry.used.push(await newEntry(file.path, file.kind, file.sha, key ? [key] : [], "export"));
    console.log(`[UsedBackgrounds] Recorded the exported background ${key ?? file.sha}.`);
  });
}

// Called when a project saves a background file: remembers which stock item
// it came from, for when the project is reopened and exported later.
export function rememberStockSource(sha: string, name: string, kind: Kind): Promise<void> {
  const key = stockKeyFromName(name, kind);
  if (!key) return Promise.resolve();
  return withRegistry(async (registry) => {
    delete registry.sources[sha];
    registry.sources[sha] = key;
    const shas = Object.keys(registry.sources);
    for (const old of shas.slice(0, Math.max(0, shas.length - SOURCES_MAX))) delete registry.sources[old];
  });
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

function toWords(hash: string, out: Uint32Array, at: number) {
  for (let w = 0; w < 8; w++) out[at + w] = parseInt(hash.slice(w * 8, w * 8 + 8), 16);
}

async function compiledRegistry(): Promise<Compiled> {
  let stat = await fs.stat(REGISTRY_PATH).catch(() => null);
  if (!stat) {
    await withRegistry(async () => undefined);
    stat = await fs.stat(REGISTRY_PATH);
  }
  const current = state.compiled;
  if (current && current.ino === stat.ino && current.mtimeMs === stat.mtimeMs && current.size === stat.size) return current;

  const registry = await readRegistry();
  if (!registry) throw new Error("used-backgrounds.json disappeared");
  const keys = new Set<string>();
  const hashes: string[] = [];
  let pending = false;
  for (const entry of registry.used) {
    for (const key of entry.keys ?? []) keys.add(key);
    for (const hash of entry.hashes ?? []) if (FINGERPRINT.test(hash)) hashes.push(hash);
    if (entry.pending) pending = true;
  }
  const words = new Uint32Array(hashes.length * 8);
  hashes.forEach((hash, i) => toWords(hash, words, i * 8));
  state.compiled = { ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size, keys, words, pending };
  return state.compiled;
}

// (stock key, thumbnail fingerprint) -> was this picture in an exported
// video? Throws when the record can't be read: callers show nothing then.
export async function usedBackgroundCheck(): Promise<(key: string, hash: string) => boolean> {
  let compiled = await compiledRegistry();
  if (compiled.pending && Date.now() - state.lastPendingRetry > PENDING_RETRY_MS) {
    state.lastPendingRetry = Date.now();
    await withRegistry(retryPending).catch((err) => console.warn("[UsedBackgrounds] Retry failed:", err));
    compiled = await compiledRegistry();
  }
  const { keys, words } = compiled;
  const query = new Uint32Array(8);
  return (key, hash) => {
    if (keys.has(key)) return true;
    toWords(hash, query, 0);
    for (let i = 0; i < words.length; i += 8) {
      let distance = 0;
      for (let w = 0; w < 8 && distance <= SAME_PICTURE_MAX_DISTANCE; w++) distance += popcount(words[i + w] ^ query[w]);
      if (distance <= SAME_PICTURE_MAX_DISTANCE) return true;
    }
    return false;
  };
}
