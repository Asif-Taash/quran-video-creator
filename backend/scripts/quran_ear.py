"""The Quran ear (2026-11-21): obadx's Quran Muaalem model
(obadx/muaalem-model-v3_2, Wav2Vec2-BERT with a multi-level CTC head,
trained on ~850 hours of recitation) hears a recitation sound by sound in
the Quran phonetic script (quran-transcript): letters with their harakat,
madd lengths, ghunna, qalqala. It writes what was said -- the expected text
isn't given to it -- so a word said twice is heard twice, and a wrong vowel
shows.

Compared on the same 17 recitations with planted mistakes, the memorization
check built on it found 15-16 of 17 left-out / swapped / added words where
Whisper + MMS found 12-13, with as few false alarms on clean readings.

The model hears a window's first and last moments poorly (a cut inside a
word lost its first letters: «خلق» heard «قلق»), so long audio is heard in
CORE_SEC pieces with CONTEXT_SEC more on each side, keeping the middle:
the frames join up as if heard in one go.

Weights: backend/data/models/muaalem-model-v3_2 (MIT; 2.4 GB; 1.3 GB of
GPU memory in bfloat16). Packages: requirements-quran.txt.
"""
import logging
import threading
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

MODEL_DIR = Path("/app/data/models/muaalem-model-v3_2")
SAMPLE_RATE = 16000
CORE_SEC = 14.0
CONTEXT_SEC = 2.0
# The model gives one frame per 640 samples (40 ms). Its frame times are
# always worked out at this rate: the rate measured on a piece (frames /
# seconds) comes out a little low on a short one -- 24.91 for the live
# pass's few-second tail -- and, used for a 3-minute reading, it put every
# word up to 0.6 s late, a different amount on each pass: slips shown and
# hidden, the reading place jumping back and forth (2026-11-25).
FPS = SAMPLE_RATE / 640

_state = None
_lock = threading.Lock()


def available():
    return (MODEL_DIR / "model.safetensors").exists()


def _load():
    global _state
    if _state is None:
        with _lock:
            if _state is None:
                import torch
                import transformers.models.wav2vec2_bert.modeling_wav2vec2_bert as w2v_bert

                # quran-muaalem was written for transformers 4, which had this
                # constant (it is 2 in every wav2vec2 model); 5 dropped it.
                if not hasattr(w2v_bert, "_HIDDEN_STATES_START_POSITION"):
                    w2v_bert._HIDDEN_STATES_START_POSITION = 2
                from quran_muaalem.modeling.modeling_multi_level_ctc import Wav2Vec2BertForMultilevelCTC
                from quran_muaalem.modeling.multi_level_tokenizer import MultiLevelTokenizer
                from transformers import AutoFeatureExtractor

                device = "cuda" if torch.cuda.is_available() else "cpu"
                dtype = torch.bfloat16 if device == "cuda" else torch.float32
                logger.info(f"Loading the Quran ear (Muaalem) on {device}...")
                model = Wav2Vec2BertForMultilevelCTC.from_pretrained(str(MODEL_DIR), dtype=dtype)
                model.to(device)
                model.eval()
                tokenizer = MultiLevelTokenizer(str(MODEL_DIR))
                id_to_char = {int(i): c for i, c in tokenizer.id_to_vocab["phonemes"].items()}
                _state = {
                    "model": model,
                    "processor": AutoFeatureExtractor.from_pretrained(str(MODEL_DIR)),
                    "device": device,
                    "dtype": dtype,
                    "id_to_char": id_to_char,
                    "vocab": {c: i for i, c in id_to_char.items()},
                }
                logger.info("Quran ear ready.")
    return _state


def warm():
    _load()


def vocab():
    """phonetic char -> CTC id (0 is the blank)."""
    return _load()["vocab"]


def frame_logprobs(audio):
    """(log probabilities [T, V] as a float32 CPU tensor, frames per second)
    for 16 kHz mono samples: CORE_SEC pieces heard with CONTEXT_SEC of the
    audio around them, only their own frames kept."""
    import torch

    st = _load()
    sr = SAMPLE_RATE
    core, ctx = int(CORE_SEC * sr), int(CONTEXT_SEC * sr)
    parts = []
    fps = FPS
    with torch.inference_mode():
        for s in range(0, len(audio), core):
            a, b = max(0, s - ctx), min(len(audio), s + core + ctx)
            piece = np.ascontiguousarray(audio[a:b], dtype=np.float32)
            if len(piece) < 1600:
                break
            feats = st["processor"]([piece], sampling_rate=sr, return_tensors="pt")
            feats = {k: v.to(st["device"], dtype=st["dtype"]) for k, v in feats.items()}
            out = st["model"](**feats, return_dict=False)[0]["phonemes"][0].float()
            lp = torch.log_softmax(out, dim=-1).cpu()
            f0 = int(round((s - a) / sr * fps))
            f1 = f0 + int(round((min(len(audio), s + core) - s) / sr * fps))
            parts.append(lp[f0:min(f1, lp.shape[0])])
    if not parts:
        return torch.zeros(0, len(st["id_to_char"])), fps
    return torch.cat(parts), fps


def greedy(lp):
    """What was heard: (phonetic text, frame index of each char)."""
    id_to_char = _load()["id_to_char"]
    text, frames = [], []
    prev = None
    for f, i in enumerate(lp.argmax(-1).tolist()):
        if i != prev and i != 0:
            text.append(id_to_char.get(i, ""))
            frames.append(f)
        prev = i
    return "".join(text), frames
