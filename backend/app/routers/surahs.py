from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List

from .. import models, schemas
from ..database import get_db

router = APIRouter()

@router.get("", response_model=List[schemas.Surah])
@router.get("/", response_model=List[schemas.Surah])
def read_surahs(skip: int = 0, limit: int = 114, db: Session = Depends(get_db)):
    surahs = db.query(models.Surah).offset(skip).limit(limit).all()
    return surahs

@router.get("/{surah_id}", response_model=schemas.SurahWithAyahs)
def read_surah(surah_id: int, db: Session = Depends(get_db)):
    surah = db.query(models.Surah).filter(models.Surah.id == surah_id).first()
    if surah is None:
        raise HTTPException(status_code=404, detail="Surah not found")
    return surah
