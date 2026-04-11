/**
 * Local OCR provider for ocr-desktop — powered by Tesseract.js.
 * Pure Node.js, no Python, no subprocess, no DLL conflicts.
 *
 * Exports: { ocr({ imageBase64, lang, runtimeConfig }) }
 * lang: ISO language code (e.g. 'en', 'ar', 'zh', 'fr')
 */

const { createWorker } = require('tesseract.js');

// Map ISO codes / full names → Tesseract language codes
// Tesseract uses 3-letter codes (eng, ara, chi_sim, etc.)
const LANG_MAP = {
  'en': 'eng', 'english': 'eng',
  'ar': 'ara', 'arabic': 'ara',
  'zh': 'chi_sim', 'zh-cn': 'chi_sim', 'chinese': 'chi_sim', 'chinese simplified': 'chi_sim',
  'zh-tw': 'chi_tra', 'chinese traditional': 'chi_tra',
  'ja': 'jpn', 'japanese': 'jpn',
  'ko': 'kor', 'korean': 'kor',
  'fr': 'fra', 'french': 'fra',
  'de': 'deu', 'german': 'deu',
  'es': 'spa', 'spanish': 'spa',
  'pt': 'por', 'portuguese': 'por',
  'it': 'ita', 'italian': 'ita',
  'ru': 'rus', 'russian': 'rus',
  'uk': 'ukr', 'ukrainian': 'ukr',
  'pl': 'pol', 'polish': 'pol',
  'nl': 'nld', 'dutch': 'nld',
  'tr': 'tur', 'turkish': 'tur',
  'vi': 'vie', 'vietnamese': 'vie',
  'th': 'tha', 'thai': 'tha',
  'hi': 'hin', 'hindi': 'hin',
  'bn': 'ben', 'bengali': 'ben',
  'ta': 'tam', 'tamil': 'tam',
  'te': 'tel', 'telugu': 'tel',
  'fa': 'fas', 'persian': 'fas', 'farsi': 'fas',
  'ur': 'urd', 'urdu': 'urd',
  'he': 'heb', 'hebrew': 'heb',
  'el': 'ell', 'greek': 'ell',
  'sv': 'swe', 'swedish': 'swe',
  'no': 'nor', 'norwegian': 'nor',
  'da': 'dan', 'danish': 'dan',
  'fi': 'fin', 'finnish': 'fin',
  'cs': 'ces', 'czech': 'ces',
  'sk': 'slk', 'slovak': 'slk',
  'ro': 'ron', 'romanian': 'ron',
  'hu': 'hun', 'hungarian': 'hun',
  'hr': 'hrv', 'croatian': 'hrv',
  'bg': 'bul', 'bulgarian': 'bul',
  'id': 'ind', 'indonesian': 'ind',
  'ms': 'msa', 'malay': 'msa',
};

function resolveLang(langInput) {
  if (!langInput) return 'eng';
  const key = langInput.trim().toLowerCase();
  return LANG_MAP[key] || 'eng';
}

// Keep one worker per language to avoid repeated init overhead
const _workers = new Map();

async function getWorker(tessLang) {
  if (_workers.has(tessLang)) return _workers.get(tessLang);

  const worker = await createWorker(tessLang, 1, {
    errorHandler: () => {},
    logger: () => {},
  });

  _workers.set(tessLang, worker);
  return worker;
}

async function ocr({ imageBase64, lang = 'en', runtimeConfig = {} } = {}) {
  const tessLang = resolveLang(lang);
  const worker = await getWorker(tessLang);

  // Tesseract.js accepts a Buffer directly
  const buffer = Buffer.from(imageBase64, 'base64');
  const { data } = await worker.recognize(buffer);
  return (data.text || '').trim();
}

/** Reset worker cache (e.g. when settings change) */
async function resetWorkerCache() {
  for (const [, worker] of _workers) {
    try { await worker.terminate(); } catch {}
  }
  _workers.clear();
}

module.exports = { ocr, resetWorkerCache, resetPythonCache: resetWorkerCache };
