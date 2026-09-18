import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { signSessionToken, sessionCookieOptions, SESSION_COOKIE } from "@/lib/auth/session";
import { generateRawToken, hashToken, VERIFY_TOKEN_TTL_MS, DEV_MODE_NO_EMAIL } from "@/lib/auth/tokens";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json({ error: "weak_password" }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: "email_taken" }, { status: 409 });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  // Every new account starts unverified (emailVerifiedAt defaults to
  // null) -- issue its first verification token right away so there's
  // something to act on immediately, same as calling
  // /api/auth/verify-email/request manually later would produce.
  const rawVerifyToken = generateRawToken();
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      emailVerifyTokenHash: hashToken(rawVerifyToken),
      emailVerifyExpiresAt: new Date(Date.now() + VERIFY_TOKEN_TTL_MS),
    },
  });

  const token = await signSessionToken({ id: user.id, email: user.email });
  const devVerifyUrl = DEV_MODE_NO_EMAIL ? `/verify-email?token=${rawVerifyToken}` : null;
  // TODO once real email sending exists: email rawVerifyToken instead of
  // returning it, and drop devVerifyUrl from the response.
  const res = NextResponse.json({ email: user.email, devVerifyUrl });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
}
