import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth/session";
import { avatarUrl } from "@/lib/auth/avatar";

const MAX_NAME_LENGTH = 60;
const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_AVATAR_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

// Deletes the previous avatar file (if any) before writing a new one, or
// when the user removes their avatar -- otherwise every re-upload/removal
// leaves an orphaned file behind under public/avatars forever, since
// avatarPath always points at exactly one file at a time.
async function deleteAvatarFile(avatarPath: string | null) {
  if (!avatarPath) return;
  try {
    await fs.unlink(path.join(process.cwd(), "public", avatarPath));
  } catch {
    // Already gone, or never existed on disk -- fine either way.
  }
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({ where: { id: session.id } });
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }

  const formData = await req.formData();
  const data: { name?: string | null; avatarPath?: string | null } = {};

  // Name: present (even empty, to clear it) means "update this field" --
  // absent means "leave it alone" (e.g. an avatar-only request).
  if (formData.has("name")) {
    const rawName = String(formData.get("name") ?? "").trim();
    if (rawName.length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: "name_too_long" }, { status: 400 });
    }
    data.name = rawName.length > 0 ? rawName : null;
  }

  const removeAvatar = formData.get("removeAvatar") === "true";
  const avatarFile = formData.get("avatar");

  if (removeAvatar) {
    await deleteAvatarFile(user.avatarPath);
    data.avatarPath = null;
  } else if (avatarFile instanceof File && avatarFile.size > 0) {
    if (avatarFile.size > MAX_AVATAR_BYTES) {
      return NextResponse.json({ error: "avatar_too_large" }, { status: 400 });
    }
    const extension = path.extname(avatarFile.name).toLowerCase();
    if (!ALLOWED_AVATAR_EXTENSIONS.has(extension)) {
      return NextResponse.json({ error: "avatar_invalid_type" }, { status: 400 });
    }

    const uploadsDir = path.join(process.cwd(), "public", "avatars");
    await fs.mkdir(uploadsDir, { recursive: true });
    const filename = `${user.id}-${Date.now()}${extension}`;
    const buffer = Buffer.from(await avatarFile.arrayBuffer());
    await fs.writeFile(path.join(uploadsDir, filename), buffer);

    await deleteAvatarFile(user.avatarPath);
    data.avatarPath = `avatars/${filename}`;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });
  }

  const updated = await prisma.user.update({ where: { id: user.id }, data });

  return NextResponse.json({
    email: updated.email,
    name: updated.name,
    avatarUrl: avatarUrl(updated.avatarPath),
  });
}
