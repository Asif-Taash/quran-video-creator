"""Image check for the background library: is this natural scenery only?

The user's rule: a background shows nature only -- no people, no buildings
(mosques included), no vehicles, no animals. Stock tags alone can't enforce
it (photographers rarely tag the hiker on the ridge or the village in the
valley), so every image the picker would show is looked at:

- CLIP (zero-shot) compares the image, and four zoomed-in quarters of it --
  small houses only register once enlarged -- against descriptions of
  natural scenes and of man-made things/people/animals. An image is
  rejected when its best "not nature" description beats all the nature ones
  combined by CLIP_REJECT on any view.
- RT-DETR (COCO object detector) finds the small things CLIP misses on a
  whole image: a tiny hiker, swimmers, a car, birds on a lake. Per-class
  confidence thresholds -- people lowest, since they matter most.

Strict on purpose (calibrated on ~230 real Pixabay nature results): it also
turns away some clean images, never the other way round as far as the
calibration showed. Verdicts are cached on disk by item key, so an image is
only ever checked once.

Each image also gets a beauty score (2026-11-20): the LAION "improved
aesthetic predictor" (Apache-2.0, a small linear head on the same CLIP
ViT-L/14 image embedding, so it costs almost nothing extra), roughly 1-10.
The search shows the most beautiful results of each batch first.

Each image also gets a fingerprint (see fingerprint()), which the frontend
compares with the backgrounds of exported videos so the library never offers
one again (frontend/src/lib/usedBackgrounds.ts).
"""
import io
import json
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import httpx
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

os.environ.setdefault("HF_HOME", "/app/data/huggingface_cache")

logger = logging.getLogger(__name__)
router = APIRouter()

# Bumped whenever the decision rule changes, so older cached verdicts are
# re-checked instead of trusted.
VISION_VERSION = "v2"
CACHE_PATH = "/app/data/vision_cache.json"

CLIP_MODEL = "openai/clip-vit-large-patch14"
DETECTOR_MODEL = "PekingU/rtdetr_v2_r50vd"
CLIP_REJECT = 0.30
AESTHETIC_PATH = "/app/data/aesthetic/sac+logos+ava1-l14-linearMSE.pth"
AESTHETIC_SHA256 = "21dd590f3ccdc646f0d53120778b296013b096a035a2718c9cb0d511bff0f1e0"

NATURE = [
    "the sky", "clouds", "the sea", "waves", "mountains", "a forest", "trees", "a desert", "sand dunes",
    "stars at night", "the milky way", "a waterfall", "a river", "a lake", "rain", "snow", "a sunset", "fog",
    "flowers", "grass", "rocks", "a beach", "a valley",
]
NOT_NATURE = [
    "a building", "a house", "a cabin", "houses", "a city", "a town", "a village", "a skyline", "a bridge",
    "a tower", "a road", "a path", "railway tracks", "a fence", "a wall", "a pier", "a lighthouse", "a temple",
    "a church", "a mosque", "a castle", "power lines", "a windmill", "a tent", "a boat", "a ship", "a car",
    "an airplane", "a person", "people", "an animal", "a bird",
    # Caught nothing above in a real search: a masked figure filling half a
    # desert shot, a snowman figurine; shell/starfish piles aren't scenery.
    "a mask", "a face", "a statue", "a sculpture", "a figurine", "a toy", "a doll", "a snowman", "a costume",
    "a robot", "christmas decorations", "a decoration", "a skull", "seashells", "a starfish", "a snail",
    "an insect", "a product",
]

PERSON_MIN = 0.30
DETECTOR_MIN = {
    **{c: 0.50 for c in ("bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat")},
    **{c: 0.60 for c in ("bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe")},
    **{c: 0.50 for c in ("bench", "umbrella", "kite", "surfboard", "skis", "snowboard", "skateboard", "chair")},
}

_models = None
_models_lock = threading.Lock()
_gpu_lock = threading.Lock()
_cache = None
_cache_lock = threading.Lock()


def _load_models():
    global _models
    if _models is None:
        with _models_lock:
            if _models is None:
                import torch
                from transformers import AutoImageProcessor, AutoModelForObjectDetection, CLIPModel, CLIPProcessor

                device = "cuda" if torch.cuda.is_available() else "cpu"
                dtype = torch.float16 if device == "cuda" else torch.float32
                t0 = time.time()
                clip = CLIPModel.from_pretrained(CLIP_MODEL, dtype=dtype).to(device).eval()
                clip_proc = CLIPProcessor.from_pretrained(CLIP_MODEL)
                prompts = [f"a photo of {p}" for p in NATURE + NOT_NATURE]
                with torch.no_grad():
                    t = clip_proc(text=prompts, return_tensors="pt", padding=True).to(device)
                    text = clip.text_projection(clip.text_model(**t).pooler_output)
                    text = text / text.norm(dim=-1, keepdim=True)
                det_proc = AutoImageProcessor.from_pretrained(DETECTOR_MODEL)
                det = AutoModelForObjectDetection.from_pretrained(DETECTOR_MODEL, dtype=dtype).to(device).eval()
                _models = {
                    "torch": torch, "device": device, "dtype": dtype, "clip": clip, "text": text,
                    "logit_scale": clip.logit_scale.exp(), "det": det, "det_proc": det_proc,
                    "aesthetic": _load_aesthetic(torch, device),
                }
                logger.info(f"Vision models ready on {device} in {time.time() - t0:.1f}s.")
    return _models


def _load_aesthetic(torch, device):
    """The aesthetic head: 768 -> 1024 -> 128 -> 64 -> 16 -> 1, all linear
    (the published model has no activations). None when the weights are
    missing or not the expected file -- results are then simply unranked."""
    import hashlib

    try:
        with open(AESTHETIC_PATH, "rb") as f:
            raw = f.read()
        if hashlib.sha256(raw).hexdigest() != AESTHETIC_SHA256:
            logger.warning("Aesthetic weights don't match the expected file; results stay unranked.")
            return None
        sd = torch.load(io.BytesIO(raw), map_location="cpu", weights_only=True)
        head = torch.nn.Sequential(
            torch.nn.Linear(768, 1024), torch.nn.Identity(), torch.nn.Linear(1024, 128), torch.nn.Identity(),
            torch.nn.Linear(128, 64), torch.nn.Identity(), torch.nn.Linear(64, 16), torch.nn.Linear(16, 1),
        )
        head.load_state_dict({k.replace("layers.", ""): v for k, v in sd.items()})
        return head.to(device).float().eval()
    except FileNotFoundError:
        logger.warning(f"No aesthetic weights at {AESTHETIC_PATH}; results stay unranked.")
    except Exception:
        logger.exception("Aesthetic weights unreadable; results stay unranked.")
    return None


def _aesthetic_scores(m, full_emb):
    """Scores for L2-normalised full-image CLIP embeddings [n, 768]."""
    if m["aesthetic"] is None:
        return [None] * len(full_emb)
    return [round(float(x), 2) for x in m["aesthetic"](full_emb.float()).flatten()]


def _clip_views(m, img_u8):
    """Full image + its four quarters, each CLIP-preprocessed on the GPU
    (resize shorter side to 224, center crop, normalize)."""
    torch = m["torch"]
    F = torch.nn.functional
    h, w = img_u8.shape[1:]
    crops = [img_u8] + [img_u8[:, y:y + h // 2, x:x + w // 2] for y in (0, h // 2) for x in (0, w // 2)]
    mean = torch.tensor([0.48145466, 0.4578275, 0.40821073], device=img_u8.device).view(3, 1, 1)
    std = torch.tensor([0.26862954, 0.26130258, 0.27577711], device=img_u8.device).view(3, 1, 1)
    out = []
    for c in crops:
        ch, cw = c.shape[1:]
        s = 224 / min(ch, cw)
        nh, nw = max(224, round(ch * s)), max(224, round(cw * s))
        r = F.interpolate(c.unsqueeze(0).float(), size=(nh, nw), mode="bicubic", antialias=True, align_corners=False)[0]
        y0, x0 = (nh - 224) // 2, (nw - 224) // 2
        r = r[:, y0:y0 + 224, x0:x0 + 224].clamp(0, 255) / 255.0
        out.append((r - mean) / std)
    return out


# Images per GPU pass. The GPU also holds the aligner's and Whisper's models
# (see scripts/quran_aligner.py), so passes stay small.
CHUNK = 8


def _classify(images):
    """[(ok, reason, aesthetic)] for decoded PIL images."""
    m = _load_models()
    results = []
    with _gpu_lock:
        try:
            for i in range(0, len(images), CHUNK):
                results.extend(_classify_chunk(m, images[i:i + CHUNK]))
        finally:
            if m["device"] == "cuda":
                m["torch"].cuda.empty_cache()
    return results


def _classify_chunk(m, images):
    import numpy as np

    torch, device, dtype = m["torch"], m["device"], m["dtype"]
    tensors = [torch.from_numpy(np.asarray(im.convert("RGB"))).to(device).permute(2, 0, 1) for im in images]
    nn = len(NATURE)
    results = []
    with torch.no_grad():
        # CLIP on 5 views per image.
        views = [v for t in tensors for v in _clip_views(m, t)]
        best = []
        embs = []
        for i in range(0, len(views), 64):
            pix = torch.stack(views[i:i + 64]).to(dtype)
            emb = m["clip"].visual_projection(m["clip"].vision_model(pixel_values=pix).pooler_output)
            emb = emb / emb.norm(dim=-1, keepdim=True)
            embs.append(emb)
            best.append((m["logit_scale"] * emb @ m["text"].T).float())
        logits = torch.cat(best).view(len(images), 5, -1)
        # The full image is each image's first view.
        aesthetic = _aesthetic_scores(m, torch.cat(embs)[0::5])
        nat = torch.logsumexp(logits[:, :, :nn], -1)
        bad_logit, bad_idx = logits[:, :, nn:].max(-1)
        p_bad = torch.sigmoid(bad_logit - nat)  # [image, view]
        p_max, view = p_bad.max(-1)

        # RT-DETR on the whole image (preprocessing on the GPU, per its processor config).
        proc = m["det_proc"]
        size = (proc.size["height"], proc.size["width"])
        batch = torch.stack([
            torch.nn.functional.interpolate(t.unsqueeze(0).float(), size=size, mode="bilinear", align_corners=False)[0] / 255.0
            for t in tensors
        ])
        if getattr(proc, "do_normalize", False):
            mean = torch.tensor(proc.image_mean, device=device).view(1, 3, 1, 1)
            std = torch.tensor(proc.image_std, device=device).view(1, 3, 1, 1)
            batch = (batch - mean) / std
        det_out = m["det"](pixel_values=batch.to(dtype))
        dets = proc.post_process_object_detection(det_out, threshold=PERSON_MIN, target_sizes=[t.shape[1:] for t in tensors])

    labels = m["det"].config.id2label
    for k in range(len(images)):
        reason = None
        if float(p_max[k]) >= CLIP_REJECT:
            reason = f"clip:{NOT_NATURE[int(bad_idx[k, int(view[k])])]}:{float(p_max[k]):.2f}"
        else:
            for score, label in zip(dets[k]["scores"], dets[k]["labels"]):
                name = labels[int(label)]
                need = PERSON_MIN if name == "person" else DETECTOR_MIN.get(name)
                if need is not None and float(score) >= need:
                    reason = f"object:{name}:{float(score):.2f}"
                    break
        results.append((reason is None, reason, aesthetic[k]))
    return results


def _score_only(images):
    """Aesthetic scores alone (CLIP on the full image), for images judged
    before scores existed."""
    import numpy as np

    m = _load_models()
    torch, device, dtype = m["torch"], m["device"], m["dtype"]
    out = []
    with _gpu_lock:
        try:
            with torch.no_grad():
                for i in range(0, len(images), 32):
                    views = [_clip_views(m, torch.from_numpy(np.asarray(im.convert("RGB"))).to(device).permute(2, 0, 1))[0]
                             for im in images[i:i + 32]]
                    emb = m["clip"].visual_projection(m["clip"].vision_model(pixel_values=torch.stack(views).to(dtype)).pooler_output)
                    out.extend(_aesthetic_scores(m, emb / emb.norm(dim=-1, keepdim=True)))
        finally:
            if device == "cuda":
                torch.cuda.empty_cache()
    return out


# --- Fingerprints -------------------------------------------------------------
# A background that went into an exported video must never be offered again:
# the user publishes the videos, and the same picture in two of them is a
# rights problem. Pixabay often carries one picture under several ids (or the
# same id comes back in another search), and an export holds a resized,
# upscaled copy, so the picture itself is compared, not its id.
#
# pHash at 256 bits: the 16x16 lowest frequencies of a 64x64 grayscale DCT,
# one bit each for above/below their median. Measured 2026-11-13 on real
# Pixabay data, distances out of 256:
# - same photo, 640 px thumbnail vs 1280 px download vs Real-ESRGAN 2160 px
#   (what an export holds): 0-8; the 14 exported backgrounds vs their
#   thumbnails in a fresh search: 0-20;
# - two different photos: never under 80 (117,370 pairs of 485 photos);
# - a video's thumbnail vs its own frames at 1 fps: 0-32 for 21 of 24
#   videos (46, 62, 76 for the rest, whose scenes change a lot); vs other
#   videos' frames: never under 86.
# 64-bit pHash separated much worse (different photos down to 10).
# A mirrored copy is a different hash (26-32 at 64 bits); fingerprint
# callers that need it ask for both.
_FP_SIZE = 64
_FP_KEEP = 16
_fp_dct = None


def fingerprint(img) -> str:
    """256-bit perceptual hash of a PIL image, as 64 hex digits."""
    global _fp_dct
    import numpy as np
    from PIL import Image

    if _fp_dct is None:
        k = np.arange(_FP_SIZE)[:, None]
        i = np.arange(_FP_SIZE)[None, :]
        m = np.sqrt(2.0 / _FP_SIZE) * np.cos(np.pi * (2 * i + 1) * k / (2 * _FP_SIZE))
        m[0] /= np.sqrt(2.0)
        _fp_dct = m
    gray = np.asarray(img.convert("L").resize((_FP_SIZE, _FP_SIZE), Image.LANCZOS), dtype=np.float64)
    low = (_fp_dct @ gray @ _fp_dct.T)[:_FP_KEEP, :_FP_KEEP].flatten()
    bits = low > np.median(low[1:])
    bits[0] = False  # overall brightness, not shape
    return np.packbits(bits).tobytes().hex()


def _load_cache():
    global _cache
    if _cache is None:
        try:
            with open(CACHE_PATH, "r", encoding="utf-8") as f:
                _cache = json.load(f)
        except Exception:
            _cache = {}
    return _cache


def _save_cache():
    tmp = CACHE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(_cache, f)
    os.replace(tmp, CACHE_PATH)


def _fetch(url):
    from PIL import Image

    for attempt in range(3):
        try:
            r = httpx.get(url, timeout=20, follow_redirects=True, headers={"User-Agent": "Mozilla/5.0"})
            r.raise_for_status()
            return Image.open(io.BytesIO(r.content)).convert("RGB")
        except Exception:
            if attempt == 2:
                return None
            time.sleep(0.5)


class CheckItem(BaseModel):
    key: str
    url: str


class CheckRequest(BaseModel):
    items: list[CheckItem]


@router.post("/check")
def check_urls(req: CheckRequest):
    """{key: {"ok": bool, "reason": str|None, "hash": str|None,
    "aesthetic": float|None}} for each item's image URL, hash being its
    fingerprint() and aesthetic its beauty score. An image that can't be
    fetched/decoded is reported not ok (and not cached), so nothing unchecked
    is ever shown; an ok one whose fingerprint couldn't be taken has hash
    None, and the frontend doesn't show it either."""
    cache = _load_cache()
    out = {}
    todo = []
    # Judged before fingerprints/scores existed: only those are missing.
    unhashed = []
    with _cache_lock:
        for it in req.items:
            hit = cache.get(it.key)
            if hit and hit.get("v") == VISION_VERSION:
                out[it.key] = {"ok": hit["ok"], "reason": hit.get("reason"), "hash": hit.get("h"), "aesthetic": hit.get("a")}
                if hit["ok"] and (not hit.get("h") or ("a" not in hit and os.path.exists(AESTHETIC_PATH))):
                    unhashed.append(it)
            else:
                todo.append(it)
    if not todo and not unhashed:
        return {"results": out}
    with ThreadPoolExecutor(12) as ex:
        images = list(ex.map(lambda it: _fetch(it.url), todo + unhashed))
    todo_images, unhashed_images = images[:len(todo)], images[len(todo):]

    found = [(it, im) for it, im in zip(unhashed, unhashed_images) if im is not None]
    try:
        scores = _score_only([im for _, im in found]) if found else []
    except Exception:
        logger.exception("Aesthetic scoring failed")
        scores = [None] * len(found)
    with _cache_lock:
        for (it, im), score in zip(found, scores):
            entry = cache.get(it.key)
            h = (entry or {}).get("h") or fingerprint(im)
            out[it.key]["hash"] = h
            out[it.key]["aesthetic"] = score
            if entry is not None:
                entry["h"] = h
                if score is not None:
                    entry["a"] = score
        if found:
            _save_cache()

    if todo:
        good = [(it, im) for it, im in zip(todo, todo_images) if im is not None]
        for it, im in zip(todo, todo_images):
            if im is None:
                out[it.key] = {"ok": False, "reason": "unreadable", "hash": None}
        if good:
            t0 = time.time()
            try:
                verdicts = _classify([im for _, im in good])
            except Exception as e:
                logger.exception("Vision check failed")
                raise HTTPException(status_code=503, detail=f"Vision check failed: {e}")
            logger.info(f"Vision check: {len(good)} images in {time.time() - t0:.2f}s, "
                        f"{sum(1 for ok, _, _ in verdicts if not ok)} rejected.")
            hashes = [fingerprint(im) for _, im in good]
            with _cache_lock:
                for (it, _), (ok, reason, score), h in zip(good, verdicts, hashes):
                    out[it.key] = {"ok": ok, "reason": reason, "hash": h, "aesthetic": score}
                    cache[it.key] = {"ok": ok, "reason": reason, "v": VISION_VERSION, "h": h,
                                     **({"a": score} if score is not None else {})}
                _save_cache()
    return {"results": out}


@router.post("/fingerprint")
def fingerprint_images(frames: list[UploadFile] = File(...), mirror: bool = Form(False)):
    """{"hashes": [...]}: fingerprint() of each image -- a background that
    went into an exported video, or frames of a background video. With
    mirror, each image's mirrored copy too (a flipped re-upload)."""
    from PIL import Image, ImageOps

    if not frames or len(frames) > 200:
        raise HTTPException(status_code=400, detail="Send 1-200 images")
    hashes = []
    for f in frames:
        try:
            im = Image.open(io.BytesIO(f.file.read())).convert("RGB")
        except Exception:
            raise HTTPException(status_code=400, detail="Unreadable image")
        hashes.append(fingerprint(im))
        if mirror:
            hashes.append(fingerprint(ImageOps.mirror(im)))
    return {"hashes": hashes}


@router.post("/check-frames")
def check_frames(key: str = Form(...), frames: list[UploadFile] = File(...)):
    """One verdict for several frames of the same picked file (a video, or a
    photo at full size): ok only if every frame is. The verdict replaces the
    item's thumbnail-based one in the cache, so a rejected pick never shows
    up in a search again."""
    from PIL import Image

    images = []
    for f in frames:
        try:
            images.append(Image.open(io.BytesIO(f.file.read())).convert("RGB"))
        except Exception:
            raise HTTPException(status_code=400, detail="Unreadable frame")
    if not images:
        raise HTTPException(status_code=400, detail="No frames")
    try:
        verdicts = _classify(images)
    except Exception as e:
        logger.exception("Vision frame check failed")
        raise HTTPException(status_code=503, detail=f"Vision check failed: {e}")
    reason = next((r for ok, r, _ in verdicts if not ok), None)
    ok = reason is None
    cache = _load_cache()
    with _cache_lock:
        # The thumbnail's fingerprint and score stay: searches compare thumbnails.
        prev = cache.get(key) or {}
        cache[key] = {"ok": ok, "reason": reason, "v": VISION_VERSION, "full": True,
                      **({"h": prev["h"]} if prev.get("h") else {}), **({"a": prev["a"]} if "a" in prev else {})}
        _save_cache()
    logger.info(f"Vision frame check {key}: {len(images)} frames, ok={ok} {reason or ''}")
    return {"ok": ok, "reason": reason}
