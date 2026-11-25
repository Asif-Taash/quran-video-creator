import { NextResponse } from "next/server";
import { markAyahs, readProgress, recordReview } from "@/lib/hifzProgress";
import type { AyahResult } from "@/lib/hifzSchedule";
import quranData from "@/data/quran.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Memorization progress (lib/hifzProgress.ts).
// GET  -> HifzProgress
// POST { action: "review", surah, today, results: AyahResult[] }
//      { action: "mark", surah, from, to, state: "known" | "forget", today }
//   -> HifzProgress (after the change)
// `today` is the viewer's own calendar day (YYYY-MM-DD): reviews fall due by
// their clock, not the server's.

const surahs = quranData as { id: number; total_verses: number }[];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const count = (n: unknown, max: number) => (Number.isInteger(n) && (n as number) >= 0 && (n as number) <= max ? (n as number) : null);

export async function GET() {
  return NextResponse.json(await readProgress());
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const info = surahs.find((s) => s.id === Number(body?.surah));
  if (!body || !info || typeof body.today !== "string" || !DAY.test(body.today)) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  if (body.action === "review" && Array.isArray(body.results) && body.results.length <= info.total_verses) {
    const results: AyahResult[] = [];
    for (const r of body.results) {
      const ayah = count(r?.ayah, info.total_verses);
      const total = count(r?.total, 200);
      const ok = count(r?.ok, 200);
      const wrong = count(r?.wrong, 200);
      const missing = count(r?.missing, 200);
      const added = count(r?.added, 200);
      if (!ayah || !total || ok === null || wrong === null || missing === null || added === null || !Array.isArray(r.weak)) {
        return NextResponse.json({ error: "invalid" }, { status: 400 });
      }
      const weak = (r.weak as unknown[]).filter((i): i is number => count(i, 200) !== null).slice(0, 200);
      results.push({ ayah, total, ok, wrong, missing, added, weak });
    }
    return NextResponse.json(await recordReview(info.id, results, body.today));
  }
  if (body.action === "mark" && (body.state === "known" || body.state === "forget")) {
    const from = count(body.from, info.total_verses);
    const to = count(body.to, info.total_verses);
    if (!from || !to || to < from) return NextResponse.json({ error: "invalid" }, { status: 400 });
    return NextResponse.json(await markAyahs(info.id, from, to, body.state, body.today));
  }
  return NextResponse.json({ error: "invalid" }, { status: 400 });
}
