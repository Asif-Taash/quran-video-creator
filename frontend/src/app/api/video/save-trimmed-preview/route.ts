import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Persists a client-side-cut audio preview (see SegmentTimingEditor's
// applyTrimOnly, which does the actual cutting via the Web Audio API in the
// browser) so it survives the timing editor being closed and reopened --
// without this, only in-memory Blob URLs held it, discarded the moment the
// editor unmounted. Lives in the SAME renders/temp_audio directory
// prepare-audio already writes to, so it's covered by the existing
// /api/video/cleanup route with no extra cleanup path needed.
export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const audio = formData.get("audio") as File | null;
    if (!audio || audio.size === 0) {
      return NextResponse.json({ error: "No audio file provided" }, { status: 400 });
    }

    const dir = path.join(process.cwd(), "public", "renders", "temp_audio");
    await fs.mkdir(dir, { recursive: true });

    const filename = `trimmed-preview-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`;
    const absolutePath = path.join(dir, filename);
    const buffer = Buffer.from(await audio.arrayBuffer());
    await fs.writeFile(absolutePath, buffer);

    const audioUrl = `/api/serve-audio?file=renders/temp_audio/${filename}&t=${Date.now()}`;
    return NextResponse.json({ success: true, audioUrl });
  } catch (error: any) {
    console.error("[Save Trimmed Preview] Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
