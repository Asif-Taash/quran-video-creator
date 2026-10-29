from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import sys
from pathlib import Path

scripts_path = str(Path("/app/scripts"))
if scripts_path not in sys.path:
    sys.path.append(scripts_path)

import segment_align

router = APIRouter()


class AlignRequest(BaseModel):
    surah: int
    ayah: int
    # alquran.cloud's Uthmani tokens for the ayah, pause marks included.
    tokens: list[str]
    # The translation, already cut into segments.
    segments: list[str]
    language: str = "tr"


@router.post("/align")
def align_segments(req: AlignRequest):
    """Each segment's Arabic word count -- see scripts/segment_align.py.
    503 when it can't run (e.g. the word glosses are unreachable); the
    caller then falls back to its own, flagged estimate."""
    try:
        return segment_align.align(req.surah, req.ayah, req.tokens, req.segments, req.language)
    except segment_align.AlignUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))
