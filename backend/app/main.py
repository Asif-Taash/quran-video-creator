from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import os

from app import idle_recycle

# No database: the Quran text is bundled with the frontend (quran.json), and
# the Postgres surah/ayah tables this API used to serve were never filled.
app = FastAPI(
    title="Kuran Nuru API",
    description="Ayah audio alignment, translation segmentation and background checks.",
    version="1.0.0",
)

# ── CORS ──────────────────────────────────────────────────────────────────────
# In production, restrict to your actual domain(s) via env var
_raw_origins = os.getenv("CORS_ORIGINS", "*")
allow_origins = [o.strip() for o in _raw_origins.split(",")]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],  # Allow GET, POST, DELETE for public API
    allow_headers=["*"],
)
app.add_middleware(idle_recycle.Middleware)
idle_recycle.start()

from app.routers import extraction, ai, vision, segmentation, enhance, search

# ── Routers ───────────────────────────────────────────────────────────────────
app.include_router(extraction.router, prefix="/api/extraction", tags=["Extraction"])
app.include_router(ai.router, prefix="/api/ai", tags=["AI"])
app.include_router(vision.router, prefix="/api/vision", tags=["Vision"])
app.include_router(segmentation.router, prefix="/api/segmentation", tags=["Segmentation"])
app.include_router(enhance.router, prefix="/api/enhance", tags=["Enhance"])
app.include_router(search.router, prefix="/api/search", tags=["Search"])


@app.get("/", tags=["Root"])
def read_root():
    return {
        "message": "Kuran Nuru API — hoş geldiniz",
        "docs": "/docs",
        "version": "1.0.0",
    }


@app.get("/health", tags=["Health"])
def health_check():
    return {"status": "ok"}
