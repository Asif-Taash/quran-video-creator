import { NextResponse } from "next/server";
import { DRAFT_ID, EXPORT_FIELDS, cloneDraft } from "@/lib/draftStore";

export const runtime = "nodejs";

// Opening an exported video from "مشاريعي": the user works on a new
// project copied from it, so the exported copy itself never changes.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const { id } = params;
  if (!DRAFT_ID.test(id)) {
    return NextResponse.json({ error: "Invalid draft id" }, { status: 400 });
  }
  try {
    const draftId = await cloneDraft(id, (copy) => {
      const project: Record<string, unknown> = { ...copy, updatedAt: new Date().toISOString() };
      for (const key of EXPORT_FIELDS) delete project[key];
      return project;
    });
    if (!draftId) return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    return NextResponse.json({ draftId });
  } catch (error) {
    console.error("[Drafts] Failed to copy a draft:", error);
    return NextResponse.json({ error: "Failed to copy the project" }, { status: 500 });
  }
}
