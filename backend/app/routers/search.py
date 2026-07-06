from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from typing import List, Optional

from .. import models, schemas
from ..database import get_db

router = APIRouter()


@router.get("/")
def search(
    q: str = Query(..., min_length=1, max_length=100, description="Search query"),
    type: Optional[str] = Query(None, description="Filter: 'surah' or 'ayah'"),
    limit: int = Query(20, ge=1, le=50),
    db: Session = Depends(get_db),
):
    """
    Search across surah names and ayah translations.
    Returns matched surahs and/or ayahs depending on `type` param.
    """
    results = {"surahs": [], "ayahs": [], "query": q}
    q_lower = q.lower().strip()

    # ── Surah search ──────────────────────────────────────────────────────────
    if type in (None, "surah"):
        surahs = (
            db.query(models.Surah)
            .filter(
                models.Surah.name_transliteration.ilike(f"%{q_lower}%")
                | models.Surah.name_arabic.contains(q)
                | models.Surah.name_turkish.ilike(f"%{q_lower}%")
            )
            .limit(limit)
            .all()
        )
        results["surahs"] = [
            {
                "id": s.id,
                "name_transliteration": s.name_transliteration,
                "name_arabic": s.name_arabic,
                "name_turkish": s.name_turkish,
                "total_ayahs": s.total_ayahs,
                "type": s.type,
            }
            for s in surahs
        ]

    # ── Ayah search (translation only, for performance) ──────────────────────
    if type in (None, "ayah"):
        ayahs = (
            db.query(models.Ayah)
            .filter(models.Ayah.text_turkish.ilike(f"%{q_lower}%"))
            .limit(limit)
            .all()
        )
        results["ayahs"] = [
            {
                "id": a.id,
                "surah_id": a.surah_id,
                "ayah_number": a.ayah_number,
                "text_arabic": a.text_arabic,
                "text_turkish": a.text_turkish,
                "juz_number": a.juz_number,
            }
            for a in ayahs
        ]

    total = len(results["surahs"]) + len(results["ayahs"])
    results["total"] = total

    return results
