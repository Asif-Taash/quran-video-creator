import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

export const runtime = "nodejs";

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

async function saveDraftFile(draftId: string, kind: "bg" | "bgVideo" | "audio" | "font", file: File): Promise<string> {
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

  await fs.writeFile(absolutePath, buffer);
  return `/api/serve-audio?file=render-assets/drafts/${draftId}/${filename}`;
}

export async function POST(req: Request) {
  try {
    const formData = await req.formData();

    const draftId = (formData.get("draftId") as string) || crypto.randomUUID();

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
    };

    const preparedAudioStr = formData.get("preparedAudio") as string | null;
    if (preparedAudioStr) {
      draft.preparedAudio = JSON.parse(preparedAudioStr);
    }

    const segmentationStr = formData.get("segmentation") as string | null;
    if (segmentationStr) {
      draft.segmentation = JSON.parse(segmentationStr);
    }

    const bgImage = formData.get("bgImage") as File | null;
    if (bgImage && bgImage.size > 0) {
      draft.background = { url: await saveDraftFile(draftId, "bg", bgImage) };
    }

    const bgVideo = formData.get("bgVideo") as File | null;
    if (bgVideo && bgVideo.size > 0) {
      draft.backgroundVideo = { url: await saveDraftFile(draftId, "bgVideo", bgVideo) };
    }

    const customAudio = formData.get("customAudio") as File | null;
    if (customAudio && customAudio.size > 0) {
      draft.customAudio = {
        url: await saveDraftFile(draftId, "audio", customAudio),
        originalName: customAudio.name,
      };
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

    return NextResponse.json({ success: true, draftId });
  } catch (error) {
    console.error("[Drafts] Failed to save draft:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save draft" },
      { status: 500 }
    );
  }
}
