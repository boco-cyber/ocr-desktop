/**
 * Ollama local vision OCR provider
 * Fetches available models dynamically from local Ollama instance.
 * Best vision models (in order of quality): llava:34b, llava:13b, llava:7b, moondream, bakllava
 *
 * Docs:
 *   Chat API:  https://github.com/ollama/ollama/blob/main/docs/api.md#generate-a-chat-completion
 *   Models:    https://ollama.com/library?q=vision
 *
 * NOTE: If a non-vision model is selected, Ollama returns an error —
 *       the caller surfaces it clearly in the UI.
 */
const fetch = require('node-fetch');

const DEFAULT_MODEL  = 'llava';
const DEFAULT_BASE   = 'http://localhost:11434';
const TIMEOUT_MS     = 300000; // 5 minutes — local models can be slow

async function ocr({ model, imageBase64, prompt, baseUrl }) {
  // No API key needed for local Ollama
  const url = (baseUrl || DEFAULT_BASE).replace(/\/$/, '') + '/api/chat';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:  model || DEFAULT_MODEL,
        stream: false,
        messages: [{
          role:    'user',
          content: prompt,
          images:  [imageBase64], // raw base64, no data: URI prefix
        }],
      }),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    // Surface a clear message if model doesn't support vision
    if (text.includes('does not support') || text.includes('no vision')) {
      throw new Error(`This Ollama model does not support image input. Please select a vision model (llava, moondream, bakllava, etc.)`);
    }
    throw new Error(`Ollama error ${response.status}: ${text}`);
  }

  const data = await response.json();
  return data.message?.content || '';
}

module.exports = { ocr };
