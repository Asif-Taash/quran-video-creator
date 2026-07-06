from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
import os

router = APIRouter()

@router.get("/ayah/{ayah_id}")
def download_ayah(ayah_id: int, db: Session = Depends(get_db)):
    ayah = db.query(models.Ayah).filter(models.Ayah.id == ayah_id).first()
    if ayah is None:
        raise HTTPException(status_code=404, detail="Ayah not found")
        
    file_path = f"app/{ayah.audio_url}"
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Audio file not found")
        
    filename = f"surah_{ayah.surah_id}_ayah_{ayah.ayah_number}.mp3"
    return FileResponse(file_path, media_type="audio/mpeg", filename=filename)

@router.get("/surah/{surah_id}")
def download_surah(surah_id: int, db: Session = Depends(get_db)):
    # In a real application, you might pre-generate full surah MP3s or zip files
    # Here we simulate finding a full surah mp3
    file_path = f"app/static/audio/surahs/{surah_id}.mp3"
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Full surah audio not found yet. Please implement merging or external fetch.")
        
    return FileResponse(file_path, media_type="audio/mpeg", filename=f"surah_{surah_id}.mp3")
