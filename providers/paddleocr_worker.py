"""
PaddleOCR worker script for ocr-desktop.
Called by providers/paddleocr.js via child_process.spawn.

Usage:
  echo <base64_image> | py -3.11 paddleocr_worker.py [lang]
  or:
  py -3.11 paddleocr_worker.py [lang] < image.b64

lang: ISO code like 'en', 'ar', 'Arabic', 'zh', etc. — mapped to PaddleOCR lang internally.
      If blank or 'auto', uses multilingual Latin model as fallback.

Output (stdout): JSON  {"text": "extracted text", "error": null}
"""

import sys
import os

# Must set these BEFORE any paddle import to disable oneDNN on Windows
os.environ['FLAGS_use_mkldnn'] = '0'
os.environ['FLAGS_enable_pir_in_executor'] = '0'
os.environ['FLAGS_pir_apply_inplace_pass'] = '0'
os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'
os.environ['GLOG_minloglevel'] = '3'
os.environ['GLOG_v'] = '0'

import json
import base64
import tempfile
import traceback

# Map ISO codes AND full language names → PaddleOCR lang codes
LANG_MAP = {
    # Chinese
    'zh': 'ch', 'zh-cn': 'ch', 'chinese': 'ch', 'chinese simplified': 'ch',
    'zh-tw': 'chinese_cht', 'chinese traditional': 'chinese_cht',
    # Arabic-script (PaddleOCR v3 uses 'ar', 'fa', 'ur', 'ps' etc. directly)
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
    # European (Latin script — use ISO codes directly, PaddleOCR v3 knows them)
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
    """Map any lang string to a PaddleOCR lang code."""
    if not lang_input or lang_input.lower() in ('auto', ''):
        return 'en'  # default
    key = lang_input.strip().lower()
    return LANG_MAP.get(key, 'en')


def main():
    lang_input = sys.argv[1] if len(sys.argv) > 1 else 'en'
    paddle_lang = resolve_lang(lang_input)

    # Read base64 image from stdin
    b64 = sys.stdin.read().strip()
    if not b64:
        print(json.dumps({"text": "", "error": "No input received"}))
        return

    try:
        img_bytes = base64.b64decode(b64)
    except Exception as e:
        print(json.dumps({"text": "", "error": f"base64 decode failed: {e}"}))
        return

    tmp_path = None
    try:
        # Convert image to RGB PNG (strip alpha, normalize format)
        # This fixes RGBA images that crash PaddleOCR's OpenCV backend
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
        png_bytes = buf.getvalue()

        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
            tmp.write(png_bytes)
            tmp_path = tmp.name

        import paddle
        try:
            paddle.set_flags({'FLAGS_use_mkldnn': False})
        except Exception:
            pass

        from paddleocr import PaddleOCR

        ocr_engine = PaddleOCR(
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_angle_cls=True,
            lang=paddle_lang,
            enable_mkldnn=False,
        )

        result = ocr_engine.predict(tmp_path)

        # Extract text lines — PaddleOCR v3 returns list of dicts with 'rec_texts'
        lines = []
        if result:
            for page in result:
                if isinstance(page, dict):
                    texts = page.get('rec_texts', [])
                    scores = page.get('rec_scores', [])
                    for text, score in zip(texts, scores or [1]*len(texts)):
                        if text and str(text).strip():
                            lines.append(str(text))
                elif isinstance(page, list):
                    # v2-style fallback
                    for item in page:
                        if item and len(item) >= 2:
                            text_conf = item[1]
                            if isinstance(text_conf, (list, tuple)) and text_conf[0]:
                                lines.append(str(text_conf[0]))

        text = '\n'.join(lines)
        print(json.dumps({"text": text, "error": None}))

    except Exception as e:
        tb = traceback.format_exc()
        print(json.dumps({"text": "", "error": str(e), "traceback": tb}))
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except Exception:
                pass

if __name__ == '__main__':
    main()
