#!/usr/bin/env python3
"""Debug script to check Mp3Quran API timings vs actual MP3 duration for Ajmi, Surah 8."""
import urllib.request, json, subprocess

url = 'https://mp3quran.net/api/v3/ayat_timing?surah=8&read=5'
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
with urllib.request.urlopen(req, timeout=15) as response:
    data = json.loads(response.read().decode())

# Find the timings list
if isinstance(data, dict) and 'times' in data:
    timings = data['times']
elif isinstance(data, dict) and 'ayat_timing' in data:
    timings = data['ayat_timing']
elif isinstance(data, list):
    timings = data
else:
    timings = next((v for v in data.values() if isinstance(v, list)), [])

# Print ayahs 58-66 timings
print("=== API Timing Data (Ayahs 58-66) ===")
for t in timings:
    if 58 <= t['ayah'] <= 66:
        st = float(t['start_time'])/1000
        en = float(t['end_time'])/1000
        print("Ayah %d: start=%.2fs, end=%.2fs, duration=%.2fs" % (t['ayah'], st, en, en-st))

# Total duration from API
api_total = float(timings[-1]['end_time'])/1000
print("\nAPI total duration: %.2fs" % api_total)

# Get actual MP3 duration
probe = subprocess.check_output([
    'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    '/app/data/surah_cache/ajmi_008_full.mp3'
], text=True).strip()
actual = float(probe)
print("Actual MP3 duration: %.2fs" % actual)

ratio = actual / api_total
print("Ratio: %.4f" % ratio)
mismatch_pct = abs(actual - api_total) / api_total * 100
print("Mismatch: %.1f%%" % mismatch_pct)

# Calculate what the code would produce
pad_start_ayah = 60  # start_ayah - 2
pad_end_ayah = 66    # end_ayah + 2

start_t = next(t for t in timings if t['ayah'] == pad_start_ayah)
end_t = next(t for t in timings if t['ayah'] == pad_end_ayah)

# From the code: base_macro_start and base_macro_end  
base_start = max(0, float(start_t['start_time'])/1000 - 10)
base_end = float(end_t['end_time'])/1000 + 10

print("\n=== Macro Clip Calculation ===")
print("pad_start_ayah=%d, pad_end_ayah=%d" % (pad_start_ayah, pad_end_ayah))
print("base_start (before scaling): %.2fs" % base_start)
print("base_end (before scaling): %.2fs" % base_end)

# If ratio triggers (>5% difference)
if mismatch_pct > 5:
    scaled_start = max(0, base_start * ratio - 10)
    scaled_end = min(actual, base_end * ratio + 10)
    print("SCALING APPLIED!")
    print("scaled_start: %.2fs" % scaled_start)
    print("scaled_end: %.2fs" % scaled_end)
    print("macro_duration: %.2fs" % (scaled_end - scaled_start))
else:
    scaled_start = max(0, base_start - 10)
    scaled_end = min(actual, base_end + 10)
    print("NO scaling needed")
    print("macro_start: %.2fs" % scaled_start)
    print("macro_end: %.2fs" % scaled_end)
    print("macro_duration: %.2fs" % (scaled_end - scaled_start))

# Show what ayah 60 API timing maps to after scaling
a60_start = float(next(t for t in timings if t['ayah'] == 60)['start_time'])/1000
a62_start = float(next(t for t in timings if t['ayah'] == 62)['start_time'])/1000
a64_end = float(next(t for t in timings if t['ayah'] == 64)['end_time'])/1000

print("\n=== Target Ayah Positions (API) ===")
print("Ayah 60 start (API): %.2fs" % a60_start)
print("Ayah 62 start (API): %.2fs" % a62_start)
print("Ayah 64 end (API):   %.2fs" % a64_end)

if mismatch_pct > 5:
    print("\n=== Target Ayah Positions (Scaled) ===")
    print("Ayah 60 start (scaled): %.2fs" % (a60_start * ratio))
    print("Ayah 62 start (scaled): %.2fs" % (a62_start * ratio))
    print("Ayah 64 end (scaled):   %.2fs" % (a64_end * ratio))
    
    # Relative to macro_start
    print("\n=== Relative to Macro Clip Start ===")
    print("Ayah 60 in macro clip at: %.2fs" % (a60_start * ratio - scaled_start))
    print("Ayah 62 in macro clip at: %.2fs" % (a62_start * ratio - scaled_start))
    print("Ayah 64 ends in macro at: %.2fs" % (a64_end * ratio - scaled_start))
else:
    print("\n=== Relative to Macro Clip Start ===")
    print("Ayah 60 in macro clip at: %.2fs" % (a60_start - scaled_start))
    print("Ayah 62 in macro clip at: %.2fs" % (a62_start - scaled_start))
    print("Ayah 64 ends in macro at: %.2fs" % (a64_end - scaled_start))
