import os
os.environ["HF_HOME"] = "/app/data/huggingface_cache"

import sys
import json
import logging
import argparse
import urllib.request
import subprocess
from pathlib import Path
import re
import threading
import uuid

# Configure Logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger(__name__)


class ExtractionError(Exception):
    """Raised on any expected extraction failure, with a message specific
    enough to show the caller (instead of a generic "check logs")."""
    pass


class MacroWindowTooNarrowError(ExtractionError):
    """Raised when Phase 3's coarse free-transcription match lands
    suspiciously close to the edge of the provided audio -- a strong signal
    that the requested ayah range's true content extends beyond what was
    cropped, so the crop should be widened and retried before accepting a
    result that may be missing audio at the source (as opposed to a mere
    forced-alignment/DTW timing error further downstream, which the
    existing collapse-recovery/boundary-cross-check machinery already
    handles). Only raised when the caller opts in via allow_macro_retry,
    since a standalone custom-audio upload has no bigger source to re-crop
    from and should never see this exception."""

    def __init__(self, message, needed_extra_seconds=None):
        super().__init__(message)
        self.needed_extra_seconds = needed_extra_seconds


def _fail(message: str):
    """Log and raise in one call so failure paths keep their exact previous
    log text while also surfacing that same text through the API response,
    instead of it being lost the moment the function used to `return None`."""
    logger.error(message)
    raise ExtractionError(message)


WORK_DIR = Path("/app/data/temp_extraction")
OUTPUT_DIR = Path("/app/data/extracted_clips")
SURAH_CACHE_DIR = Path("/app/data/surah_cache")
WORK_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
SURAH_CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Maximum number of cached surah files to keep on disk
MAX_SURAH_CACHE = 10

# ========== CACHING SINGLETONS ==========

_model_cache = {}
_model_lock = threading.Lock()

def get_whisper_model(size='small'):
    """Load Whisper model once and reuse across requests."""
    if size not in _model_cache:
        with _model_lock:
            if size not in _model_cache:  # Double-check inside lock
                try:
                    import stable_whisper
                except ImportError:
                    logger.info("installing stable_whisper...")
                    subprocess.run([sys.executable, "-m", "pip", "install", "--no-cache-dir", "faster-whisper", "stable-ts", "torch", "torchaudio", "--extra-index-url", "https://download.pytorch.org/whl/cpu"], check=True)
                    import stable_whisper
                
                logger.info(f"Loading faster-whisper model '{size}' (one-time)...")
                try:
                    _model_cache[size] = stable_whisper.load_faster_whisper(size, device="cuda", compute_type="float16")
                    logger.info(f"faster-whisper model '{size}' loaded successfully on CUDA.")
                except Exception as e:
                    logger.warning(f"Failed to load faster-whisper on CUDA: {e}. Falling back to CPU...")
                    _model_cache[size] = stable_whisper.load_faster_whisper(size, device="cpu", compute_type="int8")
    return _model_cache[size]

_text_cache = {}
_text_cache_lock = threading.Lock()

def _enforce_surah_cache_limit():
    """Remove oldest cached surah files if we exceed MAX_SURAH_CACHE."""
    try:
        cached_files = sorted(SURAH_CACHE_DIR.glob("*_full.mp3"), key=lambda f: f.stat().st_atime)
        while len(cached_files) > MAX_SURAH_CACHE:
            oldest = cached_files.pop(0)
            oldest.unlink(missing_ok=True)
            logger.info(f"Evicted old surah cache: {oldest.name}")
    except Exception as e:
        logger.warning(f"Cache eviction error: {e}")

RECITERS_MP3QURAN = {
    "ajmi": "https://server10.mp3quran.net/ajm/{surah:03d}.mp3",
    "maher": "https://server12.mp3quran.net/maher/{surah:03d}.mp3",
    "mishary": "https://server8.mp3quran.net/afs/{surah:03d}.mp3",
    "yasser": "https://server11.mp3quran.net/yasser/{surah:03d}.mp3",
    "mousa": "https://server14.mp3quran.net/mousa/Rewayat-Hafs-A-n-Assem/{surah:03d}.mp3",
    "raad_alkurdi": "https://server6.mp3quran.net/kurdi/{surah:03d}.mp3"
}

RECITERS_TIMING_ID = {
    "ajmi": 5,
    "maher": 133,
    "mishary": 123,
    "yasser": 92,
    "mousa": 243,
    "raad_alkurdi": 221
}

HUROOF_MUQATTAAH = {
    "الم": "ألف لام ميم",
    "المص": "ألف لام ميم صاد",
    "الر": "ألف لام را",
    "المر": "ألف لام ميم را",
    "كهيعص": "كاف ها يا عين صاد",
    "طه": "طا ها",
    "طسم": "طا سين ميم",
    "طس": "طا سين",
    "يس": "يا سين",
    "ص": "صاد",
    "حم": "حا ميم",
    "عسق": "عين سين قاف",
    "ق": "قاف",
    "ن": "نون"
}

def clean_arabic(text):
    # Remove all diacritics and tashkeel for Whisper alignment
    text = re.sub(r'[\u0617-\u061A\u064B-\u0652\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED]', '', text)
    return text.strip()

def download_full_surah(reciter_id, surah_id):
    url = RECITERS_MP3QURAN[reciter_id].format(surah=surah_id)
    # Use persistent cache directory instead of temp
    cache_file = SURAH_CACHE_DIR / f"{reciter_id}_{surah_id:03d}_full.mp3"
    
    if cache_file.exists():
        logger.info(f"Full Surah {surah_id} for {reciter_id} found in cache.")
        # Touch the file to update access time for LRU eviction
        cache_file.touch()
        return cache_file

    logger.info(f"Downloading full Surah {surah_id} from {url}...")
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    
    temp_file = WORK_DIR / f"temp_raw_{reciter_id}_{surah_id:03d}.mp3"
    with urllib.request.urlopen(req, timeout=120) as response:
        with open(temp_file, 'wb') as f:
            f.write(response.read())
            
    logger.info("Sanitizing audio file (stripping cover art and junk data)...")
    try:
        subprocess.run([
            "ffmpeg", "-y",
            "-i", str(temp_file),
            "-vn",                  # Strip video (cover art)
            "-map", "0:a",          # Only map audio stream explicitly
            "-c:a", "copy",         # Copy audio stream without re-encoding
            "-map_metadata", "-1",  # Strip metadata (tags, covers)
            str(cache_file)
        ], check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    except subprocess.CalledProcessError as e:
        logger.error(f"Failed to sanitize audio: {e.output.decode(errors='ignore')}")
        if temp_file.exists(): temp_file.unlink()
        raise e
        
    if temp_file.exists():
        temp_file.unlink()
    
    # Enforce cache size limit
    _enforce_surah_cache_limit()
    return cache_file

def fetch_surah_texts(surah_id):
    # Check in-memory cache first
    with _text_cache_lock:
        if surah_id in _text_cache:
            logger.info(f"Surah {surah_id} texts found in memory cache.")
            return _text_cache[surah_id]

    # Fetch Uthmani text for JSON output
    url_uthmani = f"http://api.alquran.cloud/v1/surah/{surah_id}/quran-uthmani"
    req1 = urllib.request.Request(url_uthmani, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req1, timeout=15) as response:
        data_uthmani = json.loads(response.read().decode())['data']['ayahs']
        
    # Fetch Simple Clean text for Whisper alignment
    url_clean = f"http://api.alquran.cloud/v1/surah/{surah_id}/quran-simple-clean"
    req2 = urllib.request.Request(url_clean, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req2, timeout=15) as response:
        data_clean = json.loads(response.read().decode())['data']['ayahs']
    
    ayahs = {}
    for au, ac in zip(data_uthmani, data_clean):
        ayah_num = au['numberInSurah']
        text_u = au['text']
        text_c = ac['text']
        
        if ayah_num == 1 and text_u.startswith("بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ ") and surah_id != 1:
            text_u = text_u.replace("بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ ", "")
            text_c = text_c.replace("بسم الله الرحمن الرحيم ", "")
            
        ayahs[ayah_num] = {
            "uthmani": text_u.split(),
            "clean": text_c.split()
        }
    
    # Store in memory cache
    with _text_cache_lock:
        _text_cache[surah_id] = ayahs
    
    return ayahs

def extract_clip(reciter_id, surah_id, start_ayah, end_ayah, pad_seconds=0.0):
    if reciter_id not in RECITERS_MP3QURAN:
        _fail(f"Reciter '{reciter_id}' not found.")

    clip_name = f"{reciter_id}_{surah_id:03d}_{start_ayah}-{end_ayah}"
    final_clip_path = OUTPUT_DIR / f"{clip_name}.mp3"
    final_json_path = OUTPUT_DIR / f"{clip_name}.json"

    # This whole function is a real Whisper transcription + DTW forced-alignment
    # pipeline (Phases 1-8 below), not a lookup -- it used to unconditionally
    # delete and redo it EVERY time, even for the exact same (reciter, surah,
    # start, end, pad_seconds) combo already extracted successfully seconds/
    # minutes earlier (e.g. the user picking a reciter they'd already tried,
    # or the wizard's own re-renders). That made every re-selection pay the
    # full cost again for no reason. Reuse a cached result instead, as long as
    # it was written with the same pad_seconds this call wants (an older
    # cache file predating the "pad_seconds" JSON field, or one written for a
    # different padding, is NOT reused -- correctness over speed) and the mp3
    # isn't a truncated/empty leftover from an interrupted previous run.
    if final_json_path.exists() and final_clip_path.exists():
        try:
            with open(final_json_path, "r", encoding="utf-8") as f:
                cached_json = json.load(f)
            cached_pad_seconds = cached_json.get("pad_seconds")
            if cached_pad_seconds == pad_seconds and final_clip_path.stat().st_size > 1024:
                logger.info(f"Cache hit for {clip_name} (pad_seconds={pad_seconds}) -- reusing existing extraction.")
                return str(final_clip_path), str(final_json_path)
            else:
                logger.info(
                    f"Cache present for {clip_name} but stale (cached pad_seconds={cached_pad_seconds!r}, "
                    f"requested={pad_seconds!r}) or truncated -- re-extracting."
                )
        except Exception as e:
            logger.warning(f"Cached extraction for {clip_name} unreadable ({e}) -- re-extracting.")

    if final_json_path.exists():
        final_json_path.unlink()
    if final_clip_path.exists():
        final_clip_path.unlink()

    logger.info("=== Phase 1: Preparation ===")
    full_audio_path = None
    macro_clip_path = None
    
    try:
        full_audio_path = download_full_surah(reciter_id, surah_id)
        ayahs_text = fetch_surah_texts(surah_id)
        
        if start_ayah not in ayahs_text or end_ayah not in ayahs_text:
            _fail(f"Ayah bounds error: surah {surah_id} has no ayah {start_ayah} or {end_ayah}.")

        logger.info("=== Phase 2: Macro-Alignment (Mp3Quran API) ===")
        timing_url = f"https://mp3quran.net/api/v3/ayat_timing?surah={surah_id}&read={RECITERS_TIMING_ID[reciter_id]}"
        req = urllib.request.Request(timing_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=15) as response:
            api_data = json.loads(response.read().decode())
            # Some versions of API return list, some return {"times": [...]}
            if isinstance(api_data, dict) and "times" in api_data:
                timings = api_data["times"]
            elif isinstance(api_data, dict) and "ayat_timing" in api_data:
                timings = api_data["ayat_timing"]
            elif isinstance(api_data, list):
                timings = api_data
            else:
                # Try to find any list in the response
                timings = next((v for v in api_data.values() if isinstance(v, list)), [])
            
        if not timings:
            _fail("Failed to parse timings array from Mp3Quran API — the reciter timing service may be down.")

        # First find target timings
        target_start_timing = next((t for t in timings if t["ayah"] == start_ayah), None)
        target_end_timing = next((t for t in timings if t["ayah"] == end_ayah), None)
        if not target_start_timing or not target_end_timing:
            _fail(f"Target timing data not found for ayah {start_ayah}-{end_ayah} from Mp3Quran API.")

        # --- PROPORTIONAL SCALING FIX ---
        api_total_duration = float(timings[-1]["end_time"]) / 1000.0
        
        actual_duration = api_total_duration
        try:
            probe_cmd = ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(full_audio_path)]
            probe_out = subprocess.check_output(probe_cmd, text=True).strip()
            if probe_out:
                actual_duration = float(probe_out)
        except Exception as e:
            logger.warning(f"Could not get actual duration from ffprobe: {e}")
            
        ratio = 1.0
        if abs(actual_duration - api_total_duration) > (0.05 * api_total_duration):
            ratio = actual_duration / api_total_duration
            logger.info(f"Timing mismatch detected. Scaling timings by ratio: {ratio:.4f} (Actual: {actual_duration}s, API: {api_total_duration}s)")
            
        # Calculate precise macro boundaries based on pad_seconds
        # We add 5.0s of extra margin to give Whisper acoustic context
        macro_start = max(0, (float(target_start_timing["start_time"]) / 1000.0 * ratio) - pad_seconds - 5.0)
        macro_end = min(actual_duration, (float(target_end_timing["end_time"]) / 1000.0 * ratio) + pad_seconds + 5.0)
        
        # For last verses, add extra padding since there's no next ayah timing to bound us
        if end_ayah == len(ayahs_text):
            macro_end = min(actual_duration, macro_end + 5.0)

        # Guard against bad/truncated end_time data from the Mp3Quran API
        # (observed for at least one surah's final ayah) collapsing the
        # macro window to near-zero or negative length, which ffmpeg turns
        # into an empty output file. When the computed window is
        # suspiciously short, fall back to running all the way to the end
        # of the downloaded audio -- Phase 3's content-based localization
        # crops this back down precisely regardless of how much slack this
        # window starts with, so widening it here is always safe.
        MIN_MACRO_DURATION = pad_seconds + 10.0
        if macro_end - macro_start < MIN_MACRO_DURATION:
            logger.warning(
                f"Macro window too short ({macro_end - macro_start:.2f}s, start={macro_start:.2f}, "
                f"end={macro_end:.2f}) -- likely bad Mp3Quran timing data for ayah {end_ayah}. "
                f"Falling back to end-of-file ({actual_duration:.2f}s)."
            )
            macro_end = actual_duration

        # Dynamically determine pad_start and pad_end by finding which ayahs are inside [macro_start, macro_end]
        pad_start = 1
        for t in timings:
            if float(t["end_time"]) / 1000.0 * ratio > macro_start:
                pad_start = t["ayah"]
                break
                
        pad_end = len(ayahs_text)
        for t in reversed(timings):
            if float(t["start_time"]) / 1000.0 * ratio < macro_end:
                pad_end = t["ayah"]
                break
                
        # Ensure pad_start/end are reasonable and include target
        if pad_start == 0: pad_start = 1
        pad_start = min(max(1, pad_start), start_ayah)
        pad_end = max(min(len(ayahs_text), pad_end), end_ayah)
        
        logger.info(f"Target verses: {start_ayah}-{end_ayah}. Extracted macro covers text: {pad_start}-{pad_end}.")
        
        macro_duration = macro_end - macro_start
        
        # Suffixed with a per-call uuid, NOT just clip_name -- two requests
        # for the identical reciter/surah/ayah-range (e.g. the frontend's
        # debounced auto-prepare firing alongside a manual click, or two
        # browser tabs) used to share this exact path, so one's `ffmpeg -y`
        # truncated the file out from under the other's still-in-progress
        # read/validation, failing both with "Macro clip empty".
        macro_clip_path = WORK_DIR / f"macro_{clip_name}_{uuid.uuid4().hex[:8]}.wav"
        
        # Use -ss after -i for accurate output seeking. 
        # We output to WAV format because WAV is uncompressed and guarantees 
        # mathematically perfect fast-seeking (-ss before -i) in Phase 5.
        # This completely fixes the "audio starts too early/late" VBR MP3 bug.
        ffmpeg_cmd = [
            "ffmpeg", "-y",
            "-i", str(full_audio_path),
            "-ss", str(macro_start),
            "-t", str(macro_duration),
            "-vn",
            "-acodec", "pcm_s16le", "-ar", "44100", str(macro_clip_path)
        ]
        
        subprocess.run(ffmpeg_cmd, check=True)
        
        # Validate the output file is not empty
        if not macro_clip_path.exists() or macro_clip_path.stat().st_size < 1024:
            _fail("Macro clip empty after output seeking — the source audio may be shorter than expected for this ayah range.")
        
        logger.info("=== Phase 3: Robust Content-Based Localization + Micro-Alignment ===")
        # A single-shot forced alignment (align() over the whole ~60-100s macro
        # clip) can silently drift by several seconds for some reciters/recordings
        # even when it reports a "successful" word-count match — this is DTW
        # misalignment, not a missing-word failure, so the boundary-word safeguard
        # above doesn't catch it. Delegating to extract_custom_clip()'s strategy
        # (free transcription + fuzzy text search to localize, then forced
        # alignment only on a tightly cropped window) avoids long-range DTW drift
        # entirely and is reciter-agnostic, since it never trusts any per-reciter
        # external timing beyond this cheap macro-window crop.
        is_last_ayah_of_surah = (end_ayah == len(ayahs_text))
        # The mp3quran.net timing API (scaled by `ratio` above) can still
        # underestimate an ayah's true end even after correction, and
        # Quranic recitation commonly prolongs (madd) an ayah's final word
        # well past that -- concretely observed: Hud/maher needed a 0.676
        # ratio (32% mismatch) and even a first +15s widening still weren't
        # enough, with the exported clip still ending mid-recitation.
        # Retry up to twice (three attempts total), re-cropping ONLY the
        # end further out each time (not the start, to avoid pulling in
        # more preceding text that could confuse the collapse-recovery
        # fuzzy search the way a symmetric widen attempt previously did),
        # sized by the actual clamped amount extract_custom_clip measured
        # rather than a blind guess -- a full, clean re-run of Phase 3
        # onward on the wider crop each time, not a patch applied mid-pipeline.
        MAX_MACRO_RETRIES = 2
        attempt = 0
        while True:
            try:
                result = extract_custom_clip(
                    str(macro_clip_path), surah_id, start_ayah, end_ayah,
                    pad_seconds=pad_seconds, ayahs_text=ayahs_text,
                    output_prefix=reciter_id, reciter_label=reciter_id,
                    allow_macro_retry=(attempt < MAX_MACRO_RETRIES),
                    is_last_ayah_of_surah=is_last_ayah_of_surah,
                )
                break
            except MacroWindowTooNarrowError as e:
                attempt += 1
                if attempt > MAX_MACRO_RETRIES:
                    raise
                extra_seconds = max(15.0, getattr(e, "needed_extra_seconds", None) or 15.0)
                logger.info(f"{e} Retrying with a wider macro crop (attempt {attempt}/{MAX_MACRO_RETRIES}, +{extra_seconds:.1f}s).")
                macro_end = min(actual_duration, macro_end + extra_seconds)
                macro_duration = macro_end - macro_start
                subprocess.run([
                    "ffmpeg", "-y",
                    "-i", str(full_audio_path),
                    "-ss", str(macro_start),
                    "-t", str(macro_duration),
                    "-vn",
                    "-acodec", "pcm_s16le", "-ar", "44100", str(macro_clip_path)
                ], check=True)
                if not macro_clip_path.exists() or macro_clip_path.stat().st_size < 1024:
                    _fail("Macro clip empty after widened re-crop.")

        logger.info(f"Done. Extracted: {final_clip_path}")
        return result

    finally:
        logger.info("=== Phase 7: Cleanup ===")
        try:
            # Clean the temporary macro clip (specific to this request), but keep
            # full_audio_path in SURAH_CACHE_DIR — it's a shared, reusable cache
            # already managed by download_full_surah()'s own LRU eviction
            # (_enforce_surah_cache_limit, capped at MAX_SURAH_CACHE). Deleting it
            # here forced every single request — including immediate retries and
            # picking a different ayah range within the same surah — to re-download
            # the full surah from the external mp3quran.net server from scratch,
            # which was a major avoidable source of slow/timed-out requests.
            if macro_clip_path and macro_clip_path.exists(): macro_clip_path.unlink()
        except Exception as e:
            logger.warning(f"Cleanup error: {e}")

def extract_custom_clip(audio_path_str, surah_id, start_ayah, end_ayah, pad_seconds=0.0,
                         ayahs_text=None, output_prefix="custom", reciter_label="custom",
                         allow_macro_retry=False, is_last_ayah_of_surah=False):
    import difflib
    import re
    audio_path = Path(audio_path_str)
    if not audio_path.exists():
        _fail(f"Custom audio file not found: {audio_path}")

    clip_name = f"{output_prefix}_{surah_id:03d}_{start_ayah}-{end_ayah}"
    final_clip_path = OUTPUT_DIR / f"{clip_name}.mp3"
    final_json_path = OUTPUT_DIR / f"{clip_name}.json"

    logger.info("=== Phase 1: Preparation (Custom Audio) ===")
    if ayahs_text is None:
        ayahs_text = fetch_surah_texts(surah_id)

    if start_ayah not in ayahs_text or end_ayah not in ayahs_text:
        _fail(f"Ayah bounds error: surah {surah_id} has no ayah {start_ayah} or {end_ayah}.")
        
    logger.info("=== Phase 2: Transcribing Custom Audio ===")
    # Use fine-tuned Quran model for better accuracy
    model = get_whisper_model('OdyAsh/faster-whisper-base-ar-quran')
    # Deliberately NOT using vad=True here (unlike Phase 5/6's alignment): this
    # transcription is later cross-checked in Phase 6 against the forced-alignment
    # result to catch cases where VAD makes the forced alignment drift. Keeping
    # this pass on a different setting preserves that independence — if both
    # passes shared the same VAD-related bias, they could agree with each other
    # while both being wrong, and the cross-check would miss it.
    transcribe_result = model.transcribe(str(audio_path), language='ar', word_timestamps=True)
    
    whisper_words = []
    for segment in transcribe_result.segments:
        for w in segment.words:
            whisper_words.append(w)
            
    def norm(t):
        t = re.sub(r'[^\w\s]', '', t)
        t = re.sub(r'[\u0617-\u061A\u064B-\u0652\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED]', '', t)
        t = t.replace('أ', 'ا').replace('إ', 'ا').replace('آ', 'ا').replace('ة', 'ه').replace('ى', 'ي')
        return t.strip()

    T_words_original = [w for w in whisper_words if norm(w.word)]
    T_words = [norm(w.word) for w in T_words_original]
    
    target_clean = []
    for a in range(start_ayah, end_ayah + 1):
        for cw in ayahs_text[a]["clean"]:
            target_clean.append(norm(cw))
            
    P_words = [w for w in target_clean if w]
    
    logger.info("=== Phase 3: Searching for Target Verses ===")
    best_ratio = -1
    best_start_idx = 0
    best_end_idx = 0
    target_len = len(P_words)
    
    for i in range(len(T_words)):
        for j in range(i + int(target_len * 0.5), min(len(T_words), i + int(target_len * 1.5) + 1)):
            window = T_words[i:j]
            sm = difflib.SequenceMatcher(None, window, P_words)
            ratio = sm.ratio()
            if ratio > best_ratio:
                best_ratio = ratio
                best_start_idx = i
                best_end_idx = j - 1

    if best_ratio < 0.15 or target_len == 0:
        _fail(f"Could not locate ayah {start_ayah}-{end_ayah} in the audio (best text match ratio: {best_ratio:.2f}). The audio may not actually contain this recitation, or its quality is too poor to transcribe.")
        
    strict_start = T_words_original[best_start_idx].start
    strict_end = T_words_original[best_end_idx].end

    logger.info(f"Target found at approx {strict_start:.2f}s to {strict_end:.2f}s (Ratio: {best_ratio:.2f})")

    if allow_macro_retry and not is_last_ayah_of_surah:
        # If the coarse match's end lands right at the edge of the audio we
        # were given, the true recitation almost certainly continues past
        # what was cropped -- no amount of downstream forced-alignment or
        # collapse-recovery can recover audio that was never included in
        # the first place. Concretely observed: Hud 15-16 / reciter maher,
        # where the macro crop was only 56.83s and this match landed at
        # 56.18s (0.65s from the edge), and the final exported clip was
        # genuinely truncated mid-word as a result. Let the caller
        # (extract_clip) catch this and retry with a wider crop from the
        # full surah audio before we ever reach DTW/collapse-recovery.
        NEAR_EDGE_SECONDS = 3.0
        try:
            probe_out = subprocess.check_output(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=noprint_wrappers=1:nokey=1", str(audio_path)],
                text=True,
            ).strip()
            input_duration = float(probe_out) if probe_out else None
        except Exception:
            input_duration = None
        if input_duration is not None and (input_duration - strict_end) < NEAR_EDGE_SECONDS:
            raise MacroWindowTooNarrowError(
                f"Coarse match ended {input_duration - strict_end:.2f}s from the edge of a "
                f"{input_duration:.2f}s macro crop — likely missing trailing audio."
            )

    logger.info("=== Phase 4: Strict-Slice Custom Audio ===")
    # This crop only exists to give the forced-alignment DTW step a small,
    # tightly-bounded acoustic window — it is NOT the final output padding
    # (that's applied separately in Phase 7 using the real pad_seconds).
    # Reusing pad_seconds here would make this window balloon back up to
    # nearly the size of the original audio whenever pad_seconds is large
    # (e.g. the 10s pre-trim buffer requested by the frontend), giving DTW
    # just as much room to drift as an unbounded alignment would.
    #
    # 3.0s used to be the value here, but two independent real extractions
    # (different surahs, different audio) both showed the model.align() DTW
    # producing several consecutive words with byte-identical timestamps
    # right at the start of the target text — i.e. exactly where only 3s of
    # lead-in context had elapsed. Raised to give DTW substantially more
    # acoustic history to stabilize on before the words that actually matter
    # arrive, at the cost of a bit more alignment compute per request.
    align_context_seconds = 10.0
    macro_start = max(0, strict_start - align_context_seconds)
    macro_duration = (strict_end - strict_start) + align_context_seconds * 2

    # Suffixed with a per-call uuid -- this is a transient intermediate
    # (deleted at the end of this function), and clip_name alone is
    # deterministic per reciter/surah/ayah-range, so two concurrent calls
    # for the identical range (e.g. extract_clip's Phase 2->3 handoff
    # racing against another request) used to collide on this exact path,
    # each ffmpeg's `-y` truncating the other's still-in-progress write.
    strict_clip_path = OUTPUT_DIR / f"strict_{clip_name}_{uuid.uuid4().hex[:8]}.mp3"
    subprocess.run([
        "ffmpeg", "-y",
        "-ss", str(macro_start),
        "-i", str(audio_path),
        "-t", str(macro_duration),
        "-vn",
        "-b:a", "192k", str(strict_clip_path)
    ], check=True)
    
    logger.info("=== Phase 5: Micro-Alignment on Target ===")
    aligned_words_mapping = []
    text_for_whisper = []
    
    for a in range(start_ayah, end_ayah + 1):
        uthmani_words = ayahs_text[a]["uthmani"]
        clean_words = ayahs_text[a]["clean"]
        min_len = min(len(uthmani_words), len(clean_words))
        for i in range(min_len):
            clean_word = clean_words[i]
            uthmani_word = uthmani_words[i]
            phonetic_word = HUROOF_MUQATTAAH.get(clean_word, clean_word)
            text_for_whisper.append(phonetic_word)
            aligned_words_mapping.append({
                "ayah": a, "w": uthmani_word, "clean": clean_word, "phonetic": phonetic_word
            })
            
    exact_text_clean = " ".join(text_for_whisper)

    logger.info("=== Phase 6: Extracting Target Timings ===")
    # Align the exact text to the ZERO-PADDING strict clip.
    # This prevents the DTW algorithm from stretching words into silence/padding.
    # VAD anchors word boundaries to where the voice actually starts/stops
    # acoustically rather than a linguistic guess, which measurably improves
    # precision (observed: ~1.2s start-boundary error down to ~0.01s on one
    # reciter) — tried first since accuracy is the priority. But it can
    # occasionally make stable-ts lose confidence near a boundary and silently
    # cram several real words into a near-zero time span (observed: both a
    # 340ms and a 5.6ms collapse, with no warning raised). When that happens,
    # fall back to plain (non-VAD) alignment rather than fail outright.
    target_start_time = None
    target_end_time = None
    target_ayah_words = []
    matched_flags = [False] * len(aligned_words_mapping)
    failure_reason = None
    last_collapse_attempt = None

    # Set whenever a collapse (or the last-resort clamp fallback) touches the
    # FINAL word of the requested ayah range. Collapse recovery re-anchors a
    # whole span of words via one fuzzy free-transcription match and then
    # interpolates their timing linearly by word count -- a coarse
    # approximation that can leave the last word's `end` several seconds
    # early even when recovery "succeeds" (concretely observed: Hud 15-16 /
    # reciter maher, where a repeated "فِيهَا" between the two ayahs confused
    # DTW and the recovered span covered the rest of the text). Surfaced to
    # the frontend so it can widen the default trim selection instead of
    # silently truncating real recitation audio.
    end_boundary_low_confidence = False

    for vad_enabled in (True, False):
        align_result = model.align(str(strict_clip_path), exact_text_clean, language='ar', vad=vad_enabled)
        align_words = []
        for segment in align_result.segments:
            for w in segment.words:
                align_words.append(w)

        attempt_start_time = None
        attempt_end_time = None
        attempt_words = []
        attempt_flags = [False] * len(aligned_words_mapping)

        w_idx = 0
        for map_idx, mapped in enumerate(aligned_words_mapping):
            expected_len = len(mapped["phonetic"].replace(" ", ""))
            if expected_len == 0: continue

            word_start = None
            word_end = None
            matched_chars = 0

            while w_idx < len(align_words) and matched_chars < expected_len:
                curr_w = align_words[w_idx]
                curr_text = curr_w.word.strip().replace(" ", "")
                if curr_text:
                    if word_start is None: word_start = curr_w.start
                    word_end = curr_w.end
                    matched_chars += len(curr_text)
                w_idx += 1

            if word_start is None: continue
            attempt_flags[map_idx] = True

            attempt_start_time = word_start if attempt_start_time is None else attempt_start_time
            attempt_end_time = word_end

            # We must shift the aligned word timestamps (which are relative to strict_clip)
            # back to absolute timestamps in the ORIGINAL audio file!
            abs_start = macro_start + word_start
            abs_end = macro_start + word_end

            attempt_words.append({
                "ayah": mapped["ayah"], "w": mapped["w"], "start": abs_start, "end": abs_end
            })

        if attempt_start_time is None:
            failure_reason = "Failed to find target Ayahs in micro-alignment."
            continue

        # Boundary-word safeguard: an aggregate match ratio can look fine while
        # specifically the first or last word of the range failed to align,
        # silently shifting the selected start/end to the wrong word.
        if aligned_words_mapping and not attempt_flags[0]:
            failure_reason = f"First word of ayah {start_ayah} ('{aligned_words_mapping[0]['w']}') failed to align."
            continue
        if aligned_words_mapping and not attempt_flags[-1]:
            failure_reason = f"Last word of ayah {end_ayah} ('{aligned_words_mapping[-1]['w']}') failed to align."
            continue

        MIN_SECONDS_PER_WORD = 0.06

        # Whole-ayah proactive cross-check: DTW forced-alignment has been
        # observed (concretely, on real extractions) to produce implausible
        # word timing even when every check above passes clean — not only
        # right at the start (where the align_context_seconds increase
        # above targets the main known cause), but potentially anywhere the
        # DTW path loses confidence. Rather than only reacting to a
        # detected symptom (collapse/long-stretch below), proactively
        # cross-check EVERY consecutive window of words across the WHOLE
        # ayah against the free transcription (T_words_original, which
        # isn't produced by constrained DTW and doesn't share its failure
        # modes) using the same fuzzy-search technique the collapse
        # recovery below uses — and only correct a window when it actually
        # looks suspicious or disagrees with a confident match by a real
        # margin, so a genuinely correct DTW result is never discarded
        # needlessly. This trades extra extraction time (one more
        # free-transcription search per 5-word window) for maximum timing
        # accuracy across the entire ayah, not just its first few words.
        CROSS_CHECK_WINDOW = 5
        for window_start in range(0, len(attempt_words), CROSS_CHECK_WINDOW):
            window_words = attempt_words[window_start:window_start + CROSS_CHECK_WINDOW]
            n = len(window_words)
            window_query = [norm(w["w"]) for w in window_words if norm(w["w"])]
            if not window_query:
                continue

            qlen = len(window_query)
            best_ratio, best_start, best_end = -1.0, 0, 0
            for i in range(len(T_words)):
                for j in range(i + max(1, int(qlen * 0.5)), min(len(T_words), i + int(qlen * 1.5) + 1)):
                    ratio = difflib.SequenceMatcher(None, T_words[i:j], window_query).ratio()
                    if ratio > best_ratio:
                        best_ratio, best_start, best_end = ratio, i, j - 1
            if best_ratio < 0.6:
                continue

            new_start = T_words_original[best_start].start
            new_end = T_words_original[best_end].end
            if (new_end - new_start) < n * MIN_SECONDS_PER_WORD:
                continue

            current_span = window_words[-1]["end"] - window_words[0]["start"]
            # Only override when the forced-alignment result actually looks
            # suspicious (implausibly short span) or disagrees with the
            # free-transcription estimate by a real margin.
            looks_wrong = current_span < n * MIN_SECONDS_PER_WORD
            disagrees = abs(new_start - window_words[0]["start"]) > 0.3
            if not (looks_wrong or disagrees):
                continue

            # Never accept a re-anchor that would push this window's timing
            # past an immediate neighbor this pass isn't touching -- this is
            # exactly how a real collapse was produced (concretely observed:
            # Al-Furqan 27-29 / reciter "mousa", where words 0-4 were
            # re-anchored on a 0.67-ratio match that placed their end past
            # the next, still-original word's start, squeezing the words
            # between them into a negative-duration span). Skip the
            # re-anchor and keep the original DTW timing instead; the
            # collapse detector/recovery below still runs as a fallback.
            prev_end = attempt_words[window_start - 1]["end"] if window_start > 0 else None
            next_start = attempt_words[window_start + n]["start"] if window_start + n < len(attempt_words) else None
            if prev_end is not None and new_start < prev_end:
                continue
            if next_start is not None and new_end > next_start:
                continue

            span = new_end - new_start
            for k in range(n):
                attempt_words[window_start + k]["start"] = new_start + span * k / n
                attempt_words[window_start + k]["end"] = new_start + span * (k + 1) / n
            logger.info(
                f"[Cross-check] Re-anchored words {window_start}-{window_start + n - 1} "
                f"('{' '.join(w['w'] for w in window_words)}') via free-transcription "
                f"search (ratio {best_ratio:.2f}), vad={vad_enabled}."
            )

        attempt_start_time = attempt_words[0]["start"] - macro_start
        attempt_end_time = attempt_words[-1]["end"] - macro_start

        # Collapse detection: scan for any run of 4 consecutive target words
        # spanning an implausibly short combined duration. word start/end here
        # are in SECONDS (straight from Whisper), not milliseconds.
        WINDOW = 4

        def _find_collapse(words):
            # Signature 1: any 2+ consecutive words sharing the EXACT same
            # (start, end) pair. This is physically impossible in real
            # speech, so it's flagged immediately regardless of absolute
            # duration -- catches collapses the duration-based check below
            # can miss (observed concretely: Al-Baqarah 286's first 4 words
            # -- "لا يكلف الله نفسا" -- all reported as 10.250-10.300s by
            # stable-ts, a known failure mode right at a clip boundary/onset
            # where DTW has accumulated little acoustic evidence yet).
            i = 0
            while i < len(words) - 1:
                if words[i]["start"] == words[i + 1]["start"] and words[i]["end"] == words[i + 1]["end"]:
                    j = i + 1
                    while j + 1 < len(words) and words[j]["start"] == words[j + 1]["start"] and words[j]["end"] == words[j + 1]["end"]:
                        j += 1
                    return (i, j)
                i += 1

            # Signature 2: any run of 4 consecutive target words spanning an
            # implausibly short combined duration.
            if len(words) < WINDOW:
                return None
            for i in range(len(words) - WINDOW + 1):
                window = words[i:i + WINDOW]
                span_sec = window[-1]["end"] - window[0]["start"]
                if span_sec < WINDOW * MIN_SECONDS_PER_WORD:
                    return (i, i + WINDOW - 1)
            return None

        collapse_range = _find_collapse(attempt_words)
        if collapse_range is not None and collapse_range[1] == len(attempt_words) - 1:
            # The collapse touches the ayah range's final word -- the
            # recovery below may fix it well or may only approximate it, but
            # either way the end boundary is no longer as trustworthy as a
            # clean, uncollapsed alignment. Flag regardless of whether
            # recovery ultimately "succeeds" below.
            end_boundary_low_confidence = True
        if collapse_range is not None:
            # Forced alignment (DTW) can lose its place specifically when the
            # expected text contains a repeated/similar phrase nearby (e.g.
            # Fatir 2's parallel "فَلَا مُمْسِكَ لَهَا ... فَلَا مُرْسِلَ لَهُ") and
            # confuses which occurrence maps to which position, cramming one
            # of them into a near-zero span. This isn't specific to any one
            # reciter or ayah — it can happen wherever the target text itself
            # has this kind of repetition, and the confusion can bleed into
            # several neighboring words, not just the minimal 4-word window
            # that first trips the detector. Recover by fuzzy-searching the
            # collapsed phrase against the free transcription from Phase 2
            # (T_words/T_words_original, already computed for Phase 3's
            # coarse search) — that method isn't constrained to a specific
            # expected sequence, so it doesn't share the same confusion —
            # and keep growing the window toward whichever side still ends
            # up out of chronological order with its neighbor, up to a cap.
            i0, i1 = collapse_range
            recovered = False
            local_words: list = []
            MAX_RECOVERY_WORDS = 40
            for _ in range(MAX_RECOVERY_WORDS):
                local_words = attempt_words[i0:i1 + 1]
                local_query = [norm(w["w"]) for w in local_words if norm(w["w"])]
                recovered = False
                if local_query:
                    qlen = len(local_query)
                    local_best_ratio, local_best_start, local_best_end = -1.0, 0, 0
                    for i in range(len(T_words)):
                        for j in range(i + max(1, int(qlen * 0.5)), min(len(T_words), i + int(qlen * 1.5) + 1)):
                            ratio = difflib.SequenceMatcher(None, T_words[i:j], local_query).ratio()
                            if ratio > local_best_ratio:
                                local_best_ratio, local_best_start, local_best_end = ratio, i, j - 1
                    # Higher bar than Phase 3's 0.15 — this is a much shorter
                    # phrase, so a weak match is more likely to be a
                    # coincidental false positive elsewhere in the recording.
                    if local_best_ratio >= 0.6:
                        new_start = T_words_original[local_best_start].start
                        new_end = T_words_original[local_best_end].end
                        if (new_end - new_start) >= len(local_words) * MIN_SECONDS_PER_WORD:
                            span = new_end - new_start
                            n = len(local_words)
                            for k, w in enumerate(local_words):
                                w["start"] = new_start + span * k / n
                                w["end"] = new_start + span * (k + 1) / n
                            recovered = True

                left_ok = i0 == 0 or attempt_words[i0 - 1]["end"] <= attempt_words[i0]["start"]
                right_ok = i1 == len(attempt_words) - 1 or attempt_words[i1]["end"] <= attempt_words[i1 + 1]["start"]

                if recovered and left_ok and right_ok:
                    logger.info(
                        f"[Collapse recovery] Re-anchored '{' '.join(w['w'] for w in local_words)}' "
                        f"via free-transcription search, vad={vad_enabled}."
                    )
                    break

                if i0 == 0 and i1 == len(attempt_words) - 1:
                    recovered = False
                    break

                if not left_ok and i0 > 0:
                    i0 -= 1
                if not right_ok and i1 < len(attempt_words) - 1:
                    i1 += 1
                if left_ok and right_ok:
                    # Recovery itself failed (low ratio / implausible span)
                    # rather than a neighbor conflict — try once more with a
                    # bit more context on both sides before giving up.
                    i0 = max(0, i0 - 1)
                    i1 = min(len(attempt_words) - 1, i1 + 1)

            # Last-resort recovery: the free-transcription re-anchor above
            # never found a confident match (or its recovered span was
            # itself implausible) even after growing the search window up
            # to MAX_RECOVERY_WORDS — on a long ayah this budget can be
            # exhausted well before the window reaches a clean boundary, so
            # neither "recovered" nor the "whole ayah" exit ever triggers.
            # Rather than shipping the still-collapsed timestamps as-is or
            # failing the entire extraction, interpolate the collapsed
            # words evenly between their nearest reliable (non-collapsed)
            # neighbors. Still an approximation, but guarantees
            # monotonically increasing, individually-plausible timing
            # instead of several words crammed into the same instant.
            still_collapsed = _find_collapse(attempt_words)
            if still_collapsed is not None:
                ci0, ci1 = still_collapsed
                n = ci1 - ci0 + 1
                anchor_start = (
                    attempt_words[ci0 - 1]["end"] if ci0 > 0
                    else max(0.0, attempt_words[ci0]["start"] - MIN_SECONDS_PER_WORD * n)
                )
                anchor_end = (
                    attempt_words[ci1 + 1]["start"] if ci1 + 1 < len(attempt_words)
                    else attempt_words[ci1]["end"] + MIN_SECONDS_PER_WORD * n
                )
                if anchor_end > anchor_start:
                    span = anchor_end - anchor_start
                    for k in range(n):
                        attempt_words[ci0 + k]["start"] = anchor_start + span * k / n
                        attempt_words[ci0 + k]["end"] = anchor_start + span * (k + 1) / n
                    logger.info(
                        f"[Collapse recovery] Free-transcription re-anchor failed for words "
                        f"'{' '.join(w['w'] for w in attempt_words[ci0:ci1 + 1])}'; "
                        f"interpolated between neighboring words as last resort, vad={vad_enabled}."
                    )

            # Boundary words may have just been patched — keep target_start/end
            # in sync with whatever attempt_words now actually says.
            attempt_start_time = attempt_words[0]["start"] - macro_start
            attempt_end_time = attempt_words[-1]["end"] - macro_start

            collapse_range = _find_collapse(attempt_words)
            left_ok = i0 == 0 or attempt_words[i0 - 1]["end"] <= attempt_words[i0]["start"]
            right_ok = i1 == len(attempt_words) - 1 or attempt_words[i1]["end"] <= attempt_words[i1 + 1]["start"]
            if collapse_range is not None or not (left_ok and right_ok):
                if collapse_range is not None:
                    window = attempt_words[collapse_range[0]:collapse_range[1] + 1]
                    span_sec = window[-1]["end"] - window[0]["start"]
                    detail = f"words '{' '.join(w['w'] for w in window)}' squeezed into {span_sec*1000:.0f}ms"
                else:
                    detail = f"words '{' '.join(w['w'] for w in local_words)}' ended up out of chronological order with a neighboring word"
                suffix = " (recovery attempt failed)." if recovered else "."
                failure_reason = f"Alignment collapse detected: {detail}{suffix}"
                # Keep this attempt around (even though it's being rejected)
                # so that if BOTH vad settings end up here, we have something
                # to run the final monotonic-clamp safety net on below
                # instead of failing the whole extraction outright.
                last_collapse_attempt = (attempt_words, attempt_flags, vad_enabled)
                continue

        # Repeated-recitation detection: a reciter re-saying a word/phrase
        # that only appears once in the reference text has nowhere to go in
        # forced alignment except to be crammed into whichever single
        # reference word is playing when the repeat happens — showing up as
        # one word's span being implausibly LONG relative to its neighbors,
        # the mirror image of the short-collapse case above. Left alone, the
        # on-screen segment for that word lingers through the whole repeated
        # utterance instead of tracking the reciter's actual current word.
        # Recover the same way as the short-collapse case above: search the
        # free transcription (T_words_original, already in absolute
        # original-audio time, same as attempt_words) for the LAST instance
        # of this word spoken inside the anomalous span, and snap to it.
        # Only nudges this one word's start forward (end and every other
        # word are untouched), so a wrong/missed detection degrades to a
        # no-op rather than corrupting neighboring boundaries.
        MAX_SECONDS_PER_WORD = 2.5
        LONG_STRETCH_MULTIPLIER = 4.0

        def _find_long_stretch(words):
            if len(words) < 3:
                return None
            durations = [w["end"] - w["start"] for w in words]
            avg = sum(durations) / len(durations)
            threshold = max(MAX_SECONDS_PER_WORD, avg * LONG_STRETCH_MULTIPLIER)
            for i, dur in enumerate(durations):
                if dur > threshold:
                    return i
            return None

        long_idx = _find_long_stretch(attempt_words)
        if long_idx is not None:
            long_word = attempt_words[long_idx]
            long_query = norm(long_word["w"])
            if long_query:
                repeat_candidates = [
                    tw for tw in T_words_original
                    if norm(tw.word) == long_query and long_word["start"] <= tw.start <= long_word["end"]
                ]
                if repeat_candidates:
                    last_instance = repeat_candidates[-1]
                    if (
                        long_word["start"] < last_instance.start < long_word["end"]
                        and (long_word["end"] - last_instance.start) >= MIN_SECONDS_PER_WORD
                    ):
                        logger.info(
                            f"[Repeat recovery] Word '{long_word['w']}' spanned "
                            f"{long_word['end'] - long_word['start']:.2f}s (threshold {max(MAX_SECONDS_PER_WORD, 0):.2f}s+) "
                            f"— likely an absorbed repeat; snapping its start to the last spoken "
                            f"instance at {last_instance.start:.2f}s, vad={vad_enabled}."
                        )
                        long_word["start"] = last_instance.start

        # This attempt passed every check — use it.
        target_start_time, target_end_time, target_ayah_words, matched_flags = (
            attempt_start_time, attempt_end_time, attempt_words, attempt_flags
        )
        failure_reason = None
        break

    if (target_start_time is None or failure_reason) and last_collapse_attempt is not None:
        # Absolute last resort: every targeted recovery above (cross-check
        # neighbor guard, fuzzy re-anchoring, growing-window recovery,
        # interpolation) failed to produce clean timing on BOTH vad settings.
        # Rather than fail the whole extraction (concretely observed: Al-Furqan
        # 27-29 / reciter "mousa"), fall back to the last attempt and clamp any
        # remaining out-of-order timestamp forward against its predecessor.
        # This guarantees monotonically valid (if, in this rare fallback case,
        # slightly approximated) timing instead of a hard failure, for any
        # reciter/ayah this can occur on -- consistent with the same
        # "approximation over failure" tradeoff the interpolation step above
        # already makes. Reaching this branch at all means targeted recovery
        # never cleanly succeeded, so the whole attempt's timing -- including
        # the end boundary -- is approximate.
        end_boundary_low_confidence = True
        words, flags, vad_used = last_collapse_attempt
        for k in range(1, len(words)):
            if words[k]["start"] < words[k - 1]["end"]:
                duration = max(words[k]["end"] - words[k]["start"], MIN_SECONDS_PER_WORD)
                words[k]["start"] = words[k - 1]["end"]
                words[k]["end"] = words[k]["start"] + duration
            elif words[k]["end"] < words[k]["start"]:
                words[k]["end"] = words[k]["start"] + MIN_SECONDS_PER_WORD
        logger.warning(
            "[Collapse recovery] All targeted re-anchoring failed on both VAD "
            "settings; clamped remaining out-of-order word timing forward as a "
            f"final safety net (last attempt used vad={vad_used})."
        )
        target_start_time = words[0]["start"] - macro_start
        target_end_time = words[-1]["end"] - macro_start
        target_ayah_words = words
        matched_flags = flags
        failure_reason = None

    if target_start_time is None or failure_reason:
        _fail(f"{failure_reason} Refusing to return a clip with inaccurate/corrupted timing (tried with and without VAD).")

    # Cross-check the very first/last word's boundary against the free-transcription
    # estimate that already located this same phrase in Phase 3 (`strict_start`/
    # `strict_end`). Forced alignment (Phase 6) is constrained to match the exact
    # expected text and can drift on unusual phonetic patterns — e.g. Huroof
    # Muqatta'at like "يس" pronounced as two separated letter-names — even when
    # every other check (boundary-word match, collapse detection) passes clean.
    # Free transcription isn't constrained that way, so when the two disagree by
    # more than a fraction of a second, trust the free-transcription boundary
    # instead. Only trusted when Phase 3's match was itself reasonably confident.
    BOUNDARY_DISAGREEMENT_THRESHOLD = 0.6
    if best_ratio >= 0.5:
        abs_start_check = macro_start + target_start_time
        if abs(abs_start_check - strict_start) > BOUNDARY_DISAGREEMENT_THRESHOLD:
            start_delta = strict_start - abs_start_check
            logger.info(f"[Boundary cross-check] forced-alignment start {abs_start_check:.2f}s vs free-transcription {strict_start:.2f}s — snapping to free-transcription estimate.")
            target_start_time += start_delta
            target_end_time += start_delta
            if target_ayah_words:
                # Shift EVERY word by the same delta, not just the first
                # one's start. A disagreement this large means the whole
                # forced-alignment run matched the target text at the wrong
                # position in the macro clip, so every word it produced is
                # off by roughly the same amount -- patching only the first
                # word left it on the corrected timeline while every other
                # word (and the new slice boundary derived from
                # target_start_time) stayed on the old one, producing wildly
                # inconsistent per-word timestamps once shifted relative to
                # the corrected clip start (concretely observed: Al-Furqan
                # 27-29 / reciter "mousa" -- 11 words of ayah 27 collapsed
                # into a 50ms sliver while ayah 28's words spread across a
                # bogus 25s span).
                for w in target_ayah_words:
                    w["start"] += start_delta
                    w["end"] += start_delta

        abs_end_check = macro_start + target_end_time
        if abs(abs_end_check - strict_end) > BOUNDARY_DISAGREEMENT_THRESHOLD:
            logger.info(f"[Boundary cross-check] forced-alignment end {abs_end_check:.2f}s vs free-transcription {strict_end:.2f}s — snapping to free-transcription estimate.")
            target_end_time += (strict_end - abs_end_check)
            if target_ayah_words:
                # Anchor "end" absolutely at strict_end (the trusted
                # free-transcription boundary) rather than shifting by
                # (strict_end - abs_end_check): when DTW has badly lost its
                # place near the end, that delta can itself be enormous
                # (tens of seconds), and adding it to the word's own
                # "start"/"end" would just relocate the same nonsense
                # somewhere else instead of fixing it (concretely observed:
                # a delta-shift attempt here once produced a "start" of
                # 95s+ for a clip whose final exported audio was only 41s
                # long). Instead, keep this word's own PRE-correction
                # duration (a locally-scaled estimate that's still
                # reasonable even if its absolute position was wrong) and
                # re-anchor it so it ends exactly at strict_end. Deliberately
                # NOT clamped against the previous word's "end" here -- that
                # neighbor can itself already be corrupted by an upstream
                # collapse this check doesn't know about, and clamping
                # against it would import that corruption into this word
                # (observed concretely: propagated a bogus ~95s neighbor
                # timestamp into this word). Phase 8's final validity pass
                # already enforces global cross-word monotonicity as a
                # last-resort safety net, so it's not needed here too.
                last_word = target_ayah_words[-1]
                original_duration = last_word["end"] - last_word["start"]
                if original_duration <= 0 or original_duration > 3.0:
                    original_duration = MIN_SECONDS_PER_WORD
                last_word["end"] = strict_end
                last_word["start"] = strict_end - original_duration
            end_boundary_low_confidence = True

    # Get duration of ORIGINAL audio
    try:
        probe_result = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                                       "format=duration", "-of",
                                       "default=noprint_wrappers=1:nokey=1", str(audio_path)],
                                      stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=True)
        original_duration = float(probe_result.stdout.strip())
    except Exception:
        original_duration = strict_end + pad_seconds + 5.0

    # The absolute bounds of the target text in the ORIGINAL audio
    abs_target_start = macro_start + target_start_time
    abs_target_end = macro_start + target_end_time

    pad_start_val = 0.250
    # Final slice start relative to original audio
    final_slice_start = max(0, abs_target_start - pad_start_val - pad_seconds)
    
    remaining = original_duration - abs_target_end
    # Quranic recitation commonly prolongs (madd) an ayah's final word well
    # past where Whisper's own transcription places its word boundary --
    # observed concretely (Hud 15-16 / maher) that even after widening the
    # macro crop until Phase 3's match was no longer clamped by crop size,
    # the exported audio still ended mid-recitation, because the 1.0s cap
    # here left no room to cover that prolongation once the crop itself
    # was no longer the bottleneck. Allow a much larger safety margin
    # specifically when the end boundary is already known to be
    # low-confidence (bounded by `remaining`/2 same as before, so it still
    # never asks for more than half of whatever room is actually left).
    safe_padding_cap = 6.0 if end_boundary_low_confidence else 1.0
    safe_padding = min(safe_padding_cap, max(0.5, remaining * 0.5))
    desired_slice_end = abs_target_end + safe_padding + pad_seconds
    final_slice_end = min(original_duration, desired_slice_end)

    if allow_macro_retry and not is_last_ayah_of_surah:
        # Quranic recitation commonly prolongs (madd) the final word of an
        # ayah well past where Whisper's own word-boundary transcription
        # places it -- the early Phase-3 "near the crop's edge" check above
        # catches the obvious cases cheaply, but a reciter's prolongation
        # can still exceed the available room even when Phase 3's match
        # didn't look suspiciously close to the edge (concretely observed:
        # Hud 15-16 / maher, where Phase 3 matched 7.29s before a widened
        # crop's own end, which looked like enough margin, yet the desired
        # padding was still clamped and the exported audio still ended
        # mid-recitation). This is the more direct, ground-truth signal:
        # did we actually have to clamp away real requested padding?
        clamped_amount = desired_slice_end - final_slice_end
        if clamped_amount > 2.0:
            raise MacroWindowTooNarrowError(
                f"Desired trailing padding was clamped by {clamped_amount:.2f}s "
                f"(wanted to end at {desired_slice_end:.2f}s, crop only extends to "
                f"{original_duration:.2f}s) — macro crop too narrow.",
                needed_extra_seconds=clamped_amount + 10.0,
            )

    clip_duration = final_slice_end - final_slice_start
    fade_in_dur = min(0.150, pad_start_val)
    fade_out_dur = min(0.150, original_duration - final_slice_end if original_duration - final_slice_end > 0 else 0.150)
    fade_out_start = clip_duration - fade_out_dur
    
    audio_filter = f"afade=t=in:st=0:d={fade_in_dur:.3f},afade=t=out:st={fade_out_start:.3f}:d={fade_out_dur:.3f}"
    
    logger.info("=== Phase 7: Micro-Slicing Custom Audio ===")
    subprocess.run([
        "ffmpeg", "-y",
        "-ss", str(final_slice_start),
        "-i", str(audio_path),
        "-t", str(clip_duration),
        "-vn",
        "-af", audio_filter,
        "-b:a", "192k", str(final_clip_path)
    ], check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

    if not final_clip_path.exists() or final_clip_path.stat().st_size < 1024:
        _fail("Micro-slice produced an empty or missing clip — aborting instead of returning a stale/mismatched result.")
    
    logger.info("=== Phase 8: JSON Generation (Custom Audio) ===")
    verses = {}
    for word_data in target_ayah_words:
        a_id = str(word_data["ayah"])
        if a_id not in verses:
            verses[a_id] = {"words": []}
            
        # Shift absolute timestamps to be relative to the new final_clip
        shifted_start = word_data["start"] - final_slice_start
        shifted_end = word_data["end"] - final_slice_start

        verses[a_id]["words"].append({
            "w": word_data["w"],
            "start": int(max(0, shifted_start) * 1000),
            "end": int(shifted_end * 1000)
        })

    for a_id, v_data in verses.items():
        words = v_data["words"]
        for i in range(1, len(words)):
            gap = words[i]["start"] - words[i-1]["end"]
            if gap > 1500:
                words[i-1]["end"] = words[i]["start"] - 100

            word_duration = words[i]["end"] - words[i]["start"]
            if word_duration > 2500:
                words[i]["start"] = words[i]["end"] - 1500
                words[i-1]["end"] = words[i]["start"] - 100

        # Safety net: the adjustments above only look at one adjacent pair at
        # a time, so a correction made while handling word i can still leave
        # an EARLIER word (i-1, or one word further still handled from other
        # ayahs sharing the same underlying target_ayah_words sequence) with
        # its end before its own start once a later step nudges things back.
        # Observed concretely: a word's start/end came out reversed (e.g.
        # 10250-7310) after this loop ran, even though nothing upstream
        # flagged a collapse — the loop's own local edits produced it. Enforce
        # basic validity as a final pass so no inverted timestamp ever reaches
        # the client, regardless of what caused it upstream.
        #
        # Both checks below only clamp for a SMALL (jitter-scale) mismatch,
        # not an arbitrarily large one: a large mismatch means the PREVIOUS
        # word is the one carrying a stale/corrupted timestamp from an
        # upstream collapse this pass doesn't know about, and forcing THIS
        # word to match it would import that corruption instead of fixing
        # anything (concretely observed: doing this unconditionally dragged
        # a correctly end-boundary-anchored last word from ~39s to ~47s to
        # match a corrupted neighbor). A large mismatch is left for
        # lowConfidenceEnd/the macro-retry logic above to have already
        # addressed instead.
        SMALL_OVERLAP_THRESHOLD_MS = 1000
        for i in range(len(words)):
            if i > 0 and 0 < (words[i - 1]["start"] - words[i]["start"]) <= SMALL_OVERLAP_THRESHOLD_MS:
                words[i]["start"] = words[i - 1]["start"]
            # Also guard against overlapping the PREVIOUS word's end, not
            # just its start -- a word can have start >= previous start yet
            # still start before the previous word finishes (observed
            # concretely: a boundary-cross-check re-anchor on the last word
            # of Al-Fatiha 7 left it starting inside the previous word's own
            # span). The gap-closing loop above only handles large positive
            # gaps, not this negative-gap/overlap case.
            if i > 0 and 0 < (words[i - 1]["end"] - words[i]["start"]) <= SMALL_OVERLAP_THRESHOLD_MS:
                words[i]["start"] = words[i - 1]["end"]
            if words[i]["end"] < words[i]["start"]:
                words[i]["end"] = words[i]["start"] + 50

    final_json = {
        "surah": surah_id,
        "start_ayah": start_ayah,
        "end_ayah": end_ayah,
        "reciter": reciter_label,
        "pad_seconds": pad_seconds,
        "lowConfidenceEnd": end_boundary_low_confidence,
        "verses": verses
    }
    
    with open(final_json_path, "w", encoding="utf-8") as f:
        json.dump(final_json, f, ensure_ascii=False, indent=2)
        
    # Cleanup strict clip
    try:
        strict_clip_path.unlink(missing_ok=True)
    except:
        pass
        
    logger.info(f"JSON written successfully to {final_json_path}")
    return str(final_clip_path), str(final_json_path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--reciter", required=True)
    parser.add_argument("--surah", required=True, type=int)
    parser.add_argument("--start", required=True, type=int)
    parser.add_argument("--end", required=True, type=int)
    args = parser.parse_args()
    extract_clip(args.reciter, args.surah, args.start, args.end)
