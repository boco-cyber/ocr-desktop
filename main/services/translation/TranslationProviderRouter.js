const path = require('path');
const { spawn } = require('child_process');
const fetch = require('node-fetch');

const {
  buildTranslationPrompt,
  NLLB_LANGUAGE_CODES,
} = require('./translationHelpers');

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODELS = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-6',
  gemini: 'gemini-1.5-flash',
  ollama: 'llama3.1',
  nllb: 'facebook/nllb-200-distilled-600M',
};

const NLLB_WORKER_PATH = path.join(__dirname, '..', '..', '..', 'workers', 'nllb-translate.py');

function createTimeoutController(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timer };
}

async function healthCheck(payload = {}) {
  const provider = payload.provider;
  const runtimeConfig = payload.runtimeConfig || {};
  if (!provider) {
    return { ok: false, error: 'Translation provider is required.' };
  }

  if (provider === 'ollama') {
    const baseUrl = (payload.baseUrl || runtimeConfig.ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL).replace(/\/$/, '');
    try {
      const { controller, timer } = createTimeoutController(5000);
      const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) {
        return { ok: false, error: `Ollama is not reachable at ${baseUrl} (HTTP ${response.status}).` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `Ollama is not reachable at ${baseUrl}: ${error.message}` };
    }
  }

  if (provider === 'nllb') {
    const pythonCmd = parsePythonCommand(runtimeConfig.nllbPythonPath || runtimeConfig.pythonPath || '');
    try {
      const result = await runNllbRequest({ type: 'health-check' }, pythonCmd);
      return result.ok ? { ok: true } : { ok: false, error: result.error || 'NLLB health check failed.' };
    } catch (error) {
      return { ok: false, error: `NLLB not available: ${error.message}` };
    }
  }

  if (!payload.apiKey) {
    return { ok: false, error: `${provider} API key is required.` };
  }

  return { ok: true };
}

async function translateChunk(payload = {}) {
  const provider = payload.provider;
  if (!provider) {
    throw new Error('Translation provider is required.');
  }

  if (!payload.targetLanguage) {
    throw new Error('Target language must be selected before starting translation.');
  }

  switch (provider) {
    case 'openai':
      return translateWithOpenAI(payload);
    case 'anthropic':
      return translateWithAnthropic(payload);
    case 'gemini':
      return translateWithGemini(payload);
    case 'ollama':
      return translateWithOllama(payload);
    case 'nllb':
      return translateWithNllb(payload);
    default:
      throw new Error(`Unsupported translation provider: ${provider}`);
  }
}

async function translateWithOpenAI(payload) {
  if (!payload.apiKey) throw new Error('OpenAI API key is required.');
  const { controller, timer } = createTimeoutController(120000);
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      signal: controller.signal,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${payload.apiKey}`,
      },
      body: JSON.stringify({
        model: payload.model || DEFAULT_MODELS.openai,
        temperature: 0.2,
        messages: [{
          role: 'user',
          content: buildTranslationPrompt(payload),
        }],
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error?.error?.message || `OpenAI error ${response.status}`);
    }

    const data = await response.json();
    return (data.choices?.[0]?.message?.content || '').trim();
  } finally {
    clearTimeout(timer);
  }
}

async function translateWithAnthropic(payload) {
  if (!payload.apiKey) throw new Error('Anthropic API key is required.');
  const { controller, timer } = createTimeoutController(120000);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      signal: controller.signal,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': payload.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: payload.model || DEFAULT_MODELS.anthropic,
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: buildTranslationPrompt(payload),
        }],
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error?.error?.message || `Anthropic error ${response.status}`);
    }

    const data = await response.json();
    const text = (data.content || [])
      .filter(item => item.type === 'text')
      .map(item => item.text)
      .join('\n');
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function translateWithGemini(payload) {
  if (!payload.apiKey) throw new Error('Gemini API key is required.');
  const model = payload.model || DEFAULT_MODELS.gemini;
  const { controller, timer } = createTimeoutController(120000);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(payload.apiKey)}`, {
      signal: controller.signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{ text: buildTranslationPrompt(payload) }],
        }],
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error?.error?.message || `Gemini error ${response.status}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('\n') || '';
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function translateWithOllama(payload) {
  const baseUrl = (payload.baseUrl || payload.runtimeConfig?.ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL).replace(/\/$/, '');
  const { controller, timer } = createTimeoutController(5 * 60 * 1000);
  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      signal: controller.signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: payload.model || DEFAULT_MODELS.ollama,
        stream: false,
        messages: [{
          role: 'user',
          content: buildTranslationPrompt(payload),
        }],
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new Error(text || `Ollama error ${response.status}`);
    }

    const data = await response.json();
    return (data.message?.content || '').trim();
  } finally {
    clearTimeout(timer);
  }
}


function detectNllbSourceLang(text) {
  // Quick Unicode-range heuristic — good enough to avoid catastrophic misdetection
  const sample = text.slice(0, 500);
  const arabicChars  = (sample.match(/[\u0600-\u06FF]/g) || []).length;
  const cjkChars     = (sample.match(/[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
  const cyrillicChars= (sample.match(/[\u0400-\u04FF]/g) || []).length;
  const latinChars   = (sample.match(/[a-zA-Z]/g) || []).length;
  const total = arabicChars + cjkChars + cyrillicChars + latinChars || 1;

  if (arabicChars / total > 0.3) return 'arb_Arab';
  if (cyrillicChars / total > 0.3) return 'rus_Cyrl';
  if (cjkChars / total > 0.3) return 'zho_Hans';
  return 'eng_Latn'; // default fallback
}

async function translateWithNllb(payload) {
  const runtimeConfig = payload.runtimeConfig || {};
  const pythonCmd = parsePythonCommand(runtimeConfig.nllbPythonPath || runtimeConfig.pythonPath || '');

  const targetNllb = NLLB_LANGUAGE_CODES[payload.targetLanguage];
  if (!targetNllb) {
    throw new Error(`NLLB does not support target language: "${payload.targetLanguage}". Choose a supported language.`);
  }

  const sourceNllb = payload.sourceLanguage ? (NLLB_LANGUAGE_CODES[payload.sourceLanguage] || null) : null;

  // If source language is not set, auto-detect from the text rather than blindly
  // defaulting to English (which causes hallucination on Arabic/CJK input)
  const resolvedSourceLang = sourceNllb || detectNllbSourceLang(payload.text || '');

  const result = await runNllbRequest({
    type: 'translate',
    text: payload.text || '',
    model: payload.model || DEFAULT_MODELS.nllb,
    targetLanguage: targetNllb,
    sourceLanguage: resolvedSourceLang,
    device: runtimeConfig.nllbDevice || 'auto',
    maxMemoryGb: runtimeConfig.nllbMemoryGb || 0,
  }, pythonCmd);

  if (!result.ok) {
    throw new Error(result.error || 'NLLB translation failed.');
  }

  return result.text || '';
}

function parsePythonCommand(commandInput) {
  const trimmed = (commandInput || '').trim();
  if (!trimmed) {
    // Default: try 'python' on Windows (py launcher), 'python3' elsewhere
    return process.platform === 'win32'
      ? { command: 'py', args: ['-3'] }
      : { command: 'python3', args: [] };
  }
  const parts = trimmed.match(/"[^"]+"|'[^']+'|\S+/g) || [];
  const normalized = parts.map(p => p.replace(/^['"]|['"]$/g, ''));
  return { command: normalized[0], args: normalized.slice(1) };
}

function runNllbRequest(requestPayload, pythonCmd) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonCmd.command, [...pythonCmd.args, NLLB_WORKER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: 'NLLB worker timed out (10 min).' });
    }, 10 * 60 * 1000);

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });

    child.on('error', error => {
      finish({ ok: false, error: `Could not start Python: ${error.message}. Set the Python path in Settings → Runtimes.` });
    });

    child.on('close', () => {
      try {
        const line = stdout.trim().split('\n').pop() || '{}';
        const parsed = JSON.parse(line);
        finish(parsed);
      } catch {
        finish({ ok: false, error: stderr.trim() || stdout.trim() || 'NLLB returned no output.' });
      }
    });

    child.stdin.write(JSON.stringify(requestPayload));
    child.stdin.end();
  });
}

module.exports = {
  DEFAULT_MODELS,
  healthCheck,
  translateChunk,
};
