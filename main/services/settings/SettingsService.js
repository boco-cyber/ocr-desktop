const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const fse = require('fs-extra');
const { PRICING: OCR_PRICING } = require('../../../shared/pricing');

const OCR_PROVIDER_MODELS = {
  anthropic: Object.keys(OCR_PRICING.anthropic),
  openai: Object.keys(OCR_PRICING.openai),
  gemini: Object.keys(OCR_PRICING.gemini),
  ollama: [],
  paddleocr: [],
  tesseract: [],
};

const TRANSLATION_PROVIDER_MODELS = {
  ollama: [],
  openai: ['gpt-4o-mini', 'gpt-4o'],
  anthropic: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  gemini: ['gemini-1.5-flash', 'gemini-1.5-pro'],
  nllb: ['facebook/nllb-200-distilled-600M', 'facebook/nllb-200-1.3B', 'facebook/nllb-200-3.3B'],
};

const DEFAULT_SETTINGS = {
  version: 1,
  general: {
    projectStoragePath: '',
    exportPath: '',
    tempPath: '',
  },
  ocr: {
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
    defaultOllamaModel: '',
    defaultLanguage: '',
    defaultOcrMode: 'standard',
  },
  translation: {
    defaultSourceLanguage: '',
    defaultTargetLanguage: 'English',
    defaultProvider: 'ollama',
    defaultModel: '',
    defaultOllamaModel: '',
    defaultChunkSize: 1400,
  },
  runtimes: {
    pythonPath: '',
    paddlePythonPath: '',
    nllbPythonPath: '',
    nllbDevice: 'auto',
    nllbMemoryGb: 0,
    ollamaBaseUrl: 'http://localhost:11434',
  },
  performance: {
    ocrConcurrency: 3,
    ocrWorkerTimeoutMs: 10 * 60 * 1000,
    translationWorkerTimeoutMs: 10 * 60 * 1000,
  },
  meta: {
    createdAt: null,
    updatedAt: null,
    recoveredCorruptConfigAt: null,
    recoveredCorruptSecretsAt: null,
    lastHealthChecks: {},
  },
};

const SECRET_PROVIDER_KEYS = ['openai', 'gemini', 'anthropic'];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function maskSecret(secret) {
  if (!secret) {
    return {
      configured: false,
      masked: '',
      last4: '',
      length: 0,
    };
  }

  const last4 = secret.slice(-4);
  const visibleTail = secret.length > 4 ? last4 : secret;
  const maskedCore = '•'.repeat(Math.max(0, secret.length - visibleTail.length));
  return {
    configured: true,
    masked: `${maskedCore}${visibleTail}`,
    last4,
    length: secret.length,
  };
}

function normalizeDirectory(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isValidUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function setDeep(target, pathKey, value) {
  const parts = pathKey.split('.');
  let current = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    current[part] = current[part] || {};
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

function parseCommandInput(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) {
    return null;
  }

  if (fs.existsSync(trimmed)) {
    return {
      command: trimmed,
      args: [],
      display: trimmed,
    };
  }

  const parts = trimmed.match(/"[^"]+"|'[^']+'|\S+/g) || [];
  const normalized = parts.map(part => part.replace(/^['"]|['"]$/g, ''));
  return {
    command: normalized[0],
    args: normalized.slice(1),
    display: trimmed,
  };
}

function runCommand(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs || 10000,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', error => {
      finish({
        ok: false,
        error: error.message,
        stdout,
        stderr,
      });
    });

    child.on('close', code => {
      finish({
        ok: code === 0,
        code,
        stdout,
        stderr,
        error: code === 0 ? null : (stderr.trim() || stdout.trim() || `Exited with code ${code}`),
      });
    });
  });
}

class SettingsService {
  constructor({
    dataDir,
    logger,
    appInfo = {},
    safeStorageAdapter = null,
  }) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.appInfo = appInfo;
    this.safeStorageAdapter = safeStorageAdapter;
    this.configPath = path.join(dataDir, 'app_settings.json');
    this.secretsPath = path.join(dataDir, 'app_secrets.json');
    this.logsPath = path.join(dataDir, 'logs');
    this.mutationChain = Promise.resolve();
    this.runtimeDependencies = {
      ocrWorkerBridge: null,
      translationWorkerBridge: null,
      ocrProjectService: null,
      translationProjectService: null,
    };
  }

  setRuntimeDependencies(dependencies = {}) {
    this.runtimeDependencies = {
      ...this.runtimeDependencies,
      ...dependencies,
    };
    this.applyRuntimeSettings(this.cachedSettings || DEFAULT_SETTINGS);
  }

  getDefaultGeneralPaths() {
    return {
      projectStoragePath: path.join(this.dataDir, 'projects-root'),
      exportPath: path.join(this.dataDir, 'exports'),
      tempPath: path.join(this.dataDir, 'temp'),
    };
  }

  buildDefaultState() {
    const defaults = clone(DEFAULT_SETTINGS);
    const paths = this.getDefaultGeneralPaths();
    defaults.general.projectStoragePath = paths.projectStoragePath;
    defaults.general.exportPath = paths.exportPath;
    defaults.general.tempPath = paths.tempPath;
    defaults.meta.createdAt = new Date().toISOString();
    defaults.meta.updatedAt = defaults.meta.createdAt;
    return defaults;
  }

  buildDefaultSecretsState() {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      encryption: this.safeStorageAdapter?.isEncryptionAvailable?.() ? 'safeStorage' : 'plaintext-fallback',
      providers: {
        openai: '',
        gemini: '',
        anthropic: '',
      },
    };
  }

  async init() {
    await fse.ensureDir(this.dataDir);
    await fse.ensureDir(this.logsPath);
    const defaults = this.buildDefaultState();
    await fse.ensureDir(defaults.general.projectStoragePath);
    await fse.ensureDir(defaults.general.exportPath);
    await fse.ensureDir(defaults.general.tempPath);

    if (!(await fse.pathExists(this.configPath))) {
      await fse.writeJson(this.configPath, defaults, { spaces: 2 });
    }
    if (!(await fse.pathExists(this.secretsPath))) {
      await fse.writeJson(this.secretsPath, this.buildDefaultSecretsState(), { spaces: 2 });
    }

    this.cachedSettings = await this.loadConfigState();
    this.applyRuntimeSettings(this.cachedSettings);
  }

  async withMutation(mutator) {
    const next = this.mutationChain.then(async () => {
      const result = await mutator();
      return result;
    }, async () => {
      const result = await mutator();
      return result;
    });
    this.mutationChain = next.then(() => undefined, () => undefined);
    return next;
  }

  async loadConfigState() {
    await this.initBaseDirs();
    try {
      const parsed = await fse.readJson(this.configPath);
      const merged = this.mergeWithDefaults(parsed || {});
      this.cachedSettings = merged;
      return merged;
    } catch (error) {
      const defaults = this.buildDefaultState();
      defaults.meta.recoveredCorruptConfigAt = new Date().toISOString();
      if (await fse.pathExists(this.configPath)) {
        const backupPath = `${this.configPath}.corrupt-${Date.now()}.bak`;
        await fse.move(this.configPath, backupPath, { overwrite: true });
      }
      await fse.writeJson(this.configPath, defaults, { spaces: 2 });
      this.logger.warn('settings.config_recovered', { error: error.message });
      this.cachedSettings = defaults;
      return defaults;
    }
  }

  async initBaseDirs() {
    await fse.ensureDir(this.dataDir);
    await fse.ensureDir(this.logsPath);
  }

  mergeWithDefaults(parsed) {
    const defaults = this.buildDefaultState();
    const merged = {
      ...defaults,
      ...parsed,
      general: {
        ...defaults.general,
        ...(parsed.general || {}),
      },
      ocr: {
        ...defaults.ocr,
        ...(parsed.ocr || {}),
      },
      translation: {
        ...defaults.translation,
        ...(parsed.translation || {}),
      },
      runtimes: {
        ...defaults.runtimes,
        ...(parsed.runtimes || {}),
      },
      performance: {
        ...defaults.performance,
        ...(parsed.performance || {}),
      },
      meta: {
        ...defaults.meta,
        ...(parsed.meta || {}),
        lastHealthChecks: {
          ...(defaults.meta.lastHealthChecks || {}),
          ...((parsed.meta || {}).lastHealthChecks || {}),
        },
      },
    };

    if (!merged.meta.createdAt) {
      merged.meta.createdAt = new Date().toISOString();
    }
    merged.meta.updatedAt = new Date().toISOString();
    return merged;
  }

  async saveConfigState(state) {
    state.meta = state.meta || {};
    state.meta.updatedAt = new Date().toISOString();
    await fse.writeJson(this.configPath, state, { spaces: 2 });
    this.cachedSettings = state;
    this.applyRuntimeSettings(state);
  }

  encryptSecret(secret) {
    if (!secret) return '';
    if (this.safeStorageAdapter?.isEncryptionAvailable?.()) {
      return this.safeStorageAdapter.encryptString(secret).toString('base64');
    }
    return secret;
  }

  decryptSecret(secret) {
    if (!secret) return '';
    if (this.safeStorageAdapter?.isEncryptionAvailable?.()) {
      try {
        return this.safeStorageAdapter.decryptString(Buffer.from(secret, 'base64'));
      } catch {
        return '';
      }
    }
    return secret;
  }

  async loadSecretsState() {
    await this.initBaseDirs();
    try {
      const parsed = await fse.readJson(this.secretsPath);
      return {
        version: 1,
        updatedAt: parsed.updatedAt || new Date().toISOString(),
        encryption: parsed.encryption || (this.safeStorageAdapter?.isEncryptionAvailable?.() ? 'safeStorage' : 'plaintext-fallback'),
        providers: {
          openai: parsed.providers?.openai || '',
          gemini: parsed.providers?.gemini || '',
          anthropic: parsed.providers?.anthropic || '',
        },
      };
    } catch (error) {
      const defaults = this.buildDefaultSecretsState();
      if (await fse.pathExists(this.secretsPath)) {
        const backupPath = `${this.secretsPath}.corrupt-${Date.now()}.bak`;
        await fse.move(this.secretsPath, backupPath, { overwrite: true });
      }
      await fse.writeJson(this.secretsPath, defaults, { spaces: 2 });
      this.logger.warn('settings.secrets_recovered', { error: error.message });
      return defaults;
    }
  }

  async saveSecretsState(secretsState) {
    secretsState.updatedAt = new Date().toISOString();
    secretsState.encryption = this.safeStorageAdapter?.isEncryptionAvailable?.() ? 'safeStorage' : 'plaintext-fallback';
    await fse.writeJson(this.secretsPath, secretsState, { spaces: 2 });
  }

  getResolvedGeneralPaths(settings) {
    const defaults = this.getDefaultGeneralPaths();
    return {
      projectStoragePath: normalizeDirectory(settings.general.projectStoragePath) || defaults.projectStoragePath,
      exportPath: normalizeDirectory(settings.general.exportPath) || defaults.exportPath,
      tempPath: normalizeDirectory(settings.general.tempPath) || defaults.tempPath,
    };
  }

  getProjectAssetsRoot(kind = 'ocr', settings = this.cachedSettings || this.buildDefaultState()) {
    const general = this.getResolvedGeneralPaths(settings);
    return path.join(general.projectStoragePath, kind === 'translation' ? 'translation-projects' : 'ocr-projects');
  }

  getRuntimeConfig(settings = this.cachedSettings || this.buildDefaultState()) {
    return {
      pythonPath: settings.runtimes.pythonPath || '',
      paddlePythonPath: settings.runtimes.paddlePythonPath || '',
      paddleDevice: settings.runtimes.paddleDevice || 'auto',
      nllbPythonPath: settings.runtimes.nllbPythonPath || '',
      nllbDevice: settings.runtimes.nllbDevice || 'auto',
      nllbMemoryGb: Number(settings.runtimes.nllbMemoryGb) || 0,
      ollamaBaseUrl: settings.runtimes.ollamaBaseUrl || DEFAULT_SETTINGS.runtimes.ollamaBaseUrl,
    };
  }

  getDiagnosticsSummary(settings) {
    const resolved = this.getResolvedGeneralPaths(settings);
    return {
      appVersion: this.appInfo.version || 'unknown',
      appName: this.appInfo.name || 'OCR Desktop',
      dataDir: this.dataDir,
      logsPath: this.logsPath,
      exportPath: resolved.exportPath,
      tempPath: resolved.tempPath,
      projectStoragePath: resolved.projectStoragePath,
      safeStorageAvailable: Boolean(this.safeStorageAdapter?.isEncryptionAvailable?.()),
    };
  }

  async getSanitizedSettings() {
    const [settings, secrets] = await Promise.all([
      this.loadConfigState(),
      this.loadSecretsState(),
    ]);

    const providerSummaries = {};
    for (const provider of SECRET_PROVIDER_KEYS) {
      providerSummaries[provider] = {
        ...maskSecret(this.decryptSecret(secrets.providers[provider] || '')),
        updatedAt: secrets.updatedAt || null,
      };
    }

    return {
      settings,
      providerSecrets: providerSummaries,
      diagnostics: this.getDiagnosticsSummary(settings),
    };
  }

  async getSecret(provider) {
    const secrets = await this.loadSecretsState();
    return this.decryptSecret(secrets.providers?.[provider] || '');
  }

  async saveProviderKey(provider, apiKey) {
    if (!provider || !SECRET_PROVIDER_KEYS.includes(provider)) {
      return { ok: false, error: 'Unknown provider.' };
    }
    await this.withMutation(async () => {
      const secrets = await this.loadSecretsState();
      const incoming = String(apiKey || '').trim();
      secrets.providers[provider] = incoming ? this.encryptSecret(incoming) : '';
      await this.saveSecretsState(secrets);
    });
    return { ok: true };
  }

  async getProviderKeyMasked(provider) {
    if (!provider || !SECRET_PROVIDER_KEYS.includes(provider)) {
      return { configured: false };
    }
    const secrets = await this.loadSecretsState();
    return maskSecret(this.decryptSecret(secrets.providers?.[provider] || ''));
  }

  async getSettingsForRuntime() {
    const settings = await this.loadConfigState();
    return settings;
  }

  async validateSettings(inputSettings = {}, { testPaths = true } = {}) {
    const merged = this.mergeWithDefaults(inputSettings);
    const errors = [];
    const warnings = [];
    const general = this.getResolvedGeneralPaths(merged);

    const addError = (field, message) => errors.push({ field, message });
    const addWarning = (field, message) => warnings.push({ field, message });

    if (!OCR_PROVIDER_MODELS[merged.ocr.defaultProvider]) {
      addError('ocr.defaultProvider', 'Unsupported OCR provider.');
    }

    if (['anthropic', 'openai', 'gemini'].includes(merged.ocr.defaultProvider)) {
      // Accept any non-empty model string — users may have fetched a live model not in the static list
      if (!merged.ocr.defaultModel) {
        addWarning('ocr.defaultModel', `No default OCR model set for ${merged.ocr.defaultProvider}.`);
      }
    }

    const ocrModes = ['standard', 'book', 'photo', 'structure', 'table', 'handwriting', 'receipt', 'numbers', 'noheaders', 'custom'];
    if (!ocrModes.includes(merged.ocr.defaultOcrMode)) {
      addError('ocr.defaultOcrMode', 'Unsupported OCR mode.');
    }

    if (!TRANSLATION_PROVIDER_MODELS[merged.translation.defaultProvider]) {
      addError('translation.defaultProvider', 'Unsupported translation provider.');
    }

    if (merged.translation.defaultProvider === 'ollama') {
      if (!merged.translation.defaultOllamaModel && !merged.translation.defaultModel) {
        addWarning('translation.defaultOllamaModel', 'No default Ollama translation model is configured.');
      }
    } else if (merged.translation.defaultProvider !== 'ollama') {
      // Accept any non-empty model string — users may have fetched a live model
      if (!merged.translation.defaultModel) {
        addWarning('translation.defaultModel', `No default translation model set for ${merged.translation.defaultProvider}.`);
      }
    }

    if (!Number.isInteger(merged.translation.defaultChunkSize) || merged.translation.defaultChunkSize < 200 || merged.translation.defaultChunkSize > 10000) {
      addError('translation.defaultChunkSize', 'Translation chunk size must be between 200 and 10000 characters.');
    }

    if (!Number.isInteger(merged.performance.ocrConcurrency) || merged.performance.ocrConcurrency < 1 || merged.performance.ocrConcurrency > 8) {
      addError('performance.ocrConcurrency', 'OCR concurrency must be between 1 and 8.');
    }

    if (!Number.isInteger(merged.performance.ocrWorkerTimeoutMs) || merged.performance.ocrWorkerTimeoutMs < 10000 || merged.performance.ocrWorkerTimeoutMs > 1800000) {
      addError('performance.ocrWorkerTimeoutMs', 'OCR worker timeout must be between 10000 and 1800000 ms.');
    }

    if (!Number.isInteger(merged.performance.translationWorkerTimeoutMs) || merged.performance.translationWorkerTimeoutMs < 10000 || merged.performance.translationWorkerTimeoutMs > 1800000) {
      addError('performance.translationWorkerTimeoutMs', 'Translation worker timeout must be between 10000 and 1800000 ms.');
    }

    if (!isValidUrl(merged.runtimes.ollamaBaseUrl)) {
      addError('runtimes.ollamaBaseUrl', 'Ollama endpoint must be a valid http:// or https:// URL.');
    }

    const pathChecks = [
      ['general.projectStoragePath', general.projectStoragePath],
      ['general.exportPath', general.exportPath],
      ['general.tempPath', general.tempPath],
    ];

    if (testPaths) {
      for (const [field, directory] of pathChecks) {
        try {
          await this.ensureWritableDirectory(directory);
        } catch (error) {
          addError(field, error.message);
        }
      }
    }

    const executableChecks = [
      ['runtimes.pythonPath', merged.runtimes.pythonPath],
      ['runtimes.paddlePythonPath', merged.runtimes.paddlePythonPath],
      ['runtimes.nllbPythonPath', merged.runtimes.nllbPythonPath],
    ];

    for (const [field, value] of executableChecks) {
      if (!value) continue;
      const result = await this.checkPythonCommand(value);
      if (!result.ok) {
        addError(field, result.error || 'Executable is not reachable.');
      }
    }

    return {
      ok: errors.length === 0,
      errors,
      warnings,
      settings: merged,
    };
  }

  async ensureWritableDirectory(directory) {
    const resolved = normalizeDirectory(directory);
    if (!resolved) {
      throw new Error('Path is required.');
    }
    await fse.ensureDir(resolved);
    const testFile = path.join(resolved, `.write-test-${Date.now()}.tmp`);
    await fse.writeFile(testFile, 'ok');
    await fse.remove(testFile);
  }

  async checkPythonCommand(commandInput) {
    const parsed = parseCommandInput(commandInput);
    if (!parsed) {
      return { ok: false, error: 'Python command is empty.' };
    }

    let args = [...parsed.args];
    if (path.basename(parsed.command).toLowerCase() === 'py' && !args.length) {
      args = ['-3.11'];
    }

    const result = await runCommand(parsed.command, [...args, '--version'], { timeoutMs: 10000 });
    if (!result.ok) {
      return {
        ok: false,
        error: result.error || `Could not run ${parsed.display}.`,
      };
    }

    return {
      ok: true,
      summary: result.stdout.trim() || result.stderr.trim() || `${parsed.display} is reachable.`,
      command: parsed.display,
    };
  }


  async saveSettings(payload = {}) {
    const candidate = this.mergeWithDefaults(payload.settings || {});
    const validation = await this.validateSettings(candidate);
    if (!validation.ok) {
      return validation;
    }

    await this.withMutation(async () => {
      const [currentSecrets, currentSettings] = await Promise.all([
        this.loadSecretsState(),
        this.loadConfigState(),
      ]);

      const nextSettings = this.mergeWithDefaults(candidate);
      nextSettings.meta.createdAt = currentSettings.meta.createdAt || nextSettings.meta.createdAt;
      nextSettings.meta.lastHealthChecks = currentSettings.meta.lastHealthChecks || {};
      await this.saveConfigState(nextSettings);

      const secretUpdates = payload.secrets || {};
      for (const provider of SECRET_PROVIDER_KEYS) {
        if (Object.prototype.hasOwnProperty.call(secretUpdates, provider)) {
          const incoming = String(secretUpdates[provider] || '').trim();
          currentSecrets.providers[provider] = incoming ? this.encryptSecret(incoming) : '';
        }
      }
      await this.saveSecretsState(currentSecrets);
    });

    const response = await this.getSanitizedSettings();
    return {
      ok: true,
      errors: [],
      warnings: validation.warnings,
      ...response,
    };
  }

  async resetSection(section) {
    const defaults = this.buildDefaultState();
    const current = await this.loadConfigState();
    const next = this.mergeWithDefaults(current);

    if (section === 'all') {
      defaults.meta.lastHealthChecks = current.meta.lastHealthChecks || {};
      await this.saveConfigState(defaults);
    } else if (Object.prototype.hasOwnProperty.call(next, section)) {
      next[section] = clone(defaults[section]);
      next.meta.lastHealthChecks = current.meta.lastHealthChecks || {};
      await this.saveConfigState(next);
    } else if (section === 'providers') {
      const secrets = this.buildDefaultSecretsState();
      await this.saveSecretsState(secrets);
    } else {
      throw new Error('Unknown settings section.');
    }

    return this.getSanitizedSettings();
  }

  async testProvider(payload = {}) {
    const provider = payload.provider;
    if (!provider) {
      throw new Error('Provider is required.');
    }

    const settings = await this.loadConfigState();
    const apiKey = payload.apiKey || await this.getSecret(provider);
    // Use the first known model for this provider as a safe default (avoid cross-provider contamination)
    const providerDefaultModels = payload.scope === 'translation'
      ? TRANSLATION_PROVIDER_MODELS
      : OCR_PROVIDER_MODELS;
    const fallbackModel = (providerDefaultModels[provider] || [])[0] || '';
    const model = payload.model
      || (payload.scope === 'translation'
        ? (settings.translation.defaultModel && TRANSLATION_PROVIDER_MODELS[provider]?.includes(settings.translation.defaultModel) ? settings.translation.defaultModel : fallbackModel)
        : (settings.ocr.defaultModel && OCR_PROVIDER_MODELS[provider]?.includes(settings.ocr.defaultModel) ? settings.ocr.defaultModel : fallbackModel));

    let result;
    if (payload.scope === 'translation') {
      result = await this.runtimeDependencies.translationProjectService.testProvider({
        provider,
        model,
        apiKey,
        baseUrl: payload.baseUrl || settings.runtimes.ollamaBaseUrl,
        runtimeConfig: this.getRuntimeConfig(settings),
      });
    } else {
      result = await this.runtimeDependencies.ocrProjectService.testProvider({
        provider,
        model,
        apiKey,
        baseUrl: payload.baseUrl || settings.runtimes.ollamaBaseUrl,
        runtimeConfig: this.getRuntimeConfig(settings),
      });
    }

    const summary = {
      ok: Boolean(result.ok),
      provider,
      scope: payload.scope || 'ocr',
      checkedAt: new Date().toISOString(),
      message: result.ok ? `${provider} is reachable.` : (result.error || 'Provider test failed.'),
    };
    await this.recordHealthCheck(`provider:${payload.scope || 'ocr'}:${provider}`, summary);
    return summary;
  }

  async testRuntime(payload = {}) {
    const runtime = payload.runtime;
    if (!runtime) {
      throw new Error('Runtime name is required.');
    }

    const settings = await this.loadConfigState();
    const runtimeConfig = this.getRuntimeConfig(settings);
    let result;

    switch (runtime) {
      case 'python':
        result = await this.checkPythonCommand(payload.command || runtimeConfig.pythonPath || (process.platform === 'win32' ? 'py -3.11' : 'python3'));
        break;
      case 'ollama':
        result = await this.runtimeDependencies.ocrProjectService.listOllamaModels(payload.baseUrl || runtimeConfig.ollamaBaseUrl);
        result = result.error
          ? { ok: false, error: result.error }
          : { ok: true, summary: `${result.models.length} model(s) visible.` };
        break;
      case 'paddleocr':
        result = await this.checkPythonCommand(payload.command || runtimeConfig.paddlePythonPath || runtimeConfig.pythonPath || (process.platform === 'win32' ? 'py -3' : 'python3'));
        break;
      case 'tesseract':
        result = { ok: true, summary: 'Tesseract.js is always available — no setup needed.' };
        break;
      case 'nllb':
        result = await this.checkPythonCommand(payload.command || runtimeConfig.nllbPythonPath || runtimeConfig.pythonPath || (process.platform === 'win32' ? 'py -3' : 'python3'));
        break;
      case 'ocr-worker':
        result = await this.runtimeDependencies.ocrWorkerBridge.healthCheck();
        result = result.ok
          ? { ok: true, summary: 'OCR worker responded to ping.' }
          : { ok: false, error: result.error || 'OCR worker did not respond.' };
        break;
      case 'translation-worker':
        result = await this.runtimeDependencies.translationWorkerBridge.healthCheck();
        result = result.ok
          ? { ok: true, summary: 'Translation worker responded to ping.' }
          : { ok: false, error: result.error || 'Translation worker did not respond.' };
        break;
      default:
        throw new Error(`Unsupported runtime test: ${runtime}`);
    }

    const summary = {
      ok: Boolean(result.ok),
      runtime,
      checkedAt: new Date().toISOString(),
      message: result.summary || result.error || `${runtime} check completed.`,
    };
    await this.recordHealthCheck(`runtime:${runtime}`, summary);
    return summary;
  }

  async recordHealthCheck(key, value) {
    await this.withMutation(async () => {
      const settings = await this.loadConfigState();
      settings.meta.lastHealthChecks[key] = value;
      await this.saveConfigState(settings);
    });
  }

  async getHealthSummary() {
    const settings = await this.loadConfigState();
    const diagnostics = this.getDiagnosticsSummary(settings);
    const providerSecrets = (await this.getSanitizedSettings()).providerSecrets;
    const localChecks = await Promise.allSettled([
      this.testRuntime({ runtime: 'ocr-worker' }),
      this.testRuntime({ runtime: 'translation-worker' }),
    ]);

    return {
      app: diagnostics,
      settingsSummary: {
        ocrProvider: settings.ocr.defaultProvider,
        translationProvider: settings.translation.defaultProvider,
        ocrConcurrency: settings.performance.ocrConcurrency,
        ocrWorkerTimeoutMs: settings.performance.ocrWorkerTimeoutMs,
        translationWorkerTimeoutMs: settings.performance.translationWorkerTimeoutMs,
      },
      providers: providerSecrets,
      runtimes: {
        pythonPath: settings.runtimes.pythonPath || '(auto)',
        tesseract: 'Built-in (Tesseract.js)',
        ollamaBaseUrl: settings.runtimes.ollamaBaseUrl,
      },
      workers: {
        ocr: localChecks[0].status === 'fulfilled' ? localChecks[0].value : { ok: false, message: localChecks[0].reason?.message || 'Failed to check OCR worker.' },
        translation: localChecks[1].status === 'fulfilled' ? localChecks[1].value : { ok: false, message: localChecks[1].reason?.message || 'Failed to check translation worker.' },
      },
      lastHealthChecks: settings.meta.lastHealthChecks || {},
      recoveredCorruptConfigAt: settings.meta.recoveredCorruptConfigAt || null,
      recoveredCorruptSecretsAt: settings.meta.recoveredCorruptSecretsAt || null,
    };
  }

  async buildDiagnosticsExport() {
    const settingsBundle = await this.getSanitizedSettings();
    const health = await this.getHealthSummary();
    return {
      defaultFileName: `ocr-desktop-diagnostics-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`,
      data: Buffer.from(JSON.stringify({
        exportedAt: new Date().toISOString(),
        settings: settingsBundle.settings,
        providerSecrets: settingsBundle.providerSecrets,
        diagnostics: settingsBundle.diagnostics,
        health,
      }, null, 2), 'utf8'),
    };
  }

  applyRuntimeSettings(settings) {
    if (!settings) return;
    const ocrTimeout = settings.performance?.ocrWorkerTimeoutMs || DEFAULT_SETTINGS.performance.ocrWorkerTimeoutMs;
    const translationTimeout = settings.performance?.translationWorkerTimeoutMs || DEFAULT_SETTINGS.performance.translationWorkerTimeoutMs;
    this.runtimeDependencies.ocrWorkerBridge?.setWorkerTimeoutMs?.(ocrTimeout);
    this.runtimeDependencies.translationWorkerBridge?.setWorkerTimeoutMs?.(translationTimeout);
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  OCR_PROVIDER_MODELS,
  SECRET_PROVIDER_KEYS,
  SettingsService,
  TRANSLATION_PROVIDER_MODELS,
};
