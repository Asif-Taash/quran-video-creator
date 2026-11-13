import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { fileResponse } from "@/lib/fileResponse";

const RENDERS_DIR = path.join(process.cwd(), "public", "renders");

export async function GET(
  req: Request,
  { params }: { params: { filename: string } }
) {
  try {
    const filename = path.basename(params.filename);
    const filePath = path.join(RENDERS_DIR, filename);

    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) {
      return NextResponse.json({ error: "Video not found" }, { status: 404 });
    }

    return fileResponse(filePath, stat.size, "video/mp4", req.headers.get("range"));
  } catch (error) {
    console.error("Error serving video:", error);
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  }
}
