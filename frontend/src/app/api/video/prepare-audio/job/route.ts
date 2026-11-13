import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Proxies the backend's per-extraction progress (GET) and cancel (DELETE)
// for VideoCreatorForm's handlePrepareAudio -- see
// backend/scripts/job_control.py. ?jobId= is the id the client sent along
// with its /api/video/prepare-audio request.
const JOB_ID = /^[A-Za-z0-9-]{8,64}$/;

function backendJobUrl(req: Request, action: "status" | "cancel"): string | null {
  const jobId = new URL(req.url).searchParams.get("jobId");
  if (!jobId || !JOB_ID.test(jobId)) return null;
  const baseUrl = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:8000";
  return `${baseUrl}/api/extraction/${action}/${jobId}`;
}

export async function GET(req: Request) {
  const url = backendJobUrl(req, "status");
  if (!url) return NextResponse.json({ error: "Invalid jobId" }, { status: 400 });
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    return NextResponse.json(res.ok ? await res.json() : { stage: null });
  } catch {
    // A missed poll just keeps the previous stage on screen.
    return NextResponse.json({ stage: null });
  }
}

export async function DELETE(req: Request) {
  const url = backendJobUrl(req, "cancel");
  if (!url) return NextResponse.json({ error: "Invalid jobId" }, { status: 400 });
  try {
    await fetch(url, { method: "POST", signal: AbortSignal.timeout(5000) });
  } catch {
    // Best effort: an uncancelled job only costs the backend some work.
  }
  return NextResponse.json({ success: true });
}
