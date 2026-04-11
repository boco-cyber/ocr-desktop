const fs = require('fs');

const anthropicProvider = require('../providers/anthropic');
const openaiProvider = require('../providers/openai');
const geminiProvider = require('../providers/gemini');
const ollamaProvider = require('../providers/ollama');
const paddleocrProvider = require('../providers/paddleocr');
const tesseractProvider = require('../providers/tesseract');

const PROVIDERS = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  gemini: geminiProvider,
  ollama: ollamaProvider,
  paddleocr: paddleocrProvider,
  tesseract: tesseractProvider,
};

process.on('message', async message => {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'ping') {
    process.send?.({ type: 'pong' });
    return;
  }

  if (message.type !== 'ocr-page') return;

  const payload = message.payload || {};
  const provider = PROVIDERS[payload.provider];
  if (!provider) {
    process.send?.({
      type: 'ocr-page-result',
      ok: false,
      jobId: payload.jobId,
      pageId: payload.pageId,
      error: `Unsupported OCR provider: ${payload.provider}`,
    });
    return;
  }

  try {
    const buffer = fs.readFileSync(payload.preparedImagePath);
    const text = await provider.ocr({
      apiKey: payload.apiKey || '',
      model: payload.model || '',
      imageBase64: buffer.toString('base64'),
      prompt: payload.prompt,
      baseUrl: payload.ollamaBaseUrl || '',
      lang: payload.language || '',
      runtimeConfig: payload.runtimeConfig || {},
    });

    process.send?.({
      type: 'ocr-page-result',
      ok: true,
      jobId: payload.jobId,
      pageId: payload.pageId,
      text: text || '',
    });
  } catch (error) {
    process.send?.({
      type: 'ocr-page-result',
      ok: false,
      jobId: payload.jobId,
      pageId: payload.pageId,
      error: error.message,
    });
  }
});

process.send?.({ type: 'ready' });
