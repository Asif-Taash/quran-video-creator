from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional
import os
import re
import sys
import uuid
from pathlib import Path
import shutil

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

@router.post("/")
def generate_clip(req: ExtractRequest):
    try:
        with job_control.job(req.job_id):
            result = extract_clip(req.reciter, req.surah, req.start, req.end, pad_seconds=req.pad_seconds)
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
            return extract_custom_clip(str(temp_file_path), surah, start, end, pad_seconds=pad_seconds)

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

@router.delete("/{filename}")
def delete_clip(filename: str):
    file_path = Path("/app/data/extracted_clips") / filename
    if file_path.exists():
        os.remove(file_path)
        return {"success": True}
    return {"success": False, "message": "Not found"}

@router.delete("/cleanup/all")
def cleanup_all():
    """Clear all temporary audio/video files to free up space."""
    import shutil
    try:
        paths_to_clean = [
            Path("/app/data/temp_extraction"),
            Path("/app/data/extracted_clips")
        ]
        
        for path in paths_to_clean:
            if path.exists():
                for item in path.iterdir():
                    if item.is_file():
                        item.unlink()
                    elif item.is_dir():
                        shutil.rmtree(item)
        
        return {"success": True, "message": "Backend cleanup completed."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
