// Server-only: the "natural scenery only" check (no people, buildings,
// vehicles or animals) for the background library, run by the backend's
// vision service (backend/app/routers/vision.py) -- stock tags alone miss
// the hiker on the ridge or the village in the valley. Fails closed: when
// the check can't run, nothing unchecked is shown or applied.
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

function backendUrl(): string {
  return process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:8000";
}

// A fingerprint: 256 bits as 64 hex digits (see vision.py fingerprint()).
const FINGERPRINT = /^[0-9a-f]{64}$/;

export type ThumbnailVerdict = {
  ok: boolean;
  // The thumbnail's fingerprint, for lib/usedBackgrounds.ts; null when the
  // backend couldn't take it.
  hash: string | null;
};

// For every image the backend has judged by its thumbnail. The first call
// of a fresh backend also loads the models (a few seconds).
export async function checkThumbnails(items: { key: string; url: string }[]): Promise<Record<string, ThumbnailVerdict>> {
  if (items.length === 0) return {};
  const res = await fetch(`${backendUrl()}/api/vision/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`Vision check failed with HTTP ${res.status}`);
  const data = await res.json();
  const verdicts: Record<string, ThumbnailVerdict> = {};
  for (const [key, v] of Object.entries<any>(data.results ?? {})) {
    verdicts[key] = { ok: Boolean(v?.ok), hash: typeof v?.hash === "string" && FINGERPRINT.test(v.hash) ? v.hash : null };
  }
  return verdicts;
}

// Fingerprints of images (JPEG/PNG/WebP/GIF bytes); with mirror, each
// image's mirrored copy follows its own.
export async function fingerprintImages(images: Buffer[], mirror: boolean): Promise<string[]> {
  const form = new FormData();
  form.append("mirror", mirror ? "true" : "false");
  images.forEach((bytes, i) => form.append("frames", new Blob([new Uint8Array(bytes)]), `image${i}`));
  const res = await fetch(`${backendUrl()}/api/vision/fingerprint`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Fingerprint failed with HTTP ${res.status}`);
  const data = await res.json();
  const hashes: unknown = data.hashes;
  const expected = images.length * (mirror ? 2 : 1);
  if (!Array.isArray(hashes) || hashes.length !== expected || !hashes.every((h) => typeof h === "string" && FINGERPRINT.test(h))) {
    throw new Error("Fingerprint answer malformed");
  }
  return hashes as string[];
}

// A video's thumbnail is a single frame -- people or buildings can still show
// up later in it -- so the picked file itself is checked at several points.
const VIDEO_FRAME_POINTS = [0.08, 0.3, 0.5, 0.7, 0.92];

export async function checkVideoFile(filePath: string, key: string): Promise<boolean> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath,
  ]);
  const duration = parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Unreadable video");

  const form = new FormData();
  form.append("key", key);
  for (const [i, point] of VIDEO_FRAME_POINTS.entries()) {
    const { stdout: jpeg } = await execFileAsync(
      "ffmpeg",
      ["-v", "error", "-ss", (duration * point).toFixed(2), "-i", filePath, "-frames:v", "1", "-vf", "scale=640:-2", "-f", "image2", "-c:v", "mjpeg", "pipe:1"],
      { encoding: "buffer", maxBuffer: 20 * 1024 * 1024 }
    );
    form.append("frames", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), `frame${i}.jpg`);
  }
  const res = await fetch(`${backendUrl()}/api/vision/check-frames`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Vision frame check failed with HTTP ${res.status}`);
  const data = await res.json();
  return Boolean(data.ok);
}
