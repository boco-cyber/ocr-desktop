const fs = require('fs');
const path = require('path');

const fse = require('fs-extra');
const fetch = require('node-fetch');

const anthropicProvider = require('../../../providers/anthropic');
const openaiProvider = require('../../../providers/openai');
const geminiProvider = require('../../../providers/gemini');
const ollamaProvider = require('../../../providers/ollama');
const paddleocrProvider = require('../../../providers/paddleocr');
const tesseractProvider = require('../../../providers/tesseract');
const { buildDocx } = require('../../../output/docx');
const { ACTIVE_RUN_STATES } = require('./stateModel');
const { isRTLLanguage } = require('./ocrHelpers');

const PROVIDERS = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  gemini: geminiProvider,
  ollama: ollamaProvider,
  paddleocr: paddleocrProvider,
  tesseract: tesseractProvider,
};

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

const VISION_MODEL_PATTERN = /llava|moondream|bakllava|vision|minicpm|qwen.*vl|phi.*vision|cogvlm/i;
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';

function buildDetectPrompt() {
  return 'Look at this image and identify the primary language of the text. Reply with ONLY a JSON object in this exact format: {"language":"English","rtl":false}. Set rtl to true for Arabic, Hebrew, Persian, Urdu, etc. Use the full English language name.';
}

function estimateImageTokensFromBytes(byteLength) {
  return Math.ceil(byteLength / 400);
}

class OCRProjectService {
  constructor({ store, logger, eventBus, settingsService }) {
    this.store = store;
    this.logger = logger;
    this.eventBus = eventBus;
    this.settingsService = settingsService;
  }

  emitProjectUpdate(projectId, state) {
    if (!this.eventBus) return;
    const project = state.projects[projectId];
    const run = project?.latestRunId ? state.runs[project.latestRunId] : null;
    if (!project) return;
    this.eventBus.emit('ocr:state-updated', {
      projectId,
      runId: run?.id || null,
      snapshot: this.store.buildProjectSnapshot(project, run),
    });
  }

  async listProjects() {
    const state = await this.store.loadState();
    return this.store.listProjectSummaries(state);
  }

  async getProject(projectId) {
    const state = await this.store.loadState();
    const project = state.projects[projectId];
    if (!project) throw new Error('Project not found.');
    const run = project.latestRunId ? state.runs[project.latestRunId] : null;
    return this.store.buildProjectSnapshot(project, run);
  }

  async markProjectOpened(projectId) {
    return this.store.withState(async state => {
      const project = state.projects[projectId];
      if (!project) throw new Error('Project not found.');
      project.lastOpenedAt = new Date().toISOString();
      project.updatedAt = new Date().toISOString();
      return {
        id: project.id,
        lastOpenedAt: project.lastOpenedAt,
      };
    });
  }

  async deleteProject(projectId) {
    const projectDir = await this.store.withState(async state => {
      const project = state.projects[projectId];
      if (!project) throw new Error('Project not found.');

      const latestRun = project.latestRunId ? state.runs[project.latestRunId] : null;
      if (latestRun && ACTIVE_RUN_STATES.has(latestRun.state)) {
        throw new Error('Stop the active OCR run before deleting this project.');
      }

      for (const runId of project.runIds || []) {
        delete state.runs[runId];
      }

      delete state.projects[projectId];
      return project.projectDir;
    });

    if (projectDir) {
      await fse.remove(projectDir);
    }

    this.logger.info('project.deleted', { projectId });
    return { ok: true };
  }

  async updatePageText(projectId, pageNumber, text) {
    const snapshot = await this.store.withState(async state => {
      const project = state.projects[projectId];
      if (!project) throw new Error('Project not found.');

      const page = Object.values(project.pages).find(item => item.pageNumber === pageNumber);
      if (!page) throw new Error('Page not found.');

      page.latestText = text || '';
      page.updatedAt = new Date().toISOString();

      if (project.latestRunId && state.runs[project.latestRunId]?.pageStates?.[page.id]) {
        state.runs[project.latestRunId].pageStates[page.id].resultText = text || '';
        state.runs[project.latestRunId].updatedAt = new Date().toISOString();
      }

      project.updatedAt = new Date().toISOString();
      const run = project.latestRunId ? state.runs[project.latestRunId] : null;
      const built = this.store.buildProjectSnapshot(project, run);
      this.emitProjectUpdate(projectId, state);
      return built;
    });

    return snapshot;
  }

  async listOllamaModels(baseUrl = '') {
    const settings = this.settingsService ? await this.settingsService.getSettingsForRuntime() : null;
    const resolvedBaseUrl = baseUrl || settings?.runtimes?.ollamaBaseUrl || 'http://localhost:11434';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(`${resolvedBaseUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const models = (data.models || []).map(model => ({
        name: model.name,
        size: model.size,
        isVision: VISION_MODEL_PATTERN.test(model.name),
      }));
      return { models };
    } catch (error) {
      clearTimeout(timer);
      return {
        models: [],
        error: `Ollama not running or not accessible at ${resolvedBaseUrl}`,
      };
    }
  }

  async detectLanguage({ projectId, provider, model, apiKey, ollamaBaseUrl }) {
    const settings = this.settingsService ? await this.settingsService.getSettingsForRuntime() : null;
    const state = await this.store.loadState();
    const project = state.projects[projectId];
    if (!project) throw new Error('Project not found.');

    const providerModule = PROVIDERS[provider];
    if (!providerModule) throw new Error('Unknown provider.');

    const firstPageId = project.pageIds[0];
    const firstPage = firstPageId ? project.pages[firstPageId] : null;
    if (!firstPage?.preparedImagePath || !fs.existsSync(firstPage.preparedImagePath)) {
      throw new Error('No prepared page image is available for language detection.');
    }

    const imageBase64 = await fse.readFile(firstPage.preparedImagePath, 'base64');
    const raw = await providerModule.ocr({
      apiKey: apiKey || (this.settingsService ? await this.settingsService.getSecret(provider) : ''),
      model: model || '',
      imageBase64,
      prompt: buildDetectPrompt(),
      baseUrl: ollamaBaseUrl || settings?.runtimes?.ollamaBaseUrl || '',
      runtimeConfig: this.settingsService ? this.settingsService.getRuntimeConfig(settings) : {},
    });

    let language = null;
    let rtl = false;

    try {
      const match = raw.match(/\{[^}]+\}/);
      const parsed = JSON.parse(match ? match[0] : raw);
      language = parsed.language || null;
      rtl = Boolean(parsed.rtl) || isRTLLanguage(parsed.language || '');
    } catch {
      language = raw.trim().split(/[\s,{}"]/)[0] || null;
      rtl = isRTLLanguage(language);
    }

    const resolvedLanguage = language ? {
      displayName: language,
      ocrValue: language,
      rtl,
      source: 'ai-detect',
      resolvedAt: new Date().toISOString(),
    } : null;

    await this.store.withState(async mutableState => {
      const mutableProject = mutableState.projects[projectId];
      if (!mutableProject || !resolvedLanguage) return;
      mutableProject.detectedLanguage = resolvedLanguage;
      mutableProject.updatedAt = new Date().toISOString();
      this.emitProjectUpdate(projectId, mutableState);
    });

    this.logger.info('project.language_detected', { projectId, provider, language, rtl });
    return { language, rtl };
  }

  async estimateProject({ projectId, provider, model }) {
    const state = await this.store.loadState();
    const project = state.projects[projectId];
    if (!project) throw new Error('Project not found.');

    if (provider === 'ollama' || provider === 'paddleocr' || provider === 'tesseract') {
      const label = provider === 'ollama' ? 'Free (local - Ollama)'
        : provider === 'paddleocr' ? 'Free (local - PaddleOCR)'
        : 'Free (local - Tesseract)';
      return { provider, model, free: true, label };
    }

    const pricing = lookupOcrPricing(provider, model);
    if (!pricing) {
      return {
        provider,
        model,
        free: false,
        label: `Pricing unavailable for ${model}`,
      };
    }

    const sizes = await Promise.all(project.pageIds.map(async pageId => {
      const filePath = project.pages[pageId].preparedImagePath || project.pages[pageId].originalImagePath;
      const stats = await fse.stat(filePath);
      return stats.size;
    }));

    const promptTokens = 100;
    const outputPerPage = 800;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const size of sizes) {
      totalInputTokens += estimateImageTokensFromBytes(size) + promptTokens;
      totalOutputTokens += outputPerPage;
    }

    const inputCost = (totalInputTokens / 1_000_000) * pricing.input;
    const outputCost = (totalOutputTokens / 1_000_000) * pricing.output;
    const totalCost = inputCost + outputCost;
    const formatCurrency = value => value < 0.01 ? '< $0.01' : `$${value.toFixed(3)}`;

    return {
      provider,
      model,
      free: false,
      pageCount: project.pageIds.length,
      totalInputTokens,
      totalOutputTokens,
      inputCost: inputCost.toFixed(4),
      outputCost: outputCost.toFixed(4),
      totalCost: totalCost.toFixed(4),
      label: formatCurrency(totalCost),
      breakdown: `~${totalInputTokens.toLocaleString()} input + ~${totalOutputTokens.toLocaleString()} output tokens`,
    };
  }

  async testProvider({ provider, model, apiKey, baseUrl }) {
    const settings = this.settingsService ? await this.settingsService.getSettingsForRuntime() : null;
    const providerModule = PROVIDERS[provider];
    if (!providerModule) {
      throw new Error('Unknown provider');
    }

    const resolvedApiKey = apiKey || (this.settingsService ? await this.settingsService.getSecret(provider) : '');
    await providerModule.ocr({
      apiKey: resolvedApiKey,
      model: model || '',
      imageBase64: TINY_PNG,
      prompt: 'Reply with the single word: ok',
      baseUrl: baseUrl || settings?.runtimes?.ollamaBaseUrl || '',
      runtimeConfig: this.settingsService ? this.settingsService.getRuntimeConfig(settings) : {},
    });

    return { ok: true };
  }

  async listProviderModels({ provider, apiKey }) {
    const providerModule = PROVIDERS[provider];
    if (!providerModule?.listModels) {
      return { ok: false, error: `Model listing is not supported for provider: ${provider}` };
    }
    const resolvedApiKey = apiKey || (this.settingsService ? await this.settingsService.getSecret(provider) : '');
    try {
      const models = await providerModule.listModels({ apiKey: resolvedApiKey });
      return { ok: true, models };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async buildExport(projectId, format) {
    const snapshot = await this.getProject(projectId);
    const baseName = path.basename(snapshot.sourceFileName, path.extname(snapshot.sourceFileName));
    const pages = snapshot.pages.map(page => ({
      index: page.index,
      text: page.latestText || '',
    }));

    if (format === 'txt') {
      const text = pages.map((page, index) =>
        snapshot.pageCount > 1 ? `=== Page ${index + 1} ===\n${page.text || ''}` : (page.text || '')
      ).join('\n\n');

      return {
        defaultFileName: `${baseName}_ocr.txt`,
        contentType: 'text/plain; charset=utf-8',
        data: Buffer.from(text, 'utf8'),
      };
    }

    if (format === 'docx') {
      const data = await buildDocx(snapshot.sourceFileName, pages, {
        rtl: Boolean(snapshot.latestRun?.resolvedLanguage?.rtl || snapshot.detectedLanguage?.rtl),
      });
      return {
        defaultFileName: `${baseName}_ocr.docx`,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        data,
      };
    }

    throw new Error(`Unsupported export format: ${format}`);
  }
}

module.exports = { OCRProjectService };
