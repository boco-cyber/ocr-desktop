import json
import sys
import re

def _print(obj):
    """Write JSON to stdout as UTF-8 bytes, bypassing Windows cp1252 default."""
    data = (json.dumps(obj, ensure_ascii=False) + '\n').encode('utf-8')
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()

# NLLB requires a source language code. Fall back to English when none is provided.
DEFAULT_SRC_LANG = "eng_Latn"

# Max tokens per segment — NLLB hard limit is 512, use 400 to leave room for overhead
MAX_TOKENS_PER_SEGMENT = 400


def resolve_device(device_pref: str):
    try:
        import torch
        has_cuda = torch.cuda.is_available()
        has_mps = hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
        if device_pref == "gpu":
            if has_cuda: return "cuda:0", "float16"
            if has_mps: return "mps", "float16"
            print("[nllb] WARNING: GPU requested but no CUDA/MPS found; using CPU.", file=sys.stderr)
            return "cpu", "float32"
        if device_pref == "cpu":
            return "cpu", "float32"
        if has_cuda: return "cuda:0", "float16"
        if has_mps: return "mps", "float16"
    except Exception:
        pass
    return "cpu", "float32"


def clean_text(text: str) -> str:
    if not isinstance(text, str):
        text = str(text) if text is not None else ""
    text = text.replace("\x00", "")
    text = text.encode("utf-8", errors="replace").decode("utf-8", errors="replace")
    return text


def load_tokenizer(model_name: str, src_lang: str):
    from transformers import AutoTokenizer
    try:
        return AutoTokenizer.from_pretrained(model_name, src_lang=src_lang, use_fast=False)
    except Exception:
        return AutoTokenizer.from_pretrained(model_name, src_lang=src_lang)


def split_into_segments(text: str, tokenizer, max_tokens: int) -> list:
    """
    Split text into segments that each fit within max_tokens.
    Splits on sentence boundaries first, then falls back to word boundaries.
    """
    # Split on sentence-ending punctuation (Arabic + Latin)
    sentence_endings = re.compile(
        r'(?<=[.!?؟。！？])\s+|(?<=\n)\s*'
    )
    # First split by double newlines (paragraphs), then sentences within each
    paragraphs = re.split(r'\n{2,}', text.strip())
    sentences = []
    for para in paragraphs:
        parts = sentence_endings.split(para.strip())
        for part in parts:
            part = part.strip()
            if part:
                sentences.append(part)
        sentences.append('\n\n')  # paragraph boundary marker

    # Remove trailing paragraph marker
    while sentences and sentences[-1] == '\n\n':
        sentences.pop()

    segments = []
    current = ''
    current_tokens = 0

    for sentence in sentences:
        is_para_break = sentence == '\n\n'

        if is_para_break:
            if current:
                current += '\n\n'
            continue

        token_count = len(tokenizer.encode(sentence, add_special_tokens=False))

        # Single sentence exceeds limit — split by words
        if token_count > max_tokens:
            words = sentence.split()
            word_chunk = ''
            word_tokens = 0
            for word in words:
                wt = len(tokenizer.encode(word, add_special_tokens=False))
                if word_tokens + wt > max_tokens and word_chunk:
                    segments.append(word_chunk.strip())
                    word_chunk = word
                    word_tokens = wt
                else:
                    word_chunk = (word_chunk + ' ' + word).strip() if word_chunk else word
                    word_tokens += wt
            if word_chunk.strip():
                segments.append(word_chunk.strip())
            current = ''
            current_tokens = 0
            continue

        candidate = (current + ' ' + sentence).strip() if current.strip() else sentence
        candidate_tokens = current_tokens + token_count

        if current_tokens > 0 and candidate_tokens > max_tokens:
            segments.append(current.strip())
            current = sentence
            current_tokens = token_count
        else:
            current = candidate
            current_tokens = candidate_tokens

    if current.strip():
        segments.append(current.strip())

    return [s for s in segments if s.strip()]


def translate_segment(text: str, tokenizer, model, device_str: str, target_lang_id: int) -> str:
    import torch
    inputs = tokenizer(
        text,
        return_tensors="pt",
        truncation=True,
        max_length=512,
        padding=False,
    ).to(device_str)
    input_len = inputs["input_ids"].shape[-1]
    max_new = min(512, max(64, input_len * 3))
    with torch.no_grad():
        tokens = model.generate(
            **inputs,
            forced_bos_token_id=target_lang_id,
            max_new_tokens=max_new,
            max_length=None,
            num_beams=4,
            early_stopping=True,
        )
    return tokenizer.batch_decode(tokens, skip_special_tokens=True)[0]


def main() -> int:
    raw = sys.stdin.buffer.read()
    payload = json.loads(raw.decode('utf-8'))
    mode = payload.get("type", "translate")

    try:
        import torch
        from transformers import AutoModelForSeq2SeqLM
    except Exception as exc:
        _print({"ok": False, "error": f"NLLB runtime unavailable: {exc}"})
        return 0

    # ── Health check ──────────────────────────────────────────────────────────
    if mode == "health-check":
        try:
            gpu_info = ""
            if torch.cuda.is_available():
                gpu_name = torch.cuda.get_device_name(0)
                vram_gb = torch.cuda.get_device_properties(0).total_memory / 1e9
                gpu_info = f" (GPU: {gpu_name}, {vram_gb:.1f} GB VRAM)"
            _print({"ok": True, "gpu_info": gpu_info})
        except Exception:
            _print({"ok": True})
        return 0

    # ── Translation ───────────────────────────────────────────────────────────
    raw_text      = payload.get("text", "")
    model_name    = payload.get("model") or "facebook/nllb-200-distilled-600M"
    target_lang   = payload.get("targetLanguage")
    source_lang   = payload.get("sourceLanguage") or DEFAULT_SRC_LANG
    device_pref   = payload.get("device") or "auto"
    max_memory_gb = float(payload.get("maxMemoryGb") or 0)

    if isinstance(raw_text, list):
        text = " ".join(str(t) for t in raw_text)
    elif raw_text is None:
        text = ""
    else:
        text = str(raw_text)

    text = clean_text(text)

    if not target_lang:
        _print({"ok": False, "error": "targetLanguage is required for NLLB."})
        return 0

    if not text.strip():
        _print({"ok": True, "text": ""})
        return 0

    try:
        device_str, dtype_str = resolve_device(device_pref)
        torch_dtype = torch.float16 if dtype_str == "float16" else torch.float32

        model_kwargs = {}
        if max_memory_gb and max_memory_gb > 0:
            limit = f"{max_memory_gb:.1f}GiB"
            if device_str.startswith("cuda"):
                dev_idx = int(device_str.split(":")[-1]) if ":" in device_str else 0
                model_kwargs["max_memory"] = {dev_idx: limit, "cpu": "4GiB"}
            else:
                model_kwargs["max_memory"] = {"cpu": limit}

        tokenizer = load_tokenizer(model_name, source_lang)

        model = AutoModelForSeq2SeqLM.from_pretrained(
            model_name,
            dtype=torch_dtype,
            **model_kwargs,
        ).to(device_str)
        model.eval()

        target_lang_id = tokenizer.convert_tokens_to_ids(target_lang)
        if target_lang_id == tokenizer.unk_token_id:
            _print({"ok": False, "error": f"Unknown NLLB language code: '{target_lang}'."})
            return 0

        # Split into segments that fit the 512-token limit, translate each, reassemble
        segments = split_into_segments(text, tokenizer, MAX_TOKENS_PER_SEGMENT)

        translated_parts = []
        for segment in segments:
            part = translate_segment(segment, tokenizer, model, device_str, target_lang_id)
            translated_parts.append(part)

        # Rejoin preserving paragraph breaks where the original had them
        translated = '\n\n'.join(translated_parts) if len(translated_parts) > 1 else (translated_parts[0] if translated_parts else '')

        _print({"ok": True, "text": translated})
        return 0

    except Exception as exc:
        import traceback
        traceback.print_exc(file=sys.stderr)
        _print({"ok": False, "error": f"NLLB translation failed: {exc}"})
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
