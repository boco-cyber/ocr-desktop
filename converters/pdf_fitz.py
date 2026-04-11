"""
pdf_fitz.py — PDF to PNG converter using PyMuPDF (fitz).

Handles JPEG2000 (JPX), scanned books, aged paper backgrounds, and any PDF
that pdfjs-dist or Ghostscript cannot render correctly.

Usage:
  python pdf_fitz.py <pdf_path> <out_dir> [--scale 2.0] [--enhance] [--start 0] [--end -1]

Output:
  Writes page_0001.png, page_0002.png … to <out_dir>
  Prints JSON line per page: {"index": 0, "path": "...", "width": N, "height": N}
  Prints a final summary JSON: {"done": true, "total": N}
"""

import sys
import os
import json
import argparse

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('pdf_path')
    parser.add_argument('out_dir')
    parser.add_argument('--scale', type=float, default=2.0)
    parser.add_argument('--enhance', action='store_true',
                        help='Apply background normalization for scanned/aged pages')
    parser.add_argument('--start', type=int, default=0, help='First page index (0-based)')
    parser.add_argument('--end', type=int, default=-1, help='Last page index inclusive (-1=all)')
    args = parser.parse_args()

    try:
        import fitz  # PyMuPDF
    except ImportError:
        print(json.dumps({"error": "PyMuPDF (fitz) is not installed. Run: pip install pymupdf"}), flush=True)
        sys.exit(1)

    os.makedirs(args.out_dir, exist_ok=True)

    doc = fitz.open(args.pdf_path)
    total = doc.page_count
    end_idx = total - 1 if args.end < 0 else min(args.end, total - 1)
    mat = fitz.Matrix(args.scale, args.scale)

    enhance = args.enhance
    if enhance:
        try:
            from PIL import Image, ImageOps, ImageFilter
            import numpy as np
            _pil_available = True
        except ImportError:
            _pil_available = False
            enhance = False  # silently degrade

    # Emit total count first so caller can show accurate progress
    page_count = end_idx - args.start + 1
    print(json.dumps({"total_pages": page_count, "doc_total": total}), flush=True)

    for i in range(args.start, end_idx + 1):
        page = doc[i]
        pix = page.get_pixmap(matrix=mat, colorspace=fitz.csRGB, alpha=False)

        out_name = f"page_{i+1:04d}.png"
        out_path = os.path.join(args.out_dir, out_name)

        if enhance and _pil_available:
            # Convert pixmap → PIL Image
            img_bytes = pix.tobytes("png")
            from io import BytesIO
            img = Image.open(BytesIO(img_bytes)).convert("RGB")

            # ── Background normalization pipeline ──────────────────────────────
            # 1. Convert to numpy for fast processing
            arr = np.array(img, dtype=np.float32)

            # 2. Estimate background color via the 95th percentile (brightest pixels)
            #    Works for yellowed/aged paper — the background is the dominant bright color
            p95 = np.percentile(arr, 95, axis=(0, 1))  # shape (3,)

            # 3. Normalize so background → white
            #    Avoid divide-by-zero; clip to [0, 255]
            p95 = np.maximum(p95, 1.0)
            arr = arr / p95 * 255.0
            arr = np.clip(arr, 0, 255).astype(np.uint8)
            img = Image.fromarray(arr)

            # 4. Slight sharpening to counter any blur from the normalization
            img = img.filter(ImageFilter.SHARPEN)

            # 5. Convert to greyscale for better OCR (optional — keep colour if needed)
            # img = ImageOps.grayscale(img)

            img.save(out_path, "PNG", optimize=False)
        else:
            pix.save(out_path)

        result = {
            "index": i,
            "path": out_path,
            "width": pix.width,
            "height": pix.height,
        }
        print(json.dumps(result), flush=True)

    doc.close()
    print(json.dumps({"done": True, "total": total}), flush=True)


if __name__ == "__main__":
    main()
