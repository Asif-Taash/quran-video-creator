import { NextResponse } from "next/server";
import { hifzAvailable, hifzPages, hifzRange, hifzSessionEnd } from "@/lib/hifzData";
import quranData from "@/data/quran.json";

export const runtime = "nodejs";

// The words of the ayahs the memorization page shows (lib/hifzData.ts).
// GET ?surah=&from=&to=  ->  { verses: [{ s, n, words: [{ g, u, t, p, l }], end }], lines: { "page:line": size } }
// &pages=1: the whole mushaf pages those ayahs are on (+ pages: [numbers]).
// &session=N: a recitation from ayah N on -- `to` reaches as far as one
// recitation may go (the surah's end, or SESSION_WORDS words), returned as sessionEnd.

const surahs = quranData as { id: number; total_verses: number }[];
// One live recitation's words (the check takes up to 1500): about eight pages.
const SESSION_WORDS = 1400;

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const surah = Number(params.get("surah"));
  const from = Number(params.get("from"));
  let to = Number(params.get("to"));
  const session = params.get("session") ? Number(params.get("session")) : null;
  const info = surahs.find((s) => s.id === surah);
  if (!info || !Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > info.total_verses) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  if (!hifzAvailable()) {
    // scripts/build-hifz-words.mjs hasn't been run on this computer.
    return NextResponse.json({ error: "data" }, { status: 503 });
  }
  if (session !== null) {
    if (!Number.isInteger(session) || session < 1 || session > info.total_verses) return NextResponse.json({ error: "invalid" }, { status: 400 });
    const sessionEnd = hifzSessionEnd(surah, session, SESSION_WORDS);
    to = Math.max(to, sessionEnd);
    return NextResponse.json({ ...hifzPages(surah, Math.min(from, session), to), sessionEnd });
  }
  if (params.get("pages") === "1") return NextResponse.json(hifzPages(surah, from, to));
  return NextResponse.json(hifzRange(surah, from, to));
}
