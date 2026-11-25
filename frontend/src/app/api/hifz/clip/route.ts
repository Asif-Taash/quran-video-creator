export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The cut a listen-and-repeat plays (api/hifz/prepare), from the backend's
// extracted clips. The page fetches it whole and plays it from memory, so
// seeking from ayah to ayah never waits on the network.
const NAME = /^[A-Za-z0-9_.-]{1,160}\.mp3$/;

function backendUrl(): string {
  return process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:8000";
}

export async function GET(req: Request) {
  const name = new URL(req.url).searchParams.get("f") ?? "";
  if (!NAME.test(name) || name.includes("..")) return new Response("invalid", { status: 400 });
  const res = await fetch(`${backendUrl()}/api/extraction/download/${encodeURIComponent(name)}`, { cache: "no-store" }).catch(() => null);
  if (!res?.ok || !res.body) return new Response("not found", { status: 404 });
  return new Response(res.body, {
    headers: { "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=3600" },
  });
}
