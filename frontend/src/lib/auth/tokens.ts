import crypto from "crypto";

// Shared by the password-reset and email-verification flows. The RAW token
// is what ever gets shown to the user (displayed directly for now -- see
// DEV_MODE_NO_EMAIL below -- or emailed once real delivery exists); only
// its hash is ever stored, so a leaked/dumped DB row is never enough to
// use a still-valid link on its own.
export function generateRawToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

// How long a password-reset / email-verification link stays usable.
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
export const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// This project sends no real email yet (no SMTP/email-API credentials
// configured anywhere) -- until that's wired up, the forgot-password and
// verify-email routes hand the raw link straight back in their own JSON
// response instead of emailing it, and the pages that call them display it
// directly with an explicit "dev mode" label. This is NOT how it should
// behave once real email exists (anyone who can see the response, e.g. by
// watching network traffic, could take over any account by its email
// alone) -- swap this to `false` and wire an actual mailer into those two
// routes before this app has real, untrusted users.
export const DEV_MODE_NO_EMAIL = true;
