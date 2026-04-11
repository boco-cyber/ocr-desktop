"""
pdf_extract_text.py — Extract text blocks with coordinates using PyMuPDF.
Full support for Arabic / RTL text, Bidi detection, and mixed-direction pages.

Outputs one JSON object per line:
  {"type":"page","index":0,"width":595,"height":842,"rtl":false}
  {"type":"block","page":0,"x":50,"y":60,"w":400,"h":20,
   "text":"Hello world","fontSize":12,"bold":false,"italic":false,
   "rtl":false,"fontFamily":"Georgia"}
  ...
  {"type":"done","total":N}

Usage:
  python pdf_extract_text.py <pdf_path> [--scale 2.0] [--start 0] [--end -1]
"""

import sys, os, json, argparse

# Arabic / RTL Unicode ranges
def _is_rtl_char(c):
    cp = ord(c)
    return (
        0x0600 <= cp <= 0x06FF or   # Arabic
        0x0750 <= cp <= 0x077F or   # Arabic Supplement
        0x08A0 <= cp <= 0x08FF or   # Arabic Extended-A
        0xFB50 <= cp <= 0xFDFF or   # Arabic Presentation Forms-A
        0xFE70 <= cp <= 0xFEFF or   # Arabic Presentation Forms-B
        0x0590 <= cp <= 0x05FF or   # Hebrew
        0x07C0 <= cp <= 0x07FF      # NKo
    )

def _text_is_rtl(text):
    rtl = sum(1 for c in text if _is_rtl_char(c))
    return rtl > len(text) * 0.3

def _best_arabic_font():
    """Return best available Arabic-capable font path."""
    candidates = [
        'C:/Windows/Fonts/arabtype.ttf',
        'C:/Windows/Fonts/DUBAI-REGULAR.TTF',
        'C:/Windows/Fonts/majalla.ttf',
        'C:/Windows/Fonts/tahoma.ttf',
        'C:/Windows/Fonts/arial.ttf',
    ]
    for f in candidates:
        if os.path.exists(f):
            return f
    return None

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('pdf_path')
    parser.add_argument('--scale', type=float, default=2.0)
    parser.add_argument('--start', type=int, default=0)
    parser.add_argument('--end',   type=int, default=-1)
    args = parser.parse_args()

    try:
        import fitz
    except ImportError:
        print(json.dumps({"error": "PyMuPDF not installed: pip install pymupdf"}), flush=True)
        sys.exit(1)

    doc = fitz.open(args.pdf_path)
    total = doc.page_count
    end_idx = total - 1 if args.end < 0 else min(args.end, total - 1)
    scale = args.scale

    for page_idx in range(args.start, end_idx + 1):
        page = doc[page_idx]
        pw = page.rect.width  * scale
        ph = page.rect.height * scale

        # Determine if the page is predominantly RTL
        full_text = page.get_text("text")
        page_rtl = _text_is_rtl(full_text)

        print(json.dumps({
            "type":   "page",
            "index":  page_idx,
            "width":  round(pw),
            "height": round(ph),
            "rtl":    page_rtl,
        }), flush=True)

        # ── Extract blocks with full span metadata ──────────────────────────
        raw = page.get_text("rawdict", flags=fitz.TEXT_PRESERVE_WHITESPACE | fitz.TEXT_MEDIABOX_CLIP)

        for block in raw.get("blocks", []):
            if block.get("type") != 0:   # skip image blocks
                continue

            lines = block.get("lines", [])
            if not lines:
                continue

            # Collect all text + metadata from every span in this block
            block_chars = []
            block_x0 = block["bbox"][0]
            block_y0 = block["bbox"][1]
            block_x1 = block["bbox"][2]
            block_y1 = block["bbox"][3]

            # Aggregate span properties (use most common / first)
            font_size    = 12.0
            bold         = False
            italic       = False
            font_family  = "Georgia"
            span_rtl     = False
            bidi_levels  = []

            for line in lines:
                for span in line.get("spans", []):
                    # Collect text char by char
                    for ch in span.get("chars", []):
                        block_chars.append(ch.get("c", ""))

                    sz = span.get("size", 0)
                    if sz > 0:
                        font_size = sz

                    flags = span.get("flags", 0)
                    if flags & (1 << 4):  # bold flag
                        bold = True
                    if flags & (1 << 1):  # italic flag
                        italic = True

                    # bidi: odd = RTL, even = LTR
                    bidi = span.get("bidi", 0)
                    bidi_levels.append(bidi)

                    # Font name hinting
                    fname = span.get("font", "").lower()
                    if any(x in fname for x in ["bold"]):
                        bold = True
                    if any(x in fname for x in ["italic", "oblique"]):
                        italic = True
                    if any(x in fname for x in ["arabic", "dubai", "majalla", "aldhabi", "arabtype", "trado", "urdtype"]):
                        font_family = "Arabic"
                    elif any(x in fname for x in ["times", "georgia", "garamond"]):
                        font_family = "Georgia"
                    elif any(x in fname for x in ["courier", "mono", "consol"]):
                        font_family = "Courier New"
                    elif any(x in fname for x in ["arial", "helvetica", "sans"]):
                        font_family = "Arial"

            text = "".join(block_chars).strip()
            if not text:
                continue

            # RTL detection: bidi level odd = RTL, or Arabic chars present
            rtl_by_bidi = any(b % 2 == 1 for b in bidi_levels) if bidi_levels else False
            rtl_by_text = _text_is_rtl(text)
            is_rtl = rtl_by_bidi or rtl_by_text

            if is_rtl and font_family not in ("Arabic",):
                font_family = "Arabic"  # force Arabic font for RTL text

            # Scale coordinates
            bx = round(block_x0 * scale)
            by = round(block_y0 * scale)
            bw = round((block_x1 - block_x0) * scale)
            bh = round((block_y1 - block_y0) * scale)

            if bw < 2 or bh < 2:
                continue

            # Scale font size
            scaled_font = max(6, round(font_size * scale * 0.72))

            print(json.dumps({
                "type":       "block",
                "page":       page_idx,
                "x":          bx,
                "y":          by,
                "w":          bw,
                "h":          bh,
                "text":       text,
                "fontSize":   scaled_font,
                "bold":       bold,
                "italic":     italic,
                "rtl":        is_rtl,
                "fontFamily": font_family,
            }), flush=True)

    doc.close()
    print(json.dumps({"type": "done", "total": total}), flush=True)


if __name__ == "__main__":
    main()
