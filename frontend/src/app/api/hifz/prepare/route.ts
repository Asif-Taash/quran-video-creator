import { NextResponse } from "next/server";
import { getReciter, reciterHasSurah } from "@/lib/reciterNames";
import { hifzExpected } from "@/lib/hifzData";
import quranData from "@/data/quran.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Listen and repeat (the memorization page): the chosen ayahs cut from the
// reciter's recording by the same aligner as the video
// (backend /api/extraction/, scripts/quran_aligner.py), with where each
// ayah starts and ends in the cut. mp3quran's own ayah timing isn't used:
// it is seconds off for many reciters (2026-11-21: Raad Al-Kurdi's Al-Fatiha
// ends at 41.7 s by it and at 45.0 s in the file), so an ayah ran into the
// next one's first words. The backend keeps each cut (30 days), so the same
// ayahs are ready at once the next time.
// POST { reciter, surah, from, to, jobId? }  ->  { audio, ayahs: { "<n>": [start, end] }, words: { "<n>": [[start, end], ...] } } (seconds in the cut)
// jobId: poll /api/video/prepare-audio/job?jobId= for progress, DELETE there to cancel.

const surahs = quranData as { id: number; total_verses: number }[];
const JOB_ID = /^[A-Za-z0-9-]{8,64}$/;
// About eight mushaf pages, as the recitation check.
const MAX_WORDS = 1500;
const LETTER = /[\u0621-\u064A\u0671]/;

function backendUrl(): string {
  return process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:8000";
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const reciter = getReciter(String(body?.reciter ?? ""));
  const surah = Number(body?.surah);
  const from = Number(body?.from);
  const to = Number(body?.to);
  const info = surahs.find((s) => s.id === surah);
  if (!reciter || !info || !Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > info.total_verses) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  if (!reciterHasSurah(reciter, surah)) return NextResponse.json({ error: "surah" }, { status: 404 });
  if (hifzExpected(surah, from, to).length > MAX_WORDS) return NextResponse.json({ error: "too_long" }, { status: 413 });
  const jobId = typeof body?.jobId === "string" && JOB_ID.test(body.jobId) ? body.jobId : undefined;

  try {
    const res = await fetch(`${backendUrl()}/api/extraction/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ surah, start: from, end: to, reciter: reciter.backendKey, pad_seconds: 0, job_id: jobId }),
      cache: "no-store",
      signal: AbortSignal.timeout(15 * 60_000),
    });
    if (res.status === 409) return NextResponse.json({ error: "cancelled" }, { status: 409 });
    if (!res.ok) return NextResponse.json({ error: "failed" }, { status: 502 });
    const made = (await res.json()) as { mp3_filename: string; json_filename: string };
    const timing = await fetch(`${backendUrl()}/api/extraction/download/${encodeURIComponent(made.json_filename)}`, { cache: "no-store" });
    if (!timing.ok) return NextResponse.json({ error: "failed" }, { status: 502 });
    const data = (await timing.json()) as { verses?: Record<string, { words?: { w?: string; start: number; end: number }[] }> };
    const ayahs: Record<string, [number, number]> = {};
    // Each word's time, for following the reciter word by word on the page:
    // the aligner lists a waqf mark (ۛ) as a word of its own, the page
    // doesn't. Left out when the counts still differ.
    const words: Record<string, [number, number][]> = {};
    for (const [n, v] of Object.entries(data.verses ?? {})) {
      const all = v.words ?? [];
      if (!all.length) continue;
      ayahs[n] = [Math.min(...all.map((w) => w.start)) / 1000, Math.max(...all.map((w) => w.end)) / 1000];
      const real = all.filter((w) => !w.w || LETTER.test(w.w));
      const shown = Number(n) >= from && Number(n) <= to ? hifzExpected(surah, Number(n), Number(n)).length : -1;
      if (real.length === shown) words[n] = real.map((w) => [w.start / 1000, w.end / 1000]);
    }
    return NextResponse.json({ audio: `/api/hifz/clip?f=${encodeURIComponent(made.mp3_filename)}`, ayahs, words });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
