import { NextResponse } from "next/server";
import { hifzAvailable, hifzExpected } from "@/lib/hifzData";
import quranData from "@/data/quran.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The memorization page's recitation check (تسميع): the recording of the
// chosen ayahs read from memory goes to the backend (scripts/hifz_check.py)
// with the words it should hold, and comes back word by word.
// POST form { audio, surah, from, to }  ->  { words: [{ s, h?, t0?, t1?, checked? }], extras, heard, duration, checked }
// words[] runs over the range's words in order (ayah by ayah).

const MAX_BYTES = 40 * 1024 * 1024;
// About eight mushaf pages: the backend's limit (MAX_WORDS) is 1500.
const MAX_WORDS = 1500;
const surahs = quranData as { id: number; total_verses: number }[];

function backendUrl(): string {
  return process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:8000";
}

export async function POST(req: Request) {
  const form = await req.formData();
  const audio = form.get("audio");
  const surah = Number(form.get("surah"));
  const from = Number(form.get("from"));
  const to = Number(form.get("to"));
  const info = surahs.find((s) => s.id === surah);
  if (!(audio instanceof Blob) || audio.size === 0 || audio.size > MAX_BYTES) {
    return NextResponse.json({ error: "audio" }, { status: 400 });
  }
  if (!info || !Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > info.total_verses) {
    return NextResponse.json({ error: "range" }, { status: 400 });
  }
  if (!hifzAvailable()) return NextResponse.json({ error: "data" }, { status: 503 });
  const expected = hifzExpected(surah, from, to);
  if (expected.length > MAX_WORDS) return NextResponse.json({ error: "too_long" }, { status: 413 });

  const upstream = new FormData();
  upstream.append("audio", audio, "recitation");
  upstream.append("expected", JSON.stringify(expected));
  upstream.append("surah", String(surah));
  try {
    const res = await fetch(`${backendUrl()}/api/hifz/check`, {
      method: "POST",
      body: upstream,
      cache: "no-store",
      signal: AbortSignal.timeout(600_000),
    });
    if (!res.ok) return NextResponse.json({ error: "failed" }, { status: 502 });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
