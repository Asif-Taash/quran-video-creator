# KuranNuru Video Creator

A web app that turns a Quran recitation into a ready-to-post video: pick a surah and ayah range and a reciter, and it cuts the exact recitation, times every ayah and word to it, and renders the video with the Mushaf text, a translation and a background.

Everything runs locally on free, open tools: no paid APIs.

## Features

- **Exact ayah clips**: whole-surah recordings of 23 reciters (mp3quran.net, QuranicAudio as a backup) are cut per ayah by CTC forced alignment (torchaudio's MMS_FA), with repeats the reciter goes back to detected and verified by a Quran-tuned faster-whisper model. Your own recording can be uploaded and aligned the same way.
- **Mushaf text**: King Fahd Complex page fonts (QCF v1 2005 / v2 2013), Uthmanic Hafs and other Arabic fonts; optional word-by-word highlight of the recited word.
- **Translations**: Turkish (Diyanet new and old, Süleyman Ateş, Elmalılı), English (Saheeh International, The Clear Quran, Pickthall, Yusuf Ali) and Arabic tafsir (Muyassar, Jalalayn); long ayahs can be split into synchronized segments (LaBSE-assisted).
- **Backgrounds**: a stock library (Pixabay, optionally Pexels) filtered to natural scenery only by local vision models (CLIP + RT-DETR); your own image or video; dim, blur and slow-zoom effects; short videos loop with a crossfade.
- **Output**: portrait, landscape or square, from 144p to 4K, with progress shown while rendering. Logged-in users get a gallery that keeps each project's latest video in sync as they edit.

## Stack

| Part | Technology |
|---|---|
| Frontend + video rendering | Next.js 14, React 18, Remotion 4 (headless Chromium + ffmpeg), Tailwind CSS, Prisma (user accounts) |
| Backend | FastAPI, SQLAlchemy, PyTorch/torchaudio (CUDA), faster-whisper, transformers |
| Database | PostgreSQL 15 |

## Requirements

- Docker with Docker Compose
- An NVIDIA GPU with the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html). The aligner and the background-image check run on it; without one, remove the `deploy:` blocks from `docker-compose.yml` (everything still works, alignment is much slower).
- About 20 GB of disk: the backend image includes CUDA PyTorch, and the models (~5 GB) download into `backend/data/` on first use.

## Getting started

```bash
git clone https://github.com/Asif-Taash/quran-video-creator.git
cd quran-video-creator
```

**1. Settings (optional but recommended)**

- `.env` next to `docker-compose.yml`:
  ```
  AUTH_SECRET=<a long random string>   # signs login sessions
  ```
- `frontend/.env.local`, for the stock background library (a free key from [pixabay.com/api/docs](https://pixabay.com/api/docs/)):
  ```
  PIXABAY_API_KEY=...
  # PEXELS_API_KEY=...   (optional second source)
  ```
  Without a key the library section is simply hidden; your own uploads still work. Don't put these keys in `docker-compose.yml`: an empty value there hides the one in `.env.local`.

**2. Start**

```bash
docker compose up --build
```

The first build takes a while (CUDA PyTorch is ~3 GB).

**3. First run only: create the database tables and Quran data**

```bash
docker compose exec frontend npx prisma migrate deploy        # user accounts
cp frontend/src/data/quran.json backend/data/quran.json        # Mushaf text + page numbers
docker compose exec backend python seed_quran.py               # surahs, ayahs, Turkish text
```

**4. Open** [http://localhost:3000](http://localhost:3000). The backend API docs are at [http://localhost:8000/docs](http://localhost:8000/docs), Postgres at `localhost:5433` (user `user`, password `password`, database `kurannuru`).

## Project layout

```
frontend/
  src/app/              pages and API routes (render, drafts, gallery, auth, backgrounds)
  src/components/       the video-creator wizard and UI
  src/remotion/         the video itself: QuranVideo.tsx (composition), timing.ts, types.ts
  src/lib/              shared logic (reciters, translations, stock backgrounds, ...)
  src/data/             bundled Quran text, QCF v1 text, translations
  public/fonts/         Mushaf page fonts and video fonts
backend/
  app/routers/          FastAPI endpoints (surahs, extraction, segmentation, vision, ai)
  scripts/              quran_aligner.py (current aligner), extract_precise_clip.py (old
                        Whisper pipeline, kept for ALIGN_ENGINE=legacy and shared helpers),
                        segment_align.py, eval_* scripts and their test cases
  seed_quran.py, update_words_data.py, patch_pua_data.py, validate_quran.py
                        one-off database setup/maintenance scripts
  data/                 (git-ignored) model caches, downloaded surah audio, eval audio
```

## Notes

- Both containers run in development mode (`next dev`, `uvicorn --reload`), so code edits apply live.
- Rendered videos are written to an in-memory `public/renders` (512 MB) and the newest few are kept; the gallery keeps its own copies in the `render_assets` volume.
- `docker compose down -v` also deletes the database and saved drafts/gallery; plain `docker compose down` keeps them.
