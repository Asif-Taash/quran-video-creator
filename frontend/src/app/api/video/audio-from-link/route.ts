import { NextResponse } from "next/server";
import axios from "axios";
import { toWebStream } from "@/lib/fileResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A little over the backend's own limit (DOWNLOAD_TIMEOUT_SEC in
// backend/scripts/link_audio.py), which may install its tools and try twice.
const TIMEOUT_MS = 45 * 60 * 1000;

// Hands the client the audio of a video link as one file it turns into its
// own File, so everything after this works like a file the user picked.
export async function POST(req: Request) {
  let url: unknown;
  try {
    ({ url } = await req.json());
  } catch {
    return NextResponse.json({ code: "unsupported" }, { status: 400 });
  }
  if (typeof url !== "string") {
    return NextResponse.json({ code: "unsupported" }, { status: 400 });
  }

  const baseUrl = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:8000";
  try {
    const res = await axios.post(`${baseUrl}/api/extraction/from-link`, { url }, {
      timeout: TIMEOUT_MS,
      responseType: "stream",
      validateStatus: () => true,
      // Without this a cancelled request leaves the backend blocked on sending
      // a file nobody reads: its temp folder stays, and the request counts as
      // running, which stops the worker from giving its memory back when idle.
      signal: req.signal,
    });

    if (res.status === 200) {
      return new Response(toWebStream(res.data), {
        headers: {
          "Content-Type": "audio/mp4",
          "X-Audio-Title": String(res.headers["x-audio-title"] ?? "audio"),
        },
      });
    }

    const chunks: Buffer[] = [];
    for await (const chunk of res.data) chunks.push(chunk);
    let code = "failed";
    try {
      const detail = JSON.parse(Buffer.concat(chunks).toString()).detail;
      if (res.status === 422 && typeof detail === "string") code = detail;
    } catch {
      // Not the backend's own answer: stays "failed".
    }
    return NextResponse.json({ code }, { status: res.status === 422 ? 422 : 502 });
  } catch (error) {
    if (!req.signal.aborted) console.error("[Audio From Link] Error:", error);
    return NextResponse.json({ code: "failed" }, { status: 502 });
  }
}
