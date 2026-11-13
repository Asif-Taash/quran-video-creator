// Server-only helpers for copying a saved project ("draft") with its files.
// Used by the export copy (api/drafts/[id]/snapshot) and by opening one
// (api/drafts/[id]/copy).
import crypto from "crypto";
import { createReadStream } from "fs";
import fs from "fs/promises";
import path from "path";

export const DRAFTS_DIR = path.join(process.cwd(), "src", "data", "drafts");
export const DRAFT_ASSETS_DIR = path.join(process.cwd(), "public", "render-assets", "drafts");
export const DRAFT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Fields only an export copy has.
export const EXPORT_FIELDS = ["exportedFrom", "exportedAt", "exportName"] as const;

type Draft = Record<string, unknown>;

export const draftJsonPath = (id: string) => path.join(DRAFTS_DIR, `${id}.json`);

export async function readDraft(id: string): Promise<Draft | null> {
  return fs.readFile(draftJsonPath(id), "utf8").then((raw) => JSON.parse(raw) as Draft, () => null);
}

async function sha1File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha1");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function filesIn(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile()).map((e) => e.name).sort();
}

// Every file URL and path of a draft names its own folder
// (render-assets/drafts/<id>/...), so a copy only renames that part.
function retarget(draft: Draft, fromId: string, toId: string): Draft {
  return JSON.parse(JSON.stringify(draft).split(`drafts/${fromId}/`).join(`drafts/${toId}/`)) as Draft;
}

// A second name for the same file (a hard link), so a copy of a project
// costs no disk: an export copy of a project with link audio was 17 MB,
// all of it duplicates. Safe because no file in a draft folder is ever
// changed in place -- every write makes a new file and renames it over the
// old name (api/drafts writeFileReplacing, stripAudioInPlace), which leaves
// the other name on the old content. Deleting either name keeps the other.
// Falls back to a real copy where links aren't possible.
async function shareFile(from: string, to: string) {
  await fs.link(from, to).catch(() => fs.copyFile(from, to));
}

// Copies a draft and its files under a new id; `edit` adjusts the copy's
// JSON before it is written. Deleting or changing either one leaves the
// other as it is (the files are shared, see shareFile).
export async function cloneDraft(sourceId: string, edit: (draft: Draft) => Draft): Promise<string | null> {
  const source = await readDraft(sourceId);
  if (!source) return null;
  const id = crypto.randomUUID();
  const sourceDir = path.join(DRAFT_ASSETS_DIR, sourceId);
  const dir = path.join(DRAFT_ASSETS_DIR, id);
  await fs.mkdir(dir, { recursive: true });
  try {
    for (const name of await filesIn(sourceDir)) {
      await shareFile(path.join(sourceDir, name), path.join(dir, name));
    }
    const copy = retarget(source, sourceId, id);
    copy.id = id;

    // The prepared clip normally lives in the draft's folder (api/drafts
    // keepPreparedAudio). If that copy failed, the draft still points at
    // the temp file: bring it along while it exists. Its name is kept, as
    // render/route.ts caches the trimmed audio by the clip's file name.
    const prepared = copy.preparedAudio as { preparedAudioLocalPath?: unknown; preparedAudioUrl?: unknown } | undefined;
    const localPath = prepared?.preparedAudioLocalPath;
    if (prepared && typeof localPath === "string" && path.dirname(path.resolve(localPath)) !== dir) {
      const name = path.basename(localPath);
      const copied = await fs.copyFile(localPath, path.join(dir, name)).then(() => true, () => false);
      if (copied) {
        prepared.preparedAudioLocalPath = path.join(dir, name);
        prepared.preparedAudioUrl = `/api/serve-audio?file=render-assets/drafts/${id}/${name}`;
      }
    }

    await fs.writeFile(draftJsonPath(id), JSON.stringify(edit(copy), null, 2));
    return id;
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// What a draft would look like on screen and in a render: its JSON without
// ids, dates and export labels, plus the content of its files. Two drafts
// with the same signature make the same video.
export async function draftSignature(id: string, draft: Draft): Promise<string> {
  const plain = retarget(draft, id, "@");
  for (const key of ["id", "updatedAt", "wizardStep", ...EXPORT_FIELDS]) delete plain[key];
  const prepared = plain.preparedAudio as Record<string, unknown> | undefined;
  if (prepared) delete prepared.copiedFrom;
  const hash = crypto.createHash("sha1").update(JSON.stringify(plain));
  const dir = path.join(DRAFT_ASSETS_DIR, id);
  for (const name of await filesIn(dir)) {
    hash.update(`\n${name}:${await sha1File(path.join(dir, name))}`);
  }
  return hash.digest("hex");
}

// Every draft whose JSON passes `keep`.
export async function findDrafts(keep: (draft: Draft) => boolean): Promise<Draft[]> {
  const names = await fs.readdir(DRAFTS_DIR).catch(() => [] as string[]);
  const drafts = await Promise.all(
    names
      .filter((name) => name.endsWith(".json") && DRAFT_ID.test(name.slice(0, -5)))
      .map((name) => readDraft(name.slice(0, -5)))
  );
  return drafts.filter((d): d is Draft => d !== null && keep(d));
}
