import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import axios from "axios";
import { DEFAULT_RECITER_ID, getReciter } from "@/lib/reciterNames";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function downloadAudioToPublic(audioUrl: string, audioPath: string) {
  const absolutePath = path.join(process.cwd(), "public", audioPath);

  // Removed fileExists check to ensure we always fetch the latest audio 
  // (e.g. if padSeconds changed, the backend generates a new file with the same name)

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(audioUrl, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "User-Agent": "KuranNuruVideoRenderer/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to download audio ${audioUrl}: HTTP ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(absolutePath, buffer);
    return absolutePath;
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const surahId = Number(formData.get("surahId"));
    const startVerse = Number(formData.get("startVerse"));
    const endVerse = Number(formData.get("endVerse"));
    const reciterId = formData.get("reciterId") as string || DEFAULT_RECITER_ID;
    const customAudio = formData.get("customAudio") as File | null;
    const padSeconds = Number(formData.get("padSeconds")) || 2.0;
    // Passed through so the client can poll/cancel this extraction (see
    // ./job/route.ts and backend/scripts/job_control.py).
    const rawJobId = formData.get("jobId");
    const jobId = typeof rawJobId === "string" && /^[A-Za-z0-9-]{8,64}$/.test(rawJobId) ? rawJobId : undefined;

    if (!Number.isInteger(surahId) || !Number.isInteger(startVerse) || !Number.isInteger(endVerse)) {
      return NextResponse.json({ error: "Invalid video options" }, { status: 400 });
    }

    const shortReciterKey = getReciter(reciterId)?.backendKey || "mishary";

    const baseUrl = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:8000";
    let wordTimingsData: any = null;
    let globalAudioPath: string | null = null;
    let localMp3Path: string | null = null;

    if (customAudio && customAudio.size > 0) {
      const backendFormData = new FormData();
      backendFormData.append("surah", surahId.toString());
      backendFormData.append("start", startVerse.toString());
      backendFormData.append("end", endVerse.toString());
      backendFormData.append("pad_seconds", padSeconds.toString());
      backendFormData.append("audio_file", customAudio);
      if (jobId) backendFormData.append("job_id", jobId);

      const extractRes = await axios.post(`${baseUrl}/api/extraction/custom`, backendFormData, {
        timeout: 1800000, // 30 minutes timeout for heavy Whisper processing
        validateStatus: () => true, // Don't throw on non-200
      });

      if (extractRes.status === 200) {
        const extractionData = extractRes.data;
        if (extractionData.success) {
          if (extractionData.mp3_filename) {
            const mp3Url = `${baseUrl}/api/extraction/download/${extractionData.mp3_filename}`;
            const mp3RelPath = `renders/temp_audio/${extractionData.mp3_filename}`;
            localMp3Path = await downloadAudioToPublic(mp3Url, mp3RelPath);
            globalAudioPath = `/api/serve-audio?file=${mp3RelPath}&t=${Date.now()}`;
          }
          const jsonUrl = `${baseUrl}/api/extraction/download/${extractionData.json_filename}`;
          const jsonRes = await axios.get(jsonUrl, { timeout: 30000, validateStatus: () => true });
          if (jsonRes.status === 200) {
            wordTimingsData = jsonRes.data;
          }
        }
      } else if (extractRes.status === 409) {
        return NextResponse.json({ cancelled: true }, { status: 409 });
      } else {
        console.error("Backend custom-audio extraction failed:", extractRes.status, extractRes.data);
        const detail = extractRes.data?.detail;
        const reason = detail ? `\n${detail}` : "";
        return NextResponse.json({ error: `فشل تجهيز الصوت المخصص. (${extractRes.status})${reason}` }, { status: 400 });
      }
    } else {
      const extractRes = await axios.post(`${baseUrl}/api/extraction/`, {
        surah: surahId,
        start: startVerse,
        end: endVerse,
        reciter: shortReciterKey,
        pad_seconds: padSeconds,
        job_id: jobId,
      }, {
        timeout: 1800000, // 30 minutes — large/whole-surah requests can legitimately take several minutes
        validateStatus: () => true
      });

      if (extractRes.status === 200) {
        const extractionData = extractRes.data;
        if (extractionData.success) {
          const mp3Url = `${baseUrl}/api/extraction/download/${extractionData.mp3_filename}`;
          const mp3RelPath = `renders/temp_audio/${extractionData.mp3_filename}`;
          localMp3Path = await downloadAudioToPublic(mp3Url, mp3RelPath);
          globalAudioPath = `/api/serve-audio?file=${mp3RelPath}&t=${Date.now()}`;

          const jsonUrl = `${baseUrl}/api/extraction/download/${extractionData.json_filename}`;
          const jsonRes = await axios.get(jsonUrl, { timeout: 30000, validateStatus: () => true });
          if (jsonRes.status === 200) {
            wordTimingsData = jsonRes.data;
          }
        }
      } else if (extractRes.status === 409) {
        return NextResponse.json({ cancelled: true }, { status: 409 });
      } else {
        console.error("Backend extraction failed:", extractRes.status, extractRes.data);
        const detail = extractRes.data?.detail;
        const reason = detail ? `\n${detail}` : " الخادم استغرق وقتاً طويلاً أو حدث خطأ.";
        return NextResponse.json({ error: `فشل تجهيز الصوت.${reason} حاول مجدداً. (${extractRes.status})` }, { status: 400 });
      }
    }

    if (!globalAudioPath || !wordTimingsData) {
      return NextResponse.json({ error: "Extraction failed" }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      audioUrl: globalAudioPath,
      localAudioPath: localMp3Path,
      wordTimingsData,
      padSeconds
    });

  } catch (error: any) {
    console.error("[Prepare Audio] Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
