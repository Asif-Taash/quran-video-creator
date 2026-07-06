from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
import os

router = APIRouter()

@router.get("/{ayah_id}", response_model=schemas.Ayah)
def read_ayah(ayah_id: int, db: Session = Depends(get_db)):
    ayah = db.query(models.Ayah).filter(models.Ayah.id == ayah_id).first()
    if ayah is None:
        raise HTTPException(status_code=404, detail="Ayah not found")
    return ayah

@router.get("/{ayah_id}/audio")
def stream_audio(ayah_id: int, db: Session = Depends(get_db)):
    ayah = db.query(models.Ayah).filter(models.Ayah.id == ayah_id).first()
    if ayah is None:
        raise HTTPException(status_code=404, detail="Ayah not found")
    
    # Assuming audio_url points to a local file in static/audio
    # In a real app this might be an absolute path or external URL
    file_path = f"app/{ayah.audio_url}"
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Audio file not found")
        
    return FileResponse(file_path, media_type="audio/mpeg")
