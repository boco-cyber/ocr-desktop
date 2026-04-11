/**
 * document-worker.js
 * Runs in a Node child_process (fork). Handles heavy PDF tasks:
 *   - parse_pdf  : extract text blocks from a PDF via pdf_extract_text.py (PyMuPDF)
 *   - export_pdf : rebuild a PDF from EditableDocument using pdf-lib
 *   - remove_bg  : whiten background of a page image using sharp
 */

'use strict';

const path = require('path');
const fse  = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const { spawn, execSync } = require('child_process');

// ── IPC bridge ───────────────────────────────────────────────────────────────
process.on('message', async msg => {
  const { type, payload, id } = msg;
  try {
    let result;
    if (type === 'parse_pdf')   result = await parsePdf(payload);
    else if (type === 'export_pdf') result = await exportPdf(payload);
    else if (type === 'remove_bg')  result = await removeBg(payload);
    else throw new Error(`Unknown message type: ${type}`);
    process.send({ id, ok: true, result });
  } catch (err) {
    process.send({ id, ok: false, error: err.message });
  }
});

// ── Find Python with PyMuPDF ─────────────────────────────────────────────────
async function _findPython() {
  for (const cmd of ['python', 'python3', 'py']) {
    try {
      const out = execSync(`${cmd} -c "import fitz; print('ok')"`, { stdio: 'pipe', timeout: 5000 }).toString().trim();
      if (out === 'ok') return cmd;
    } catch (_) {}
  }
  throw new Error('No Python installation with PyMuPDF (fitz) found. Run: pip install pymupdf');
}

// ── Parse PDF → pages of elements via pdf_extract_text.py ───────────────────
async function parsePdf({ filePath }) {
  const scriptPath = path.join(__dirname, '..', 'converters', 'pdf_extract_text.py');

  let pythonExe;
  try {
    pythonExe = await _findPython();
  } catch (e) {
    // Fall back to plain text layout if Python/PyMuPDF not available
    return await _fallbackParsePdf(filePath);
  }

  const pages = await _parseWithExtractScript(filePath, scriptPath, pythonExe);
  if (!pages || pages.length === 0) {
    return await _fallbackParsePdf(filePath);
  }

  return {
    pages,
    pageCount: pages.length,
    name: path.basename(filePath, '.pdf'),
  };
}

function _parseWithExtractScript(filePath, scriptPath, pythonExe) {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonExe, [scriptPath, filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let lineBuf = '';

    // Accumulate page/block messages
    const pageMap = new Map();   // page index → { width, height, rtl, elements[] }

    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.stdout.on('data', chunk => {
      lineBuf += chunk.toString();
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.error) { proc.kill(); reject(new Error(msg.error)); return; }

          if (msg.type === 'page') {
            pageMap.set(msg.index, {
              id: uuidv4(),
              width:    msg.width,
              height:   msg.height,
              rtl:      msg.rtl || false,
              elements: [],
            });
          } else if (msg.type === 'block') {
            const pg = pageMap.get(msg.page);
            if (!pg) continue;
            pg.elements.push({
              id:         uuidv4(),
              type:       'text',
              content:    msg.text,
              x:          msg.x,
              y:          msg.y,
              width:      msg.w,
              height:     msg.h,
              fontSize:   msg.fontSize || 12,
              fontFamily: msg.fontFamily || 'Georgia',
              bold:       msg.bold || false,
              italic:     msg.italic || false,
              rtl:        msg.rtl || false,
            });
          }
          // 'done' message — nothing needed; we resolve on close
        } catch (_) { /* non-JSON line — ignore */ }
      }
    });

    proc.on('close', code => {
      if (code !== 0 && pageMap.size === 0) {
        reject(new Error(`pdf_extract_text.py exited ${code}: ${stderr.slice(0, 400)}`));
        return;
      }
      // Sort pages by index and resolve
      const pages = Array.from(pageMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([, pg]) => pg);
      resolve(pages);
    });

    proc.on('error', err => reject(new Error(`Failed to spawn python: ${err.message}`)));
  });
}

async function _fallbackParsePdf(filePath) {
  // Plain-text fallback using pdf-parse
  try {
    const pdfParse = require('pdf-parse');
    const buf = await fse.readFile(filePath);
    const parsed = await pdfParse(buf);
    const pages = _fallbackPages(parsed.text, parsed.numpages);
    return { pages, pageCount: parsed.numpages, name: path.basename(filePath, '.pdf') };
  } catch (_) {
    return { pages: [{ id: uuidv4(), width: 794, height: 1123, elements: [] }], pageCount: 1, name: path.basename(filePath, '.pdf') };
  }
}

function _fallbackPages(text, numpages) {
  const lines = text.split('\n').filter(l => l.trim());
  const perPage = Math.ceil(lines.length / Math.max(numpages, 1));
  const pages = [];
  for (let i = 0; i < numpages; i++) {
    const slice = lines.slice(i * perPage, (i + 1) * perPage);
    const elements = slice.map((line, li) => ({
      id: uuidv4(),
      type: 'text',
      content: line,
      x: 60,
      y: 60 + li * 24,
      width: 680,
      height: 20,
      fontSize: 12,
      fontFamily: 'Georgia',
      bold: false,
      italic: false,
      rtl: false,
    }));
    pages.push({ id: uuidv4(), width: 794, height: 1123, elements });
  }
  return pages.length ? pages : [{ id: uuidv4(), width: 794, height: 1123, elements: [] }];
}

// ── Export PDF from EditableDocument ─────────────────────────────────────────
async function exportPdf({ document: doc, outputPath }) {
  const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

  const pdfDoc = await PDFDocument.create();
  const fonts = {};

  async function getFont(bold, italic) {
    const key = `${bold ? 'b' : ''}${italic ? 'i' : ''}` || 'n';
    if (fonts[key]) return fonts[key];
    let fontName = StandardFonts.Helvetica;
    if (bold && italic) fontName = StandardFonts.HelveticaBoldOblique;
    else if (bold)      fontName = StandardFonts.HelveticaBold;
    else if (italic)    fontName = StandardFonts.HelveticaOblique;
    fonts[key] = await pdfDoc.embedFont(fontName);
    return fonts[key];
  }

  for (const page of doc.pages) {
    const pdfPage = pdfDoc.addPage([page.width, page.height]);

    for (const el of page.elements) {
      if (el.type === 'text') {
        const font = await getFont(el.bold, el.italic);
        const size = el.fontSize || 12;
        // PDF coordinate system: y=0 is bottom
        const y = page.height - el.y - size;
        try {
          pdfPage.drawText(el.content || '', {
            x: el.x,
            y: Math.max(0, y),
            size,
            font,
            color: rgb(0, 0, 0),
            maxWidth: el.width || 500,
          });
        } catch (_) { /* skip unrenderable glyphs */ }
      } else if (el.type === 'shape' && el.shape === 'rectangle') {
        pdfPage.drawRectangle({
          x: el.x,
          y: page.height - el.y - el.height,
          width: el.width,
          height: el.height,
          borderColor: rgb(0, 0, 0),
          borderWidth: 1,
        });
      } else if (el.type === 'image' && el.src) {
        try {
          const imgBuf = await fse.readFile(el.src);
          const ext = path.extname(el.src).toLowerCase();
          const embedded = ext === '.png'
            ? await pdfDoc.embedPng(imgBuf)
            : await pdfDoc.embedJpg(imgBuf);
          pdfPage.drawImage(embedded, {
            x: el.x,
            y: page.height - el.y - el.height,
            width: el.width,
            height: el.height,
          });
        } catch (_) { /* skip unembeddable images */ }
      }
    }
  }

  const pdfBytes = await pdfDoc.save();
  await fse.ensureDir(path.dirname(outputPath));
  await fse.writeFile(outputPath, pdfBytes);
  return { outputPath };
}

// ── Remove background (whiten non-text areas) via sharp ─────────────────────
async function removeBg({ imagePath, outputPath }) {
  const sharp = require('sharp');
  await sharp(imagePath)
    .greyscale()
    .normalise()
    .threshold(200)          // binarize: keep dark text, white everything else
    .negate()                // invert so text is black on white
    .negate()
    .toFile(outputPath);
  return { outputPath };
}
