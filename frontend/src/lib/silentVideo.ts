// Server-only. A background video must be silent -- the recitation is the
// only sound in the video. QuranVideo.tsx already mutes it, but around a
// third of stock videos (and many uploads) carry their own audio track
// (waves, rain, music...), so every background video is also stripped of
// audio at each place one enters the project (stock download, render
// upload, draft save): then no browser, player or export can ever play it.
import { execFile } from "child_process";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// Rewrites the file in place with only its first video stream -- copied
// as-is (no re-encode), so it takes a fraction of a second and loses no
// quality. Throws if ffmpeg can't read the file.
export async function stripAudioInPlace(filePath: string): Promise<void> {
  const ext = path.extname(filePath) || ".mp4";
  const tempPath = `${filePath}.silent${ext}`;
  try {
    await execFileAsync("ffmpeg", [
      "-v", "error",
      "-y",
      "-i", filePath,
      "-map", "0:v:0",
      "-c", "copy",
      "-an", "-sn", "-dn",
      ...(ext === ".mp4" || ext === ".mov" || ext === ".m4v" ? ["-movflags", "+faststart"] : []),
      tempPath,
    ]);
    await fs.rename(tempPath, filePath);
  } catch (err) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw err;
  }
}
