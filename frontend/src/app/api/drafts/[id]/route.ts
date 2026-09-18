import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

export const runtime = "nodejs";

const DRAFTS_DIR = path.join(process.cwd(), "src", "data", "drafts");
const DRAFT_ASSETS_DIR = path.join(process.cwd(), "public", "render-assets", "drafts");

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Draft ids are always our own crypto.randomUUID() output -- reject
  // anything else outright rather than letting a path-traversal-shaped id
  // reach the filesystem join below.
  if (!/^[a-f0-9-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "Invalid draft id" }, { status: 400 });
  }

  try {
    const raw = await fs.readFile(path.join(DRAFTS_DIR, `${id}.json`), "utf8");
    return NextResponse.json(JSON.parse(raw));
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }
    console.error("[Drafts] Failed to load draft:", error);
    return NextResponse.json({ error: "Failed to load draft" }, { status: 500 });
  }
}

// Called by the "Start Over" button (VideoCreatorForm.handleStartOver) --
// drafts have no automatic expiry, so explicitly deleting one when the user
// abandons it is the only thing keeping src/data/drafts and
// public/render-assets/drafts from growing forever.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!/^[a-f0-9-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "Invalid draft id" }, { status: 400 });
  }

  try {
    await fs.unlink(path.join(DRAFTS_DIR, `${id}.json`)).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
    await fs.rm(path.join(DRAFT_ASSETS_DIR, id), { recursive: true, force: true });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Drafts] Failed to delete draft:", error);
    return NextResponse.json({ error: "Failed to delete draft" }, { status: 500 });
  }
}
