const path = require('path');

const RTL_LANGS = ['arabic', 'hebrew', 'persian', 'farsi', 'urdu', 'pashto', 'yiddish', 'ar', 'he', 'fa', 'ur', 'ps', 'yi'];

function isRTLLanguage(lang) {
  if (!lang) return false;
  return RTL_LANGS.some(value => lang.toLowerCase().includes(value));
}

function detectRTLFromText(text) {
  if (!text) return false;
  const rtlChars = (text.match(/[\u0600-\u06FF\u0590-\u05FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
  const allChars = text.replace(/[\s\d.,!?]/g, '').length;
  return allChars > 20 && rtlChars / allChars > 0.3;
}

function detectScriptFromText(text) {
  if (!text || !text.trim()) return null;
  const counts = {
    arabic: (text.match(/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length,
    hebrew: (text.match(/[\u0590-\u05FF\uFB1D-\uFB4F]/g) || []).length,
    cjk: (text.match(/[\u4E00-\u9FFF\u3400-\u4DBF\u3000-\u303F\u30A0-\u30FF\u3040-\u309F]/g) || []).length,
    korean: (text.match(/[\uAC00-\uD7AF\u1100-\u11FF]/g) || []).length,
    cyrillic: (text.match(/[\u0400-\u04FF]/g) || []).length,
    devanagari: (text.match(/[\u0900-\u097F]/g) || []).length,
    thai: (text.match(/[\u0E00-\u0E7F]/g) || []).length,
    greek: (text.match(/[\u0370-\u03FF]/g) || []).length,
    latin: (text.match(/[A-Za-z]/g) || []).length,
  };
  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (!dominant || dominant[1] < 5) return null;

  const map = {
    arabic: { displayName: 'Arabic', ocrValue: 'ar', rtl: true, source: 'script-detect' },
    hebrew: { displayName: 'Hebrew', ocrValue: 'he', rtl: true, source: 'script-detect' },
    cjk: { displayName: 'Chinese', ocrValue: 'zh', rtl: false, source: 'script-detect' },
    korean: { displayName: 'Korean', ocrValue: 'ko', rtl: false, source: 'script-detect' },
    cyrillic: { displayName: 'Russian', ocrValue: 'ru', rtl: false, source: 'script-detect' },
    devanagari: { displayName: 'Hindi', ocrValue: 'hi', rtl: false, source: 'script-detect' },
    thai: { displayName: 'Thai', ocrValue: 'th', rtl: false, source: 'script-detect' },
    greek: { displayName: 'Greek', ocrValue: 'el', rtl: false, source: 'script-detect' },
    latin: { displayName: 'English', ocrValue: 'en', rtl: false, source: 'script-detect' },
  };

  return {
    script: dominant[0],
    ...map[dominant[0]],
    resolvedAt: new Date().toISOString(),
  };
}

async function detectScriptFromImage(imageBase64, runtimeConfig = {}) {
  try {
    const { createWorker } = require('tesseract.js');
    const worker = await createWorker('eng', 1, { logger: () => {}, errorHandler: () => {} });
    const buffer = Buffer.from(imageBase64, 'base64');
    const { data } = await worker.recognize(buffer);
    await worker.terminate();
    return detectScriptFromText(data.text || '');
  } catch {
    return null;
  }
}

const OCR_MODE_PROMPTS = {
  book: 'This is a scanned book or article page. Preserve paragraph breaks, chapter titles, and section headings. Maintain the reading flow. Ignore page numbers and running headers.',
  photo: 'This image may be skewed, rotated, low-contrast, or photographed at an angle. Correct for perspective distortion mentally and extract all readable text. If parts are unreadable, mark them [unreadable].',
  structure: 'This is a structured document page. Identify and preserve document roles such as titles, subtitles, body text, headers, footers, and footnotes. Output each recognized block with one label on its own line using ONLY these tags: [TITLE], [SUBTITLE], [BODY], [HEADER], [FOOTER], [FOOTNOTE]. Put the corresponding text on the following line(s). Preserve reading order from top to bottom. Repeat tags as needed. Do not invent missing sections. If a block is uncertain, classify it as [BODY].',
  table: 'This document contains tables. Extract all table data preserving rows and columns. Use | to separate columns and a blank line between rows. Preserve column headers.',
  handwriting: 'This is handwritten text. Do your best to decipher the handwriting accurately. Preserve line breaks. If a word is unclear, write [unclear] instead of guessing.',
  receipt: 'This is a receipt or invoice. Extract: vendor name, date, all line items with quantities and prices, subtotal, tax, and total amount. Format as a clean list.',
  numbers: 'Extract ONLY numbers, amounts, dates, and numeric data. Ignore decorative text and labels unless they provide essential context for the numbers.',
  noheaders: 'Skip page headers, footers, page numbers, running titles, and watermarks. Extract only the main body text.',
};

const RTL_LANGUAGE_NAMES = ['arabic', 'hebrew', 'persian', 'farsi', 'urdu', 'pashto', 'yiddish'];

function buildOCRPrompt(language, customPrompt, pageIndex, pageCount, ocrMode) {
  if (customPrompt) return customPrompt;

  const isRTL = language && RTL_LANGUAGE_NAMES.some(l => language.toLowerCase().includes(l));

  let langHint;
  if (language) {
    if (isRTL) {
      langHint = ` The document is written in ${language}. Output ONLY ${language} text — do NOT translate, transliterate, or add any English words. Preserve all diacritics (tashkeel/harakat) exactly as they appear. Read right-to-left and output text in correct right-to-left reading order.`;
    } else {
      langHint = ` The document is written in ${language}.`;
    }
  } else {
    langHint = ' Auto-detect the language of the text. Output text in the same language as the source — do NOT translate.';
  }

  const pageHint = pageCount > 1 ? ` This is page ${pageIndex + 1} of ${pageCount}.` : '';
  const modeHint = (ocrMode && OCR_MODE_PROMPTS[ocrMode]) ? ` ${OCR_MODE_PROMPTS[ocrMode]}` : '';
  return `You are a professional OCR (Optical Character Recognition) system.${langHint}${pageHint}${modeHint} Extract ALL text from this image exactly as it appears. Preserve the original layout, visual hierarchy, line breaks, paragraph spacing, indentation, and structural formatting as faithfully as possible. When titles, subtitles, headers, footers, footnotes, or body text are visually distinct, preserve that distinction in the plain-text output. Output ONLY the extracted text — no commentary, no descriptions, no metadata. If the image contains no readable text, output an empty string.`;
}

module.exports = {
  OCR_MODE_PROMPTS,
  buildOCRPrompt,
  detectScriptFromImage,
  detectRTLFromText,
  detectScriptFromText,
  isRTLLanguage,
};
