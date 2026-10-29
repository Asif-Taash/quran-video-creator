import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { fileResponse } from "@/lib/fileResponse";

const PUBLIC_DIR = path.join(process.cwd(), "public");

const CONTENT_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const file = searchParams.get("file");

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  // Only ever serves from inside public/.
  const absolutePath = path.resolve(PUBLIC_DIR, file.replace(/^[/\\]+/, ""));
  if (!absolutePath.startsWith(PUBLIC_DIR + path.sep)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  try {
    const stat = await fs.stat(absolutePath).catch(() => null);
    if (!stat?.isFile()) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const contentType = CONTENT_TYPES[path.extname(absolutePath).toLowerCase()] ?? "application/octet-stream";
    return fileResponse(absolutePath, stat.size, contentType, request.headers.get("range"));
  } catch (error) {
    console.error("Error serving audio:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
