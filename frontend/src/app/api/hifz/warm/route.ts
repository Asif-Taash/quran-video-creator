import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Gets the Quran ear loaded before a recitation starts (backend /api/hifz/warm):
// the page asks when the reader opens «سمّع».
// POST  ->  { ok }

function backendUrl(): string {
  return process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:8000";
}

export async function POST(req: Request) {
  const p = new URL(req.url).searchParams;
  const surah = Number(p.get("surah")) || 0;
  const start = Number(p.get("start")) || 1;
  const q = surah >= 1 && surah <= 114 ? `?surah=${surah}&start=${Math.max(1, Math.min(start, 286))}` : "";
  try {
    const res = await fetch(`${backendUrl()}/api/hifz/warm${q}`, { method: "POST", cache: "no-store", signal: AbortSignal.timeout(10_000) });
    return NextResponse.json({ ok: res.ok });
  } catch {
    return NextResponse.json({ ok: false });
  }
}
