#!/usr/bin/env bash
set -e

echo "=== OCR Desktop — Ubuntu dependency installer ==="

# ── System packages ───────────────────────────────────────────────────────────
echo ""
echo ">>> Installing system packages..."
sudo apt-get update -qq
sudo apt-get install -y \
  python3 python3-pip python3-venv \
  ghostscript \
  libvips-dev \
  libtesseract-dev tesseract-ocr \
  libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
  build-essential

# ── Python packages (PyMuPDF strategy 1) ─────────────────────────────────────
echo ""
echo ">>> Installing Python packages (PyMuPDF, Pillow, NumPy)..."
pip3 install --user pymupdf pillow numpy

# ── Node packages ─────────────────────────────────────────────────────────────
echo ""
echo ">>> Installing Node.js packages..."
/usr/bin/npm install

# ── Rebuild native modules against the installed Electron ─────────────────────
echo ""
echo ">>> Rebuilding native modules for Electron..."
/usr/bin/npx @electron/rebuild

echo ""
echo "=== All done! Run the app with: npm run electron ==="
