"""Progress and cancellation for one extraction request.

The frontend tags each audio preparation with a job id, polls its stage
(GET /api/extraction/status/{id}) and cancels it (POST
/api/extraction/cancel/{id}) the moment the user picks something else --
without this, an abandoned selection (say a whole Al-Baqarah download from a
slow mirror) kept running for many minutes while the UI waited on it.

The job lives in a thread-local for the worker thread running it, so the
download/alignment code reports progress and checks for cancellation with
plain calls (report / check_cancelled) instead of threading a token through
every function. Both are no-ops outside a job (CLI use, legacy engine).
"""
import re
import threading
import time
from contextlib import contextmanager


class Cancelled(Exception):
    """The job was cancelled by the client; stop as soon as possible."""


_JOB_ID = re.compile(r"^[A-Za-z0-9-]{8,64}$")
# A cancel can arrive before its job starts (or after it ended); remembered
# this long so a late-starting job still sees it.
_FORGET_AFTER_SEC = 600

_jobs = {}
_lock = threading.Lock()
_local = threading.local()


def valid_job_id(job_id):
    return bool(job_id) and bool(_JOB_ID.match(job_id))


def _prune(now):
    for job_id in [k for k, v in _jobs.items() if not v["running"] and now - v["updated"] > _FORGET_AFTER_SEC]:
        del _jobs[job_id]


@contextmanager
def job(job_id):
    """Run the body as job `job_id` in this thread (no-op for a missing or
    malformed id)."""
    if not valid_job_id(job_id):
        yield
        return
    now = time.monotonic()
    with _lock:
        _prune(now)
        entry = _jobs.get(job_id)
        if entry is None:
            entry = _jobs[job_id] = {"cancelled": False}
        entry.update(running=True, stage="queued", percent=None, source=None, updated=now)
    _local.entry = entry
    try:
        check_cancelled()
        yield
    finally:
        _local.entry = None
        with _lock:
            entry.update(running=False, updated=time.monotonic())


def run(job_id, fn, *args, **kwargs):
    """fn(*args, **kwargs) as job `job_id` -- for handing to a thread pool."""
    with job(job_id):
        return fn(*args, **kwargs)


def report(stage, percent=None, source=None):
    entry = getattr(_local, "entry", None)
    if entry is None:
        return
    with _lock:
        entry.update(stage=stage, percent=None if percent is None else max(0, min(100, int(percent))),
                     updated=time.monotonic())
        if source is not None:
            entry["source"] = source


def check_cancelled():
    entry = getattr(_local, "entry", None)
    if entry is not None and entry["cancelled"]:
        raise Cancelled()


def cancel(job_id):
    if not valid_job_id(job_id):
        return
    now = time.monotonic()
    with _lock:
        _prune(now)
        entry = _jobs.setdefault(job_id, {"running": False})
        entry.update(cancelled=True, updated=now)


def status(job_id):
    with _lock:
        entry = _jobs.get(job_id) if valid_job_id(job_id) else None
        if entry is None or not entry.get("running"):
            return {"stage": None}
        return {"stage": entry["stage"], "percent": entry["percent"], "source": entry["source"]}
