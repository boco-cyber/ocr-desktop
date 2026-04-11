"""
PaddleOCR persistent server for ocr-desktop.
Called once by providers/paddleocr.js via child_process.spawn.
Stays alive and handles multiple OCR requests via stdin/stdout JSON lines.

Protocol (newline-delimited JSON):
  stdin  -> { "id": str, "imageBase64": str, "lang": str, "device": str }
           { "type": "exit" }   <- graceful shutdown
  stdout -> { "id": str, "text": str, "error": null }
           { "type": "ready" }  <- sent once engine is loaded
"""

import sys
import os

# ── Must be set BEFORE any paddle/torch import ───────────────────────────────
os.environ['FLAGS_use_mkldnn'] = '0'
os.environ['FLAGS_enable_pir_in_executor'] = '0'
os.environ['FLAGS_pir_apply_inplace_pass'] = '0'
os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'
os.environ['GLOG_minloglevel'] = '3'
os.environ['GLOG_v'] = '0'

# On Windows: ensure torch/lib is registered with the DLL loader so that
# paddle's dependency on torch's shm.dll can be resolved, then also register
# paddle's own lib dirs. This must happen before any import of paddle or torch.
if sys.platform == 'win32':
    import importlib.util

    # Register torch/lib with the Windows DLL loader (Python 3.8+)
    # paddle depends on torch's shm.dll — it needs torch's DLLs findable
    try:
        torch_spec = importlib.util.find_spec('torch')
        if torch_spec and torch_spec.origin:
            torch_lib = os.path.join(os.path.dirname(torch_spec.origin), 'lib')
            if os.path.isdir(torch_lib) and hasattr(os, 'add_dll_directory'):
                os.add_dll_directory(torch_lib)
    except Exception:
        pass

    # Register paddle's own lib dirs
    try:
        paddle_spec = importlib.util.find_spec('paddle')
        if paddle_spec and paddle_spec.origin:
            paddle_dir = os.path.dirname(paddle_spec.origin)
            if hasattr(os, 'add_dll_directory'):
                for sub in ('libs', 'fluid', 'base'):
                    d = os.path.join(paddle_dir, sub)
                    if os.path.isdir(d):
                        try:
                            os.add_dll_directory(d)
                        except Exception:
                            pass
    except Exception:
        pass

    # Pre-load shm.dll and torch.dll from torch/lib explicitly so the OS
    # uses our already-loaded copies instead of searching PATH
    try:
        import ctypes
        torch_spec = importlib.util.find_spec('torch')
        if torch_spec and torch_spec.origin:
            torch_lib = os.path.join(os.path.dirname(torch_spec.origin), 'lib')
            for dll_name in ('torch.dll', 'shm.dll'):
                dll_path = os.path.join(torch_lib, dll_name)
                if os.path.isfile(dll_path):
                    try:
                        ctypes.WinDLL(dll_path)
                    except Exception:
                        pass
    except Exception:
        pass

import json
import base64
import tempfile
import traceback

# Map ISO codes AND full language names → PaddleOCR lang codes
LANG_MAP = {
    # Chinese
    'zh': 'ch', 'zh-cn': 'ch', 'chinese': 'ch', 'chinese simplified': 'ch',
    'zh-tw': 'chinese_cht', 'chinese traditional': 'chinese_cht',
    # Arabic-script
    'ar': 'ar', 'arabic': 'ar',
    'fa': 'fa', 'persian': 'fa', 'farsi': 'fa',
    'ur': 'ur', 'urdu': 'ur',
    'ps': 'ps', 'pashto': 'ps',
    'ug': 'ug', 'uyghur': 'ug',
    'sd': 'sd', 'sindhi': 'sd',
    # CJK
    'ja': 'japan', 'japanese': 'japan',
    'ko': 'korean', 'korean': 'korean',
    # South Asian
    'hi': 'hi', 'hindi': 'hi',
    'mr': 'hi', 'marathi': 'hi',
    'ne': 'hi', 'nepali': 'hi',
    'bn': 'bn', 'bengali': 'bn',
    'ta': 'ta', 'tamil': 'ta',
    'te': 'te', 'telugu': 'te',
    # European
    'de': 'de', 'german': 'de',
    'fr': 'fr', 'french': 'fr',
    'es': 'es', 'spanish': 'es',
    'pt': 'pt', 'portuguese': 'pt',
    'it': 'it', 'italian': 'it',
    'nl': 'nl', 'dutch': 'nl',
    'pl': 'pl', 'polish': 'pl',
    'cs': 'cs', 'czech': 'cs',
    'sk': 'sk', 'slovak': 'sk',
    'tr': 'tr', 'turkish': 'tr',
    'vi': 'vi', 'vietnamese': 'vi',
    'sv': 'sv', 'swedish': 'sv',
    'no': 'no', 'norwegian': 'no',
    'da': 'da', 'danish': 'da',
    'fi': 'fi', 'finnish': 'fi',
    'id': 'id', 'indonesian': 'id',
    'ms': 'ms', 'malay': 'ms',
    'ro': 'ro', 'romanian': 'ro',
    'hr': 'hr', 'croatian': 'hr',
    'hu': 'hu', 'hungarian': 'hu',
    # Cyrillic
    'ru': 'ru', 'russian': 'ru',
    'uk': 'uk', 'ukrainian': 'uk',
    'be': 'be', 'belarusian': 'be',
    'bg': 'bg', 'bulgarian': 'bg',
    # Thai
    'th': 'th', 'thai': 'th',
    # Greek
    'el': 'el', 'greek': 'el',
    # English / default
    'en': 'en', 'english': 'en',
}

def resolve_lang(lang_input):
    if not lang_input or lang_input.lower() in ('auto', ''):
        return 'en'
    return LANG_MAP.get(lang_input.strip().lower(), 'en')


def resolve_device(device_pref: str) -> str:
    try:
        import paddle
        has_gpu = paddle.device.is_compiled_with_cuda()
        if device_pref == 'gpu':
            return 'gpu' if has_gpu else 'cpu'
        if device_pref == 'cpu':
            return 'cpu'
        return 'gpu' if has_gpu else 'cpu'  # auto
    except Exception:
        return 'cpu'


def run_ocr(engine, image_b64: str) -> str:
    img_bytes = base64.b64decode(image_b64)

    from PIL import Image
    import io

    img = Image.open(io.BytesIO(img_bytes))
    if img.mode in ('RGBA', 'LA', 'P'):
        bg = Image.new('RGB', img.size, (255, 255, 255))
        if img.mode == 'P':
            img = img.convert('RGBA')
        bg.paste(img, mask=img.split()[-1] if img.mode in ('RGBA', 'LA') else None)
        img = bg
    elif img.mode != 'RGB':
        img = img.convert('RGB')

    buf = io.BytesIO()
    img.save(buf, format='PNG')

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
            tmp.write(buf.getvalue())
            tmp_path = tmp.name

        result = engine.predict(tmp_path)

        lines = []
        if result:
            for page in result:
                if isinstance(page, dict):
                    texts = page.get('rec_texts', [])
                    scores = page.get('rec_scores', [])
                    for text, score in zip(texts, scores or [1] * len(texts)):
                        if text and str(text).strip():
                            lines.append(str(text))
                elif isinstance(page, list):
                    for item in page:
                        if item and len(item) >= 2:
                            text_conf = item[1]
                            if isinstance(text_conf, (list, tuple)) and text_conf[0]:
                                lines.append(str(text_conf[0]))
        return '\n'.join(lines)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except Exception:
                pass


def main():
    lang_input  = sys.argv[1] if len(sys.argv) > 1 else 'en'
    device_pref = sys.argv[2] if len(sys.argv) > 2 else 'auto'
    paddle_lang = resolve_lang(lang_input)
    device = resolve_device(device_pref)

    # Load engine once
    from paddleocr import PaddleOCR
    engine = PaddleOCR(
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        lang=paddle_lang,
        device=device,
    )

    # Signal ready to the Node.js host
    sys.stdout.write(json.dumps({'type': 'ready'}) + '\n')
    sys.stdout.flush()

    # Process requests line by line
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
        except Exception:
            continue

        if req.get('type') == 'exit':
            break

        req_id = req.get('id', '')
        image_b64 = req.get('imageBase64', '')

        if not image_b64:
            sys.stdout.write(json.dumps({'id': req_id, 'text': '', 'error': 'No imageBase64'}) + '\n')
            sys.stdout.flush()
            continue

        try:
            text = run_ocr(engine, image_b64)
            sys.stdout.write(json.dumps({'id': req_id, 'text': text, 'error': None}) + '\n')
        except Exception as e:
            tb = traceback.format_exc()
            sys.stdout.write(json.dumps({'id': req_id, 'text': '', 'error': str(e), 'traceback': tb}) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    main()
