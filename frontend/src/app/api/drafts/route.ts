import { NextResponse } from "next/server";
import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import crypto from "crypto";
import { stripAudioInPlace } from "@/lib/silentVideo";
import { lowDiskError } from "@/lib/diskSpace";
import { fileSha, rememberStockSource } from "@/lib/usedBackgrounds";

export const runtime = "nodejs";
// GET lists the drafts on disk: never a build-time snapshot.
export const dynamic = "force-dynamic";

const DRAFTS_DIR = path.join(process.cwd(), "src", "data", "drafts");
const DRAFT_ASSETS_DIR = path.join(process.cwd(), "public", "render-assets", "drafts");

const VALID_IMAGE_HEADERS = [
  [0xff, 0xd8, 0xff], // JPEG
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0x47, 0x49, 0x46], // GIF
  [0x52, 0x49, 0x46, 0x46], // WEBP
];

function isValidImage(buffer: Buffer) {
  return VALID_IMAGE_HEADERS.some((header) => header.every((byte, i) => buffer[i] === byte));
}

// Never writes into an existing file: export copies share their files with
// the project by hard links (lib/draftStore shareFile), so overwriting
// bg.jpg in place would change the copy's background too. A new file
// renamed over the old name leaves the copy's link on the old content. A
// temp file left by a crash is unused, so the next save removes it
// (removeUnusedDraftFiles).
async function writeFileReplacing(filePath: string, data: Buffer) {
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, data);
    await fs.rename(tempPath, filePath);
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
}

async function saveDraftFile(draftId: string, kind: "bg" | "bgVideo" | "audio" | "font", file: File): Promise<string> {
  const lowDisk = await lowDiskError();
  if (lowDisk) throw new Error(lowDisk);
  const dir = path.join(DRAFT_ASSETS_DIR, draftId);
  await fs.mkdir(dir, { recursive: true });
  const defaultExtension = kind === "bg" ? ".jpg" : kind === "bgVideo" ? ".mp4" : kind === "font" ? ".ttf" : ".mp3";
  const extension = path.extname(file.name).toLowerCase() || defaultExtension;
  const filename = `${kind}${extension}`;
  const absolutePath = path.join(dir, filename);
  const buffer = Buffer.from(await file.arrayBuffer());

  if (kind === "bg" && !isValidImage(buffer)) {
    throw new Error("Uploaded background is not a valid image (JPEG, PNG, GIF, or WebP)");
  }
  // bgVideo isn't magic-byte-validated here (video containers vary too much
  // for a simple header check the way images allow) -- an actually invalid
  // file still gets caught later, since render/route.ts's ffprobe duration
  // probe fails loudly on anything it can't read.

  await writeFileReplacing(absolutePath, buffer);
  if (kind === "bgVideo") {
    // Background videos are always silent (see lib/silentVideo.ts), so a
    // restored draft's copy has no sound either.
    await stripAudioInPlace(absolutePath).catch((err) => {
      console.warn("[Drafts] Could not strip audio from background video:", err);
    });
  }
  if (kind === "bg" || kind === "bgVideo") {
    // Reopened, the project sends this file as "draft-bg.*": keep which
    // library item it is (lib/usedBackgrounds.ts), for when it's exported.
    const sha = await fileSha(absolutePath);
    void rememberStockSource(sha, file.name, kind === "bg" ? "image" : "video").catch((err) => {
      console.warn("[Drafts] Could not remember the background's source:", err);
    });
  }
  return `/api/serve-audio?file=render-assets/drafts/${draftId}/${filename}`;
}

// Draft ids are crypto.randomUUID()s; anything else could point the file
// paths below outside the drafts folders.
const DRAFT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class MissingDraftFile extends Error {}

// { [key]: value } when the form field holds one of the allowed values, else {}.
function oneOf(formData: FormData, key: string, allowed: string[]): Record<string, string> {
  const value = formData.get(key);
  return typeof value === "string" && allowed.includes(value) ? { [key]: value } : {};
}

// The client sends keep<Name>=true instead of a file the server already
// holds for this draft (VideoCreatorForm's savedDraftFilesRef): re-uploading
// the audio and background on every autosave sent tens of MB per edit. The
// whole draft JSON is rewritten each save, so the kept entry is copied from
// the previous one -- only if its file is really still on disk; otherwise
// the client is told (409) and sends the files again.
async function keptDraftFile(
  formData: FormData,
  flag: string,
  draftId: string,
  previous: Record<string, unknown> | null,
  field: string
): Promise<unknown> {
  if (formData.get(flag) !== "true") return undefined;
  const entry = previous?.[field] as { url?: unknown } | undefined;
  const match = typeof entry?.url === "string"
    ? entry.url.match(/^\/api\/serve-audio\?file=render-assets\/drafts\/([^/]+)\/([^/?&]+)$/)
    : null;
  if (!match || match[1] !== draftId) throw new MissingDraftFile(field);
  const onDisk = await fs.stat(path.join(DRAFT_ASSETS_DIR, draftId, match[2])).then((s) => s.isFile(), () => false);
  if (!onDisk) throw new MissingDraftFile(field);
  return entry;
}

const TEMP_AUDIO_DIR = path.join(process.cwd(), "public", "renders", "temp_audio");

type CopiedFrom = { file: string; size: number; mtimeMs: number };

// A prepared clip's improved copy (FLAC, same name): see render/route.ts's
// improvedAudioPath.
function improvedCopyName(preparedName: string): string {
  return `${path.basename(preparedName, path.extname(preparedName))}.flac`;
}

async function sha1File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha1");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

// The prepared (aligned) clip is written to public/renders/temp_audio, a
// tmpfs that every container restart wipes: a project saved pointing there
// lost its audio, and the render then fell back to a fresh extraction with
// the trim reset (before 2026-11-07, for an uploaded recording, even the
// built-in reciter's voice). So the draft keeps its own copy, in its
// persistent assets folder, and points there. The copy is named by its
// content: render/route.ts caches trimmed audio by the source file's name.
// The client keeps sending the temp path it prepared; copiedFrom tells an
// unchanged clip (no new copy) from a re-prepared one, and lets a save that
// arrives after a restart wiped the temp file keep the copy made before.
async function keepPreparedAudio(
  draftId: string,
  prepared: Record<string, unknown>,
  previous: Record<string, unknown> | null
): Promise<Record<string, unknown>> {
  const localPath = prepared.preparedAudioLocalPath;
  if (typeof localPath !== "string" || path.dirname(path.resolve(localPath)) !== TEMP_AUDIO_DIR) {
    // Already this draft's own copy (a resumed project), or nothing to copy.
    return prepared;
  }
  const source = path.resolve(localPath);
  const draftDir = path.join(DRAFT_ASSETS_DIR, draftId);
  const prev = previous?.preparedAudio as { preparedAudioLocalPath?: unknown; copiedFrom?: CopiedFrom } | undefined;
  const prevCopy = typeof prev?.preparedAudioLocalPath === "string" ? prev.preparedAudioLocalPath : null;
  const prevCopyOnDisk = prevCopy !== null && path.dirname(prevCopy) === draftDir
    && (await fs.stat(prevCopy).then((s) => s.isFile(), () => false));
  const pointTo = (copyPath: string, copiedFrom: CopiedFrom) => ({
    ...prepared,
    preparedAudioUrl: `/api/serve-audio?file=render-assets/drafts/${draftId}/${path.basename(copyPath)}`,
    preparedAudioLocalPath: copyPath,
    copiedFrom,
  });

  try {
    const stat = await fs.stat(source).catch(() => null);
    const sameSource = (c?: CopiedFrom) => c?.file === path.basename(source)
      && (!stat || (c.size === stat.size && c.mtimeMs === stat.mtimeMs));
    if (prevCopyOnDisk && prev?.copiedFrom && sameSource(prev.copiedFrom)) {
      return pointTo(prevCopy!, prev.copiedFrom);
    }
    if (!stat) return prepared;

    await fs.mkdir(draftDir, { recursive: true });
    const copyName = `prepared-${(await sha1File(source)).slice(0, 12)}${path.extname(source) || ".mp3"}`;
    const copyPath = path.join(draftDir, copyName);
    // Named by content: a file already there holds this clip (and may be
    // shared with an export copy, so it is never rewritten in place).
    if (!(await fs.stat(copyPath).then((s) => s.isFile() && s.size === stat.size, () => false))) {
      const tempPath = `${copyPath}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.copyFile(source, tempPath);
        await fs.rename(tempPath, copyPath);
      } catch (err) {
        await fs.unlink(tempPath).catch(() => {});
        throw err;
      }
    }
    // Only the current clip is kept, with its improved copy if it has one
    // (render/route.ts's improvedAudioPath).
    for (const name of await fs.readdir(draftDir)) {
      if (name.startsWith("prepared-") && name !== copyName && name !== improvedCopyName(copyName)) {
        await fs.unlink(path.join(draftDir, name)).catch(() => {});
      }
    }
    return pointTo(copyPath, { file: path.basename(source), size: stat.size, mtimeMs: stat.mtimeMs });
  } catch (err) {
    console.warn("[Drafts] Could not keep a copy of the prepared audio:", err);
    return prepared;
  }
}

// A project's folder keeps only what its draft uses: a replaced background
// or font, a removed recording, an older prepared clip. (A recording stays
// in the draft after switching to a built-in reciter, so switching back
// finds it again.) Files used to pile up there (20 MB of a recording one
// project no longer used, 2026-11-07).
async function removeUnusedDraftFiles(draftId: string, draft: Record<string, unknown>) {
  const dir = path.join(DRAFT_ASSETS_DIR, draftId);
  const prefix = `render-assets/drafts/${draftId}/`;
  const used = new Set<string>();
  for (const key of ["background", "backgroundVideo", "customAudio", "customTranslationFont"]) {
    const url = (draft[key] as { url?: unknown } | undefined)?.url;
    const at = typeof url === "string" ? url.indexOf(prefix) : -1;
    if (at >= 0) used.add((url as string).slice(at + prefix.length).split(/[?&]/)[0]);
  }
  const prepared = (draft.preparedAudio as { preparedAudioLocalPath?: unknown } | undefined)?.preparedAudioLocalPath;
  if (typeof prepared === "string" && path.dirname(path.resolve(prepared)) === dir) {
    used.add(path.basename(prepared));
    used.add(improvedCopyName(path.basename(prepared)));
  }
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    names.filter((name) => !used.has(name)).map((name) => fs.unlink(path.join(dir, name)).catch(() => {}))
  );
}

// The "مشاريعي" list (ProjectsDialog): a short summary of every saved
// project, newest first.
export async function GET() {
  const files = await fs.readdir(DRAFTS_DIR).catch(() => [] as string[]);
  const drafts = await Promise.all(
    files
      .filter((name) => DRAFT_ID.test(name.replace(/\.json$/, "")) && name.endsWith(".json"))
      .map(async (name) => {
        try {
          const d = JSON.parse(await fs.readFile(path.join(DRAFTS_DIR, name), "utf8"));
          return {
            id: d.id as string,
            updatedAt: d.updatedAt as string,
            surahId: d.surahId as number | null,
            startVerse: d.startVerse as number | null,
            endVerse: d.endVerse as number | null,
            audioSourceMode: d.audioSourceMode as string,
            selectedReciter: d.selectedReciter as string | null,
            customAudioName: (d.customAudio?.originalName as string | undefined) ?? null,
            backgroundUrl: (d.background?.url as string | undefined) ?? null,
            hasBackgroundVideo: Boolean(d.backgroundVideo?.url),
            // Set on the copy each export keeps (api/drafts/[id]/snapshot).
            exportedAt: (d.exportedAt as string | undefined) ?? null,
            exportName: (d.exportName as string | undefined) ?? null,
          };
        } catch {
          return null;
        }
      })
  );
  const list = drafts
    .filter((d): d is NonNullable<typeof d> => d !== null && typeof d.id === "string" && d.surahId !== null)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return NextResponse.json({ drafts: list });
}

export async function POST(req: Request) {
  try {
    const formData = await req.formData();

    const requestedDraftId = formData.get("draftId") as string | null;
    if (requestedDraftId && !DRAFT_ID.test(requestedDraftId)) {
      return NextResponse.json({ error: "Invalid draft id" }, { status: 400 });
    }
    const draftId = requestedDraftId || crypto.randomUUID();
    const previous: Record<string, unknown> | null = requestedDraftId
      ? await fs.readFile(path.join(DRAFTS_DIR, `${draftId}.json`), "utf8").then((raw) => JSON.parse(raw), () => null)
      : null;

    const draft: Record<string, unknown> = {
      id: draftId,
      updatedAt: new Date().toISOString(),
      surahId: Number(formData.get("surahId")) || null,
      startVerse: formData.get("startVerse") ? Number(formData.get("startVerse")) : null,
      endVerse: formData.get("endVerse") ? Number(formData.get("endVerse")) : null,
      selectedReciter: (formData.get("selectedReciter") as string) || null,
      audioSourceMode: (formData.get("audioSourceMode") as string) || "reciter",
      translationId: (formData.get("translationId") as string) || "none",
      wizardStep: Number(formData.get("wizardStep")) || 1,
      arabicTextScale: Number(formData.get("arabicTextScale")) || 1,
      arabicWidthScale: Number(formData.get("arabicWidthScale")) || 1,
      translationTextScale: Number(formData.get("translationTextScale")) || 1,
      translationWidthScale: Number(formData.get("translationWidthScale")) || 1,
      translationFont: (formData.get("translationFont") as string) || "aileron",
      arabicFont: (formData.get("arabicFont") as string) || "qcf2",
      ...(formData.has("backgroundDim") ? { backgroundDim: Number(formData.get("backgroundDim")) } : {}),
      backgroundBlur: Number(formData.get("backgroundBlur")) || 0,
      backgroundZoom: formData.get("backgroundZoom") === "true",
      backgroundVignette: Number(formData.get("backgroundVignette")) || 0,
      wordHighlight: formData.get("wordHighlight") === "true",
      ...(formData.get("wordHighlightColor") ? { wordHighlightColor: formData.get("wordHighlightColor") as string } : {}),
      showReciterName: formData.get("showReciterName") !== "false",
      // Starts with the basmala before ayah 1 (lib/basmala.ts).
      includeBasmala: formData.get("includeBasmala") === "true",
      // Video shape, export quality, and the title language of a video
      // without a translation: not saved before 2026-11-07, so a reopened
      // project came back portrait, 720p, in the interface's language.
      ...oneOf(formData, "aspectRatio", ["portrait", "landscape", "square"]),
      ...oneOf(formData, "quality", ["720p", "1080p"]),
      ...oneOf(formData, "translationLanguage", ["tr", "en", "ar"]),
      // Present only once the user typed their own text (see
      // VideoCreatorForm's reciterNameEdit); absent = the reciter's own name.
      ...(formData.has("reciterNameEdit") ? { reciterNameEdit: String(formData.get("reciterNameEdit")).slice(0, 80) } : {}),
    };

    const preparedAudioStr = formData.get("preparedAudio") as string | null;
    if (preparedAudioStr) {
      draft.preparedAudio = await keepPreparedAudio(draftId, JSON.parse(preparedAudioStr), previous);
    }

    const segmentationStr = formData.get("segmentation") as string | null;
    if (segmentationStr) {
      draft.segmentation = JSON.parse(segmentationStr);
    }

    const keptBackground = await keptDraftFile(formData, "keepBgImage", draftId, previous, "background");
    const keptBackgroundVideo = await keptDraftFile(formData, "keepBgVideo", draftId, previous, "backgroundVideo");
    const keptCustomAudio = await keptDraftFile(formData, "keepCustomAudio", draftId, previous, "customAudio");

    const bgImage = formData.get("bgImage") as File | null;
    if (bgImage && bgImage.size > 0) {
      draft.background = { url: await saveDraftFile(draftId, "bg", bgImage) };
    } else if (keptBackground) {
      draft.background = keptBackground;
    }

    const bgVideo = formData.get("bgVideo") as File | null;
    if (bgVideo && bgVideo.size > 0) {
      draft.backgroundVideo = { url: await saveDraftFile(draftId, "bgVideo", bgVideo) };
    } else if (keptBackgroundVideo) {
      draft.backgroundVideo = keptBackgroundVideo;
    }

    const customAudio = formData.get("customAudio") as File | null;
    if (customAudio && customAudio.size > 0) {
      draft.customAudio = {
        url: await saveDraftFile(draftId, "audio", customAudio),
        originalName: customAudio.name,
      };
    } else if (keptCustomAudio) {
      draft.customAudio = keptCustomAudio;
    }

    // A fresh upload is saved here (this draft's own copy, separate from
    // the copy /api/video/render saves for the actual export -- same
    // dual-storage pattern already used for bgImage/customAudio above).
    // Once already uploaded (this session or a previous one, restored from
    // the draft), the client resends the URL instead of re-uploading the
    // identical file on every autosave -- without this, a save cycle with
    // no fresh file would silently drop customTranslationFont from the
    // draft entirely, since this whole object is rewritten each time.
    const customTranslationFont = formData.get("customTranslationFont") as File | null;
    const existingCustomTranslationFontUrl = formData.get("existingCustomTranslationFontUrl") as string | null;
    if (customTranslationFont && customTranslationFont.size > 0) {
      draft.customTranslationFont = {
        url: await saveDraftFile(draftId, "font", customTranslationFont),
        originalName: customTranslationFont.name,
      };
    } else if (existingCustomTranslationFontUrl) {
      draft.customTranslationFont = { url: existingCustomTranslationFontUrl };
    }

    await fs.mkdir(DRAFTS_DIR, { recursive: true });
    await fs.writeFile(path.join(DRAFTS_DIR, `${draftId}.json`), JSON.stringify(draft, null, 2));
    await removeUnusedDraftFiles(draftId, draft);

    return NextResponse.json({ success: true, draftId });
  } catch (error) {
    if (error instanceof MissingDraftFile) {
      return NextResponse.json({ error: "A kept file is missing", missing: error.message }, { status: 409 });
    }
    console.error("[Drafts] Failed to save draft:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save draft" },
      { status: 500 }
    );
  }
}
