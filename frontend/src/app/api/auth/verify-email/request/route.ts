import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth/session";
import { generateRawToken, hashToken, VERIFY_TOKEN_TTL_MS, DEV_MODE_NO_EMAIL } from "@/lib/auth/tokens";

// Issues (or re-issues) an email-verification link for the logged-in user.
// Called both right after signup and from a "resend" button on the account
// page for anyone still unverified.
export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({ where: { id: session.id } });
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  if (user.emailVerifiedAt) {
    return NextResponse.json({ success: true, alreadyVerified: true, devVerifyUrl: null });
  }

  const rawToken = generateRawToken();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerifyTokenHash: hashToken(rawToken),
      emailVerifyExpiresAt: new Date(Date.now() + VERIFY_TOKEN_TTL_MS),
    },
  });

  const devVerifyUrl = DEV_MODE_NO_EMAIL ? `/verify-email?token=${rawToken}` : null;
  // TODO once real email sending exists: email rawToken instead of
  // returning it, and drop devVerifyUrl from the response.

  return NextResponse.json({ success: true, alreadyVerified: false, devVerifyUrl });
}
