from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse
from pydantic import BaseModel
import os
import sys
from pathlib import Path
import shutil

scripts_path = str(Path("/app/scripts"))
if scripts_path not in sys.path:
    sys.path.append(scripts_path)

from extract_precise_clip import extract_clip, extract_custom_clip

router = APIRouter(
    tags=["extract"],
)

class ExtractRequest(BaseModel):
    surah: int
    start: int
    end: int
    reciter: str
    pad_seconds: float = 0.0

@router.post("/")
def generate_clip(req: ExtractRequest):
    try:
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
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/custom")
async def generate_custom_clip(
    surah: int = Form(...),
    start: int = Form(...),
    end: int = Form(...),
    pad_seconds: float = Form(0.0),
    audio_file: UploadFile = File(...)
):
    temp_file_path = None
    try:
        temp_dir = Path("/app/data/temp_extraction")
        temp_dir.mkdir(parents=True, exist_ok=True)
        
        # Save the uploaded file temporarily
        temp_file_path = temp_dir / audio_file.filename
        with open(temp_file_path, "wb") as buffer:
            shutil.copyfileobj(audio_file.file, buffer)
            
        result = extract_custom_clip(str(temp_file_path), surah, start, end, pad_seconds=pad_seconds)
            
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
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        # Clean up the temporary audio file now that we're done with it
        try:
            if temp_file_path and temp_file_path.exists():
                os.remove(temp_file_path)
        except Exception as cleanup_err:
            print(f"Warning: Failed to clean up temp audio file: {cleanup_err}")

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
