/**
 * Image file converter
 * Converts a single image file (JPG, PNG, TIFF, BMP, WebP) to a pages array.
 * For multi-frame TIFFs, each frame becomes a separate page.
 * Resizes to MAX_DIM on the longest edge before base64 encoding to stay within
 * API size limits (Anthropic: 5MB, OpenAI: 20MB, Gemini: 4MB per image).
 */
const sharp = require('sharp');
const fs    = require('fs');

const MAX_DIM = 2000; // pixels — keeps base64 under ~3MB for most images

/**
 * @param {string} filePath
 * @param {function} [onPage] - called after each page: onPage(index, total)
 */
async function toPages(filePath, { onPage } = {}) {
  const meta = await sharp(filePath).metadata();

  // Handle multi-frame TIFFs
  const frameCount = meta.pages || 1;
  const pages = [];

  for (let frame = 0; frame < frameCount; frame++) {
    const img = sharp(filePath, { page: frame });

    const needsResize = meta.width > MAX_DIM || meta.height > MAX_DIM;
    let pipeline = img;
    if (needsResize) {
      pipeline = pipeline.resize(MAX_DIM, MAX_DIM, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    const buffer = await pipeline.png().toBuffer();
    pages.push({
      index:       pages.length,
      imageBase64: buffer.toString('base64'),
      width:       meta.width,
      height:      meta.height,
    });

    if (onPage) onPage(pages.length, frameCount);
  }

  return pages;
}

module.exports = { toPages };
