import { NextResponse } from "next/server";
import fs from "fs/promises";
import { DRAFT_ID, cloneDraft, draftJsonPath, draftSignature, findDrafts, readDraft } from "@/lib/draftStore";
import { lowDiskError } from "@/lib/diskSpace";

export const runtime = "nodejs";

// Called by every export, just before rendering: keeps a copy of the
// project exactly as it is exported, listed in "مشاريعي" as an exported
// video. The project itself stays a working copy the user goes on editing;
// before this, changing its audio after an export (which resets the split
// and trim) lost the exported version for good (Nuh 28, 2026-11-08).
// Exporting the same thing again reuses the last copy instead of adding
// another one.
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const { id } = params;
  if (!DRAFT_ID.test(id)) {
    return NextResponse.json({ error: "Invalid draft id" }, { status: 400 });
  }
  const body = (await req.json().catch(() => ({}))) as { exportName?: unknown };
  const exportName = typeof body.exportName === "string" ? body.exportName.slice(0, 200) : null;

  try {
    const source = await readDraft(id);
    if (!source) return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    if (source.exportedAt) {
      return NextResponse.json({ error: "Already an exported copy" }, { status: 400 });
    }
    const now = new Date().toISOString();

    const latest = (await findDrafts((d) => d.exportedFrom === id))
      .sort((a, b) => String(b.exportedAt).localeCompare(String(a.exportedAt)))[0];
    if (latest && (await draftSignature(String(latest.id), latest)) === (await draftSignature(id, source))) {
      const refreshed = { ...latest, updatedAt: now, exportedAt: now, ...(exportName ? { exportName } : {}) };
      await fs.writeFile(draftJsonPath(String(latest.id)), JSON.stringify(refreshed, null, 2));
      return NextResponse.json({ snapshotId: latest.id, reused: true });
    }

    // The copy itself takes next to no space (its files are shared with the
    // project, see cloneDraft), but nothing is added to a full disk.
    const lowDisk = await lowDiskError();
    if (lowDisk) return NextResponse.json({ error: lowDisk }, { status: 507 });

    const snapshotId = await cloneDraft(id, (copy) => ({
      ...copy,
      updatedAt: now,
      exportedFrom: id,
      exportedAt: now,
      exportName,
    }));
    if (!snapshotId) return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    return NextResponse.json({ snapshotId, reused: false });
  } catch (error) {
    console.error("[Drafts] Failed to keep the exported copy:", error);
    return NextResponse.json({ error: "Failed to keep the exported copy" }, { status: 500 });
  }
}
