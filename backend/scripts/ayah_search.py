"""Search for ayahs by meaning (2026-11-20): "الصبر", "sabır", "patience",
"cennet nimetleri"... finds the ayahs about it, not only those containing
the word.

multilingual-e5-base (MIT, free, local) embeds every ayah three times --
its Arabic text, a Turkish translation (Diyanet Vakfı) and an English one
(Sahih International) -- once, into /app/data/ayah_search/. A query is
embedded on the CPU (0.1-0.3 s) and an ayah scores the mean of its three
similarities. Tried on 2026-11-20 with ~20 Arabic/Turkish/English queries:
- e5-small mixed up short words ("الأم" found "الم", "التوبة" found
  punishment ayahs), so the base model is used.
- The best of the three (instead of the mean) let a short Arabic ayah win
  on spelling alone; ayahs under 4 words get a small penalty for the same
  reason (the disjointed letters).
- A short Latin query is ambiguous across languages ("dua" is "two" in
  Malay), so a Turkish-UI query is marked "Türkçe:" -- "anne", "dua",
  "kıyamet" all went from off-topic to right.
- "Verses about X" wordings attracted ayahs that mention "verses".
A query word found in an ayah's text adds a little (LITERAL_BONUS), so an
exact word ranks first among equally close meanings.

Build the index (about a minute on the GPU, once):

    docker compose exec -T backend python -I scripts/ayah_search.py --build

The Turkish translation is copied in from the frontend's local data
(frontend/src/data/translations/diyanet_vakfi.json -> data/ayah_search/);
the Arabic and English texts are downloaded from alquran.cloud. None of it
is published (backend/data is git-ignored).
"""
import argparse
import json
import logging
import os
import re
import threading
import time
import unicodedata
import urllib.request
from pathlib import Path

os.environ.setdefault("HF_HOME", "/app/data/huggingface_cache")

logger = logging.getLogger(__name__)

MODEL = os.environ.get("AYAH_SEARCH_MODEL", "intfloat/multilingual-e5-base")
DIR = Path(os.environ.get("AYAH_SEARCH_DIR", "/app/data/ayah_search"))
INDEX_VERSION = 1
LANGS = ("ar", "tr", "en")
# Added per query word found in the ayah's texts, at most twice (e5
# similarities between related texts sit around 0.80-0.90).
LITERAL_BONUS = 0.03
SHORT_AYAH_WORDS = 4
SHORT_AYAH_PENALTY = 0.03
# Spellings the translation doesn't use.
SYNONYMS = {"tövbe": "tevbe", "tovbe": "tevbe"}

_lock = threading.Lock()
_state = None


def _model(device):
    from transformers import AutoModel, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(MODEL)
    model = AutoModel.from_pretrained(MODEL).to(device).eval()
    return tok, model


def _embed(tok, model, texts, device, batch=64):
    import torch

    out = []
    with torch.no_grad():
        for i in range(0, len(texts), batch):
            enc = tok(texts[i:i + batch], padding=True, truncation=True, max_length=256, return_tensors="pt").to(device)
            hidden = model(**enc).last_hidden_state
            mask = enc["attention_mask"].unsqueeze(-1).to(hidden.dtype)
            emb = (hidden * mask).sum(1) / mask.sum(1)
            out.append(torch.nn.functional.normalize(emb.float(), dim=-1).cpu())
    return torch.cat(out).numpy()


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def _edition(name):
    data = _get(f"http://api.alquran.cloud/v1/quran/{name}")["data"]["surahs"]
    out = {}
    for s in data:
        for a in s["ayahs"]:
            text = a["text"]
            if s["number"] not in (1, 9) and a["numberInSurah"] == 1:
                text = re.sub(r"^﻿?بسم الله الرحمن الرحيم\s*", "", text)
            out[f"{s['number']}:{a['numberInSurah']}"] = text
    return out


def build():
    import numpy as np
    import torch

    DIR.mkdir(parents=True, exist_ok=True)
    tr_path = DIR / "diyanet_vakfi.json"
    if not tr_path.exists() and (Path("/app/data/ayah_search") / "diyanet_vakfi.json").exists():
        import shutil
        shutil.copy(Path("/app/data/ayah_search") / "diyanet_vakfi.json", tr_path)
    if not tr_path.exists():
        raise SystemExit(f"Copy the Turkish translation to {tr_path} first.")
    tr = json.loads(tr_path.read_text(encoding="utf-8"))
    ar = _edition("quran-simple-clean")
    en = _edition("en.sahih")
    keys = list(ar.keys())
    assert len(keys) == 6236, len(keys)
    texts = {"ar": [ar[k] for k in keys], "tr": [tr.get(k, "") for k in keys], "en": [en.get(k, "") for k in keys]}
    device = "cuda" if torch.cuda.is_available() else "cpu"
    tok, model = _model(device)
    if device == "cuda":
        model = model.half()
    t0 = time.time()
    for lang in LANGS:
        emb = _embed(tok, model, ["passage: " + t for t in texts[lang]], device)
        np.save(DIR / f"emb_{lang}.npy", emb.astype(np.float16))
    (DIR / "texts.json").write_text(json.dumps({"keys": keys, **texts}, ensure_ascii=False), encoding="utf-8")
    (DIR / "meta.json").write_text(json.dumps({"model": MODEL, "version": INDEX_VERSION}), encoding="utf-8")
    print(f"Indexed {len(keys)} ayahs x {len(LANGS)} texts in {time.time() - t0:.1f}s on {device}.")


def available():
    try:
        meta = json.loads((DIR / "meta.json").read_text())
        return meta.get("model") == MODEL and meta.get("version") == INDEX_VERSION
    except Exception:
        return False


def _load():
    global _state
    if _state is None:
        with _lock:
            if _state is None:
                import numpy as np

                t0 = time.time()
                texts = json.loads((DIR / "texts.json").read_text(encoding="utf-8"))
                emb = {lang: np.load(DIR / f"emb_{lang}.npy").astype(np.float32) for lang in LANGS}
                tok, model = _model("cpu")
                words = {lang: [set(re.findall(r"\w+", _fold(t))) for t in texts[lang]] for lang in LANGS}
                short = np.array([len(t.split()) < SHORT_AYAH_WORDS for t in texts["ar"]])
                _state = {"keys": texts["keys"], "emb": emb, "tok": tok, "model": model, "words": words, "short": short,
                          "index": {k: i for i, k in enumerate(texts["keys"])}, "texts": texts}
                logger.info(f"Ayah search ready in {time.time() - t0:.1f}s.")
    return _state


_AR_MARKS = re.compile(r"[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]")
_VOWELS = "aeıioöuüâîû"


def _fold(text):
    """Lower case, no Arabic marks, one alef/ya/ta marbuta, no Latin accents
    -- for the literal-word bonus only."""
    text = _AR_MARKS.sub("", text)
    text = re.sub("[أإآٱ]", "ا", text).replace("ة", "ه").replace("ى", "ي")
    text = unicodedata.normalize("NFKD", text.replace("İ", "i").replace("I", "ı").lower())
    return "".join(c for c in text if not unicodedata.combining(c))


def _is_arabic(word):
    return bool(re.match(r"[\u0600-\u06ff]", word))


def _word_found(word, tokens):
    """A query word in an ayah's words: Latin ones as a word start (Turkish
    drops a vowel before a suffix: sabır -> sabredin, şükür -> şükret);
    Arabic ones without "ال" and a leading و/ف/ب/ل/ك, whole for short words
    (so "الأم" isn't found in "الأمانة")."""
    if _is_arabic(word):
        core = word[2:] if word.startswith("ال") and len(word) > 3 else word
        for tok in tokens:
            t = tok[1:] if tok[:1] in ("و", "ف") and len(tok) > 3 else tok
            t = t[1:] if t[:1] in ("ب", "ل", "ك") and len(t) > 3 else t
            t = t[2:] if t.startswith("ال") and len(t) > 3 else t
            if (t == core) if len(core) <= 3 else t.startswith(core):
                return True
        return False
    forms = {word}
    if len(word) >= 4 and word[-2] in _VOWELS and word[-1] not in _VOWELS and word[-3] not in _VOWELS:
        forms.add(word[:-2] + word[-1])
    return any(tok.startswith(f) for tok in tokens for f in forms)


def search(query, limit=40, ui_language=None):
    """[(surah, ayah, score)] best first."""
    import numpy as np

    st = _load()
    query = " ".join(SYNONYMS.get(w.lower(), w) for w in query.strip().split())
    text = query
    if ui_language == "tr" and not re.search(r"[\u0600-\u06ff]", query):
        text = f"Türkçe: {query}"
    q = _embed(st["tok"], st["model"], ["query: " + text], "cpu")[0]
    scores = np.mean(np.stack([st["emb"][lang] @ q for lang in LANGS]), axis=0)
    scores -= SHORT_AYAH_PENALTY * st["short"]
    words = [w for w in re.findall(r"\w+", _fold(query)) if len(w) >= 3]
    if words:
        for i in np.argsort(-scores)[:400]:
            found = sum(1 for w in words if any(_word_found(w, st["words"][lang][i]) for lang in LANGS))
            scores[i] += LITERAL_BONUS * min(found, 2)
    best = np.argsort(-scores)[:limit]
    out = []
    for i in best:
        s, a = st["keys"][i].split(":")
        out.append((int(s), int(a), round(float(scores[i]), 4)))
    return out


def translation(surah, ayah, lang):
    """The indexed Turkish/English translation of an ayah, or None."""
    st = _load()
    i = st["index"].get(f"{surah}:{ayah}")
    return st["texts"][lang][i] if i is not None and lang in ("tr", "en") else None


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--build", action="store_true")
    parser.add_argument("--query")
    parser.add_argument("--ui", default=None)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    if args.build:
        build()
    if args.query:
        for s, a, sc in search(args.query, 10, args.ui):
            print(f"{s}:{a} {sc}")
