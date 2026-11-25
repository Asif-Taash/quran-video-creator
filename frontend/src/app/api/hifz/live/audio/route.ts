import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// More of a live reading (raw 16 kHz mono 16-bit PCM) -> the reading so far,
// word by word; with ?final=1 the full check of the whole recording.
// POST ?session=&final=0|1, body: PCM bytes

const SESSION = /^[0-9a-f]{32}$/;
const MAX_BYTES = 2 * 1024 * 1024;

function backendUrl(): string {
  return process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:8000";
}

export async function POST(req: Request) {
  const params = new URL(req.url).searchParams;
  const session = params.get("session") ?? "";
  const final = params.get("final") === "1";
  if (!SESSION.test(session)) return NextResponse.json({ error: "session" }, { status: 400 });
  const pcm = await req.arrayBuffer();
  if (pcm.byteLength > MAX_BYTES) return NextResponse.json({ error: "audio" }, { status: 413 });
  try {
    const res = await fetch(`${backendUrl()}/api/hifz/live/${session}?final=${final ? 1 : 0}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: pcm,
      cache: "no-store",
      signal: AbortSignal.timeout(final ? 600_000 : 60_000),
    });
    if (res.status === 404) return NextResponse.json({ error: "gone" }, { status: 404 });
    if (!res.ok) return NextResponse.json({ error: "failed" }, { status: 502 });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
