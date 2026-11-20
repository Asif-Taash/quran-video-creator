import { NextResponse } from "next/server";
import { rememberShown } from "@/lib/shownBackgrounds";

export const runtime = "nodejs";

const KEY = /^(pixabay|pexels)-(photo|video)-\d{1,15}$/;

// Results the picker loaded ahead (search ?ahead=1) and the user has now
// actually had on screen: recorded as shown like any search's results.
// Body: { keys: string[] }.
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const keys: string[] = Array.isArray(body?.keys)
    ? body.keys.filter((k: unknown): k is string => typeof k === "string" && KEY.test(k)).slice(0, 300)
    : [];
  await rememberShown(keys);
  return NextResponse.json({ ok: true, count: keys.length });
}
