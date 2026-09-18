import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import type { AspectRatio } from "@/remotion/types";

// Manifest entries live under src/data/gallery (one JSON file per video,
// same pattern as src/data/drafts) and the actual mp4 copies live under
// public/render-assets/gallery -- the PERSISTENT render_assets docker
// volume, deliberately NOT the ephemeral public/renders tmpfs that
// render/route.ts writes the per-request file to (that one is wiped on
// container restart and gets overwritten on every re-render of the same
// verse range). This is a separate, deliberately-kept copy.
const GALLERY_MANIFEST_DIR = path.join(process.cwd(), "src", "data", "gallery");
const GALLERY_ASSETS_DIR = path.join(process.cwd(), "public", "render-assets", "gallery");

// Hard cap on how many finished videos the gallery keeps -- the oldest
// entries (file + manifest) are deleted automatically once a save would
// push the count past this. Without a cap, a shared/self-hosted instance
// used by many people would grow this persistent folder without bound.
const MAX_GALLERY_ENTRIES = 20;

export type GalleryEntry = {
  id: string;
  userId: string;
  createdAt: string;
  // Last time this entry's mp4 was actually (re-)written -- equal to
  // createdAt for an entry that's only ever been rendered once, and for any
  // entry saved before this field existed (GalleryGrid.tsx only shows an
  // "updated" line when this differs from createdAt, so an absent/equal
  // value silently just shows nothing extra rather than a wrong date).
  updatedAt?: string;
  surahNameArabic: string;
  surahNameTransliteration: string;
  startVerse: number;
  endVerse: number;
  reciterName: string;
  // Latin-script reciter name (see reciterNames.ts) -- undefined on any
  // entry saved before this field existed, so GalleryGrid.tsx falls back to
  // reciterName (Arabic) for those regardless of the selected language.
  reciterNameLatin?: string;
  aspectRatio: AspectRatio;
  sizeBytes: number;
  // The draft this video was rendered from (see VideoCreatorForm's
  // buildRenderFormData/executeVideoRender) -- lets GalleryGrid.tsx's Edit
  // button send the user back to "/" with this exact project restored
  // (surah, verses, background, audio, timing, fonts, everything the draft
  // system already knows how to resume). Undefined for any video rendered
  // before this field existed, or if the autosave that should have
  // produced it failed -- Edit is simply hidden for those.
  draftId?: string;
};

type GalleryMeta = Omit<GalleryEntry, "id" | "createdAt" | "sizeBytes">;

function isSafeId(id: string) {
  return /^[a-zA-Z0-9-]+$/.test(id);
}

async function readAllEntries(): Promise<GalleryEntry[]> {
  try {
    const files = await fs.readdir(GALLERY_MANIFEST_DIR);
    const entries = await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map(async (f) => {
          try {
            const raw = await fs.readFile(path.join(GALLERY_MANIFEST_DIR, f), "utf8");
            return JSON.parse(raw) as GalleryEntry;
          } catch {
            return null;
          }
        })
    );
    return entries.filter((e): e is GalleryEntry => e !== null);
  } catch {
    // Gallery dir doesn't exist yet -- nothing saved so far.
    return [];
  }
}

export async function listGalleryEntries(userId: string): Promise<GalleryEntry[]> {
  const entries = await readAllEntries();
  return entries
    .filter((e) => e.userId === userId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

async function deleteGalleryFiles(id: string) {
  await Promise.all([
    fs.unlink(path.join(GALLERY_MANIFEST_DIR, `${id}.json`)).catch(() => {}),
    fs.unlink(path.join(GALLERY_ASSETS_DIR, `${id}.mp4`)).catch(() => {}),
  ]);
}

export async function deleteGalleryEntry(id: string, userId: string): Promise<boolean> {
  if (!isSafeId(id)) return false;
  const entries = await readAllEntries();
  const entry = entries.find((e) => e.id === id);
  if (!entry || entry.userId !== userId) return false;
  await deleteGalleryFiles(id);
  return true;
}

// Removes every gallery entry (manifest + mp4) belonging to a user. Called
// on account deletion -- best-effort: failures are logged, never thrown, so
// the user's DB row can still be removed even if file cleanup hiccups.
export async function deleteUserGallery(userId: string): Promise<void> {
  const entries = await listGalleryEntries(userId);
  await Promise.all(entries.map((e) => deleteGalleryFiles(e.id)));
}

async function pruneOldEntries(userId: string) {
  const entries = await listGalleryEntries(userId);
  if (entries.length <= MAX_GALLERY_ENTRIES) return;
  const toRemove = entries.slice(MAX_GALLERY_ENTRIES);
  await Promise.all(toRemove.map((e) => deleteGalleryFiles(e.id)));
}

// Looks up the one gallery entry (if any) that a given draft has already
// produced, for the SAME user -- lets saveToGallery below update that video
// in place on every subsequent render of the same project instead of piling
// up a fresh copy each time. userId is checked too (not just draftId) so one
// user's draft id can never collide with -- or overwrite -- another user's
// entry.
async function findEntryByDraftId(userId: string, draftId: string): Promise<GalleryEntry | null> {
  const entries = await readAllEntries();
  return entries.find((e) => e.userId === userId && e.draftId === draftId) ?? null;
}

// Copies an already-rendered mp4 into the persistent gallery location and
// records its metadata. Called every time renderMedia() succeeds in
// render/route.ts -- both the user-initiated "download" render AND the
// debounced auto-save render VideoCreatorForm.tsx fires in the background as
// the project is edited -- so failures here are non-fatal to the actual
// render/download the user may be waiting on (caller is expected to
// catch/log, not throw the user's request into an error state over a
// gallery-save hiccup).
//
// When meta.draftId matches an entry this user already has (i.e. this same
// project was rendered before, whether from scratch or resumed via
// GalleryGrid.tsx's Edit button), that SAME entry is updated in place -- its
// mp4 overwritten, its id/createdAt kept -- rather than a new entry being
// created next to it. A brand new project (no existing entry for this
// draftId, or no draftId at all -- draftId is only ever absent for a render
// requested before autosaveDraft existed) still gets a fresh id as before.
export async function saveToGallery(sourceFilePath: string, meta: GalleryMeta): Promise<GalleryEntry> {
  await fs.mkdir(GALLERY_MANIFEST_DIR, { recursive: true });
  await fs.mkdir(GALLERY_ASSETS_DIR, { recursive: true });

  const existing = meta.draftId ? await findEntryByDraftId(meta.userId, meta.draftId) : null;
  const id = existing?.id ?? crypto.randomUUID();
  const now = new Date().toISOString();

  const destPath = path.join(GALLERY_ASSETS_DIR, `${id}.mp4`);
  await fs.copyFile(sourceFilePath, destPath);
  const stat = await fs.stat(destPath);

  const entry: GalleryEntry = {
    ...meta,
    id,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    sizeBytes: stat.size,
  };

  await fs.writeFile(path.join(GALLERY_MANIFEST_DIR, `${id}.json`), JSON.stringify(entry, null, 2));

  // Only a genuinely new entry can push the user over the cap -- updating an
  // existing one in place never changes how many entries they have.
  if (!existing) {
    await pruneOldEntries(meta.userId);
  }

  return entry;
}
