import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateRawToken, hashToken, RESET_TOKEN_TTL_MS, DEV_MODE_NO_EMAIL } from "@/lib/auth/tokens";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";

  if (!email) {
    return NextResponse.json({ error: "email_required" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { email } });

  // Always respond the same shape whether or not the email is registered
  // -- otherwise the response itself would leak which emails have
  // accounts. devResetUrl is only ever present when a user actually
  // exists (see DEV_MODE_NO_EMAIL's own note: this is a placeholder for
  // real email delivery, not how a production response should look).
  if (!user) {
    return NextResponse.json({ success: true, devResetUrl: null });
  }

  const rawToken = generateRawToken();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordResetTokenHash: hashToken(rawToken),
      passwordResetExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    },
  });

  const devResetUrl = DEV_MODE_NO_EMAIL ? `/reset-password?token=${rawToken}` : null;
  // TODO once real email sending exists: send rawToken via email here
  // instead of returning it, and drop devResetUrl from the response.

  return NextResponse.json({ success: true, devResetUrl });
}
