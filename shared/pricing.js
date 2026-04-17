/**
 * Single source of truth for OCR provider pricing.
 * Prices are in USD per 1 million tokens.
 */
const PRICING = {
  anthropic: {
    'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
    'claude-opus-4-6': { input: 15.0, output: 75.0 },
    'claude-opus-4-5': { input: 15.0, output: 75.0 },
    'claude-haiku-4-5-20251001': { input: 0.8, output: 4.0 },
    'claude-haiku-4-5': { input: 0.8, output: 4.0 },
  },
  openai: {
    'gpt-4o': { input: 2.5, output: 10.0 },
    'gpt-4o-mini': { input: 0.15, output: 0.6 },
    'gpt-4-turbo': { input: 10.0, output: 30.0 },
    'gpt-4': { input: 30.0, output: 60.0 },
  },
  gemini: {
    'gemini-1.5-pro': { input: 1.25, output: 5.0 },
    'gemini-1.5-flash': { input: 0.075, output: 0.3 },
    'gemini-2.0-flash': { input: 0.1, output: 0.4 },
    'gemini-2.0-flash-lite': { input: 0.075, output: 0.3 },
    'gemini-2.5-pro': { input: 1.25, output: 10.0 },
    'gemini-2.5-flash': { input: 0.15, output: 0.6 },
  },
  ollama: {},
  paddleocr: {},
};

function lookupOcrPricing(provider, model) {
  const table = PRICING[provider];
  if (!table) return null;
  if (table[model]) return table[model];
  // Prefix fallback for live-fetched model variants
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (model && model.startsWith(key)) return table[key];
  }
  return null;
}

module.exports = { PRICING, lookupOcrPricing };