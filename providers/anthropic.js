/**
 * Anthropic (Claude) vision OCR provider
 * Uses claude-sonnet-4-6 (or any claude model with vision support)
 * Docs: https://docs.anthropic.com/en/api/messages
 */
const fetch = require('node-fetch');

const DEFAULT_MODEL = 'claude-sonnet-4-6';

function detectMime(b64) {
  const head = Buffer.from(b64.slice(0, 8), 'base64');
  if (head[0] === 0xFF && head[1] === 0xD8) return 'image/jpeg';
  if (head[0] === 0x89 && head[1] === 0x50) return 'image/png';
  if (head[0] === 0x52 && head[1] === 0x49) return 'image/webp';
  return 'image/jpeg';
}

async function ocr({ apiKey, model, imageBase64, prompt }) {
  if (!apiKey) throw new Error('Anthropic API key is required');

  const mimeType = detectMime(imageBase64);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-key':       apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      model || DEFAULT_MODEL,
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type:       'base64',
              media_type: mimeType,
              data:       imageBase64,
            },
          },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Anthropic error ${response.status}: ${err?.error?.message || response.statusText}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || '';
}

async function listModels({ apiKey }) {
  if (!apiKey) throw new Error('Anthropic API key is required');
  const response = await fetch('https://api.anthropic.com/v1/models', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Anthropic error ${response.status}: ${err?.error?.message || response.statusText}`);
  }
  const data = await response.json();
  // Filter to models that support vision (have "claude" in name)
  const models = (data.data || []).map(m => m.id).filter(id => id.includes('claude'));
  return models;
}

module.exports = { ocr, listModels };
