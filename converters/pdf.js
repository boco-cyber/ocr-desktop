/**
 * PDF to images converter
 * Strategy 1: pdf2pic (Ghostscript-backed, highest quality at 200 DPI)
 *   — Requires Ghostscript installed on the system OR bundled via electron-builder extraResources
 * Strategy 2: pdfjs-dist + canvas (pure Node, no system dependencies, ~144 DPI equivalent)
 *   — Used automatically if pdf2pic/Ghostscript is unavailable
 *
 * Output: Array of { index, imageBase64, width, height }
 * Each element represents one PDF page as a PNG image.
 */
const path = require('path');
const fs   = require('fs');

const MAX_DIM = 2000;

async function toPages(pdfPath) {
  try {
    return await convertWithPdf2pic(pdfPath);
  } catch (err) {
    console.warn('pdf2pic unavailable, falling back to pdfjs-dist:', err.message);
    return await convertWithPdfjs(pdfPath);
  }
}

async function convertWithPdf2pic(pdfPath) {
  const { fromPath } = require('pdf2pic');
  const outputDir = path.dirname(pdfPath);

  const converter = fromPath(pdfPath, {
    density:      200,
    saveFilename: path.basename(pdfPath, '.pdf'),
    savePath:     outputDir,
    format:       'png',
    width:        MAX_DIM,
    height:       MAX_DIM,
  });

  const result = await converter.bulk(-1, { responseType: 'base64' });

  return result.map((r, i) => ({
    index:       i,
    imageBase64: r.base64,
    width:       r.width  || MAX_DIM,
    height:      r.height || MAX_DIM,
  }));
}

async function convertWithPdfjs(pdfPath) {
  // Lazy require — canvas has native bindings that may not be available in dev
  const pdfjsLib   = require('pdfjs-dist/legacy/build/pdf.js');
  const { createCanvas } = require('canvas');

  const data       = new Uint8Array(fs.readFileSync(pdfPath));
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdfDoc     = await loadingTask.promise;

  const pages = [];
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page     = await pdfDoc.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 }); // ~144 DPI

    const canvas  = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');

    await page.render({ canvasContext: context, viewport }).promise;

    const buffer = canvas.toBuffer('image/png');
    pages.push({
      index:       i - 1,
      imageBase64: buffer.toString('base64'),
      width:       viewport.width,
      height:      viewport.height,
    });
  }

  return pages;
}

module.exports = { toPages };
