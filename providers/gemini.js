/**
 * Google Gemini vision OCR provider
 * Uses gemini-1.5-pro (recommended) or gemini-1.5-flash (faster/cheaper)
 * Docs: https://ai.google.dev/api/generate-content
 */
const fetch = require('node-fetch');

const DEFAULT_MODEL = 'gemini-1.5-pro';

function detectMime(b64) {
  const head = Buffer.from(b64.slice(0, 8), 'base64');
  if (head[0] === 0xFF && head[1] === 0xD8) return 'image/jpeg';
  if (head[0] === 0x89 && head[1] === 0x50) return 'image/png';
  if (head[0] === 0x52 && head[1] === 0x49) return 'image/webp';
  return 'image/jpeg';
}

async function ocr({ apiKey, model, imageBase64, prompt }) {
  if (!apiKey) throw new Error('Google Gemini API key is required');

  const m   = model || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
  const mimeType = detectMime(imageBase64);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: mimeType, data: imageBase64 } },
          { text: prompt },
        ],
      }],
      generationConfig: { maxOutputTokens: 8192 },
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Gemini error ${response.status}: ${err?.error?.message || response.statusText}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function listModels({ apiKey }) {
  if (!apiKey) throw new Error('Google Gemini API key is required');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=50`);
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Gemini error ${response.status}: ${err?.error?.message || response.statusText}`);
  }
  const data = await response.json();
  // Only keep models that support generateContent (usable for OCR/translation)
  const models = (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace('models/', ''))
    .filter(id => id.startsWith('gemini'));
  return models;
}

module.exports = { ocr, listModels };
