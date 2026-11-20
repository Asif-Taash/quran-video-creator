"""Regression check for segment_align: 48 Diyanet-translated ayahs whose
split was checked by hand (segment_align_cases.json -- sentence-level
splits; 14:36 corrected, 67:25 dropped). Run in the backend container:

    python /app/scripts/eval_segment_align.py            # align()
    python /app/scripts/eval_segment_align.py --reverse  # split_translation()

align() finds each segment's Arabic words; --reverse gives split_translation()
the right Arabic parts and the whole translation, and checks it cuts the text
back into the same segments.

Baseline: align() 91/97 cuts exact (2026-10-27); split_translation() 95/97
(2026-11-16).
"""
import json
import sys
from pathlib import Path

import segment_align

reverse = "--reverse" in sys.argv[1:]
cases = json.loads((Path(__file__).parent / "segment_align_cases.json").read_text(encoding="utf-8"))
right = total = flagged_wrong = flagged_right = 0
for c in cases:
    if reverse:
        got = segment_align.split_translation(
            c["surah"], c["ayah"], c["tokens"], c["word_counts"], " ".join(c["segments"]), "tr"
        )
        want_sizes = [len(s.split()) for s in c["segments"]]
        got_sizes = [len(p.split()) for p in got["pieces"]]
    else:
        got = segment_align.align(c["surah"], c["ayah"], c["tokens"], c["segments"], "tr")
        want_sizes, got_sizes = c["word_counts"], got["word_counts"]
    want_edges = [sum(want_sizes[:i + 1]) for i in range(len(want_sizes) - 1)]
    got_edges = [sum(got_sizes[:i + 1]) for i in range(len(got_sizes) - 1)]
    for w, g, margin in zip(want_edges, got_edges, got["margins"]):
        total += 1
        ok = w == g
        right += ok
        if margin < segment_align.LOW_CONFIDENCE_MARGIN:
            flagged_right += ok
            flagged_wrong += not ok
    if got_edges != want_edges:
        print(f"  {c['surah']}:{c['ayah']} got {got_sizes} want {want_sizes}")
print(f"cuts exact: {right}/{total}; uncertain-flag caught {flagged_wrong}/{total - right} wrong cuts, "
      f"flagged {flagged_right}/{right} right ones")
