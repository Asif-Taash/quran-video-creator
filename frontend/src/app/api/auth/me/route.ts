import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth/session";
import { avatarUrl } from "@/lib/auth/avatar";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }

  // name/avatar can change after the session cookie was issued (see
  // /api/auth/profile), so read them fresh from the DB every time rather
  // than trusting anything baked into the JWT.
  const user = await prisma.user.findUnique({ where: { id: session.id } });
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }

  return NextResponse.json({
    email: user.email,
    name: user.name,
    avatarUrl: avatarUrl(user.avatarPath),
    emailVerified: Boolean(user.emailVerifiedAt),
  });
}
