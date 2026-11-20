import { NextResponse } from "next/server";
import { uthmaniAyahs } from "@/lib/uthmaniData";

export const runtime = "nodejs";

// The chosen ayahs in Uthmani script as readable text, for the post caption
// (lib/postCaption.ts).
// GET ?surah=&from=&to=  ->  { ayahs: [{ n, text }] }

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const surah = Number(params.get("surah"));
  const from = Number(params.get("from"));
  const to = Math.min(Number(params.get("to")), from + 300);
  if (!Number.isInteger(surah) || !Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const ayahs = uthmaniAyahs(surah, from, to);
  if (ayahs.length === 0) return NextResponse.json({ error: "invalid" }, { status: 400 });
  return NextResponse.json({ ayahs });
}
