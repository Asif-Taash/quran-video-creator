import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { getSession, SESSION_COOKIE } from "@/lib/auth/session";
import { deleteUserGallery } from "@/lib/videoGallery";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";
  const verifyOnly = body?.verifyOnly === true;

  if (!password) {
    return NextResponse.json({ error: "password_required" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { id: session.id } });
  if (!user) {
    // Account is already gone -- treat as authenticated, clear the cookie.
    const res = NextResponse.json({ success: true });
    res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  }

  const matches = await bcrypt.compare(password, user.passwordHash);
  if (!matches) {
    return NextResponse.json({ error: "invalid_password" }, { status: 403 });
  }

  // Verification-only call (used to gate the final confirmation step in the
  // UI) -- password checks out, nothing is deleted.
  if (verifyOnly) {
    return NextResponse.json({ success: true });
  }

  try {
    await deleteUserGallery(user.id);
  } catch (err) {
    console.error("[auth/delete] Failed to clean up gallery:", err);
  }

  try {
    await prisma.user.delete({ where: { id: user.id } });
  } catch (err) {
    console.error("[auth/delete] Failed to delete user:", err);
    return NextResponse.json({ error: "delete_failed" }, { status: 500 });
  }

  const res = NextResponse.json({ success: true });
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
