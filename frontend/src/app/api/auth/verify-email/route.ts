import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/auth/tokens";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const token = typeof body?.token === "string" ? body.token : "";

  if (!token) {
    return NextResponse.json({ error: "token_required" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { emailVerifyTokenHash: hashToken(token) } });
  if (!user || !user.emailVerifyExpiresAt || user.emailVerifyExpiresAt < new Date()) {
    return NextResponse.json({ error: "invalid_or_expired_token" }, { status: 400 });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerifiedAt: new Date(),
      emailVerifyTokenHash: null,
      emailVerifyExpiresAt: null,
    },
  });

  return NextResponse.json({ success: true });
}
