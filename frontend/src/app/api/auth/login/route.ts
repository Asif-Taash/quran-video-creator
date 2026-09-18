import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { signSessionToken, sessionCookieOptions, SESSION_COOKIE } from "@/lib/auth/session";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  // Same generic error for "no such user" and "wrong password" -- never
  // reveal to a caller whether an email address is registered.
  const invalid = () => NextResponse.json({ error: "invalid_credentials" }, { status: 401 });

  if (!email || !password) return invalid();

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return invalid();

  const matches = await bcrypt.compare(password, user.passwordHash);
  if (!matches) return invalid();

  const token = await signSessionToken({ id: user.id, email: user.email });
  const res = NextResponse.json({ email: user.email });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
}
