"""Fetches the audio of a YouTube, TikTok or Instagram video from its link, to
be used exactly like an uploaded audio file.

yt-dlp does the work, as its standalone build: it carries its own Python (the
pip package has deprecated this image's 3.10) and the browser impersonation
TikTok needs. Deno solves YouTube's JavaScript challenges. Both are fetched on
first use into data/bin, like the AI models, so the image doesn't change and
yt-dlp's updates survive a container restart. Those updates matter: these
sites break old versions every few weeks, so a failed download updates yt-dlp
and tries once more.
"""
import hashlib
import io
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.request
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

BIN_DIR = Path("/app/data/bin")
YT_DLP = BIN_DIR / "yt-dlp"
DENO = BIN_DIR / "deno"
YT_DLP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux"
DENO_URL = "https://github.com/denoland/deno/releases/download/v2.9.8/deno-x86_64-unknown-linux-gnu.zip"
DENO_SHA256 = "e890975bc2549807bbcc0b584ffafda72cc7c93349dd99c80483dd784f6c4609"

# Wiped on every container start (docker-compose.yml), so a download whose
# cleanup never ran can't pile up.
TEMP_DIR = Path("/app/data/temp_extraction")

ALLOWED_HOSTS = ("youtube.com", "youtu.be", "tiktok.com", "instagram.com")
# "end" stops yt-dlp before its generic extractor, which would otherwise follow
# a page on these sites to whatever it embeds.
EXTRACTORS = r"youtube.*,tiktok.*,vm\.tiktok,instagram.*,end"

# Long enough for Al-Baqarah read slowly. A video of the whole Quran is too
# much to send through the browser and align on this laptop.
MAX_DURATION_SEC = 4 * 3600
# A site with no audio-only format makes this download the whole video.
MAX_DOWNLOAD_SIZE = "1G"
DOWNLOAD_TIMEOUT_SEC = 20 * 60
TOOL_TIMEOUT_SEC = 5 * 60
UPDATE_EVERY_SEC = 6 * 3600

MAX_TITLE_CHARS = 80
# Trying again with a newer yt-dlp can't change these.
FINAL_FAILURES = ("unsupported", "too_long", "no_audio")
NOT_PUBLIC_HINTS = (
    "private", "log in", "login", "sign in", "cookies", "unavailable", "not available",
    "removed", "deleted", "does not exist", "empty media", "http error 404",
)

_install_lock = threading.Lock()
_update_lock = threading.Lock()
_last_update = None


class LinkError(Exception):
    """Why the audio couldn't be fetched, as a code the frontend words in the
    user's language: unsupported, not_public, too_long, no_audio or failed."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def is_supported(url):
    try:
        parts = urlsplit(url.strip())
        host = (parts.hostname or "").lower()
    except ValueError:
        return False
    if parts.scheme not in ("http", "https") or parts.username or parts.password:
        return False
    return any(host == site or host.endswith(f".{site}") for site in ALLOWED_HOSTS)


def _download(url):
    with urllib.request.urlopen(url, timeout=TOOL_TIMEOUT_SEC) as res:
        return res.read()


def _install_executable(path, data):
    tmp = path.with_name(f"{path.name}.{os.getpid()}.part")
    tmp.write_bytes(data)
    tmp.chmod(0o755)
    os.replace(tmp, path)


def _install_tools():
    with _install_lock:
        BIN_DIR.mkdir(parents=True, exist_ok=True)
        if not YT_DLP.exists():
            logger.info("Installing yt-dlp in %s", BIN_DIR)
            _install_executable(YT_DLP, _download(YT_DLP_URL))
        if not DENO.exists():
            logger.info("Installing Deno in %s", BIN_DIR)
            archive = _download(DENO_URL)
            if hashlib.sha256(archive).hexdigest() != DENO_SHA256:
                raise ValueError("Deno archive checksum mismatch")
            with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
                _install_executable(DENO, zipped.read("deno"))


def _version():
    return subprocess.run([str(YT_DLP), "--version"], capture_output=True, text=True, timeout=TOOL_TIMEOUT_SEC).stdout.strip()


def _update_yt_dlp():
    """True when this installed a newer yt-dlp, so trying again can help."""
    global _last_update
    with _update_lock:
        now = time.monotonic()
        if _last_update is not None and now - _last_update < UPDATE_EVERY_SEC:
            return False
        _last_update = now
        try:
            before = _version()
            subprocess.run([str(YT_DLP), "--update"], capture_output=True, timeout=TOOL_TIMEOUT_SEC)
            after = _version()
        except (OSError, subprocess.TimeoutExpired) as e:
            logger.warning("yt-dlp update failed: %s", e)
            return False
    if after != before:
        logger.info("yt-dlp updated from %s to %s", before, after)
    return after != before


def _run_yt_dlp(url, workdir):
    return subprocess.run(
        [
            str(YT_DLP),
            "--ignore-config",
            "--js-runtimes", f"deno:{DENO}",
            "--use-extractors", EXTRACTORS,
            "--no-playlist", "--playlist-items", "1",
            "--match-filter", f"!is_live & duration<=?{MAX_DURATION_SEC}",
            "--max-filesize", MAX_DOWNLOAD_SIZE,
            "--socket-timeout", "30",
            "--no-progress",
            # AAC as the site serves it, copied without re-encoding when it can be.
            "-f", "ba[ext=m4a]/ba/b",
            "-x", "--audio-format", "m4a",
            "--print-to-file", "%(title)s", str(workdir / "title.txt"),
            "-P", str(workdir),
            "-o", "audio.%(ext)s",
            "--", url,
        ],
        capture_output=True,
        text=True,
        errors="replace",
        timeout=DOWNLOAD_TIMEOUT_SEC,
    )


def _failure_code(output):
    text = output.lower()
    if "unsupported url" in text:
        return "unsupported"
    if "does not pass filter" in text or "max-filesize" in text:
        return "too_long"
    # What yt-dlp's audio extraction says about a file with no audio stream.
    if "audio codec" in text:
        return "no_audio"
    if any(hint in text for hint in NOT_PUBLIC_HINTS):
        return "not_public"
    return "failed"


def _title(workdir):
    try:
        lines = (workdir / "title.txt").read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        lines = []
    # It becomes the file's name in the browser.
    title = re.sub(r'[\x00-\x1f/\\:*?"<>|]+', " ", lines[0] if lines else "").strip()
    return title[:MAX_TITLE_CHARS].strip() or "audio"


def _fetch_into(url, workdir):
    audio = workdir / "audio.m4a"
    for may_retry in (True, False):
        result = _run_yt_dlp(url, workdir)
        if result.returncode == 0 and audio.is_file() and audio.stat().st_size > 0:
            return audio
        output = f"{result.stdout}\n{result.stderr}"
        code = _failure_code(output)
        logger.warning("Fetching audio from %s failed (%s): %s", url, code, output[-1500:])
        if not may_retry or code in FINAL_FAILURES or not _update_yt_dlp():
            raise LinkError(code)


def fetch_audio(url):
    """Returns (audio path, title). The file sits in its own temporary folder,
    which the caller deletes once it's done with it. Raises LinkError."""
    url = url.strip()
    if not is_supported(url):
        raise LinkError("unsupported")

    try:
        _install_tools()
        TEMP_DIR.mkdir(parents=True, exist_ok=True)
        workdir = Path(tempfile.mkdtemp(prefix="link_", dir=TEMP_DIR))
    except (OSError, ValueError, zipfile.BadZipFile) as e:
        logger.error("Couldn't set up the audio download: %s", e)
        raise LinkError("failed") from e

    try:
        return _fetch_into(url, workdir), _title(workdir)
    except subprocess.TimeoutExpired as e:
        logger.warning("Fetching audio from %s timed out", url)
        shutil.rmtree(workdir, ignore_errors=True)
        raise LinkError("failed") from e
    except Exception:
        shutil.rmtree(workdir, ignore_errors=True)
        raise
