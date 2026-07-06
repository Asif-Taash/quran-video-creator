import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const videoFile = formData.get("video") as File | null;

    if (!videoFile) {
      return NextResponse.json({ error: "No video provided" }, { status: 400 });
    }

    const buffer = Buffer.from(await videoFile.arrayBuffer());
    
    // Create temporary directory
    const tempDir = path.join(process.cwd(), "public", "render-assets", "temp-extract");
    await fs.mkdir(tempDir, { recursive: true });

    const id = Date.now().toString() + Math.random().toString(36).substring(2);
    const videoExt = path.extname(videoFile.name) || ".mp4";
    const videoPath = path.join(tempDir, `input_${id}${videoExt}`);
    const audioPath = path.join(tempDir, `output_${id}.mp3`);

    await fs.writeFile(videoPath, buffer);

    // Extract audio using ffmpeg
    try {
      await execAsync(`ffmpeg -i "${videoPath}" -q:a 0 -map a "${audioPath}"`);
    } catch (err) {
      console.error("FFmpeg error:", err);
      await fs.unlink(videoPath).catch(() => {});
      return NextResponse.json({ error: "Failed to extract audio using FFmpeg" }, { status: 500 });
    }

    // Read the extracted audio file
    const audioBuffer = await fs.readFile(audioPath);

    // Cleanup temp files
    await fs.unlink(videoPath).catch(() => {});
    await fs.unlink(audioPath).catch(() => {});

    // Return the audio file directly as a Blob
    return new NextResponse(audioBuffer, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Disposition": `attachment; filename="extracted.mp3"`,
      },
    });

  } catch (error) {
    console.error("Extract audio API error:", error);
    return NextResponse.json(
      { error: "Failed to process video file" },
      { status: 500 }
    );
  }
}
