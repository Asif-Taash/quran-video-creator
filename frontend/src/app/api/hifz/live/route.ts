import { NextResponse } from "next/server";
import { hifzAvailable, hifzExpected } from "@/lib/hifzData";
import quranData from "@/data/quran.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Starts a live recitation check (backend scripts/hifz_check.py LiveSession):
// the words the reading should hold go to the backend once, then the page
// sends the microphone's audio to /api/hifz/live/audio while the reader
// recites.
// POST { surah, from, to }  ->  { session }

const surahs = quranData as { id: number; total_verses: number }[];
const MAX_WORDS = 1500;

function backendUrl(): string {
  return process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:8000";
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const surah = Number(body?.surah);
  const from = Number(body?.from);
  const to = Number(body?.to);
  const info = surahs.find((s) => s.id === surah);
  if (!info || !Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > info.total_verses) {
    return NextResponse.json({ error: "range" }, { status: 400 });
  }
  if (!hifzAvailable()) return NextResponse.json({ error: "data" }, { status: 503 });
  const expected = hifzExpected(surah, from, to);
  if (expected.length > MAX_WORDS) return NextResponse.json({ error: "too_long" }, { status: 413 });
  try {
    const res = await fetch(`${backendUrl()}/api/hifz/live`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expected, surah }),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return NextResponse.json({ error: "failed" }, { status: 502 });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
