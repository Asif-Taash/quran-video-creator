"""Regression check for segment_align: 48 Diyanet-translated ayahs whose
split was checked by hand (segment_align_cases.json -- sentence-level
splits; 14:36 corrected, 67:25 dropped). Run in the backend container:

    python /app/scripts/eval_segment_align.py

Baseline (2026-10-27): 91/97 cuts exact.
"""
import json
from pathlib import Path

import segment_align

cases = json.loads((Path(__file__).parent / "segment_align_cases.json").read_text(encoding="utf-8"))
right = total = flagged_wrong = flagged_right = 0
for c in cases:
    got = segment_align.align(c["surah"], c["ayah"], c["tokens"], c["segments"], "tr")
    want_edges = [sum(c["word_counts"][:i + 1]) for i in range(len(c["word_counts"]) - 1)]
    got_edges = [sum(got["word_counts"][:i + 1]) for i in range(len(got["word_counts"]) - 1)]
    for w, g, margin in zip(want_edges, got_edges, got["margins"]):
        total += 1
        ok = w == g
        right += ok
        if margin < segment_align.LOW_CONFIDENCE_MARGIN:
            flagged_right += ok
            flagged_wrong += not ok
    if got_edges != want_edges:
        print(f"  {c['surah']}:{c['ayah']} got {got['word_counts']} want {c['word_counts']}")
print(f"cuts exact: {right}/{total}; uncertain-flag caught {flagged_wrong}/{total - right} wrong cuts, "
      f"flagged {flagged_right}/{right} right ones")
