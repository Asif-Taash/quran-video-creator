// Shared by /api/auth/me and /api/auth/profile -- a stored avatarPath is
// relative to /public (e.g. "avatars/<id>-<ts>.png"), served through the
// same /api/serve-audio convention every other uploaded asset in this app
// already uses, rather than a raw public/ URL.
export function avatarUrl(avatarPath: string | null): string | null {
  return avatarPath ? `/api/serve-audio?file=${avatarPath}` : null;
}
