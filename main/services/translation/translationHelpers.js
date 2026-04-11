const PAID_TRANSLATION_PRICING = {
  anthropic: {
    'claude-sonnet-4-6': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    'claude-opus-4-6': { inputPerMillion: 15.0, outputPerMillion: 75.0 },
    'claude-opus-4-5': { inputPerMillion: 15.0, outputPerMillion: 75.0 },
    'claude-haiku-4-5-20251001': { inputPerMillion: 0.8, outputPerMillion: 4.0 },
    'claude-haiku-4-5': { inputPerMillion: 0.8, outputPerMillion: 4.0 },
  },
  openai: {
    'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10.0 },
    'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
    'gpt-4-turbo': { inputPerMillion: 10.0, outputPerMillion: 30.0 },
    'gpt-4': { inputPerMillion: 30.0, outputPerMillion: 60.0 },
  },
  gemini: {
    'gemini-1.5-pro': { inputPerMillion: 1.25, outputPerMillion: 5.0 },
    'gemini-1.5-flash': { inputPerMillion: 0.075, outputPerMillion: 0.3 },
    'gemini-2.0-flash': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
    'gemini-2.0-flash-lite': { inputPerMillion: 0.075, outputPerMillion: 0.3 },
    'gemini-2.5-pro': { inputPerMillion: 1.25, outputPerMillion: 10.0 },
    'gemini-2.5-flash': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  },
};

/**
 * Look up pricing for a model, with prefix-based fallback so newly-released
 * model variants (e.g. "gemini-2.5-pro-preview-03-25") still get an estimate.
 */
function lookupPricing(provider, model) {
  const table = PAID_TRANSLATION_PRICING[provider];
  if (!table) return null;
  // Exact match
  if (table[model]) return table[model];
  // Prefix fallback: find the longest key that the model starts with
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (model.startsWith(key)) return table[key];
  }
  return null;
}

const TRANSLATION_LANGUAGES = [
  { label: 'Auto detect', value: '' },
  { label: 'Arabic', value: 'Arabic' },
  { label: 'Bengali', value: 'Bengali' },
  { label: 'Chinese', value: 'Chinese' },
  { label: 'Dutch', value: 'Dutch' },
  { label: 'English', value: 'English' },
  { label: 'French', value: 'French' },
  { label: 'German', value: 'German' },
  { label: 'Greek', value: 'Greek' },
  { label: 'Hebrew', value: 'Hebrew' },
  { label: 'Hindi', value: 'Hindi' },
  { label: 'Italian', value: 'Italian' },
  { label: 'Japanese', value: 'Japanese' },
  { label: 'Korean', value: 'Korean' },
  { label: 'Latin', value: 'Latin' },
  { label: 'Persian', value: 'Persian' },
  { label: 'Polish', value: 'Polish' },
  { label: 'Portuguese', value: 'Portuguese' },
  { label: 'Russian', value: 'Russian' },
  { label: 'Spanish', value: 'Spanish' },
  { label: 'Turkish', value: 'Turkish' },
  { label: 'Ukrainian', value: 'Ukrainian' },
  { label: 'Urdu', value: 'Urdu' },
];

const NLLB_LANGUAGE_CODES = {
  Arabic: 'arb_Arab',
  Bengali: 'ben_Beng',
  Chinese: 'zho_Hans',
  Dutch: 'nld_Latn',
  English: 'eng_Latn',
  French: 'fra_Latn',
  German: 'deu_Latn',
  Greek: 'ell_Grek',
  Hebrew: 'heb_Hebr',
  Hindi: 'hin_Deva',
  Italian: 'ita_Latn',
  Japanese: 'jpn_Jpan',
  Korean: 'kor_Hang',
  Latin: 'lat_Latn',
  Persian: 'pes_Arab',
  Polish: 'pol_Latn',
  Portuguese: 'por_Latn',
  Russian: 'rus_Cyrl',
  Spanish: 'spa_Latn',
  Turkish: 'tur_Latn',
  Ukrainian: 'ukr_Cyrl',
  Urdu: 'urd_Arab',
};

function isPaidTranslationProvider(provider) {
  return provider === 'openai' || provider === 'anthropic' || provider === 'gemini';
}

function estimateTokensFromText(text) {
  return Math.max(1, Math.ceil((text || '').length / 4));
}

function buildTranslationPrompt({ sourceLanguage, targetLanguage, text }) {
  const sourceHint = sourceLanguage ? `The source language is ${sourceLanguage}.` : 'Detect the source language if needed.';
  return [
    'You are a professional document translator.',
    sourceHint,
    `Translate the text into ${targetLanguage}.`,
    'Preserve paragraph breaks, line order, numbering, and structural labels when they exist.',
    'Do not add commentary or explanations.',
    'Return only the translated text.',
    '',
    text || '',
  ].join('\n');
}

function formatCurrency(value) {
  if (!Number.isFinite(value)) return 'Unavailable';
  if (value < 0.01) return '< $0.01';
  return `$${value.toFixed(3)}`;
}

module.exports = {
  PAID_TRANSLATION_PRICING,
  TRANSLATION_LANGUAGES,
  NLLB_LANGUAGE_CODES,
  isPaidTranslationProvider,
  estimateTokensFromText,
  buildTranslationPrompt,
  formatCurrency,
  lookupPricing,
};
