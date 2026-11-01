"""Sharper photo backgrounds: a picked or uploaded photo too small for the
video is upscaled with Real-ESRGAN (realesr-general-x4v3, BSD-3-Clause,
runs locally) instead of being stretched by the plain resize the video
would otherwise do.

Why: Pixabay serves photos at 1280 px at most, and a landscape photo in a
portrait 1080x1920 video is shown 2.25x enlarged -- visibly soft. Checked
on real library photos (forest, waves, rock, starry skies): the general
model is crisp and natural where RealESRGAN_x4plus looked painted (and is
~14x slower); at full denoise strength it wiped faint stars, so it runs at
half strength (Real-ESRGAN's own default: its weights blended with the
"-wdn" ones), which keeps them.
"""
import hashlib
import io
import logging
import os
import threading
import time
import urllib.request

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response

logger = logging.getLogger(__name__)
router = APIRouter()

MODEL_DIR = "/app/data/sr_models"
RELEASE = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0"
WEIGHTS = {
    "realesr-general-x4v3.pth": "8dc7edb9ac80ccdc30c3a5dca6616509367f05fbc184ad95b731f05bece96292",
    "realesr-general-wdn-x4v3.pth": "1641f8c4464b9f097c9fdda5589273713f67cf59f3d909e0bd688f0cee269dca",
}
DENOISE = 0.5

# A photo whose short side reaches SKIP_SHORT_SIDE already covers a 1080p
# export in any shape (portrait's 1920 height on a landscape photo) and is
# returned as it is; a smaller one is upscaled (4x at most) to
# TARGET_SHORT_SIDE, which leaves room for the slow zoom.
SKIP_SHORT_SIDE = 1920
TARGET_SHORT_SIDE = 2160
# The 4x intermediate is 16x the photo's pixels, so very large inputs
# (panoramas) are left alone.
MAX_INPUT_PIXELS = 6_000_000
MAX_BYTES = 30 * 1024 * 1024
TILE = 384
TILE_PAD = 16

CACHE_DIR = "/app/data/enhance_cache"
CACHE_MAX_FILES = 60
# Part of every cache key: bump when the output changes.
ENHANCE_VERSION = "v1"

_model = None
_model_lock = threading.Lock()
# One photo at a time: each holds a few hundred MB while it is upscaled.
_run_lock = threading.Lock()


def _weights(name):
    path = os.path.join(MODEL_DIR, name)
    if not os.path.exists(path):
        os.makedirs(MODEL_DIR, exist_ok=True)
        tmp = f"{path}.{os.getpid()}.part"
        with urllib.request.urlopen(f"{RELEASE}/{name}", timeout=120) as res, open(tmp, "wb") as out:
            out.write(res.read())
        with open(tmp, "rb") as f:
            digest = hashlib.sha256(f.read()).hexdigest()
        if digest != WEIGHTS[name]:
            os.remove(tmp)
            raise RuntimeError(f"{name}: unexpected checksum {digest}")
        os.replace(tmp, path)
    return path


def _load_model():
    """(model, torch, device, dtype): SRVGGNetCompact, 4x, weights blended
    at DENOISE."""
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                import torch
                import torch.nn as nn
                import torch.nn.functional as F

                class Compact(nn.Module):
                    # SRVGGNetCompact (Real-ESRGAN): 32 convs at the input's
                    # size, then pixel shuffle onto a nearest-neighbour base.
                    def __init__(self, feat=64, convs=32, up=4):
                        super().__init__()
                        self.up = up
                        layers = [nn.Conv2d(3, feat, 3, 1, 1), nn.PReLU(feat)]
                        for _ in range(convs):
                            layers += [nn.Conv2d(feat, feat, 3, 1, 1), nn.PReLU(feat)]
                        layers.append(nn.Conv2d(feat, 3 * up * up, 3, 1, 1))
                        self.body = nn.ModuleList(layers)
                        self.upsampler = nn.PixelShuffle(up)

                    def forward(self, x):
                        out = x
                        for layer in self.body:
                            out = layer(out)
                        return self.upsampler(out) + F.interpolate(x, scale_factor=self.up, mode="nearest")

                t0 = time.time()
                load = lambda name: torch.load(_weights(name), map_location="cpu", weights_only=True)["params"]  # noqa: E731
                strong, weak = load("realesr-general-x4v3.pth"), load("realesr-general-wdn-x4v3.pth")
                model = Compact()
                model.load_state_dict({k: DENOISE * v + (1 - DENOISE) * weak[k] for k, v in strong.items()})
                device = "cuda" if torch.cuda.is_available() else "cpu"
                dtype = torch.float16 if device == "cuda" else torch.float32
                _model = (model.eval().to(device, dtype), torch, device, dtype)
                logger.info(f"Background upscaler ready on {device} in {time.time() - t0:.1f}s.")
    return _model


def _upscale4(img, model, torch, device, dtype):
    """PIL RGB -> PIL RGB at 4x, tile by tile (each tile padded so the seams
    don't show)."""
    import numpy as np
    from PIL import Image

    x = torch.from_numpy(np.array(img)).permute(2, 0, 1)[None]
    _, _, h, w = x.shape
    out = np.empty((h * 4, w * 4, 3), dtype=np.uint8)
    with torch.inference_mode():
        for y0 in range(0, h, TILE):
            for x0 in range(0, w, TILE):
                y1, x1 = min(h, y0 + TILE), min(w, x0 + TILE)
                py0, px0, py1, px1 = max(0, y0 - TILE_PAD), max(0, x0 - TILE_PAD), min(h, y1 + TILE_PAD), min(w, x1 + TILE_PAD)
                tile = x[:, :, py0:py1, px0:px1].to(device, dtype) / 255.0
                up = model(tile)[0, :, (y0 - py0) * 4:(y1 - py0) * 4, (x0 - px0) * 4:(x1 - px0) * 4]
                out[y0 * 4:y1 * 4, x0 * 4:x1 * 4] = (up.float().clamp(0, 1) * 255.0).round().byte().permute(1, 2, 0).cpu().numpy()
    return Image.fromarray(out)


def _enhance(data):
    """JPEG bytes of the sharper photo, or None when it is already big
    enough (or too big to upscale)."""
    from PIL import Image, ImageOps

    img = Image.open(io.BytesIO(data))
    if img.width * img.height > MAX_INPUT_PIXELS:
        return None
    # A colour profile only still fits once the pixels are RGB.
    icc = img.info.get("icc_profile") if img.mode == "RGB" else None
    # Phone photos are stored sideways with an EXIF turn the browser applies;
    # the JPEG written below has no EXIF, so the turn is applied here.
    img = ImageOps.exif_transpose(img)
    short = min(img.size)
    if short >= SKIP_SHORT_SIDE or short < 16:
        return None
    if img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info):
        # Over black, as the video shows a see-through photo.
        rgba = img.convert("RGBA")
        img = Image.new("RGB", rgba.size, (0, 0, 0))
        img.paste(rgba, mask=rgba.getchannel("A"))
    else:
        img = img.convert("RGB")

    model, torch, device, dtype = _load_model()
    with _run_lock:
        t0 = time.time()
        try:
            up = _upscale4(img, model, torch, device, dtype)
        except torch.cuda.OutOfMemoryError:
            # The GPU also holds the aligner, Whisper and the image check.
            # The photo stays as it is: on the CPU it would take minutes.
            logger.warning("Background upscaler: GPU memory full, photo left as it is.")
            return None
        finally:
            if device == "cuda":
                torch.cuda.empty_cache()
    scale = min(4.0, TARGET_SHORT_SIDE / short)
    size = (round(img.width * scale), round(img.height * scale))
    if size != up.size:
        up = up.resize(size, Image.LANCZOS)
    buf = io.BytesIO()
    up.save(buf, "JPEG", quality=92, optimize=True, **({"icc_profile": icc} if icc else {}))
    logger.info(f"Background upscaled {img.size} -> {size} in {time.time() - t0:.1f}s on {device}.")
    return buf.getvalue()


def _prune_cache():
    files = sorted((os.path.join(CACHE_DIR, f) for f in os.listdir(CACHE_DIR)), key=os.path.getmtime)
    for path in files[:-CACHE_MAX_FILES]:
        try:
            os.remove(path)
        except OSError:
            pass


@router.post("/image")
def enhance_image(file: UploadFile = File(...)):
    """The photo upscaled as JPEG, or 204 when it is already sharp enough
    for the video."""
    data = file.file.read(MAX_BYTES + 1)
    if not data or len(data) > MAX_BYTES:
        raise HTTPException(status_code=413 if data else 400, detail="Photo missing or too large")
    key = hashlib.sha256(data + f"|{ENHANCE_VERSION}|{DENOISE}|{TARGET_SHORT_SIDE}".encode()).hexdigest()
    cached = os.path.join(CACHE_DIR, f"{key}.jpg")
    if os.path.exists(cached):
        os.utime(cached)
        with open(cached, "rb") as f:
            return Response(content=f.read(), media_type="image/jpeg")
    from PIL import UnidentifiedImageError

    try:
        out = _enhance(data)
    except UnidentifiedImageError:
        raise HTTPException(status_code=400, detail="Unreadable photo")
    except Exception as e:
        logger.exception("Background upscale failed")
        raise HTTPException(status_code=503, detail=f"Upscale failed: {e}")
    if out is None:
        return Response(status_code=204)
    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = f"{cached}.{os.getpid()}.part"
    with open(tmp, "wb") as f:
        f.write(out)
    os.replace(tmp, cached)
    _prune_cache()
    return Response(content=out, media_type="image/jpeg")
