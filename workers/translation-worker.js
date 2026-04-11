// Suppress Node.js deprecation warnings from dependencies (e.g. punycode via node-fetch v2)
process.removeAllListeners('warning');
process.on('warning', w => { if (w.name !== 'DeprecationWarning') process.emitWarning(w.message, w); });

const path = require('path');
const {
  healthCheck,
  translateChunk,
} = require(path.resolve(__dirname, '../main/services/translation/TranslationProviderRouter'));

process.on('message', async message => {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'ping') {
    process.send?.({ type: 'pong' });
    return;
  }

  if (message.type === 'health-check') {
    try {
      const result = await healthCheck(message.payload || {});
      process.send?.({ type: 'health-check-result', ok: result.ok, error: result.error || null });
    } catch (error) {
      process.send?.({ type: 'health-check-result', ok: false, error: error.message });
    }
    return;
  }

  if (message.type !== 'translate-chunk') return;

  try {
    const text = await translateChunk(message.payload || {});
    process.send?.({
      type: 'translate-chunk-result',
      ok: true,
      text: text || '',
      diagnostics: {
        provider: message.payload?.provider || null,
        model: message.payload?.model || null,
      },
    });
  } catch (error) {
    process.send?.({
      type: 'translate-chunk-result',
      ok: false,
      error: error.message,
    });
  }
});

process.send?.({ type: 'ready' });
