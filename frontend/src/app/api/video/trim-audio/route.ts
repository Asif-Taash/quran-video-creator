import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { audioPath, trimStart, trimEnd, wordTimingsData } = body;

    if (!audioPath || trimStart === undefined || trimEnd === undefined) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // Resolve the audio path
    let absoluteAudioPath = audioPath;
    if (!path.isAbsolute(audioPath)) {
      absoluteAudioPath = path.join(process.cwd(), "public", audioPath);
    }

    // Verify audio file exists
    try {
      await fs.access(absoluteAudioPath);
    } catch {
      return NextResponse.json({ error: "Audio file not found" }, { status: 404 });
    }

    const uploadsDir = path.join(process.cwd(), "public", "render-assets", "trimmed-audio");
    await fs.mkdir(uploadsDir, { recursive: true });

    const trimmedFilename = `trimmed-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`;
    const trimmedAbsolutePath = path.join(uploadsDir, trimmedFilename);

    // Build FFmpeg command for trimming
    const duration = trimEnd - trimStart;
    const ffmpegArgs = [
      "ffmpeg", "-y",
      "-i", `"${absoluteAudioPath}"`,
      "-ss", String(trimStart),
      "-t", String(duration),
      "-c:a", "libmp3lame", "-q:a", "2",
      `"${trimmedAbsolutePath}"`
    ].join(" ");

    await execAsync(ffmpegArgs);

    // Shift word timings by trimStart
    let updatedWordTimings = null;
    if (wordTimingsData) {
      updatedWordTimings = JSON.parse(JSON.stringify(wordTimingsData));
      if (updatedWordTimings.verses) {
        const trimStartMs = trimStart * 1000;
        for (const ayah in updatedWordTimings.verses) {
          const words = updatedWordTimings.verses[ayah].words || [];
          for (const word of words) {
            word.start = Math.max(0, word.start - trimStartMs);
            word.end = Math.max(0, word.end - trimStartMs);
          }
        }
      }
    }

    const serveUrl = `/api/serve-audio?file=render-assets/trimmed-audio/${trimmedFilename}&t=${Date.now()}`;

    return NextResponse.json({
      success: true,
      audioUrl: serveUrl,
      localAudioPath: trimmedAbsolutePath,
      wordTimingsData: updatedWordTimings,
    });
  } catch (error: any) {
    console.error("[Trim Audio] Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
