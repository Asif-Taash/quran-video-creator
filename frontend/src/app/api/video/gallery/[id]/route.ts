import { NextResponse } from "next/server";
import { deleteGalleryEntry } from "@/lib/videoGallery";
import { getSession } from "@/lib/auth/session";

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }

  const deleted = await deleteGalleryEntry(params.id, session.id);
  if (!deleted) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  return NextResponse.json({ success: true });
}
