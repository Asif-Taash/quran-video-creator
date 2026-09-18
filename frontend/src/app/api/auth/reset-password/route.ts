import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/auth/tokens";

const MIN_PASSWORD_LENGTH = 8;

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const token = typeof body?.token === "string" ? body.token : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!token) {
    return NextResponse.json({ error: "token_required" }, { status: 400 });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json({ error: "weak_password" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { passwordResetTokenHash: hashToken(token) } });
  if (!user || !user.passwordResetExpiresAt || user.passwordResetExpiresAt < new Date()) {
    return NextResponse.json({ error: "invalid_or_expired_token" }, { status: 400 });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      // One-time use -- clearing it here means a second attempt with the
      // same link (or a stale tab still showing it) fails cleanly instead
      // of silently resetting the password again.
      passwordResetTokenHash: null,
      passwordResetExpiresAt: null,
    },
  });

  return NextResponse.json({ success: true });
}
