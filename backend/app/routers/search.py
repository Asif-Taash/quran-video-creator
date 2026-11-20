"""Ayah search by meaning (scripts/ayah_search.py) and by recitation
(scripts/recite_search.py)."""
import os
import sys
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool

scripts_path = str(Path("/app/scripts"))
if scripts_path not in sys.path:
    sys.path.append(scripts_path)

import ayah_search  # noqa: E402
import recite_search  # noqa: E402

MAX_RECORDING_BYTES = 25 * 1024 * 1024

router = APIRouter()


@router.get("/ayahs")
async def search_ayahs(q: str, lang: str = "", limit: int = 30):
    """{"results": [{"surah", "ayah", "score", "translation"}]} best first
    (translation: Turkish for lang=tr, English for en, none otherwise); 503
    until the index is built (see ayah_search.py)."""
    q = q.strip()[:200]
    if not q:
        raise HTTPException(status_code=400, detail="Missing query")
    if not ayah_search.available():
        raise HTTPException(status_code=503, detail="index not built")
    results = await run_in_threadpool(ayah_search.search, q, max(1, min(limit, 60)), lang or None)
    return {"results": [
        {"surah": s, "ayah": a, "score": sc, "translation": ayah_search.translation(s, a, lang)}
        for s, a, sc in results
    ]}


@router.post("/recitation")
async def search_recitation(audio: UploadFile = File(...)):
    """Find ayahs by reciting them (scripts/recite_search.py): a short
    recording from the microphone -> {"heard", "basmala", "results":
    [{"surah", "from", "to", "score"}]} best first."""
    if not recite_search.available():
        raise HTTPException(status_code=503, detail="Quran text not built (see ayah_search.py)")
    data = await audio.read(MAX_RECORDING_BYTES + 1)
    if not data or len(data) > MAX_RECORDING_BYTES:
        raise HTTPException(status_code=400, detail="Bad recording")
    with tempfile.NamedTemporaryFile(suffix=".audio", delete=False) as f:
        f.write(data)
        path = f.name
    try:
        return await run_in_threadpool(recite_search.recognize, path)
    finally:
        os.unlink(path)
