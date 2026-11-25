"""The memorization page (/hifz): the recitation check (scripts/hifz_check.py,
heard by the Quran ear), at the end of a reading or live while the reader
recites. Listen-and-repeat uses the aligner's cuts (/api/extraction/)."""
import json
import os
import sys
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool

scripts_path = str(Path("/app/scripts"))
if scripts_path not in sys.path:
    sys.path.append(scripts_path)

import hifz_check  # noqa: E402

# A long session read from memory, even as the browser's opus.
MAX_RECORDING_BYTES = 40 * 1024 * 1024

router = APIRouter()


def _expected(raw):
    """The words the reading should hold: [{"a", "i", "t"}] in order."""
    try:
        words = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(words, list) or not 0 < len(words) <= hifz_check.MAX_WORDS:
        return None
    out = []
    for w in words:
        if not isinstance(w, dict):
            return None
        a, i, u = w.get("a"), w.get("i"), w.get("u")
        if not (isinstance(a, int) and isinstance(i, int) and isinstance(u, str) and 0 < len(u) <= 80):
            return None
        out.append({"a": a, "i": i, "u": u})
    return out


def _surah(value):
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if 1 <= n <= 114 else None


@router.post("/check")
async def check_recitation(audio: UploadFile = File(...), expected: str = Form(...), surah: str = Form(...)):
    """A reading of ayahs from memory against the words they should hold ->
    {"words": [{"s": ok|wrong|missing|unread, "h"?, "t0"?, "t1"?,
    "checked"?}], "extras": [{"after", "kind", "h", "t0", "t1"}], "heard",
    "duration", "checked", "seconds"}."""
    words = _expected(expected)
    sura = _surah(surah)
    if words is None or sura is None:
        raise HTTPException(status_code=400, detail="Bad words")
    with tempfile.NamedTemporaryFile(suffix=".audio", delete=False) as f:
        size = 0
        while chunk := await audio.read(1 << 20):
            size += len(chunk)
            if size > MAX_RECORDING_BYTES:
                f.close()
                os.unlink(f.name)
                raise HTTPException(status_code=413, detail="Recording too large")
            f.write(chunk)
        path = f.name
    try:
        if size == 0:
            raise HTTPException(status_code=400, detail="Empty recording")
        return await run_in_threadpool(hifz_check.check, path, words, sura)
    finally:
        os.unlink(path)


# About a second of 16 kHz 16-bit audio per live request, with room.
MAX_LIVE_CHUNK_BYTES = 2 * 1024 * 1024


@router.post("/warm")
async def warm():
    """Loads the Quran ear ahead of a recitation (the page asks when the
    reader opens «سمّع»), so the first words aren't late."""
    hifz_check.warm_soon()
    return {"ok": True}


@router.post("/live")
async def live_start(request: Request):
    """Starts a live check: {"surah", "expected": [{"a", "i", "u"}]} -> {"session"}."""
    body = await request.json()
    words = _expected(json.dumps(body.get("expected"))) if isinstance(body, dict) else None
    sura = _surah(body.get("surah")) if isinstance(body, dict) else None
    if words is None or sura is None:
        raise HTTPException(status_code=400, detail="Bad words")
    return {"session": await run_in_threadpool(hifz_check.live_start, words, sura)}


@router.post("/live/{session}")
async def live_audio(session: str, request: Request, final: int = 0):
    """More of the reading (raw 16 kHz mono int16 PCM in the body) -> the
    reading so far, graded as the final check is ({"words", "extras",
    "stop", "heard", "duration"}); with final=1 the full check of the whole
    recording, and the session ends. 404 for a session that's gone."""
    pcm = await request.body()
    if len(pcm) > MAX_LIVE_CHUNK_BYTES or not session.isalnum():
        raise HTTPException(status_code=400, detail="Bad audio")
    result = await run_in_threadpool(hifz_check.live_audio, session, pcm, bool(final))
    if result is None:
        raise HTTPException(status_code=404, detail="No such session")
    return result
