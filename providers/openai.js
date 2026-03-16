/**
 * OpenAI (GPT-4o) vision OCR provider
 * Uses gpt-4o with high detail for best OCR quality
 * Docs: https://platform.openai.com/docs/guides/vision
 */
const fetch = require('node-fetch');

const DEFAULT_MODEL = 'gpt-4o';

function detectMime(b64) {
  const head = Buffer.from(b64.slice(0, 8), 'base64');
  if (head[0] === 0xFF && head[1] === 0xD8) return 'image/jpeg';
  if (head[0] === 0x89 && head[1] === 0x50) return 'image/png';
  if (head[0] === 0x52 && head[1] === 0x49) return 'image/webp';
  return 'image/jpeg';
}

async function ocr({ apiKey, model, imageBase64, prompt }) {
  if (!apiKey) throw new Error('OpenAI API key is required');

  const mimeType = detectMime(imageBase64);
  const dataUrl  = `data:${mimeType};base64,${imageBase64}`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model:      model || DEFAULT_MODEL,
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`OpenAI error ${response.status}: ${err?.error?.message || response.statusText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

module.exports = { ocr };
