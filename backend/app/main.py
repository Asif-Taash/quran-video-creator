from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy.exc import OperationalError
import logging
import os

from app.database import engine, Base
from app import models  # noqa: F401 -- registers the tables on Base.metadata; create_all below creates nothing without it

# Create tables. Must not take the whole API down when Postgres is
# unreachable (e.g. the db container didn't come back after a reboot): an
# exception here kills the uvicorn worker while the reloader keeps the
# container "Up", so EVERY endpoint -- including audio extraction, which
# never touches the database -- fails with ECONNREFUSED.
try:
    Base.metadata.create_all(bind=engine)
except OperationalError as e:
    logging.getLogger(__name__).warning(
        "Database unavailable at startup; DB-backed endpoints will fail until it is up: %s", e
    )

app = FastAPI(
    title="Kuran Nuru API",
    description="Kur'an-ı Kerim veritabanı — Uthmânî metin, Türkçe çeviri, ses dosyaları.",
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

# ── Static files ──────────────────────────────────────────────────────────────
os.makedirs("app/static/audio", exist_ok=True)
os.makedirs("app/static/text", exist_ok=True)
app.mount("/static", StaticFiles(directory="app/static"), name="static")

from app.routers import surahs, ayahs, extraction, ai, vision, segmentation

# ── Routers ───────────────────────────────────────────────────────────────────
app.include_router(surahs.router, prefix="/api/surahs", tags=["Surahs"])
app.include_router(ayahs.router, prefix="/api/ayahs", tags=["Ayahs"])
app.include_router(extraction.router, prefix="/api/extraction", tags=["Extraction"])
app.include_router(ai.router, prefix="/api/ai", tags=["AI"])
app.include_router(vision.router, prefix="/api/vision", tags=["Vision"])
app.include_router(segmentation.router, prefix="/api/segmentation", tags=["Segmentation"])


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
