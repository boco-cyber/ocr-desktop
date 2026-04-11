const fs = require('fs');
const path = require('path');
const fse = require('fs-extra');

class TranslationPersistenceService {
  constructor({ dataDir, logger, getProjectsRoot }) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.getProjectsRoot = getProjectsRoot;
    this.defaultProjectsRoot = path.join(dataDir, 'translation-projects');
    this.dbPath = path.join(dataDir, 'translation_projects.json');
    this.mutationChain = Promise.resolve();
  }

  async init() {
    await fse.ensureDir(this.dataDir);
    await fse.ensureDir(this.resolveProjectsRoot());
    if (!fs.existsSync(this.dbPath)) {
      await this.saveState({
        version: 1,
        projects: {},
        runs: {},
        meta: {
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
    }
  }

  resolveProjectsRoot() {
    return this.getProjectsRoot?.() || this.defaultProjectsRoot;
  }

  async loadState() {
    await this.init();
    return fse.readJson(this.dbPath);
  }

  async saveState(state) {
    state.meta = state.meta || {};
    state.meta.updatedAt = new Date().toISOString();
    await fse.writeJson(this.dbPath, state, { spaces: 2 });
  }

  async withState(mutator) {
    const runMutation = async () => {
      const state = await this.loadState();
      const result = await mutator(state);
      await this.saveState(state);
      return result;
    };

    const nextMutation = this.mutationChain.then(runMutation, runMutation);
    this.mutationChain = nextMutation.then(() => undefined, () => undefined);
    return nextMutation;
  }

  getProjectDir(projectId) {
    return path.join(this.resolveProjectsRoot(), projectId);
  }

  clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  buildProjectSnapshot(project, run) {
    if (!project) return null;
    const chunks = project.chunkIds.map(chunkId => {
      const chunk = project.chunks[chunkId];
      const runChunk = run?.chunkStates?.[chunkId];
      return {
        id: chunk.id,
        index: chunk.index,
        chunkNumber: chunk.chunkNumber,
        pageNumber: chunk.pageNumber || null,
        sourceLabel: chunk.sourceLabel || null,
        sourceText: chunk.sourceText || '',
        translatedText: chunk.translatedText || '',
        latestRunId: chunk.latestRunId || null,
        latestTranslationState: runChunk?.state || chunk.latestTranslationState || 'Pending',
        lastError: runChunk?.error || chunk.lastError || null,
        diagnostics: runChunk?.diagnostics || chunk.diagnostics || null,
        updatedAt: chunk.updatedAt,
      };
    });

    return {
      id: project.id,
      projectType: 'translation',
      title: project.title,
      sourceKind: project.sourceKind,
      sourceFileName: project.sourceFileName,
      sourceCopyPath: project.sourceCopyPath || null,
      normalizedTextPath: project.normalizedTextPath || null,
      linkedOcrProjectId: project.linkedOcrProjectId || null,
      projectDir: project.projectDir,
      importState: project.importState,
      importError: project.importError || null,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      lastOpenedAt: project.lastOpenedAt || null,
      sourceLanguage: project.sourceLanguage || '',
      targetLanguage: project.targetLanguage || '',
      provider: project.provider || '',
      model: project.model || '',
      chunkSize: project.chunkSize || 1400,
      latestRunId: project.latestRunId || null,
      latestEditorDocumentId: project.latestEditorDocumentId || null,
      sourceStats: this.clone(project.sourceStats || {}),
      chunkCount: project.chunkIds.length,
      chunks,
      latestRun: run ? this.buildRunSnapshot(run, project) : null,
    };
  }

  buildRunSnapshot(run, project) {
    if (!run) return null;
    const chunkStates = project.chunkIds.map(chunkId => {
      const chunk = project.chunks[chunkId];
      const runChunk = run.chunkStates[chunkId];
      return {
        chunkId,
        chunkNumber: chunk.chunkNumber,
        pageNumber: chunk.pageNumber || null,
        sourceLabel: chunk.sourceLabel || null,
        state: runChunk.state,
        attempts: runChunk.attempts,
        translatedText: runChunk.translatedText || '',
        error: runChunk.error || null,
        diagnostics: runChunk.diagnostics || null,
        startedAt: runChunk.startedAt || null,
        completedAt: runChunk.completedAt || null,
        durationMs: runChunk.durationMs || null,
      };
    });

    return {
      id: run.id,
      projectId: run.projectId,
      state: run.state,
      workerState: run.workerState,
      provider: run.provider,
      model: run.model,
      sourceLanguage: run.sourceLanguage || '',
      targetLanguage: run.targetLanguage || '',
      chunkSize: run.chunkSize || 1400,
      segmentationMode: run.segmentationMode || 'paragraph',
      createdAt: run.createdAt,
      startedAt: run.startedAt || null,
      completedAt: run.completedAt || null,
      pausedAt: run.pausedAt || null,
      stoppedAt: run.stoppedAt || null,
      retryOfRunId: run.retryOfRunId || null,
      lastError: run.lastError || null,
      interruptionReason: run.interruptionReason || null,
      costEstimate: this.clone(run.costEstimate || null),
      progress: this.clone(run.progress),
      chunkStates,
    };
  }

  listProjectSummaries(state) {
    return Object.values(state.projects)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      .map(project => {
        const run = project.latestRunId ? state.runs[project.latestRunId] : null;
        return {
          id: project.id,
          projectType: 'translation',
          title: project.title,
          sourceKind: project.sourceKind,
          sourceFileName: project.sourceFileName,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          lastOpenedAt: project.lastOpenedAt || null,
          importState: project.importState,
          chunkCount: project.chunkIds.length,
          latestRunId: project.latestRunId || null,
          latestRunState: run?.state || null,
          latestWorkerState: run?.workerState || null,
          sourceLanguage: project.sourceLanguage || '',
          targetLanguage: project.targetLanguage || '',
          provider: project.provider || '',
          model: project.model || '',
        };
      });
  }
}

module.exports = { TranslationPersistenceService };
