import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const RENDERS_DIR = path.join(process.cwd(), "public", "renders");

export async function GET(
  req: Request,
  { params }: { params: { filename: string } }
) {
  try {
    const filename = path.basename(params.filename);
    const filePath = path.join(RENDERS_DIR, filename);

    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: "Video not found" }, { status: 404 });
    }

    const stat = fs.statSync(filePath);
    const total = stat.size;

    const range = req.headers.get("range");

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const partialstart = parts[0];
      const partialend = parts[1];

      const start = parseInt(partialstart, 10);
      const end = partialend ? parseInt(partialend, 10) : total - 1;
      const chunksize = end - start + 1;

      // MP4 files can be somewhat large, but since it's just a generated clip, readFileSync is okay for now.
      // A createReadStream approach is better for large files, but for consistency with serve-audio:
      const buffer = fs.readFileSync(filePath);
      const chunk = buffer.subarray(start, end + 1);

      return new NextResponse(chunk, {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunksize.toString(),
          "Content-Type": "video/mp4",
          "Cache-Control": "no-store, max-age=0",
        },
      });
    } else {
      const buffer = fs.readFileSync(filePath);
      return new NextResponse(buffer, {
        status: 200,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": total.toString(),
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store, max-age=0",
        },
      });
    }
  } catch (error) {
    console.error("Error serving video:", error);
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  }
}
