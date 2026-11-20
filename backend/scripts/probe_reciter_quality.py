"""Measures each reciter recording's audio quality (bitrate, sample rate),
for the reciter picker's quality note.

Run inside the backend container (it needs ffprobe):

    docker compose exec -T backend python -I scripts/probe_reciter_quality.py

then copy the result next to the frontend's list:

    cp backend/scripts/reciter_quality.json frontend/src/lib/reciterQuality.json

One mid-length surah is probed per recording (ffprobe reads only the
header). The audio stream's own bitrate is used, not the file's: a cover
image inside the file would inflate that.
"""
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from extract_precise_clip import RECITER_SURAHS, RECITERS_HQ, RECITERS_MP3QURAN, has_hq_copy  # noqa: E402

OUT = Path(__file__).with_name("reciter_quality.json")
PREFERRED_SURAHS = (67, 36, 18, 55, 78)


def probe(key):
    surahs = RECITER_SURAHS.get(key)
    surah = next((s for s in PREFERRED_SURAHS if surahs is None or s in surahs), min(surahs) if surahs else 67)
    # What the app actually cuts from: the better-quality copy when there is one.
    url = (RECITERS_HQ[key][0] if has_hq_copy(key, surah) else RECITERS_MP3QURAN[key]).format(surah=surah)
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-user_agent", "Mozilla/5.0", "-select_streams", "a:0",
             "-show_entries", "stream=bit_rate,sample_rate:format=bit_rate", "-of", "json", url],
            capture_output=True, text=True, timeout=60).stdout
        data = json.loads(out)
        stream = data["streams"][0]
        rate = stream.get("bit_rate") or data.get("format", {}).get("bit_rate")
        return key, {"kbps": round(int(rate) / 1000), "hz": int(stream["sample_rate"])}
    except Exception as e:
        print(f"{key}: {e}", file=sys.stderr)
        return key, None


def main():
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = dict(pool.map(probe, sorted(RECITERS_MP3QURAN)))
    OUT.write_text(json.dumps({k: v for k, v in sorted(results.items()) if v}, indent=1) + "\n")
    print(f"{sum(1 for v in results.values() if v)} of {len(results)} recordings measured")


if __name__ == "__main__":
    main()
