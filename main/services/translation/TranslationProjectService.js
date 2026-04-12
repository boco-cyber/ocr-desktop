const path = require('path');

const fse = require('fs-extra');
const fetch = require('node-fetch');
const { buildDocx } = require('../../../output/docx');

const { ACTIVE_TRANSLATION_RUN_STATES } = require('./stateModel');
const { healthCheck } = require('./TranslationProviderRouter');

class TranslationProjectService {
  constructor({ store, logger, eventBus, ocrProjectService, editorService, costEstimator, settingsService }) {
    this.store = store;
    this.logger = logger;
    this.eventBus = eventBus;
    this.ocrProjectService = ocrProjectService;
    this.editorService = editorService;
    this.costEstimator = costEstimator;
    this.settingsService = settingsService;
  }

  emitProjectUpdate(projectId, state) {
    const project = state.projects[projectId];
    const run = project?.latestRunId ? state.runs[project.latestRunId] : null;
    if (!project) return;
    this.eventBus.emit('translation:state-updated', {
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
    if (!project) throw new Error('Translation project not found.');
    const run = project.latestRunId ? state.runs[project.latestRunId] : null;
    return this.store.buildProjectSnapshot(project, run);
  }

  async markProjectOpened(projectId) {
    return this.store.withState(async state => {
      const project = state.projects[projectId];
      if (!project) throw new Error('Translation project not found.');
      project.lastOpenedAt = new Date().toISOString();
      project.updatedAt = new Date().toISOString();
      return {
        id: project.id,
        lastOpenedAt: project.lastOpenedAt,
      };
    });
  }

  async updateSettings(projectId, changes = {}) {
    return this.store.withState(async state => {
      const project = state.projects[projectId];
      if (!project) throw new Error('Translation project not found.');
      project.sourceLanguage = changes.sourceLanguage ?? project.sourceLanguage;
      project.targetLanguage = changes.targetLanguage ?? project.targetLanguage;
      project.provider = changes.provider ?? project.provider;
      project.model = changes.model ?? project.model;
      project.chunkSize = changes.chunkSize ?? project.chunkSize;
      project.updatedAt = new Date().toISOString();
      const run = project.latestRunId ? state.runs[project.latestRunId] : null;
      const snapshot = this.store.buildProjectSnapshot(project, run);
      this.emitProjectUpdate(projectId, state);
      return snapshot;
    });
  }

  async updateChunkTranslation(projectId, chunkNumber, text) {
    return this.store.withState(async state => {
      const project = state.projects[projectId];
      if (!project) throw new Error('Translation project not found.');

      const chunk = Object.values(project.chunks).find(item => item.chunkNumber === chunkNumber);
      if (!chunk) throw new Error('Translation chunk not found.');

      chunk.translatedText = text || '';
      chunk.updatedAt = new Date().toISOString();
      if (project.latestRunId && state.runs[project.latestRunId]?.chunkStates?.[chunk.id]) {
        state.runs[project.latestRunId].chunkStates[chunk.id].translatedText = text || '';
        state.runs[project.latestRunId].updatedAt = new Date().toISOString();
      }
      project.updatedAt = new Date().toISOString();
      const run = project.latestRunId ? state.runs[project.latestRunId] : null;
      const snapshot = this.store.buildProjectSnapshot(project, run);
      this.emitProjectUpdate(projectId, state);
      return snapshot;
    });
  }

  async deleteProject(projectId) {
    let editorDocumentId = null;
    const projectDir = await this.store.withState(async state => {
      const project = state.projects[projectId];
      if (!project) throw new Error('Translation project not found.');

      const latestRun = project.latestRunId ? state.runs[project.latestRunId] : null;
      if (latestRun && ACTIVE_TRANSLATION_RUN_STATES.has(latestRun.state)) {
        throw new Error('Stop the active translation run before deleting this project.');
      }

      editorDocumentId = project.latestEditorDocumentId || null;

      for (const runId of project.runIds || []) {
        delete state.runs[runId];
      }

      delete state.projects[projectId];
      return project.projectDir;
    });

    if (projectDir) {
      await fse.remove(projectDir);
    }

    if (editorDocumentId) {
      await this.editorService.deleteDocument(editorDocumentId);
    }

    this.logger.info('translation.project.deleted', { projectId });
    return { ok: true };
  }

  async listImportableOcrProjects() {
    const projects = await this.ocrProjectService.listProjects();
    return projects.filter(project => project.pageCount > 0);
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
      return { models: (data.models || []).map(model => ({ name: model.name, size: model.size })) };
    } catch (error) {
      clearTimeout(timer);
      return { models: [], error: `Ollama not running or not accessible at ${resolvedBaseUrl}` };
    }
  }

  async estimateCost({ projectId, provider, model }) {
    const state = await this.store.loadState();
    const project = state.projects[projectId];
    if (!project) throw new Error('Translation project not found.');
    return this.costEstimator.estimate({ project, provider, model });
  }

  async testProvider(payload) {
    const settings = this.settingsService ? await this.settingsService.getSettingsForRuntime() : null;
    return healthCheck({
      ...payload,
      apiKey: payload.apiKey || (this.settingsService ? await this.settingsService.getSecret(payload.provider || '') : ''),
      baseUrl: payload.baseUrl || settings?.runtimes?.ollamaBaseUrl || '',
      runtimeConfig: this.settingsService ? this.settingsService.getRuntimeConfig(settings) : {},
    });
  }

  async fetchFailureDiagnostics(projectId) {
    const snapshot = await this.getProject(projectId);
    return snapshot.chunks
      .filter(chunk => chunk.lastError || chunk.diagnostics)
      .map(chunk => ({
        chunkNumber: chunk.chunkNumber,
        pageNumber: chunk.pageNumber || null,
        error: chunk.lastError || null,
        diagnostics: chunk.diagnostics || null,
      }));
  }

  async buildExport(projectId, format = 'txt') {
    const snapshot = await this.getProject(projectId);
    const baseName = path.basename(snapshot.sourceFileName, path.extname(snapshot.sourceFileName));
    const assembledText = snapshot.chunks
      .map(chunk => chunk.translatedText || chunk.sourceText || '')
      .join('\n\n')
      .trim();

    if (format === 'txt') {
      return {
        defaultFileName: `${baseName}_translation.txt`,
        contentType: 'text/plain; charset=utf-8',
        data: Buffer.from(assembledText, 'utf8'),
      };
    }

    if (format === 'docx') {
      const pages = snapshot.chunks.map((chunk, i) => ({
        index: i,
        text: chunk.translatedText || chunk.sourceText || '',
      }));
      const data = await buildDocx(snapshot.sourceFileName, pages, {
        rtl: false,
      });
      return {
        defaultFileName: `${baseName}_translation.docx`,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        data,
      };
    }

    if (format === 'json') {
      return {
        defaultFileName: `${baseName}_translation.json`,
        contentType: 'application/json; charset=utf-8',
        data: Buffer.from(JSON.stringify(snapshot, null, 2), 'utf8'),
      };
    }

    throw new Error(`Unsupported translation export format: ${format}`);
  }

  async sendToEditor(projectId) {
    const snapshot = await this.getProject(projectId);
    const document = await this.editorService.createOrUpdateFromTranslation(snapshot);

    await this.store.withState(async state => {
      const project = state.projects[projectId];
      if (!project) return;
      project.latestEditorDocumentId = document.id;
      project.updatedAt = new Date().toISOString();
    });

    this.logger.info('translation.project.sent_to_editor', {
      projectId,
      editorDocumentId: document.id,
    });

    return document;
  }
}

module.exports = { TranslationProjectService };
