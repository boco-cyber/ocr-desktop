/**
 * PDF to images converter
 *
 * Strategy order:
 *   1. PyMuPDF (fitz) via pdf_fitz.py — handles JPEG2000, scanned books, all edge cases
 *      Requires: Python + `pip install pymupdf pillow numpy`
 *      Also applies background normalization to remove aged-paper yellowing.
 *   2. pdf2pic (Ghostscript-backed, highest quality at 200 DPI)
 *      Requires Ghostscript installed on the system.
 *   3. pdf-to-img (pure JS, uses pdfjs-dist internally, no native deps)
 *      May fail to render JPEG2000 / JPX compressed PDFs (produces blank pages).
 *      We detect blank pages and warn if this happens.
 *
 * Output: Array of { index, imageBase64, width, height }
 *
 * @param {string} pdfPath
 * @param {object} [opts]
 * @param {function} [opts.onPage]  - called after each page: onPage(pagesDone, totalPages)
 * @param {string}  [opts.python]   - path to Python executable (default: 'python')
 * @param {boolean} [opts.enhance]  - apply background normalization (default: true)
 */
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const sharp = require('sharp');
const { spawn } = require('child_process');

const MAX_DIM = 2400;

async function toPages(pdfPath, { onPage, python, enhance = true } = {}) {
  // Strategy 1: PyMuPDF
  try {
    return await convertWithFitz(pdfPath, { onPage, python, enhance });
  } catch (err) {
    console.warn('[pdf] PyMuPDF unavailable, trying pdf2pic:', err.message);
  }

  // Strategy 2: pdf2pic (Ghostscript)
  try {
    return await convertWithPdf2pic(pdfPath, { onPage });
  } catch (err) {
    console.warn('[pdf] pdf2pic unavailable, falling back to pdf-to-img:', err.message);
  }

  // Strategy 3: pdf-to-img (pdfjs-dist) — may produce blank pages for JPX PDFs
  const pages = await convertWithPdfToImg(pdfPath, { onPage });

  // Warn if many blank pages detected
  const blankCount = pages.filter(p => p._isBlanked).length;
  if (blankCount > pages.length * 0.3) {
    console.warn(`[pdf] WARNING: ${blankCount}/${pages.length} pages appear blank. ` +
      'This PDF likely contains JPEG2000 (JPX) images that pdfjs-dist cannot decode. ' +
      'Install PyMuPDF for full support: pip install pymupdf pillow numpy');
  }

  return pages;
}

// ── Strategy 1: PyMuPDF via Python (streaming — processes pages as they arrive) ─
async function convertWithFitz(pdfPath, { onPage, python, enhance } = {}) {
  const scriptPath = path.join(__dirname, 'pdf_fitz.py');
  if (!fs.existsSync(scriptPath)) throw new Error('pdf_fitz.py not found');

  const tmpDir = path.join(os.tmpdir(), `pdf_fitz_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const pythonExe = python || await _findPython();

  const args = [scriptPath, pdfPath, tmpDir, '--scale', '2.0'];
  if (enhance) args.push('--enhance');

  return new Promise((resolve, reject) => {
    const proc = spawn(pythonExe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const result = [];
    let totalPages = 0;    // set from first "total_pages" message
    let rejected = false;

    proc.stderr.on('data', d => { stderr += d.toString(); });

    // ── Stream pages as Python writes them ──────────────────────────────────
    // Each PNG is complete on disk when Python prints the JSON line.
    // We read + encode it immediately so memory stays bounded.
    let lineBuf = '';
    proc.stdout.on('data', chunk => {
      lineBuf += chunk.toString();
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop(); // keep trailing incomplete line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.error) {
            if (!rejected) { rejected = true; proc.kill(); _rmDir(tmpDir); reject(new Error(msg.error)); }
            return;
          }
          // First message tells us the total so progress shows correctly
          if (msg.total_pages !== undefined) {
            totalPages = msg.total_pages;
            return;
          }
          if (msg.done) return;

          // Page ready — read from disk immediately and delete to free space
          if (msg.path && fs.existsSync(msg.path)) {
            try {
              const fileBuf = fs.readFileSync(msg.path);
              fs.unlinkSync(msg.path); // free disk space immediately

              const meta = sharp(fileBuf).metadata(); // sync metadata via sync API not available; handled below
              // Push as-is; we'll process metadata synchronously when possible
              result.push({
                index:       msg.index,
                imageBase64: fileBuf.toString('base64'),
                width:       msg.width,
                height:      msg.height,
                _buf:        fileBuf,   // keep for potential resize; cleared after
              });

              const done = result.length;
              if (onPage) onPage(done, totalPages);
            } catch (readErr) {
              console.warn('[pdf] Could not read page file:', readErr.message);
            }
          }
        } catch (_) { /* non-JSON stdout line — ignore */ }
      }
    });

    proc.on('close', async code => {
      _rmDir(tmpDir);
      if (rejected) return;
      if (code !== 0 && result.length === 0) {
        reject(new Error(`pdf_fitz.py exited ${code}: ${stderr.slice(0, 400)}`));
        return;
      }

      // Final pass: resize any oversized pages (done after streaming to not block progress)
      try {
        for (const page of result) {
          const buf = page._buf;
          delete page._buf;
          if (!buf) continue;
          const meta = await sharp(buf).metadata();
          page.width  = meta.width  || page.width;
          page.height = meta.height || page.height;
          if ((meta.width || 0) > MAX_DIM || (meta.height || 0) > MAX_DIM) {
            page.imageBase64 = (await sharp(buf)
              .resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true })
              .png()
              .toBuffer()).toString('base64');
          }
        }
        // Sort by index in case any arrived out of order
        result.sort((a, b) => a.index - b.index);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });

    proc.on('error', err => {
      _rmDir(tmpDir);
      reject(new Error(`Failed to spawn python: ${err.message}`));
    });
  });
}

// ── Strategy 2: pdf2pic (Ghostscript) ────────────────────────────────────────
async function convertWithPdf2pic(pdfPath, { onPage } = {}) {
  const { fromPath } = require('pdf2pic');
  const outputDir = path.dirname(pdfPath);

  const converter = fromPath(pdfPath, {
    density:      200,
    saveFilename: path.basename(pdfPath, '.pdf') + '_p',
    savePath:     outputDir,
    format:       'png',
    width:        MAX_DIM,
    height:       MAX_DIM,
  });

  const result = await converter.bulk(-1, { responseType: 'base64' });
  if (!result || !result.length) throw new Error('pdf2pic returned empty result (Ghostscript not available?)');

  // Check if all pages are blank (Ghostscript not actually installed)
  const hasContent = result.some(r => r.base64 && r.base64.length > 100);
  if (!hasContent) throw new Error('pdf2pic produced blank pages — Ghostscript likely not installed');

  const total = result.length;
  return result.map((r, i) => {
    if (onPage) onPage(i + 1, total);
    return {
      index:       i,
      imageBase64: r.base64,
      width:       r.width  || MAX_DIM,
      height:      r.height || MAX_DIM,
    };
  });
}

// ── Strategy 3: pdf-to-img (pdfjs-dist pure JS) ───────────────────────────────
async function convertWithPdfToImg(pdfPath, { onPage } = {}) {
  const { pdf } = require('pdf-to-img');

  const pages = [];
  const doc   = await pdf(pdfPath, { scale: 2.0 });
  const total = doc.length || 0;

  let index = 0;
  for await (const pageImage of doc) {
    const meta = await sharp(pageImage).metadata();

    // Detect blank pages (mean brightness ≈ 255 = all white)
    const stats = await sharp(pageImage).greyscale().stats();
    const mean = stats.channels[0]?.mean ?? 128;
    const _isBlanked = mean > 252;

    const needsResize = (meta.width || 0) > MAX_DIM || (meta.height || 0) > MAX_DIM;
    let buffer = pageImage;
    if (needsResize) {
      buffer = await sharp(pageImage)
        .resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer();
    }

    pages.push({
      index,
      imageBase64: buffer.toString('base64'),
      width:       meta.width  || MAX_DIM,
      height:      meta.height || MAX_DIM,
      _isBlanked,
    });
    index++;
    if (onPage) onPage(index, total);
  }

  return pages;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function _findPython() {
  const { execSync } = require('child_process');
  for (const cmd of ['python', 'python3', 'py']) {
    try {
      const out = execSync(`${cmd} -c "import fitz; print('ok')"`, { stdio: 'pipe', timeout: 5000 }).toString().trim();
      if (out === 'ok') return cmd;
    } catch (_) {}
  }
  throw new Error('No Python installation with PyMuPDF (fitz) found');
}

function _rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

module.exports = { toPages };
