"""A live recitation (the memorization page) goes before background work.

2026-11-26: a recitation from the phone while a video's audio was being
prepared (Al-Rahman, the whole surah aligned) got an update every 2.7 s
instead of every 0.3 s: the preparation took 7 CPU cores and the GPU, and
each live pass took 0.9 s instead of 0.13 s. The live check marks itself
active with every bit of audio; heavy background steps (the aligner's GPU
passes, Whisper, the path search) wait at their start while it is.
"""
import threading
import time

ACTIVE_SEC = 2.5      # audio this recent: a recitation is going on
MAX_WAIT_SEC = 600    # background work never waits longer than this in one go

_last = 0.0
_lock = threading.Lock()


def mark():
    """A live recitation sent audio just now."""
    global _last
    with _lock:
        _last = time.monotonic()


def busy():
    with _lock:
        return time.monotonic() - _last < ACTIVE_SEC


def yield_to_live():
    """Called by background work at a step's start: waits while a live
    recitation is going on (at most MAX_WAIT_SEC)."""
    start = time.monotonic()
    while busy() and time.monotonic() - start < MAX_WAIT_SEC:
        time.sleep(0.2)
