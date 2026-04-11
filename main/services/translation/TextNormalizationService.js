const fs = require('fs/promises');

const iconv = require('iconv-lite');
const jschardet = require('jschardet');

class TextNormalizationService {
  async readFile(filePath) {
    const buffer = await fs.readFile(filePath);
    return this.decodeBuffer(buffer);
  }

  decodeBuffer(buffer) {
    if (!buffer || !buffer.length) return '';

    if (buffer.length >= 2) {
      if (buffer[0] === 0xff && buffer[1] === 0xfe) {
        return iconv.decode(buffer, 'utf16-le');
      }
      if (buffer[0] === 0xfe && buffer[1] === 0xff) {
        return iconv.decode(buffer, 'utf16-be');
      }
    }

    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      return iconv.decode(buffer, 'utf8');
    }

    const guess = jschardet.detect(buffer);
    const encoding = guess?.encoding ? guess.encoding.toLowerCase() : 'utf-8';
    const safeEncoding = iconv.encodingExists(encoding) ? encoding : 'utf-8';
    return iconv.decode(buffer, safeEncoding);
  }

  normalizeText(text) {
    return (text || '')
      .replace(/\u0000/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/^\uFEFF/, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}

module.exports = { TextNormalizationService };
