from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask
from typing import Optional
import json
import os
import re
import sys
import urllib.request
import uuid
from pathlib import Path
import shutil
from urllib.parse import quote

scripts_path = str(Path("/app/scripts"))
if scripts_path not in sys.path:
    sys.path.append(scripts_path)

# quran_aligner (CTC forced alignment) is the default; ALIGN_ENGINE=legacy
# switches back to the previous Whisper-transcription pipeline.
if os.environ.get("ALIGN_ENGINE", "ctc").lower() == "legacy":
    from extract_precise_clip import extract_clip, extract_custom_clip
else:
    from quran_aligner import extract_clip, extract_custom_clip
import job_control
import link_audio

router = APIRouter(
    tags=["extract"],
)

class ExtractRequest(BaseModel):
    surah: int
    start: int
    end: int
    reciter: str
    pad_seconds: float = 0.0
    # Optional: lets the client poll /status and /cancel this request (see
    # scripts/job_control.py).
    job_id: Optional[str] = None
    # Start with the basmala before ayah 1 (see quran_aligner.BASMALA_AYAH).
    basmala: bool = False

@router.post("/")
def generate_clip(req: ExtractRequest):
    try:
        with job_control.job(req.job_id):
            # Only passed when set: the legacy engine has no such option.
            extra = {"basmala": True} if req.basmala else {}
            result = extract_clip(req.reciter, req.surah, req.start, req.end, pad_seconds=req.pad_seconds, **extra)
        if not result:
            raise HTTPException(status_code=400, detail="Failed to extract clip. Check logs.")
        
        mp3_path, json_path = result
        mp3_filename = os.path.basename(mp3_path)
        json_filename = os.path.basename(json_path)
        
        return {
            "success": True,
            "mp3_filename": mp3_filename,
            "json_filename": json_filename
        }
    except job_control.Cancelled:
        raise HTTPException(status_code=409, detail="cancelled")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/custom")
async def generate_custom_clip(
    surah: int = Form(...),
    start: int = Form(...),
    end: int = Form(...),
    pad_seconds: float = Form(0.0),
    audio_file: UploadFile = File(...),
    job_id: Optional[str] = Form(None),
    basmala: bool = Form(False),
):
    temp_file_path = None
    try:
        temp_dir = Path("/app/data/temp_extraction")
        temp_dir.mkdir(parents=True, exist_ok=True)

        # Saved under a generated name: the browser-sent filename could
        # collide with another upload's, or carry path components.
        suffix = Path(audio_file.filename or "").suffix
        if not re.fullmatch(r"\.[A-Za-z0-9]{1,8}", suffix):
            suffix = ""
        temp_file_path = temp_dir / f"upload_{uuid.uuid4().hex}{suffix}"

        # Saving and aligning are blocking work; run them off the event loop,
        # which otherwise froze every other request (status polls, the
        # background search...) for the whole alignment.
        def work():
            with open(temp_file_path, "wb") as buffer:
                shutil.copyfileobj(audio_file.file, buffer)
            return extract_custom_clip(str(temp_file_path), surah, start, end, pad_seconds=pad_seconds, basmala=basmala)

        result = await run_in_threadpool(job_control.run, job_id, work)

        if not result:
            raise HTTPException(status_code=400, detail="Failed to align custom clip. Check logs.")
            
        audio_path, json_path = result
        json_filename = os.path.basename(json_path)
        mp3_filename = os.path.basename(audio_path)
        
        return {
            "success": True,
            "mp3_filename": mp3_filename,
            "json_filename": json_filename
        }
    except job_control.Cancelled:
        raise HTTPException(status_code=409, detail="cancelled")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        # Clean up the temporary audio file now that we're done with it
        try:
            if temp_file_path and temp_file_path.exists():
                os.remove(temp_file_path)
        except Exception as cleanup_err:
            print(f"Warning: Failed to clean up temp audio file: {cleanup_err}")

@router.post("/lossless")
def lossless_clip(
    surah: int = Form(...),
    clip_start: float = Form(...),
    duration: float = Form(...),
    reciter: str = Form("custom"),
    source: str = Form("mp3quran"),
    fade_in: bool = Form(True),
    fade_out: bool = Form(True),
    hq: bool = Form(False),
    audio_file: Optional[UploadFile] = File(None),
):
    """A prepared clip cut again from its recording without MP3 compression
    (quran_aligner.write_lossless_cut), for the video. `source` is the
    prepared JSON's: "mp3quran"/"backup" read the reciter's cached surah
    recording, "custom" the uploaded `audio_file` (the recording the clip
    was prepared from). `hq` is the prepared JSON's too: the clip was cut
    from RECITERS_HQ's copy, which sits ~0.1 s apart from mp3quran's file."""
    from quran_aligner import write_lossless_cut
    from extract_precise_clip import BACKUP_CACHE_SUFFIX, SURAH_CACHE_DIR, download_full_surah, is_backup_recording

    if not re.fullmatch(r"[a-z0-9_]{1,40}", reciter) or clip_start < 0 or not 0 < duration < 4 * 3600:
        raise HTTPException(status_code=400, detail="Invalid clip")
    temp_dir = Path("/app/data/temp_extraction")
    temp_dir.mkdir(parents=True, exist_ok=True)
    work = temp_dir / f"lossless_{uuid.uuid4().hex}"
    work.mkdir()
    try:
        if source == "custom":
            if audio_file is None:
                raise HTTPException(status_code=400, detail="audio_file is required for custom audio")
            suffix = Path(audio_file.filename or "").suffix
            if not re.fullmatch(r"\.[A-Za-z0-9]{1,8}", suffix):
                suffix = ""
            src = work / f"upload{suffix}"
            with open(src, "wb") as buffer:
                shutil.copyfileobj(audio_file.file, buffer)
        elif source == "backup":
            src = SURAH_CACHE_DIR / f"{reciter}_{surah:03d}{BACKUP_CACHE_SUFFIX}"
            if not src.exists():
                raise HTTPException(status_code=404, detail="The backup recording is no longer cached")
        elif source == "mp3quran":
            src = Path(download_full_surah(reciter, surah, allow_backup=False, prefer_hq=hq))
            if is_backup_recording(src):
                raise HTTPException(status_code=404, detail="The mp3quran recording is unavailable")
        else:
            raise HTTPException(status_code=400, detail="Unknown source")
        out = work / "clip.flac"
        write_lossless_cut(src, clip_start, duration, fade_in, fade_out, out)
        return FileResponse(str(out), media_type="audio/flac",
                            background=BackgroundTask(shutil.rmtree, work, ignore_errors=True))
    except HTTPException:
        shutil.rmtree(work, ignore_errors=True)
        raise
    except Exception as e:
        shutil.rmtree(work, ignore_errors=True)
        raise HTTPException(status_code=500, detail=str(e))

_preview_timing_cache = {}


@router.get("/preview-source")
def preview_source(reciter: str, surah: int, start: int, end: int):
    """Where to listen to the chosen ayahs in a reciter's recording before
    preparing anything: the browser plays `url` from `start` to `end`
    seconds itself. mp3quran's timing can be off by a constant factor for
    some files, so `total` (the recording's length by that timing) lets the
    browser rescale to the real duration. A recording without timing gives
    start 0 / end null: the browser plays its opening as a voice sample."""
    from extract_precise_clip import RECITERS_HQ, RECITERS_MP3QURAN, RECITERS_TIMING_ID, RECITER_SURAHS, has_hq_copy

    if reciter not in RECITERS_MP3QURAN or not 1 <= surah <= 114 or start < 0 or end < start:
        raise HTTPException(status_code=400, detail="Invalid request")
    if reciter in RECITER_SURAHS and surah not in RECITER_SURAHS[reciter]:
        raise HTTPException(status_code=404, detail="surah not recorded")
    # The copy the video will be cut from (same recording, same timing).
    url = (RECITERS_HQ[reciter][0] if has_hq_copy(reciter, surah) else RECITERS_MP3QURAN[reciter]).format(surah=surah)
    read_id = RECITERS_TIMING_ID.get(reciter)
    if not read_id:
        return {"url": url, "start": 0, "end": None, "total": None, "timed": False}
    key = (read_id, surah)
    times = _preview_timing_cache.get(key)
    if times is None:
        req = urllib.request.Request(
            f"https://mp3quran.net/api/v3/ayat_timing?surah={surah}&read={read_id}",
            headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                data = json.loads(response.read().decode())
        except Exception:
            return {"url": url, "start": 0, "end": None, "total": None, "timed": False}
        rows = data if isinstance(data, list) else (data.get("times") or data.get("ayat_timing") or [])
        times = {int(t["ayah"]): (t["start_time"] / 1000.0, t["end_time"] / 1000.0) for t in rows}
        if len(_preview_timing_cache) > 300:
            _preview_timing_cache.clear()
        _preview_timing_cache[key] = times
    total = max((e for _, e in times.values()), default=None)
    first = times.get(start) or (times.get(1) if start == 0 else None)
    last = times.get(end)
    if not first or not last:
        return {"url": url, "start": 0, "end": None, "total": None, "timed": False}
    return {"url": url, "start": first[0], "end": last[1], "total": total, "timed": True}


class LinkRequest(BaseModel):
    url: str

@router.post("/from-link")
def audio_from_link(req: LinkRequest):
    """The audio of a YouTube/TikTok/Instagram video, which the client then
    uses like any file it picked. Failures answer 422 with a code from
    link_audio.LinkError."""
    try:
        audio_path, title = link_audio.fetch_audio(req.url)
    except link_audio.LinkError as e:
        raise HTTPException(status_code=422, detail=e.code)
    return FileResponse(
        str(audio_path),
        media_type="audio/mp4",
        headers={"X-Audio-Title": quote(title)},
        background=BackgroundTask(shutil.rmtree, audio_path.parent, ignore_errors=True),
    )

@router.get("/status/{job_id}")
def job_status(job_id: str):
    """What a running extraction is doing right now: {"stage": None} once
    it's finished (or unknown)."""
    return job_control.status(job_id)

@router.post("/cancel/{job_id}")
def cancel_job(job_id: str):
    """Stops a running extraction at its next checkpoint (within seconds),
    or makes it stop right away if it hasn't started yet."""
    job_control.cancel(job_id)
    return {"success": True}

@router.get("/download/{filename}")
def download_extracted(filename: str):
    file_path = Path("/app/data/extracted_clips") / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    media_type = "audio/mpeg" if filename.endswith(".mp3") else "application/json"
    return FileResponse(str(file_path), media_type=media_type)

