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

// key -> ok, for every image the backend has judged by its thumbnail.
// The first call of a fresh backend also loads the models (a few seconds).
export async function checkThumbnails(items: { key: string; url: string }[]): Promise<Record<string, boolean>> {
  if (items.length === 0) return {};
  const res = await fetch(`${backendUrl()}/api/vision/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`Vision check failed with HTTP ${res.status}`);
  const data = await res.json();
  const verdicts: Record<string, boolean> = {};
  for (const [key, v] of Object.entries<any>(data.results ?? {})) verdicts[key] = Boolean(v?.ok);
  return verdicts;
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
