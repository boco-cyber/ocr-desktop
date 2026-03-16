/**
 * PDF to images converter
 * Strategy 1: pdf2pic (Ghostscript-backed, highest quality at 200 DPI)
 *   — Requires Ghostscript installed on the system
 *   — Falls back automatically if unavailable
 * Strategy 2: pdf-to-img (pure JS, uses pdfjs-dist internally, no native deps)
 *   — No system dependencies, works on all Node versions
 *   — Used automatically if pdf2pic/Ghostscript is unavailable
 *
 * Output: Array of { index, imageBase64, width, height }
 * Each element represents one PDF page as a PNG image.
 *
 * @param {string} pdfPath
 * @param {object} [opts]
 * @param {function} [opts.onPage] - called after each page: onPage(pagesDone, totalPages)
 *   totalPages may be 0 if unknown (pdf2pic doesn't report total upfront)
 */
const path = require('path');
const fs   = require('fs');
const sharp = require('sharp');

const MAX_DIM = 2000;

async function toPages(pdfPath, { onPage } = {}) {
  try {
    return await convertWithPdf2pic(pdfPath, { onPage });
  } catch (err) {
    console.warn('pdf2pic unavailable, falling back to pdf-to-img:', err.message);
    return await convertWithPdfToImg(pdfPath, { onPage });
  }
}

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
  const total  = result.length;

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

async function convertWithPdfToImg(pdfPath, { onPage } = {}) {
  const { pdf } = require('pdf-to-img');

  const pages = [];
  const doc   = await pdf(pdfPath, { scale: 2.0 });
  const total = doc.length || 0; // pdf-to-img exposes .length when known

  let index = 0;
  for await (const pageImage of doc) {
    // pageImage is a Buffer (PNG)
    const meta = await sharp(pageImage).metadata();
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
    });
    index++;
    if (onPage) onPage(index, total);
  }

  return pages;
}

module.exports = { toPages };
