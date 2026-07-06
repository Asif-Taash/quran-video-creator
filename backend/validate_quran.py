"""
Kuran Nuru — Quran Data Validation Script
=========================================
Run this inside the Docker backend container to validate the seeded database.

Usage:
    docker compose exec backend python validate_quran.py

Output:
    Prints a human-readable validation report and writes validation_report.json
"""

import json
import sys
from datetime import datetime
from sqlalchemy.orm import Session
from app.database import SessionLocal
from app import models

# ── Known authoritative constants ─────────────────────────────────────────────
EXPECTED_SURAH_COUNT = 114
EXPECTED_AYAH_COUNT = 6236

# Ayah counts per surah (1-indexed) — from Tanzil / standard Uthmani mushaf
EXPECTED_AYAH_COUNTS = [
    7, 286, 200, 176, 120, 165, 206, 75, 129, 109,
    123, 111, 43, 52, 99, 128, 111, 110, 98, 135,
    112, 78, 118, 64, 77, 227, 93, 88, 69, 60,
    34, 30, 73, 54, 45, 83, 182, 88, 75, 85,
    54, 53, 89, 59, 37, 35, 38, 29, 18, 45,
    60, 49, 62, 55, 78, 96, 29, 22, 24, 13,
    14, 11, 11, 18, 12, 12, 30, 52, 52, 44,
    28, 28, 20, 56, 40, 31, 50, 40, 46, 42,
    29, 19, 36, 25, 22, 17, 19, 26, 30, 20,
    15, 21, 11, 8, 8, 5, 5, 8, 8, 11,
    11, 8, 3, 9, 5, 4, 5, 3, 6, 3,
    5, 4, 5, 6,
]

# Known sajdah ayahs: (surah_id, ayah_number) — 15 total per Hanafi school
KNOWN_SAJDAH = [
    (7, 206), (13, 15), (16, 50), (17, 109), (19, 58),
    (22, 18), (22, 77), (25, 60), (27, 26), (32, 15),
    (38, 24), (41, 38), (53, 62), (84, 21), (96, 19),
]

# ── Validator ─────────────────────────────────────────────────────────────────
def validate(db: Session) -> dict:
    issues = []
    warnings = []
    checks = []

    def check(name: str, passed: bool, detail: str = ""):
        status = "PASS" if passed else "FAIL"
        checks.append({"check": name, "status": status, "detail": detail})
        if not passed:
            issues.append(f"[FAIL] {name}: {detail}")
        return passed

    def warn(name: str, detail: str):
        warnings.append(f"[WARN] {name}: {detail}")
        checks.append({"check": name, "status": "WARN", "detail": detail})

    print("=" * 60)
    print("Kuran Nuru Quran Data Validation")
    print(f"Run at: {datetime.utcnow().isoformat()}Z")
    print("=" * 60)

    # ── 1. Surah count ────────────────────────────────────────────────────────
    surah_count = db.query(models.Surah).count()
    check(
        "Surah count = 114",
        surah_count == EXPECTED_SURAH_COUNT,
        f"Found {surah_count}",
    )

    # ── 2. Total ayah count ───────────────────────────────────────────────────
    ayah_count = db.query(models.Ayah).count()
    check(
        "Total ayah count = 6236",
        ayah_count == EXPECTED_AYAH_COUNT,
        f"Found {ayah_count}",
    )

    # ── 3. Surah ordering (IDs 1–114 sequential) ─────────────────────────────
    surah_ids = [s.id for s in db.query(models.Surah).order_by(models.Surah.id).all()]
    check(
        "Surah IDs are sequential 1–114",
        surah_ids == list(range(1, 115)),
        f"Missing: {set(range(1,115)) - set(surah_ids)}" if surah_ids != list(range(1,115)) else "OK",
    )

    # ── 4. Per-surah ayah count ───────────────────────────────────────────────
    per_surah_issues = []
    for i, expected in enumerate(EXPECTED_AYAH_COUNTS, 1):
        actual = db.query(models.Ayah).filter(models.Ayah.surah_id == i).count()
        if actual != expected:
            per_surah_issues.append(f"Surah {i}: expected {expected}, found {actual}")
    check(
        "Per-surah ayah counts match Tanzil",
        len(per_surah_issues) == 0,
        "; ".join(per_surah_issues[:5]) if per_surah_issues else "All match",
    )

    # ── 5. No duplicate (surah_id, ayah_number) pairs ────────────────────────
    from sqlalchemy import func
    dupe_count = (
        db.query(models.Ayah.surah_id, models.Ayah.ayah_number)
        .group_by(models.Ayah.surah_id, models.Ayah.ayah_number)
        .having(func.count() > 1)
        .count()
    )
    check("No duplicate (surah, ayah) pairs", dupe_count == 0, f"{dupe_count} duplicates found")

    # ── 6. No NULL Arabic text ────────────────────────────────────────────────
    null_arabic = db.query(models.Ayah).filter(models.Ayah.text_arabic.is_(None)).count()
    check("No NULL text_arabic", null_arabic == 0, f"{null_arabic} NULL values")

    # ── 7. No NULL Turkish text ───────────────────────────────────────────────
    null_turkish = db.query(models.Ayah).filter(models.Ayah.text_turkish.is_(None)).count()
    check("No NULL text_turkish", null_turkish == 0, f"{null_turkish} NULL values")

    # ── 8. Juz range 1–30 ────────────────────────────────────────────────────
    invalid_juz = (
        db.query(models.Ayah)
        .filter((models.Ayah.juz_number < 1) | (models.Ayah.juz_number > 30))
        .count()
    )
    check("All juz_number values in 1–30", invalid_juz == 0, f"{invalid_juz} out-of-range values")

    # ── 9. Sajdah markers ────────────────────────────────────────────────────
    sajdah_db = set(
        (a.surah_id, a.ayah_number)
        for a in db.query(models.Ayah).filter(models.Ayah.sajdah.is_(True)).all()
    )
    known_set = set(KNOWN_SAJDAH)
    missing_sajdah = known_set - sajdah_db
    extra_sajdah = sajdah_db - known_set

    if missing_sajdah:
        warn("Sajdah markers — missing", str(missing_sajdah))
    if extra_sajdah:
        warn("Sajdah markers — unexpected", str(extra_sajdah))
    if not missing_sajdah and not extra_sajdah:
        checks.append({"check": "Sajdah markers complete", "status": "PASS", "detail": f"{len(sajdah_db)} found"})

    # ── 10. Audio URL format ──────────────────────────────────────────────────
    sample = db.query(models.Ayah).filter(models.Ayah.audio_url.isnot(None)).first()
    if sample:
        valid_audio = sample.audio_url.startswith("http")
        check(
            "Audio URLs are absolute URLs",
            valid_audio,
            f"Sample: {sample.audio_url[:60]}",
        )
    else:
        warn("Audio URL check", "No ayahs with audio_url found")

    # ── 11. Unicode integrity spot-check ─────────────────────────────────────
    fatiha = db.query(models.Ayah).filter(
        models.Ayah.surah_id == 1, models.Ayah.ayah_number == 1
    ).first()
    if fatiha:
        expected_bismillah = "ﱁ ﱂ ﱃ ﱄ ﱅ"
        check(
            "Surah 1 Ayah 1 PUA string correct",
            fatiha.text_arabic == expected_bismillah,
            f"DB: {fatiha.text_arabic[:40]!r}" if fatiha.text_arabic != expected_bismillah else "Match",
        )
    else:
        warn("Surah 1 Ayah 1 check", "Ayah not found in DB")

    # ── Summary ───────────────────────────────────────────────────────────────
    fail_count = sum(1 for c in checks if c["status"] == "FAIL")
    warn_count = sum(1 for c in checks if c["status"] == "WARN")
    pass_count = sum(1 for c in checks if c["status"] == "PASS")

    print(f"\n{'✓ PASS':>10}: {pass_count}")
    print(f"{'⚠ WARN':>10}: {warn_count}")
    print(f"{'✗ FAIL':>10}: {fail_count}")
    print()

    for c in checks:
        icon = "✓" if c["status"] == "PASS" else ("⚠" if c["status"] == "WARN" else "✗")
        print(f"  {icon} {c['check']}: {c['detail']}")

    report = {
        "run_at": datetime.utcnow().isoformat() + "Z",
        "source": "Local quran.json + api.alquran.cloud/v1/quran/tr.yazir",
        "validation_reference": "Tanzil.net — Standard Uthmani Quran counts",
        "summary": {
            "pass": pass_count,
            "warn": warn_count,
            "fail": fail_count,
            "overall": "PASS" if fail_count == 0 else "FAIL",
        },
        "checks": checks,
        "issues": issues,
        "warnings": warnings,
    }
    return report


def main():
    db = SessionLocal()
    try:
        report = validate(db)
    finally:
        db.close()

    # Write JSON report
    with open("validation_report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print("\n📄 Report saved to: validation_report.json")

    if report["summary"]["fail"] > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
