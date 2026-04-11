const path = require('path');
const { v4: uuidv4 } = require('uuid');

const {
  WorkerProcessState,
  OCRRunState,
  PageOCRState,
  ACTIVE_RUN_STATES,
} = require('./stateModel');
const { buildOCRPrompt } = require('./ocrHelpers');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class OCRRunManager {
  constructor({ store, workerBridge, eventBus, logger, settingsService }) {
    this.store = store;
    this.workerBridge = workerBridge;
    this.eventBus = eventBus;
    this.logger = logger;
    this.settingsService = settingsService;
    this.activeRuns = new Map();
  }

  launchRunLoop(projectId, runId, command) {
    setImmediate(() => {
      this.runLoop(projectId, runId, command).catch(async error => {
        this.logger.error('ocr.run.loop_crashed', {
          projectId,
          runId,
          error: error.message,
        });

        await this.store.withState(async state => {
          const project = state.projects[projectId];
          const run = state.runs[runId];
          if (!project || !run) return;
          run.state = OCRRunState.Failed;
          run.workerState = WorkerProcessState.Error;
          run.lastError = error.message;
          run.completedAt = new Date().toISOString();
          run.updatedAt = new Date().toISOString();
          run.progress = this.calculateProgress(run);
          project.updatedAt = new Date().toISOString();
        });

        await this.publishProjectState(projectId);
      });
    });
  }

  async publishProjectState(projectId) {
    const state = await this.store.loadState();
    const project = state.projects[projectId];
    if (!project) return null;
    const run = project.latestRunId ? state.runs[project.latestRunId] : null;
    const snapshot = this.store.buildProjectSnapshot(project, run);
    this.eventBus.emit('ocr:state-updated', {
      projectId,
      runId: run?.id || null,
      snapshot,
    });
    return snapshot;
  }

  getSelectedPageIds(project, pageFrom, pageTo) {
    const from = Number.isInteger(pageFrom) ? pageFrom : 0;
    const to = Number.isInteger(pageTo) ? pageTo : project.pageIds.length - 1;
    return project.pageIds.filter(pageId => {
      const index = project.pages[pageId].index;
      return index >= from && index <= to;
    });
  }

  resolveLanguage(project, command) {
    if (command.language) {
      return {
        languageMode: 'manual',
        resolvedLanguage: {
          displayName: command.language,
          ocrValue: command.language,
          rtl: false,
          source: 'manual',
          resolvedAt: new Date().toISOString(),
        },
      };
    }

    if (project.detectedLanguage?.displayName || project.detectedLanguage?.ocrValue) {
      return {
        languageMode: 'auto',
        resolvedLanguage: project.detectedLanguage,
      };
    }

    throw new Error('OCR language is unresolved. Detect or set the document language before starting OCR.');
  }

  calculateProgress(run) {
    const selectedStates = run.selectedPageIds.map(pageId => run.pageStates[pageId].state);
    const total = selectedStates.length;
    const completed = selectedStates.filter(state => state === PageOCRState.Completed).length;
    const failed = selectedStates.filter(state => state === PageOCRState.Failed).length;
    const processing = selectedStates.filter(state => state === PageOCRState.Processing).length;
    const queued = selectedStates.filter(state => state === PageOCRState.Queued).length;
    const skipped = selectedStates.filter(state => state === PageOCRState.Skipped).length;
    const cancelled = selectedStates.filter(state => state === PageOCRState.Cancelled).length;
    const remaining = total - completed - failed - processing - queued - skipped - cancelled;
    return {
      total,
      completed,
      failed,
      processing,
      queued,
      skipped,
      cancelled,
      remaining: Math.max(0, remaining),
      currentPageNumber: null,
      etaSeconds: null,
      avgMsPerPage: null,
    };
  }

  buildRun(project, command, { retryOfRunId = null, selectedPageIds }) {
    const { languageMode, resolvedLanguage } = this.resolveLanguage(project, command);
    const now = new Date().toISOString();
    const runId = uuidv4();
    const pageStates = {};

    for (const pageId of project.pageIds) {
      const page = project.pages[pageId];
      pageStates[pageId] = {
        pageId,
        pageNumber: page.pageNumber,
        state: selectedPageIds.includes(pageId) ? PageOCRState.Prepared : PageOCRState.Skipped,
        attempts: 0,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        resultText: selectedPageIds.includes(pageId) ? '' : (page.latestText || ''),
        error: null,
        diagnostics: null,
        preparedImagePath: page.preparedImagePath,
      };
    }

    const run = {
      id: runId,
      projectId: project.id,
      state: OCRRunState.Created,
      workerState: WorkerProcessState.Stopped,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      pausedAt: null,
      stoppedAt: null,
      retryOfRunId,
      lastError: null,
      interruptionReason: null,
      languageMode,
      resolvedLanguage,
      options: {
        provider: command.provider,
        model: command.model || '',
        ocrMode: command.ocrMode || 'standard',
        customPrompt: command.customPrompt || '',
        ollamaBaseUrl: command.ollamaBaseUrl || '',
        concurrency: Math.max(1, parseInt(command.concurrency) || 1),
        pageFrom: command.pageFrom,
        pageTo: command.pageTo,
      },
      selectedPageIds,
      progress: {
        total: selectedPageIds.length,
        queued: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        skipped: project.pageIds.length - selectedPageIds.length,
        cancelled: 0,
        remaining: selectedPageIds.length,
        currentPageNumber: null,
        etaSeconds: null,
        avgMsPerPage: null,
      },
      pageStates,
    };

    return run;
  }

  async validateWorkerAvailability() {
    const health = await this.workerBridge.healthCheck();
    if (!health.ok) {
      throw new Error(health.error || 'OCR worker is unavailable.');
    }
  }

  async validateProviderAvailability(provider, runtimeConfig = {}) {
    // tesseract is always available — no pre-flight check needed
    // paddleocr requires Python; let the worker fail with a clear error if Python is missing
  }

  async startRun(projectId, command) {
    await this.validateWorkerAvailability();
    const settings = this.settingsService ? await this.settingsService.getSettingsForRuntime() : null;
    const runtimeConfig = this.settingsService ? this.settingsService.getRuntimeConfig(settings) : {};
    await this.validateProviderAvailability(command.provider, runtimeConfig);

    const result = await this.store.withState(async state => {
      const project = state.projects[projectId];
      if (!project) throw new Error('Project not found.');
      if (project.importState !== 'Ready') {
        throw new Error(project.importError || 'Project is not ready for OCR.');
      }

      const latestRun = project.latestRunId ? state.runs[project.latestRunId] : null;
      if (latestRun && ACTIVE_RUN_STATES.has(latestRun.state)) {
        throw new Error('An OCR run is already active for this project.');
      }

      const pageFrom = Number.isInteger(command.pageFrom) ? command.pageFrom : 0;
      const pageTo = Number.isInteger(command.pageTo) ? command.pageTo : project.pageIds.length - 1;
      const selectedPageIds = this.getSelectedPageIds(project, pageFrom, pageTo);
      if (!selectedPageIds.length) {
        throw new Error('No pages selected for OCR.');
      }

      const run = this.buildRun(project, { ...command, pageFrom, pageTo }, { selectedPageIds });
      run.state = OCRRunState.Ready;
      run.workerState = WorkerProcessState.Idle;
      run.updatedAt = new Date().toISOString();

      state.runs[run.id] = run;
      project.latestRunId = run.id;
      project.runIds.push(run.id);
      project.updatedAt = new Date().toISOString();

      return { project: this.store.clone(project), run: this.store.clone(run) };
    });

    this.logger.info('ocr.run.created', {
      projectId,
      runId: result.run.id,
      pageFrom: result.run.options.pageFrom,
      pageTo: result.run.options.pageTo,
    });

    const snapshot = await this.publishProjectState(projectId);
    this.launchRunLoop(projectId, result.run.id, command);
    return snapshot;
  }

  async resumeRun(projectId, runId, command = {}) {
    await this.validateWorkerAvailability();

    await this.store.withState(async state => {
      const run = state.runs[runId];
      const project = state.projects[projectId];
      if (!run || !project || run.projectId !== projectId) throw new Error('Run not found.');

      const settings = this.settingsService ? await this.settingsService.getSettingsForRuntime() : null;
      const runtimeConfig = this.settingsService ? this.settingsService.getRuntimeConfig(settings) : {};
      await this.validateProviderAvailability(run.options?.provider, runtimeConfig);

      if (![OCRRunState.Paused, OCRRunState.Interrupted, OCRRunState.Stopped].includes(run.state)) {
        throw new Error('Only paused, interrupted, or stopped runs can be resumed.');
      }

      run.state = OCRRunState.Ready;
      run.workerState = WorkerProcessState.Idle;
      run.lastError = null;
      run.interruptionReason = null;
      run.pausedAt = null;
      run.stoppedAt = null;
      run.updatedAt = new Date().toISOString();

      if (command.language) {
        run.languageMode = 'manual';
        run.resolvedLanguage = {
          displayName: command.language,
          ocrValue: command.language,
          rtl: false,
          source: 'manual',
          resolvedAt: new Date().toISOString(),
        };
      }

      run.options = {
        ...run.options,
        provider: command.provider || run.options.provider,
        model: command.model ?? run.options.model,
        ocrMode: command.ocrMode || run.options.ocrMode,
        customPrompt: command.customPrompt ?? run.options.customPrompt,
        ollamaBaseUrl: command.ollamaBaseUrl ?? run.options.ollamaBaseUrl,
        concurrency: Math.max(1, parseInt(command.concurrency) || run.options.concurrency || 1),
      };

      for (const pageId of run.selectedPageIds) {
        const pageState = run.pageStates[pageId];
        if ([PageOCRState.Cancelled, PageOCRState.Queued, PageOCRState.Processing].includes(pageState.state)) {
          pageState.state = PageOCRState.Prepared;
          pageState.startedAt = null;
          pageState.completedAt = null;
          pageState.durationMs = null;
        }
      }

      run.progress = this.calculateProgress(run);
      project.latestRunId = run.id;
      project.updatedAt = new Date().toISOString();
    });

    this.logger.info('ocr.run.resume_requested', { projectId, runId });
    const snapshot = await this.publishProjectState(projectId);
    this.launchRunLoop(projectId, runId, command);
    return snapshot;
  }

  async pauseRun(projectId, runId) {
    const controller = this.activeRuns.get(runId);
    if (!controller) throw new Error('The selected OCR run is not currently active.');

    controller.pauseRequested = true;
    await this.store.withState(async state => {
      const run = state.runs[runId];
      if (!run) return;
      if (run.state === OCRRunState.Running) {
        run.state = OCRRunState.Pausing;
        run.updatedAt = new Date().toISOString();
      }
    });

    this.logger.info('ocr.run.pause_requested', { projectId, runId });
    return this.publishProjectState(projectId);
  }

  async stopRun(projectId, runId) {
    const controller = this.activeRuns.get(runId);

    await this.store.withState(async state => {
      const run = state.runs[runId];
      if (!run) throw new Error('Run not found.');
      if (![OCRRunState.Running, OCRRunState.Pausing, OCRRunState.Paused, OCRRunState.Ready].includes(run.state)) {
        throw new Error('This OCR run cannot be stopped in its current state.');
      }
      run.state = controller ? OCRRunState.Stopping : OCRRunState.Stopped;
      run.workerState = controller ? WorkerProcessState.Busy : WorkerProcessState.Stopped;
      run.stoppedAt = controller ? null : new Date().toISOString();
      run.updatedAt = new Date().toISOString();

      if (!controller) {
        for (const pageId of run.selectedPageIds) {
          const pageState = run.pageStates[pageId];
          if (![PageOCRState.Completed, PageOCRState.Failed].includes(pageState.state)) {
            pageState.state = PageOCRState.Cancelled;
          }
        }
        run.progress = this.calculateProgress(run);
      }
    });

    if (controller) {
      controller.stopRequested = true;
    }

    this.logger.info('ocr.run.stop_requested', { projectId, runId });
    return this.publishProjectState(projectId);
  }

  async retryFailedPages(projectId, runId, command = {}) {
    const snapshot = await this.getProject(projectId);
    const latestRun = snapshot.latestRun;
    if (!latestRun || latestRun.id !== runId) {
      throw new Error('Retry currently works on the latest OCR run for a project.');
    }

    const failedPageNumbers = latestRun.pageStates
      .filter(page => page.state === PageOCRState.Failed)
      .map(page => page.pageNumber);

    if (!failedPageNumbers.length) {
      throw new Error('There are no failed pages to retry.');
    }

    return this.retryPageRange(projectId, runId, {
      ...command,
      pageFrom: Math.min(...failedPageNumbers) - 1,
      pageTo: Math.max(...failedPageNumbers) - 1,
      failedOnly: true,
    });
  }

  async retryPageRange(projectId, runId, command = {}) {
    await this.validateWorkerAvailability();

    const result = await this.store.withState(async state => {
      const project = state.projects[projectId];
      const sourceRun = state.runs[runId];
      if (!project || !sourceRun) throw new Error('Project or run not found.');

      const latestRun = project.latestRunId ? state.runs[project.latestRunId] : null;
      if (latestRun && ACTIVE_RUN_STATES.has(latestRun.state)) {
        throw new Error('Cannot retry while another OCR run is active.');
      }

      const pageFrom = Number.isInteger(command.pageFrom) ? command.pageFrom : sourceRun.options.pageFrom;
      const pageTo = Number.isInteger(command.pageTo) ? command.pageTo : sourceRun.options.pageTo;
      let selectedPageIds = this.getSelectedPageIds(project, pageFrom, pageTo);
      if (command.failedOnly) {
        selectedPageIds = selectedPageIds.filter(pageId => sourceRun.pageStates[pageId]?.state === PageOCRState.Failed);
      }

      if (!selectedPageIds.length) {
        throw new Error(command.failedOnly ? 'No failed pages in the selected range.' : 'No pages selected for retry.');
      }

      const run = this.buildRun(project, {
        provider: command.provider || sourceRun.options.provider,
        model: command.model ?? sourceRun.options.model,
        language: command.language || (sourceRun.resolvedLanguage?.ocrValue || sourceRun.resolvedLanguage?.displayName || ''),
        ocrMode: command.ocrMode || sourceRun.options.ocrMode,
        customPrompt: command.customPrompt ?? sourceRun.options.customPrompt,
        ollamaBaseUrl: command.ollamaBaseUrl ?? sourceRun.options.ollamaBaseUrl,
        concurrency: command.concurrency || sourceRun.options.concurrency,
        pageFrom,
        pageTo,
      }, {
        retryOfRunId: sourceRun.id,
        selectedPageIds,
      });

      run.state = OCRRunState.Ready;
      run.workerState = WorkerProcessState.Idle;
      run.updatedAt = new Date().toISOString();

      state.runs[run.id] = run;
      project.latestRunId = run.id;
      project.runIds.push(run.id);
      project.updatedAt = new Date().toISOString();

      return { run: this.store.clone(run) };
    });

    this.logger.info('ocr.run.retry_created', {
      projectId,
      sourceRunId: runId,
      retryRunId: result.run.id,
      pageFrom: result.run.options.pageFrom,
      pageTo: result.run.options.pageTo,
    });

    const snapshot = await this.publishProjectState(projectId);
    this.launchRunLoop(projectId, result.run.id, command);
    return snapshot;
  }

  async getProject(projectId) {
    const state = await this.store.loadState();
    const project = state.projects[projectId];
    if (!project) throw new Error('Project not found.');
    const run = project.latestRunId ? state.runs[project.latestRunId] : null;
    return this.store.buildProjectSnapshot(project, run);
  }

  async listProjects() {
    const state = await this.store.loadState();
    return this.store.listProjectSummaries(state);
  }

  async runLoop(projectId, runId, command = {}) {
    if (this.activeRuns.has(runId)) return;

    const controller = {
      runId,
      projectId,
      pauseRequested: false,
      stopRequested: false,
    };
    this.activeRuns.set(runId, controller);

    try {
      await this.store.withState(async state => {
        const run = state.runs[runId];
        if (!run) throw new Error('Run not found.');
        run.state = OCRRunState.Running;
        run.workerState = WorkerProcessState.Starting;
        run.startedAt = run.startedAt || new Date().toISOString();
        run.updatedAt = new Date().toISOString();
      });
      await this.publishProjectState(projectId);

      while (true) {
        const state = await this.store.loadState();
        const project = state.projects[projectId];
        const run = state.runs[runId];
        if (!project || !run) break;

        const nextPageIds = run.selectedPageIds.filter(pageId =>
          [PageOCRState.Prepared, PageOCRState.Pending].includes(run.pageStates[pageId].state)
        );

        if (!nextPageIds.length) {
          await this.finalizeRun(projectId, runId);
          break;
        }

        if (controller.stopRequested) {
          await this.markRemainingPages(projectId, runId, PageOCRState.Cancelled);
          await this.finalizeRun(projectId, runId, { stopped: true });
          break;
        }

        if (controller.pauseRequested) {
          await this.store.withState(async stateToPause => {
            const runToPause = stateToPause.runs[runId];
            if (!runToPause) return;
            runToPause.state = OCRRunState.Paused;
            runToPause.workerState = WorkerProcessState.Paused;
            runToPause.pausedAt = new Date().toISOString();
            runToPause.updatedAt = new Date().toISOString();
          });
          await this.publishProjectState(projectId);
          break;
        }

        const batchSize = Math.max(1, parseInt(command.concurrency) || run.options.concurrency || 1);
        const chunk = nextPageIds.slice(0, batchSize);

        await this.store.withState(async nextState => {
          const runToQueue = nextState.runs[runId];
          if (!runToQueue) return;
          runToQueue.workerState = WorkerProcessState.Busy;
          for (const pageId of chunk) {
            if (runToQueue.pageStates[pageId].state === PageOCRState.Prepared || runToQueue.pageStates[pageId].state === PageOCRState.Pending) {
              runToQueue.pageStates[pageId].state = PageOCRState.Queued;
            }
          }
          runToQueue.progress = this.calculateProgress(runToQueue);
          runToQueue.updatedAt = new Date().toISOString();
        });
        await this.publishProjectState(projectId);

        await Promise.all(chunk.map(pageId => this.processPage(projectId, runId, pageId, command)));

        await sleep(10);
      }
    } finally {
      this.activeRuns.delete(runId);
    }
  }

  async processPage(projectId, runId, pageId, command) {
    let payload;
    const settings = this.settingsService ? await this.settingsService.getSettingsForRuntime() : null;
    const runtimeConfig = this.settingsService ? this.settingsService.getRuntimeConfig(settings) : {};

    await this.store.withState(async state => {
      const project = state.projects[projectId];
      const run = state.runs[runId];
      if (!project || !run) throw new Error('Project or run not found.');
      const pageState = run.pageStates[pageId];
      const page = project.pages[pageId];
      const providerKey = run.options.provider || command.provider || '';
      const resolvedApiKey = command.apiKey || (this.settingsService ? await this.settingsService.getSecret(providerKey) : '');

      pageState.state = PageOCRState.Processing;
      pageState.startedAt = new Date().toISOString();
      pageState.attempts += 1;
      pageState.error = null;
      pageState.diagnostics = null;
      run.progress = this.calculateProgress(run);
      run.progress.currentPageNumber = page.pageNumber;
      run.updatedAt = new Date().toISOString();
      project.updatedAt = new Date().toISOString();

      const languageValue = run.resolvedLanguage?.ocrValue || run.resolvedLanguage?.displayName || '';

      payload = {
        jobId: runId,
        runId,
        projectId,
        pageId,
        provider: run.options.provider,
        model: run.options.model,
        apiKey: resolvedApiKey || '',
        ollamaBaseUrl: run.options.ollamaBaseUrl || settings?.runtimes?.ollamaBaseUrl || '',
        language: languageValue,
        preparedImagePath: page.preparedImagePath,
        runtimeConfig,
        prompt: buildOCRPrompt(
          run.resolvedLanguage?.displayName || '',
          run.options.customPrompt,
          page.index,
          project.pageIds.length,
          run.options.ocrMode
        ),
      };
    });

    await this.publishProjectState(projectId);
    this.logger.info('ocr.page.dispatched', { projectId, runId, pageId });

    const startedAt = Date.now();
    try {
      const result = await this.workerBridge.runPage(payload);
      const durationMs = Date.now() - startedAt;

      await this.store.withState(async state => {
        const project = state.projects[projectId];
        const run = state.runs[runId];
        if (!project || !run) return;
        const pageState = run.pageStates[pageId];
        const page = project.pages[pageId];

        pageState.state = PageOCRState.Completed;
        pageState.resultText = result.text || '';
        pageState.completedAt = new Date().toISOString();
        pageState.durationMs = durationMs;
        pageState.error = null;
        pageState.diagnostics = null;

        page.latestText = result.text || '';
        page.latestRunId = runId;
        page.latestOcrState = PageOCRState.Completed;
        page.lastError = null;
        page.updatedAt = new Date().toISOString();

        run.workerState = WorkerProcessState.Idle;
        run.progress = this.calculateProgress(run);
        run.updatedAt = new Date().toISOString();
        project.updatedAt = new Date().toISOString();
      });

      this.logger.info('ocr.page.completed', { projectId, runId, pageId, durationMs });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      await this.store.withState(async state => {
        const project = state.projects[projectId];
        const run = state.runs[runId];
        if (!project || !run) return;
        const pageState = run.pageStates[pageId];
        const page = project.pages[pageId];

        pageState.state = PageOCRState.Failed;
        pageState.error = error.message;
        pageState.completedAt = new Date().toISOString();
        pageState.durationMs = durationMs;
        pageState.diagnostics = {
          stage: 'ocr',
          summary: error.message,
          worker: run.workerState,
        };

        page.latestRunId = runId;
        page.latestOcrState = PageOCRState.Failed;
        page.lastError = error.message;
        page.updatedAt = new Date().toISOString();

        run.workerState = WorkerProcessState.Error;
        run.lastError = error.message;
        run.progress = this.calculateProgress(run);
        run.updatedAt = new Date().toISOString();
        project.updatedAt = new Date().toISOString();
      });

      this.logger.error('ocr.page.failed', { projectId, runId, pageId, error: error.message });
    } finally {
      await this.publishProjectState(projectId);
    }
  }

  async markRemainingPages(projectId, runId, stateValue) {
    await this.store.withState(async state => {
      const run = state.runs[runId];
      const project = state.projects[projectId];
      if (!run || !project) return;
      for (const pageId of run.selectedPageIds) {
        const pageState = run.pageStates[pageId];
        if (![PageOCRState.Completed, PageOCRState.Failed].includes(pageState.state)) {
          pageState.state = stateValue;
          project.pages[pageId].latestOcrState = stateValue;
        }
      }
      run.progress = this.calculateProgress(run);
      run.updatedAt = new Date().toISOString();
      project.updatedAt = new Date().toISOString();
    });
    await this.publishProjectState(projectId);
  }

  async finalizeRun(projectId, runId, { stopped = false } = {}) {
    await this.store.withState(async state => {
      const run = state.runs[runId];
      const project = state.projects[projectId];
      if (!run || !project) return;

      const progress = this.calculateProgress(run);
      run.progress = progress;
      run.workerState = WorkerProcessState.Stopped;
      run.completedAt = new Date().toISOString();
      run.updatedAt = new Date().toISOString();

      if (stopped) {
        run.state = OCRRunState.Stopped;
        run.stoppedAt = new Date().toISOString();
      } else if (progress.failed > 0 && progress.completed > 0) {
        run.state = OCRRunState.CompletedWithFailures;
      } else if (progress.failed > 0 && progress.completed === 0) {
        run.state = OCRRunState.Failed;
      } else {
        run.state = OCRRunState.Completed;
      }

      project.updatedAt = new Date().toISOString();
    });
    this.logger.info('ocr.run.finalized', { projectId, runId, stopped });
    await this.publishProjectState(projectId);
  }

  async reconcileInterruptedRuns() {
    await this.store.withState(async state => {
      for (const run of Object.values(state.runs)) {
        if (![OCRRunState.Running, OCRRunState.Pausing, OCRRunState.Stopping].includes(run.state)) {
          continue;
        }

        const project = state.projects[run.projectId];
        if (!project) continue;

        run.state = OCRRunState.Interrupted;
        run.workerState = WorkerProcessState.Stopped;
        run.interruptionReason = 'App restarted before OCR run could finish.';
        run.updatedAt = new Date().toISOString();

        for (const pageId of run.selectedPageIds) {
          const pageState = run.pageStates[pageId];
          if ([PageOCRState.Queued, PageOCRState.Processing, PageOCRState.Cancelled].includes(pageState.state)) {
            pageState.state = PageOCRState.Prepared;
            pageState.startedAt = null;
            pageState.completedAt = null;
            pageState.durationMs = null;
          }
        }

        run.progress = this.calculateProgress(run);
        project.updatedAt = new Date().toISOString();
        this.logger.warn('ocr.run.reconciled_to_interrupted', {
          projectId: run.projectId,
          runId: run.id,
        });
      }
    });
  }
}

module.exports = { OCRRunManager };
