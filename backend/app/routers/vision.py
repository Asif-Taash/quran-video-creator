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
                }
                logger.info(f"Vision models ready on {device} in {time.time() - t0:.1f}s.")
    return _models


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
    """[(ok, reason)] for decoded PIL images."""
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
        for i in range(0, len(views), 64):
            pix = torch.stack(views[i:i + 64]).to(dtype)
            emb = m["clip"].visual_projection(m["clip"].vision_model(pixel_values=pix).pooler_output)
            emb = emb / emb.norm(dim=-1, keepdim=True)
            best.append((m["logit_scale"] * emb @ m["text"].T).float())
        logits = torch.cat(best).view(len(images), 5, -1)
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
        results.append((reason is None, reason))
    return results


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
    """{key: {"ok": bool, "reason": str|None}} for each item's image URL. An
    image that can't be fetched/decoded is reported not ok (and not cached),
    so nothing unchecked is ever shown."""
    cache = _load_cache()
    out = {}
    todo = []
    with _cache_lock:
        for it in req.items:
            hit = cache.get(it.key)
            if hit and hit.get("v") == VISION_VERSION:
                out[it.key] = {"ok": hit["ok"], "reason": hit.get("reason")}
            else:
                todo.append(it)
    if todo:
        with ThreadPoolExecutor(12) as ex:
            images = list(ex.map(lambda it: _fetch(it.url), todo))
        good = [(it, im) for it, im in zip(todo, images) if im is not None]
        for it, im in zip(todo, images):
            if im is None:
                out[it.key] = {"ok": False, "reason": "unreadable"}
        if good:
            t0 = time.time()
            try:
                verdicts = _classify([im for _, im in good])
            except Exception as e:
                logger.exception("Vision check failed")
                raise HTTPException(status_code=503, detail=f"Vision check failed: {e}")
            logger.info(f"Vision check: {len(good)} images in {time.time() - t0:.2f}s, "
                        f"{sum(1 for ok, _ in verdicts if not ok)} rejected.")
            with _cache_lock:
                for (it, _), (ok, reason) in zip(good, verdicts):
                    out[it.key] = {"ok": ok, "reason": reason}
                    cache[it.key] = {"ok": ok, "reason": reason, "v": VISION_VERSION}
                _save_cache()
    return {"results": out}


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
    reason = next((r for ok, r in verdicts if not ok), None)
    ok = reason is None
    cache = _load_cache()
    with _cache_lock:
        cache[key] = {"ok": ok, "reason": reason, "v": VISION_VERSION, "full": True}
        _save_cache()
    logger.info(f"Vision frame check {key}: {len(images)} frames, ok={ok} {reason or ''}")
    return {"ok": ok, "reason": reason}
