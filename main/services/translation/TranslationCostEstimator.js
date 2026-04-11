const {
  estimateTokensFromText,
  formatCurrency,
  isPaidTranslationProvider,
  lookupPricing,
} = require('./translationHelpers');

class TranslationCostEstimator {
  estimate({ project, provider, model }) {
    if (!provider) {
      return {
        provider: '',
        model: '',
        free: true,
        label: 'Select a provider',
      };
    }

    if (!isPaidTranslationProvider(provider)) {
      return {
        provider,
        model,
        free: true,
        label: 'Free (local)',
      };
    }

    const pricing = lookupPricing(provider, model);
    if (!pricing) {
      return {
        provider,
        model,
        free: false,
        label: `Pricing unavailable for ${model}`,
      };
    }

    const chunks = (project.chunkIds || []).map(chunkId => project.chunks[chunkId]).filter(Boolean);
    const inputTokens = chunks.reduce((sum, chunk) => sum + estimateTokensFromText(chunk.sourceText || ''), 0);
    const outputTokens = Math.ceil(inputTokens * 1.1);
    const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
    const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
    const totalCost = inputCost + outputCost;

    return {
      provider,
      model,
      free: false,
      chunkCount: chunks.length,
      totalInputTokens: inputTokens,
      totalOutputTokens: outputTokens,
      inputCost: inputCost.toFixed(4),
      outputCost: outputCost.toFixed(4),
      totalCost: totalCost.toFixed(4),
      label: formatCurrency(totalCost),
      assumptions: 'Approximate cost based on source text length and 1.1x output-token multiplier.',
    };
  }
}

module.exports = { TranslationCostEstimator };
