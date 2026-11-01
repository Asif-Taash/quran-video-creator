import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 30 * 1024 * 1024;

function backendUrl(): string {
  return process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:8000";
}

// A background photo, sharper: the backend upscales it when it's too small
// for the video (backend/app/routers/enhance.py). 204 when it's already
// sharp enough -- the caller keeps the photo it has.
export async function POST(req: Request) {
  let file: File | null = null;
  try {
    const entry = (await req.formData()).get("file");
    file = entry instanceof File ? entry : null;
  } catch {
    file = null;
  }
  if (!file || !file.type.startsWith("image/")) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "File is too large" }, { status: 413 });

  try {
    const form = new FormData();
    form.append("file", file, file.name || "background.jpg");
    const res = await fetch(`${backendUrl()}/api/enhance/image`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(180_000),
    });
    if (res.status === 204) return new NextResponse(null, { status: 204 });
    if (!res.ok) throw new Error(`Upscale failed with HTTP ${res.status}`);
    return new NextResponse(await res.arrayBuffer(), { headers: { "Content-Type": "image/jpeg" } });
  } catch (error) {
    console.error("[Backgrounds] Enhance failed:", error);
    return NextResponse.json({ error: "Could not enhance this photo." }, { status: 502 });
  }
}
