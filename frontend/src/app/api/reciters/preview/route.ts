import { NextResponse } from "next/server";
import { getReciter } from "@/lib/reciterNames";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function backendUrl(): string {
  return process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:8000";
}

// Where the reciter picker's listen button plays the chosen ayahs from
// (backend/app/routers/extraction.py's preview-source): the reciter's
// mp3quran recording and the ayahs' start/end in it. Nothing is prepared or
// downloaded here -- the browser streams the recording itself.
//
// GET ?reciter=<id>&surah=&start=&end=
// Answer: { url, start, end, total, timed }.
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const reciter = getReciter(params.get("reciter") ?? "");
  const surah = Number(params.get("surah"));
  const start = Number(params.get("start"));
  const end = Number(params.get("end"));
  if (!reciter || !Number.isInteger(surah) || !Number.isInteger(start) || !Number.isInteger(end)) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const query = new URLSearchParams({
    reciter: reciter.backendKey,
    surah: String(surah),
    start: String(start),
    end: String(end),
  });
  try {
    const res = await fetch(`${backendUrl()}/api/extraction/preview-source?${query}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
