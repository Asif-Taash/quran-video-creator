import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Which ayahs a short recording holds (a reel pasted or picked as the
// audio): the backend hears all of it (scripts/recite_search.py identify).
// POST form { audio }  ->  { found: { surah, from, to, score, basmala } | null }

const MAX_BYTES = 200 * 1024 * 1024;

function backendUrl(): string {
  return process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:8000";
}

export async function POST(req: Request) {
  const form = await req.formData();
  const audio = form.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0 || audio.size > MAX_BYTES) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const upstream = new FormData();
  upstream.append("audio", audio, "recording");
  const res = await fetch(`${backendUrl()}/api/search/identify`, {
    method: "POST",
    body: upstream,
    cache: "no-store",
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) return NextResponse.json({ error: "failed" }, { status: 502 });
  const data = await res.json();
  return NextResponse.json({ found: data.found ?? null });
}
