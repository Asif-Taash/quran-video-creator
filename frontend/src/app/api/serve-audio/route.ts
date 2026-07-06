import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const file = searchParams.get("file");

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  // Ensure it only reads from public directory
  const safeFile = file.replace(/\.\./g, "");
  const absolutePath = path.join(process.cwd(), "public", safeFile);

  try {
    if (!fs.existsSync(absolutePath)) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const stat = fs.statSync(absolutePath);
    const total = stat.size;

    const ext = path.extname(absolutePath).toLowerCase();
    let contentType = "application/octet-stream";
    if (ext === ".mp3") contentType = "audio/mpeg";
    else if (ext === ".wav") contentType = "audio/wav";
    else if (ext === ".png") contentType = "image/png";
    else if (ext === ".jpg" || ext === ".jpeg") contentType = "image/jpeg";
    else if (ext === ".webp") contentType = "image/webp";
    else if (ext === ".mp4") contentType = "video/mp4";

    const range = request.headers.get("range");

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const partialstart = parts[0];
      const partialend = parts[1];

      const start = parseInt(partialstart, 10);
      const end = partialend ? parseInt(partialend, 10) : total - 1;
      const chunksize = end - start + 1;

      // Small files can be read into memory and sliced
      const buffer = fs.readFileSync(absolutePath);
      const chunk = buffer.subarray(start, end + 1);

      return new NextResponse(chunk, {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunksize.toString(),
          "Content-Type": contentType,
          "Cache-Control": "no-store, max-age=0",
        },
      });
    } else {
      const buffer = fs.readFileSync(absolutePath);
      return new NextResponse(buffer, {
        status: 200,
        headers: {
          "Content-Length": total.toString(),
          "Accept-Ranges": "bytes",
          "Content-Type": contentType,
          "Cache-Control": "no-store, max-age=0",
        },
      });
    }
  } catch (error) {
    console.error("Error serving audio:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
