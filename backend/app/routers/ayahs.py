from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db

router = APIRouter()

@router.get("/{ayah_id}", response_model=schemas.Ayah)
def read_ayah(ayah_id: int, db: Session = Depends(get_db)):
    ayah = db.query(models.Ayah).filter(models.Ayah.id == ayah_id).first()
    if ayah is None:
        raise HTTPException(status_code=404, detail="Ayah not found")
    return ayah
