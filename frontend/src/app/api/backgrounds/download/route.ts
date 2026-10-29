import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { resolveDownloadUrl, type StockMediaType, type StockProvider } from "@/lib/stockBackgrounds";
import { stripAudioInPlace } from "@/lib/silentVideo";
import { checkVideoFile } from "@/lib/natureCheck";

// Picked videos whose every checked frame passed (see checkVideoFile) --
// a repeat pick of the same one doesn't re-run the check.
const verifiedVideos = new Set<string>();

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Wiped on every container start (docker-compose.yml) -- a picked file is
// only needed until the client has turned it into its own File, after which
// drafts/renders keep their own copies.
const STOCK_DIR = path.join(process.cwd(), "public", "render-assets", "stock-bg");
const MAX_BYTES: Record<StockMediaType, number> = { photo: 30 * 1024 * 1024, video: 150 * 1024 * 1024 };

function extensionFor(type: StockMediaType, contentType: string): string {
  if (type === "video") return ".mp4";
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  return ".jpg";
}

export async function POST(req: Request) {
  let body: { provider?: string; type?: string; id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const provider = body.provider as StockProvider;
  const type = body.type as StockMediaType;
  const id = String(body.id ?? "");
  if (!["pexels", "pixabay"].includes(provider) || !["photo", "video"].includes(type) || !/^\d+$/.test(id)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  try {
    await fs.mkdir(STOCK_DIR, { recursive: true });
    const key = `${provider}-${type}-${id}`;
    const existing = (await fs.readdir(STOCK_DIR)).find((f) => f.startsWith(`${key}.`));
    if (existing && (type !== "video" || verifiedVideos.has(key))) {
      return NextResponse.json({ url: `/api/serve-audio?file=render-assets/stock-bg/${existing}`, type });
    }

    const fileUrl = await resolveDownloadUrl(provider, type, id);
    const res = await fetch(fileUrl, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`Download failed with HTTP ${res.status}`);
    const contentType = res.headers.get("content-type") || "";
    const expectedPrefix = type === "photo" ? "image/" : "video/";
    if (!contentType.startsWith(expectedPrefix)) throw new Error(`Unexpected content type ${contentType}`);
    const declaredSize = Number(res.headers.get("content-length")) || 0;
    if (declaredSize > MAX_BYTES[type]) throw new Error("File is too large");

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_BYTES[type]) throw new Error("File is too large");

    const filename = `${provider}-${type}-${id}${extensionFor(type, contentType)}`;
    // Written under a temp name first so a half-written file is never
    // picked up by the reuse check above (which matches on the
    // "provider-type-id." prefix -- the temp name doesn't start with it).
    const tempPath = path.join(STOCK_DIR, `.tmp-${process.pid}-${Date.now()}-${filename}`);
    await fs.writeFile(tempPath, buffer);
    if (type === "video") {
      try {
        await stripAudioInPlace(tempPath);
      } catch (err) {
        await fs.unlink(tempPath).catch(() => undefined);
        throw err;
      }
    }
    // A video's thumbnail is one frame; people or buildings may still appear
    // later in it. Checked across the whole file before it's ever applied.
    if (type === "video") {
      let natural: boolean;
      try {
        natural = await checkVideoFile(tempPath, key);
      } catch (err) {
        await fs.unlink(tempPath).catch(() => undefined);
        throw err;
      }
      if (!natural) {
        await fs.unlink(tempPath).catch(() => undefined);
        return NextResponse.json({ error: "notNature" }, { status: 422 });
      }
      verifiedVideos.add(key);
    }
    await fs.rename(tempPath, path.join(STOCK_DIR, filename));

    return NextResponse.json({ url: `/api/serve-audio?file=render-assets/stock-bg/${filename}`, type });
  } catch (error) {
    console.error("[Backgrounds] Download failed:", error);
    return NextResponse.json({ error: "Could not download this background. Please try another one." }, { status: 502 });
  }
}
