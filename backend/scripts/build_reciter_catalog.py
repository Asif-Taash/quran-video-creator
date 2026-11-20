"""Builds the extra-reciter catalog from mp3quran's public API.

Run on the host from the repository root (needs only the standard library):

    python3 backend/scripts/build_reciter_catalog.py

It writes two files from the same data:
- backend/scripts/mp3quran_reciters.json: backend key -> recording URL
  template, ayat_timing read id (or null) and the surahs it has. Merged
  into RECITERS_MP3QURAN / RECITERS_TIMING_ID by extract_precise_clip.py.
- frontend/src/lib/mp3quranReciters.json: the names the reciter picker,
  the video credit and the suggested title use. Appended to RECITERS by
  lib/reciterNames.ts.

Only Hafs 'an 'Asim recordings are taken (the app's Quran text and aligner
are Hafs), murattal and mujawwad; the teaching mushafs (المصحف المعلم)
repeat every ayah, so they are left out. The built-in reciters (CURATED
below) keep their hand-written entries and are skipped here.
"""
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND_OUT = ROOT / "backend" / "scripts" / "mp3quran_reciters.json"
FRONTEND_OUT = ROOT / "frontend" / "src" / "lib" / "mp3quranReciters.json"

# Recording folders the built-in reciters already use (some under mp3quran's
# older server names, mapped here to the cdn folder of the same recording).
CURATED = {
    "ahmad-ajmi/r1", "maher-muaiqly/r1", "mishary-alafasy/r1", "yasser-dosari/r1",
    "abdullah-mousa/r1", "raad-kurdi/r1", "abdulrahman-sudais/r1", "saud-shuraim/r1",
    "saad-ghamdi/r1", "abubakr-shatri/r1", "mahmoud-husary/r1", "muhammad-minshawi/r1",
    "abdulbasit-abdulsamad/r3", "abdulbasit-abdulsamad/r1", "muhammad-minshawi/r2",
    "nasser-qatami/r1", "idrees-abkar/r1", "fares-abbad/r1", "khalid-jalil/r1",
    "ali-jaber/r1", "muhammad-ayyub/r1", "abdullah-juhani/r1", "bandar-baleela/r1",
    "mansour-salimi/r1", "ahmad-nufais/r1", "haitham-dukhain/r1",
}
# Built-in reciters whose plain dropdown label gains "(مرتّل)" because a
# second recording of theirs is added here -- reported, fixed by hand in
# lib/reciterNames.ts.
CURATED_NAMES = {"ماهر المعيقلي", "محمود خليل الحصري", "مشاري العفاسي"}

# mp3quran's English names, where they are misspelt.
LATIN_FIXES = {
    "Slaah Bukhatir": "Salah Bukhatir",
    "Abdullah Basfer": "Abdullah Basfar",
    "Ahmad Nauina": "Ahmad Nuaina",
    "Adel Ryyan": "Adel Rayyan",
    "Saber Abdulhakm": "Saber Abdulhakam",
    "Mohammad Abdullkarem": "Mohammad Abdulkarim",
    "Ibrahim Al-Akdar": "Ibrahim Al-Akhdar",
    "Shirazad Taher": "Shirzad Taher",
    "Abdelbari Al-Toubayti": "Abdulbari Al-Thubaiti",
    "Mohammad Al-Tablaway": "Mohammad Al-Tablawi",
    "Abdullah Al-Mattrod": "Abdullah Al-Matrood",
    "Ali Hajjaj Alsouasi": "Ali Hajjaj Al-Souissi",
    "Mohammed Al-Lohaidan": "Mohammed Al-Luhaidan",
    "Khalid Al-Jileel": "Khalid Al-Jalil",
    # The built-in reciters' spelling, for their other recordings.
    "Maher Al Meaqli": "Maher Al-Muaiqly",
    "Mahmoud Khalil Al-Hussary": "Mahmoud Khalil Al-Husary",
    "Mohammed Siddiq Al-Minshawi": "Muhammad Siddiq Al-Minshawi",
    "Mohammed Ayyub": "Muhammad Ayyub",
    "Ahmed Al-trabulsi": "Ahmed Al-Trabulsi",
    "Mahmoud Ali Albanna": "Mahmoud Ali Al-Banna",
    "Abdullah Qaulan": "Abdullah Ghailan",
    "Mustafa raad Alazawy": "Mustafa Raad Al-Azzawi",
    "Sami Al-Hasn": "Sami Al-Hassan",
    "Yusuf ALaidroos": "Yousef Al-Aidarous",
    "Hitham Aljadani": "Haitham Al-Jadani",
    "Nathier Almalki": "Nadhir Al-Maliki",
    "Adel Al-Khalbany": "Adel Al-Kalbani",
    "Ibrahem Assadan": "Ibrahim Al-Saadan",
    "Mahmood Al rifai": "Mahmoud Al-Rifai",
    "Nabil Al Rifay": "Nabil Al-Rifai",
    "Hani Arrifai": "Hani Al-Rifai",
    "Nasser Al obaid": "Nasser Al-Obaid",
    "Shaban Al-Sayiaad": "Shaban Al-Sayyad",
    "Saad Almqren": "Saad Al-Muqrin",
    "Salman Alsadeiq": "Salman Al-Siddiq",
    "Mohammed Hafas Ali": "Mohammed Hafs Ali",
}
# Recordings of only a few surahs (mostly competition recordings) would
# crowd the list while being usable for almost nothing.
MIN_SURAHS = 10

KIND_LABELS = {
    "مرتل": ("مرتّل", "Murattal"),
    "المصحف المجود": ("مجوّد", "Mujawwad"),
    "تلاوة مميزة": ("تلاوة مميزة", "Special"),
}


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


def folder_of(server):
    m = re.search(r"/audio/([^/]+/r\d+)/?$", server)
    return m.group(1) if m else None


def ranges(nums):
    nums = sorted(nums)
    out, start = [], None
    for i, n in enumerate(nums):
        if start is None:
            start = n
        if i + 1 == len(nums) or nums[i + 1] != n + 1:
            out.append(str(start) if start == n else f"{start}-{n}")
            start = None
    return ",".join(out)


def clean_latin(name):
    name = re.sub(r"\s+", " ", name).strip()
    name = LATIN_FIXES.get(name, name)
    # "Alturki" -> "Al-Turki", in surnames only ("Alzain", "Ali" and "Alim"
    # are given names or part of one).
    words = name.split(" ")
    for i in range(1, len(words)):
        w = words[i]
        if re.fullmatch(r"Al[a-z]{3,}", w) and w != "Alim":
            words[i] = "Al-" + w[2].upper() + w[3:]
    return " ".join(words)


def main():
    reads = get("https://mp3quran.net/api/v3/ayat_timing/reads")
    ar = get("https://mp3quran.net/api/v3/reciters?language=ar")["reciters"]
    eng = {r["id"]: r["name"] for r in get("https://mp3quran.net/api/v3/reciters?language=eng")["reciters"]}
    timing_by_folder = {folder_of(r["folder_url"]): r["id"] for r in reads if folder_of(r["folder_url"])}

    entries = []
    for reciter in ar:
        kept = []
        for moshaf in reciter["moshaf"]:
            parts = [p.strip() for p in moshaf["name"].split(" - ")]
            if parts[0] != "حفص عن عاصم" or "المعلم" in moshaf["name"]:
                continue
            folder = folder_of(moshaf["server"])
            if not folder or not moshaf.get("surah_list"):
                continue
            if len([x for x in moshaf["surah_list"].split(",") if x.strip()]) < MIN_SURAHS:
                continue
            kind = parts[-1] if parts[-1] in KIND_LABELS else ("المصحف المجود" if "المجود" in moshaf["name"] else "مرتل")
            # The 1967 Minshawi recording is named by its year.
            year = re.search(r"(\d{4})م", moshaf["name"])
            kept.append((moshaf, folder, kind, year.group(1) if year else None))
        if not kept:
            continue
        # r1 first, so it is the plain "(مرتّل)" and a later one "(مرتّل 2)".
        kept.sort(key=lambda k: int(k[1].rsplit("/r", 1)[1]))
        name_ar = re.sub(r"\s+", " ", reciter["name"]).strip()
        name_latin = clean_latin(eng.get(reciter["id"], ""))
        if not name_latin:
            print(f"skipped (no English name): {name_ar}", file=sys.stderr)
            continue
        # Labels name the kind when a reciter has more than one recording
        # here or among the built-in ones.
        several = len(kept) > 1 or name_ar in CURATED_NAMES or any(f in CURATED for _, f, _, _ in kept)
        seen_labels = {}
        for moshaf, folder, kind, year in kept:
            if folder in CURATED:
                continue
            key = "mq_" + re.sub(r"[^a-z0-9]+", "_", folder.lower()).strip("_")
            key = re.sub(r"_r1$", "", key)
            surahs = sorted(int(s) for s in moshaf["surah_list"].split(",") if s.strip())
            label_ar, label_lat = KIND_LABELS[kind]
            if year:
                label_ar, label_lat = f"تسجيل {year}", year
            # Two recordings of the same kind: "(مرتّل)" and "(مرتّل 2)".
            seen_labels[label_ar] = seen_labels.get(label_ar, 0) + 1
            if seen_labels[label_ar] > 1:
                label_ar, label_lat = f"{label_ar} {seen_labels[label_ar]}", f"{label_lat} {seen_labels[label_ar]}"
            entry = {
                "id": key,
                "backendKey": key,
                "nameAr": name_ar,
                "nameLatin": name_latin,
                "url": moshaf["server"].rstrip("/") + "/{surah:03d}.mp3",
                "timing": timing_by_folder.get(folder),
                "surahs": ranges(surahs),
            }
            if several or kind != "مرتل":
                entry["labelAr"] = f"{name_ar} ({label_ar})"
                entry["labelLatin"] = f"{name_latin} ({label_lat})"
            entries.append(entry)

    entries.sort(key=lambda e: (e["nameAr"], e.get("labelAr", "").replace(")", " ")))
    keys = [e["id"] for e in entries]
    assert len(keys) == len(set(keys)), "duplicate keys"
    assert all(len(k) <= 40 for k in keys), "key too long"

    backend = {e["backendKey"]: {"url": e["url"], "timing": e["timing"], "surahs": e["surahs"]} for e in entries}
    frontend = [
        {k: e[k] for k in ("id", "backendKey", "nameAr", "nameLatin", "labelAr", "labelLatin") if k in e}
        | ({"surahs": e["surahs"]} if e["surahs"] != "1-114" else {})
        | ({"timed": True} if e["timing"] else {})
        for e in entries
    ]
    BACKEND_OUT.write_text(json.dumps(backend, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    FRONTEND_OUT.write_text(json.dumps(frontend, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{len(entries)} recordings, {sum(1 for e in entries if e['timing'])} with ayah timing, "
          f"{sum(1 for e in entries if e['surahs'] != '1-114')} partial")


if __name__ == "__main__":
    main()
