import { NextResponse } from "next/server";
import { uthmaniAyahs } from "@/lib/uthmaniData";

export const runtime = "nodejs";

// Find ayahs by reciting them (components/video-creator/ReciteSearch.tsx):
// the recording goes to the backend (scripts/recite_search.py), which hears
// it and returns the closest places; each comes back with its first ayah's
// text to show.
// POST form { audio }  ->  { heard, basmala, results: [{ surah, from, to, score, text }] }

const MAX_BYTES = 25 * 1024 * 1024;

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
  upstream.append("audio", audio, "recitation");
  const res = await fetch(`${backendUrl()}/api/search/recitation`, {
    method: "POST",
    body: upstream,
    cache: "no-store",
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) return NextResponse.json({ error: "failed" }, { status: 502 });
  const data = await res.json();
  const results = (data.results ?? [])
    .map((r: { surah: number; from: number; to: number; score: number }) => {
      const first = uthmaniAyahs(r.surah, r.from, r.from)[0];
      return first ? { ...r, text: first.text } : null;
    })
    .filter(Boolean);
  return NextResponse.json({ heard: data.heard ?? "", basmala: Boolean(data.basmala), results });
}
