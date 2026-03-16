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
 */
const path = require('path');
const fs   = require('fs');
const sharp = require('sharp');

const MAX_DIM = 2000;

async function toPages(pdfPath) {
  try {
    return await convertWithPdf2pic(pdfPath);
  } catch (err) {
    console.warn('pdf2pic unavailable, falling back to pdf-to-img:', err.message);
    return await convertWithPdfToImg(pdfPath);
  }
}

async function convertWithPdf2pic(pdfPath) {
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

  return result.map((r, i) => ({
    index:       i,
    imageBase64: r.base64,
    width:       r.width  || MAX_DIM,
    height:      r.height || MAX_DIM,
  }));
}

async function convertWithPdfToImg(pdfPath) {
  const { pdf } = require('pdf-to-img');

  const pages = [];
  const doc   = await pdf(pdfPath, { scale: 2.0 });

  let index = 0;
  for await (const pageImage of doc) {
    // pageImage is a Buffer (PNG)
    // Resize if too large
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
  }

  return pages;
}

module.exports = { toPages };
