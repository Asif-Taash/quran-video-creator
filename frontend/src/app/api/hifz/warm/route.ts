import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Gets the Quran ear loaded before a recitation starts (backend /api/hifz/warm):
// the page asks when the reader opens «سمّع».
// POST  ->  { ok }

function backendUrl(): string {
  return process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:8000";
}

export async function POST() {
  try {
    const res = await fetch(`${backendUrl()}/api/hifz/warm`, { method: "POST", cache: "no-store", signal: AbortSignal.timeout(10_000) });
    return NextResponse.json({ ok: res.ok });
  } catch {
    return NextResponse.json({ ok: false });
  }
}
