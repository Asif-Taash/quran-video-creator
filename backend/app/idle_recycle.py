"""Gives the AI models' memory back to the laptop when nobody is using them.

The models stay loaded between requests so the next one starts fast, but that
held up to 4 GB all day. Unloading them one by one would still leave torch and
CUDA behind, so the worker simply exits: dev_server.py starts a fresh one
(about 150 MB) and the next request loads what it needs again.

Only active under dev_server.py (WORKER_RESPAWNS): under plain uvicorn nothing
would start the worker again.
"""
import logging
import os
import signal
import threading
import time

IDLE_SEC = float(os.getenv("IDLE_RECYCLE_SEC", "600"))
# Below this no model is loaded, so a restart would give nothing back.
MIN_RSS_MB = float(os.getenv("IDLE_RECYCLE_MIN_RSS_MB", "800"))
# The routes that can load a model; others don't count as using one.
MODEL_PATHS = ("/api/extraction", "/api/vision", "/api/enhance", "/api/segmentation")

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_in_flight = 0
_last_use = time.monotonic()


def _rss_mb():
    with open("/proc/self/status") as f:
        for line in f:
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) / 1024
    return 0.0


def _watch():
    while True:
        time.sleep(min(30.0, IDLE_SEC / 2))
        with _lock:
            idle = _in_flight == 0 and time.monotonic() - _last_use >= IDLE_SEC
        if idle and (rss := _rss_mb()) >= MIN_RSS_MB:
            logger.warning("Models unused for %.0fs, restarting the worker to free %.0f MB.", IDLE_SEC, rss)
            os.kill(os.getpid(), signal.SIGTERM)
            return


def start():
    if os.getenv("WORKER_RESPAWNS"):
        threading.Thread(target=_watch, daemon=True).start()


class Middleware:
    """Tracks running requests, which includes every extraction job: a job
    runs inside its request, even after the client gave up on it."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        global _in_flight, _last_use
        with _lock:
            _in_flight += 1
        try:
            await self.app(scope, receive, send)
        finally:
            with _lock:
                _in_flight -= 1
                if scope["path"].startswith(MODEL_PATHS):
                    _last_use = time.monotonic()
