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

# Configure Logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger(__name__)

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
        logger.error(f"Reciter '{reciter_id}' not found.")
        return

    clip_name = f"{reciter_id}_{surah_id:03d}_{start_ayah}-{end_ayah}"
    final_clip_path = OUTPUT_DIR / f"{clip_name}.mp3"
    final_json_path = OUTPUT_DIR / f"{clip_name}.json"
    
    if final_json_path.exists():
        logger.info(f"Existing JSON found at {final_json_path}. Deleting to ensure fresh extraction.")
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
            logger.error(f"Ayah bounds error.")
            return None

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
            logger.error("Failed to parse timings array from Mp3Quran API")
            return None
        

        # First find target timings
        target_start_timing = next((t for t in timings if t["ayah"] == start_ayah), None)
        target_end_timing = next((t for t in timings if t["ayah"] == end_ayah), None)
        if not target_start_timing or not target_end_timing:
            logger.error("Target timing data not found.")
            return None

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
        
        macro_clip_path = WORK_DIR / f"macro_{clip_name}.wav"
        
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
            logger.error("Macro clip empty after output seeking. Cannot proceed.")
            return None
        
        try:
            probe_result = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                                           "format=duration", "-of",
                                           "default=noprint_wrappers=1:nokey=1", str(macro_clip_path)],
                                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=True)
            actual_macro_duration = float(probe_result.stdout.strip())
        except Exception as e:
            logger.warning(f"Failed to get actual_macro_duration with ffprobe: {e}")
            actual_macro_duration = macro_end - macro_start

        logger.info("=== Phase 3: Text Padding for Alignment ===")
        aligned_words_mapping = []
        text_for_whisper = []
        
        for a in range(pad_start, pad_end + 1):
            uthmani_words = ayahs_text[a]["uthmani"]
            clean_words = ayahs_text[a]["clean"]
            
            min_len = min(len(uthmani_words), len(clean_words))
            for i in range(min_len):
                clean_word = clean_words[i]
                uthmani_word = uthmani_words[i]
                
                phonetic_word = HUROOF_MUQATTAAH.get(clean_word, clean_word)
                
                text_for_whisper.append(phonetic_word)
                aligned_words_mapping.append({
                    "ayah": a, 
                    "w": uthmani_word, 
                    "clean": clean_word,
                    "phonetic": phonetic_word
                })
                
        # To absorb any Ta'awwudh or Basmalah audio present in the padded macro_clip
        # before the first mapped ayah, we prepend them as dummy words ONLY if pad_start == 1.
        if pad_start == 1:
            if surah_id == 1:
                dummy_text = "أعوذ بالله من الشيطان الرجيم"
            else:
                dummy_text = "أعوذ بالله من الشيطان الرجيم بسم الله الرحمن الرحيم"
            dummy_words = list(reversed(dummy_text.split())) # reverse to insert at 0 properly
            
            # Prepend dummy words to the mapping so indices match perfectly
            for w in dummy_words:
                aligned_words_mapping.insert(0, {"ayah": -1, "w": w, "clean": w, "phonetic": w})
                text_for_whisper.insert(0, w)
                
        # To absorb any "Sadaqallahul Adheem" audio present at the very end of the surah
        if pad_end == len(ayahs_text):
            dummy_end_text = "صدق الله العظيم"
            for w in dummy_end_text.split():
                aligned_words_mapping.append({"ayah": 999, "w": w, "clean": w, "phonetic": w})
                text_for_whisper.append(w)
            
        exact_text_clean = " ".join(text_for_whisper)

        logger.info("=== Phase 4: Micro-Alignment (Stable Whisper) ===")
        model = get_whisper_model('OdyAsh/faster-whisper-base-ar-quran')
        try:
            result = model.align(str(macro_clip_path), exact_text_clean, language='ar')
        except Exception as e:
            import traceback
            logger.error(f"Alignment crashed: {e}")
            logger.error(traceback.format_exc())
            raise e
        
        # Flatten whisper words
        whisper_words = []
        for segment in result.segments:
            for w in segment.words:
                whisper_words.append(w)
                
        # Extract target Ayah boundaries within the macro clip
        target_start_time = None
        target_end_time = None
        prev_word_end_time = 0.0
        next_word_start_time = None
        
        target_ayah_words = []
        
        w_idx = 0
        for mapped in aligned_words_mapping:
            expected_clean = mapped["phonetic"]
            expected_len = len(expected_clean.replace(" ", ""))
            if expected_len == 0: continue
                
            word_start = None
            word_end = None
            matched_chars = 0
            
            while w_idx < len(whisper_words) and matched_chars < expected_len:
                curr_w = whisper_words[w_idx]
                curr_text = curr_w.word.strip().replace(" ", "")
                if curr_text:
                    if word_start is None:
                        word_start = curr_w.start
                    word_end = curr_w.end
                    matched_chars += len(curr_text)
                w_idx += 1
                
            if word_start is None: continue

            if mapped["ayah"] < start_ayah:
                prev_word_end_time = word_end
            elif start_ayah <= mapped["ayah"] <= end_ayah:
                if target_start_time is None:
                    target_start_time = word_start
                target_end_time = word_end
                target_ayah_words.append({
                    "ayah": mapped["ayah"],
                    "w": mapped["w"], # Original Uthmani word
                    "start": word_start,
                    "end": word_end
                })
            elif mapped["ayah"] > end_ayah:
                if next_word_start_time is None:
                    next_word_start_time = word_start

        if target_start_time is None:
            logger.error("Failed to find target Ayahs in alignment.")
            return None
            
        # Validation: Did we actually align most of the target words?
        expected_words = len([w for w in aligned_words_mapping if start_ayah <= w["ayah"] <= end_ayah])
        actual_words = len(target_ayah_words)
        match_ratio = actual_words / max(1, expected_words)
        
        logger.info(f"Alignment matched {actual_words}/{expected_words} words ({match_ratio*100:.1f}%)")
        
        if match_ratio < 0.5:
            logger.error(f"Poor alignment match! Only {match_ratio*100:.1f}% of words found. The audio might be too corrupted or the timing ratio shift was too extreme.")
            return None

        # Dynamic padding for micro slice
        pad_start_val = 0.250
        if prev_word_end_time > 0 and prev_word_end_time < target_start_time:
            silence_gap = target_start_time - prev_word_end_time
            pad_start_val = min(0.300, silence_gap * 0.9)
        micro_slice_start = max(0, target_start_time - pad_start_val - pad_seconds)

        if next_word_start_time is not None and next_word_start_time > target_end_time:
            # Capture any repetitions by ending the slice right before the NEXT ayah starts
            micro_slice_end = next_word_start_time - 0.050
            pad_end_val = micro_slice_end - target_end_time
        else:
            # If there is no next ayah (and no dummy end words were matched),
            # use a safe bounded padding after the last detected word.
            remaining = actual_macro_duration - target_end_time
            safe_padding = min(2.0, max(0.5, remaining * 0.5))
            micro_slice_end = target_end_time + safe_padding
            pad_end_val = safe_padding
            
        # Ensure micro_slice_end doesn't go below target_end_time
        if micro_slice_end < target_end_time:
            micro_slice_end = target_end_time + 0.250
            pad_end_val = 0.250
        
        # Safety cap: never exceed the actual macro clip duration
        if micro_slice_end > actual_macro_duration:
            micro_slice_end = actual_macro_duration
            pad_end_val = micro_slice_end - target_end_time
        
        # Ensure pad_end_val is never negative
        if pad_end_val < 0:
            pad_end_val = 0.150

        micro_slice_end += pad_seconds
        pad_end_val += pad_seconds
        micro_slice_end = min(micro_slice_end, actual_macro_duration)
        
        logger.info(f"[TIMING] target_start={target_start_time:.3f}s, target_end={target_end_time:.3f}s")
        logger.info(f"[TIMING] micro_slice: {micro_slice_start:.3f}s -> {micro_slice_end:.3f}s (duration={micro_slice_end - micro_slice_start:.3f}s)")
        logger.info(f"[TIMING] next_word_start_time={'None' if next_word_start_time is None else f'{next_word_start_time:.3f}s'}")
        logger.info(f"[TIMING] actual_macro_duration={actual_macro_duration:.3f}s, pad_end_val={pad_end_val:.3f}s")
            
        # Calculate exact duration for fade-out
        clip_duration = micro_slice_end - micro_slice_start
        # Fade in 150ms, fade out 150ms (or less if padding is very small)
        fade_in_dur = min(0.150, pad_start_val)
        fade_out_dur = min(0.150, pad_end_val)
        fade_out_start = clip_duration - fade_out_dur
        
        audio_filter = f"afade=t=in:st=0:d={fade_in_dur:.3f},afade=t=out:st={fade_out_start:.3f}:d={fade_out_dur:.3f}"
        
        logger.info("=== Phase 5: Micro-Slicing Audio ===")
        subprocess.run([
            "ffmpeg", "-y",
            "-ss", str(micro_slice_start),
            "-i", str(macro_clip_path), 
            "-t", str(clip_duration), 
            "-vn",
            "-af", audio_filter,
            "-b:a", "192k", str(final_clip_path)
        ])
        
        logger.info("=== Phase 6: JSON Generation ===")
        verses = {}
        for word_data in target_ayah_words:
            a_id = str(word_data["ayah"])
            if a_id not in verses:
                verses[a_id] = {"words": []}
                
            # Shift timestamps relative to micro_slice_start
            shifted_start = word_data["start"] - micro_slice_start
            shifted_end = word_data["end"] - micro_slice_start
            
            verses[a_id]["words"].append({
                "w": word_data["w"],
                "start": int(max(0, shifted_start) * 1000),
                "end": int(shifted_end * 1000)
            })
            
        # Post-process to fix gaps caused by repetitions
        for a_id, v_data in verses.items():
            words = v_data["words"]
            for i in range(1, len(words)):
                gap = words[i]["start"] - words[i-1]["end"]
                
                # 1. Handle explicit gaps (silence or unmapped repetitions)
                if gap > 1500:
                    words[i-1]["end"] = words[i]["start"] - 100
                    
                # 2. Handle hidden repetitions: 
                # If a word's duration is abnormally long (> 2.5s), Whisper likely absorbed a repetition into it.
                # We pull its start time forward to its actual pronunciation (last 1.5s), 
                # and extend the previous word to cover the repetition time.
                word_duration = words[i]["end"] - words[i]["start"]
                if word_duration > 2500:
                    words[i]["start"] = words[i]["end"] - 1500
                    words[i-1]["end"] = words[i]["start"] - 100

        final_json = {
            "surah": surah_id,
            "start_ayah": start_ayah,
            "end_ayah": end_ayah,
            "reciter": reciter_id,
            "verses": verses
        }
        
        with open(final_json_path, "w", encoding="utf-8") as f:
            json.dump(final_json, f, ensure_ascii=False, indent=2)
        logger.info(f"JSON written successfully to {final_json_path}")
        
        logger.info(f"Done. Extracted: {final_clip_path}")
        return str(final_clip_path), str(final_json_path)

    finally:
        logger.info("=== Phase 7: Cleanup ===")
        try:
            # Clean macro clip
            if macro_clip_path and macro_clip_path.exists(): macro_clip_path.unlink()
            # Clean full audio as requested by the user (make it temporary)
            if 'full_audio_path' in locals() and full_audio_path and full_audio_path.exists(): full_audio_path.unlink()
        except Exception as e:
            logger.warning(f"Cleanup error: {e}")

def extract_custom_clip(audio_path_str, surah_id, start_ayah, end_ayah, pad_seconds=0.0):
    import difflib
    import re
    audio_path = Path(audio_path_str)
    if not audio_path.exists():
        logger.error(f"Custom audio file not found: {audio_path}")
        return None
        
    clip_name = f"custom_{surah_id:03d}_{start_ayah}-{end_ayah}"
    final_clip_path = OUTPUT_DIR / f"{clip_name}.mp3"
    final_json_path = OUTPUT_DIR / f"{clip_name}.json"
    
    logger.info("=== Phase 1: Preparation (Custom Audio) ===")
    ayahs_text = fetch_surah_texts(surah_id)
    
    if start_ayah not in ayahs_text or end_ayah not in ayahs_text:
        logger.error(f"Ayah bounds error.")
        return None
        
    logger.info("=== Phase 2: Transcribing Custom Audio ===")
    # Use fine-tuned Quran model for better accuracy
    model = get_whisper_model('OdyAsh/faster-whisper-base-ar-quran')
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
        logger.error(f"Could not locate target verses in custom audio. Best match ratio: {best_ratio}")
        return None
        
    strict_start = T_words_original[best_start_idx].start
    strict_end = T_words_original[best_end_idx].end
    
    logger.info(f"Target found at approx {strict_start:.2f}s to {strict_end:.2f}s (Ratio: {best_ratio:.2f})")
    
    logger.info("=== Phase 4: Strict-Slice Custom Audio ===")
    macro_start = max(0, strict_start - pad_seconds - 5.0)
    macro_duration = (strict_end - strict_start) + (pad_seconds + 5.0) * 2

    strict_clip_path = OUTPUT_DIR / f"strict_{clip_name}.mp3"
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
    
    # Align the exact text to the ZERO-PADDING strict clip.
    # This prevents the DTW algorithm from stretching words into silence/padding.
    align_result = model.align(str(strict_clip_path), exact_text_clean, language='ar')
    align_words = []
    for segment in align_result.segments:
        for w in segment.words:
            align_words.append(w)
            
    logger.info("=== Phase 6: Extracting Target Timings ===")
    target_start_time = None
    target_end_time = None
    target_ayah_words = []
    
    w_idx = 0
    for mapped in aligned_words_mapping:
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

        target_start_time = word_start if target_start_time is None else target_start_time
        target_end_time = word_end
        
        # We must shift the aligned word timestamps (which are relative to strict_clip) 
        # back to absolute timestamps in the ORIGINAL audio file!
        abs_start = macro_start + word_start
        abs_end = macro_start + word_end
        
        target_ayah_words.append({
            "ayah": mapped["ayah"], "w": mapped["w"], "start": abs_start, "end": abs_end
        })

    if target_start_time is None:
        logger.error("Failed to find target Ayahs in micro-alignment.")
        return None

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
    safe_padding = min(1.0, max(0.5, remaining * 0.5))
    final_slice_end = abs_target_end + safe_padding + pad_seconds
    final_slice_end = min(original_duration, final_slice_end)
    
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
    ])
    
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

    final_json = {
        "surah": surah_id,
        "start_ayah": start_ayah,
        "end_ayah": end_ayah,
        "reciter": "custom",
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
