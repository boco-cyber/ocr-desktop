const fs = require('fs');
const path = require('path');
const fse = require('fs-extra');
const { pathToFileURL } = require('url');

class OCRPersistenceService {
  constructor({ dataDir, logger, getProjectsRoot }) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.getProjectsRoot = getProjectsRoot;
    this.defaultProjectsRoot = path.join(dataDir, 'projects');
    this.dbPath = path.join(dataDir, 'ocr_projects.json');
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
          legacyMigration: {
            migratedJobIds: [],
          },
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

  toAssetUrl(filePath) {
    if (!filePath) return null;
    return pathToFileURL(filePath).href;
  }

  clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  buildProjectSnapshot(project, run) {
    if (!project) return null;

    const pages = project.pageIds.map(pageId => {
      const page = project.pages[pageId];
      const runPage = run?.pageStates?.[pageId];
      return {
        id: page.id,
        index: page.index,
        pageNumber: page.pageNumber,
        width: page.width,
        height: page.height,
        originalImageUrl: this.toAssetUrl(page.originalImagePath),
        preparedImageUrl: this.toAssetUrl(page.preparedImagePath),
        thumbnailUrl: this.toAssetUrl(page.thumbnailPath),
        latestText: page.latestText || '',
        latestRunId: page.latestRunId || null,
        latestOcrState: runPage?.state || page.latestOcrState || 'Pending',
        lastError: runPage?.error || page.lastError || null,
        diagnostics: runPage?.diagnostics || null,
      };
    });

    return {
      id: project.id,
      title: project.title,
      sourceFileName: project.sourceFileName,
      sourceCopyPath: project.sourceCopyPath,
      projectDir: project.projectDir,
      importState: project.importState,
      importError: project.importError || null,
      importProgress: this.clone(project.importProgress || {
        done: project.pageIds.length,
        total: project.pageIds.length,
      }),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      lastOpenedAt: project.lastOpenedAt || null,
      pageCount: project.pageIds.length,
      detectedLanguage: project.detectedLanguage || null,
      latestRunId: project.latestRunId || null,
      pages,
      latestRun: run ? this.buildRunSnapshot(run, project) : null,
    };
  }

  buildRunSnapshot(run, project) {
    if (!run) return null;
    const pageStates = project.pageIds.map(pageId => {
      const runPage = run.pageStates[pageId];
      return {
        pageId,
        pageNumber: project.pages[pageId].pageNumber,
        state: runPage.state,
        attempts: runPage.attempts,
        resultText: runPage.resultText || '',
        error: runPage.error || null,
        diagnostics: runPage.diagnostics || null,
        startedAt: runPage.startedAt || null,
        completedAt: runPage.completedAt || null,
        durationMs: runPage.durationMs || null,
      };
    });

    return {
      id: run.id,
      projectId: run.projectId,
      state: run.state,
      workerState: run.workerState,
      createdAt: run.createdAt,
      startedAt: run.startedAt || null,
      completedAt: run.completedAt || null,
      pausedAt: run.pausedAt || null,
      stoppedAt: run.stoppedAt || null,
      retryOfRunId: run.retryOfRunId || null,
      lastError: run.lastError || null,
      interruptionReason: run.interruptionReason || null,
      languageMode: run.languageMode,
      resolvedLanguage: run.resolvedLanguage || null,
      options: this.clone(run.options),
      progress: this.clone(run.progress),
      pageStates,
    };
  }

  listProjectSummaries(state) {
    return Object.values(state.projects)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      .map(project => {
        const run = project.latestRunId ? state.runs[project.latestRunId] : null;
        return {
          id: project.id,
          title: project.title,
          sourceFileName: project.sourceFileName,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          lastOpenedAt: project.lastOpenedAt || null,
          importState: project.importState,
          pageCount: project.pageIds.length,
          latestRunId: project.latestRunId || null,
          latestRunState: run?.state || null,
          latestWorkerState: run?.workerState || null,
          detectedLanguage: project.detectedLanguage || null,
        };
      });
  }
}

module.exports = { OCRPersistenceService };
