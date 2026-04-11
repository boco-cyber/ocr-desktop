const { v4: uuidv4 } = require('uuid');

const {
  TranslationWorkerState,
  TranslationRunState,
  TranslationChunkState,
  ACTIVE_TRANSLATION_RUN_STATES,
} = require('./stateModel');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class TranslationRunManager {
  constructor({ store, workerBridge, eventBus, logger, costEstimator, settingsService }) {
    this.store = store;
    this.workerBridge = workerBridge;
    this.eventBus = eventBus;
    this.logger = logger;
    this.costEstimator = costEstimator;
    this.settingsService = settingsService;
    this.activeRuns = new Map();
  }

  async publishProjectState(projectId) {
    const state = await this.store.loadState();
    const project = state.projects[projectId];
    if (!project) return null;
    const run = project.latestRunId ? state.runs[project.latestRunId] : null;
    const snapshot = this.store.buildProjectSnapshot(project, run);
    this.eventBus.emit('translation:state-updated', {
      projectId,
      runId: run?.id || null,
      snapshot,
    });
    return snapshot;
  }

  getSelectedChunkIds(project, chunkFrom, chunkTo) {
    const from = Number.isInteger(chunkFrom) ? chunkFrom : 0;
    const to = Number.isInteger(chunkTo) ? chunkTo : project.chunkIds.length - 1;
    return project.chunkIds.filter(chunkId => {
      const index = project.chunks[chunkId].index;
      return index >= from && index <= to;
    });
  }

  calculateProgress(run) {
    const selectedStates = run.selectedChunkIds.map(chunkId => run.chunkStates[chunkId].state);
    const total = selectedStates.length;
    const completed = selectedStates.filter(state => state === TranslationChunkState.Completed).length;
    const failed = selectedStates.filter(state => state === TranslationChunkState.Failed).length;
    const processing = selectedStates.filter(state => state === TranslationChunkState.Processing).length;
    const queued = selectedStates.filter(state => state === TranslationChunkState.Queued).length;
    const skipped = selectedStates.filter(state => state === TranslationChunkState.Skipped).length;
    const cancelled = selectedStates.filter(state => state === TranslationChunkState.Cancelled).length;
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
      currentChunkNumber: null,
      etaSeconds: null,
      avgMsPerChunk: null,
    };
  }

  buildRun(project, command, { retryOfRunId = null, selectedChunkIds }) {
    if (!command.targetLanguage) {
      throw new Error('Target language must be selected before starting translation.');
    }

    const now = new Date().toISOString();
    const runId = uuidv4();
    const chunkStates = {};

    for (const chunkId of project.chunkIds) {
      const chunk = project.chunks[chunkId];
      chunkStates[chunkId] = {
        chunkId,
        chunkNumber: chunk.chunkNumber,
        state: selectedChunkIds.includes(chunkId) ? TranslationChunkState.Pending : TranslationChunkState.Skipped,
        attempts: 0,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        translatedText: selectedChunkIds.includes(chunkId) ? '' : (chunk.translatedText || ''),
        error: null,
        diagnostics: null,
      };
    }

    return {
      id: runId,
      projectId: project.id,
      state: TranslationRunState.Created,
      workerState: TranslationWorkerState.Stopped,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      pausedAt: null,
      stoppedAt: null,
      retryOfRunId,
      lastError: null,
      interruptionReason: null,
      provider: command.provider,
      model: command.model || '',
      sourceLanguage: command.sourceLanguage || '',
      targetLanguage: command.targetLanguage,
      chunkSize: command.chunkSize || project.chunkSize || 1400,
      segmentationMode: command.segmentationMode || 'paragraph',
      options: {
        apiKey: command.apiKey ? '__set__' : '',
        baseUrl: command.baseUrl || '',
        chunkFrom: command.chunkFrom,
        chunkTo: command.chunkTo,
      },
      costEstimate: command.costEstimate || null,
      selectedChunkIds,
      progress: {
        total: selectedChunkIds.length,
        queued: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        skipped: project.chunkIds.length - selectedChunkIds.length,
        cancelled: 0,
        remaining: selectedChunkIds.length,
        currentChunkNumber: null,
        etaSeconds: null,
        avgMsPerChunk: null,
      },
      chunkStates,
    };
  }

  async validateWorkerAvailability(command) {
    const health = await this.workerBridge.healthCheck(command);
    if (!health.ok) {
      throw new Error(health.error || 'Translation worker is unavailable.');
    }
  }

  launchRunLoop(projectId, runId, command) {
    setImmediate(() => {
      this.runLoop(projectId, runId, command).catch(async error => {
        this.logger.error('translation.run.loop_crashed', {
          projectId,
          runId,
          error: error.message,
        });

        await this.store.withState(async state => {
          const project = state.projects[projectId];
          const run = state.runs[runId];
          if (!project || !run) return;
          run.state = TranslationRunState.Failed;
          run.workerState = TranslationWorkerState.Error;
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

  async startRun(projectId, command) {
    await this.validateWorkerAvailability(command);

    await this.store.withState(async state => {
      const project = state.projects[projectId];
      if (!project) throw new Error('Translation project not found.');
      if (project.importState !== 'Ready') {
        throw new Error(project.importError || 'Translation project is not ready.');
      }

      const latestRun = project.latestRunId ? state.runs[project.latestRunId] : null;
      if (latestRun && ACTIVE_TRANSLATION_RUN_STATES.has(latestRun.state)) {
        throw new Error('A translation run is already active for this project.');
      }

      const chunkFrom = Number.isInteger(command.chunkFrom) ? command.chunkFrom : 0;
      const chunkTo = Number.isInteger(command.chunkTo) ? command.chunkTo : project.chunkIds.length - 1;
      const selectedChunkIds = this.getSelectedChunkIds(project, chunkFrom, chunkTo);
      if (!selectedChunkIds.length) {
        throw new Error('No chunks selected for translation.');
      }

      const costEstimate = this.costEstimator.estimate({
        project,
        provider: command.provider,
        model: command.model,
      });

      const run = this.buildRun(project, {
        ...command,
        chunkFrom,
        chunkTo,
        costEstimate,
      }, { selectedChunkIds });

      run.state = TranslationRunState.Ready;
      run.workerState = TranslationWorkerState.Idle;
      run.updatedAt = new Date().toISOString();

      state.runs[run.id] = run;
      project.sourceLanguage = command.sourceLanguage || project.sourceLanguage || '';
      project.targetLanguage = command.targetLanguage;
      project.provider = command.provider;
      project.model = command.model || '';
      project.chunkSize = command.chunkSize || project.chunkSize || 1400;
      project.latestRunId = run.id;
      project.runIds.push(run.id);
      project.updatedAt = new Date().toISOString();
    });

    const snapshot = await this.publishProjectState(projectId);
    this.launchRunLoop(projectId, snapshot.latestRun.id, command);
    return snapshot;
  }

  async resumeRun(projectId, runId, command = {}) {
    await this.validateWorkerAvailability(command);

    await this.store.withState(async state => {
      const project = state.projects[projectId];
      const run = state.runs[runId];
      if (!project || !run || run.projectId !== projectId) throw new Error('Translation run not found.');
      if (![TranslationRunState.Paused, TranslationRunState.Interrupted, TranslationRunState.Stopped].includes(run.state)) {
        throw new Error('Only paused, interrupted, or stopped runs can be resumed.');
      }

      run.state = TranslationRunState.Ready;
      run.workerState = TranslationWorkerState.Idle;
      run.lastError = null;
      run.interruptionReason = null;
      run.pausedAt = null;
      run.stoppedAt = null;
      run.provider = command.provider || run.provider;
      run.model = command.model ?? run.model;
      run.sourceLanguage = command.sourceLanguage ?? run.sourceLanguage;
      run.targetLanguage = command.targetLanguage || run.targetLanguage;
      run.options.baseUrl = command.baseUrl ?? run.options.baseUrl;
      run.updatedAt = new Date().toISOString();

      project.sourceLanguage = run.sourceLanguage || '';
      project.targetLanguage = run.targetLanguage || '';
      project.provider = run.provider;
      project.model = run.model;
      project.latestRunId = run.id;
      project.updatedAt = new Date().toISOString();

      for (const chunkId of run.selectedChunkIds) {
        const chunkState = run.chunkStates[chunkId];
        if ([TranslationChunkState.Queued, TranslationChunkState.Processing, TranslationChunkState.Cancelled].includes(chunkState.state)) {
          chunkState.state = TranslationChunkState.Pending;
          chunkState.startedAt = null;
          chunkState.completedAt = null;
          chunkState.durationMs = null;
        }
      }

      run.progress = this.calculateProgress(run);
    });

    const snapshot = await this.publishProjectState(projectId);
    this.launchRunLoop(projectId, runId, command);
    return snapshot;
  }

  async pauseRun(projectId, runId) {
    const controller = this.activeRuns.get(runId);
    if (!controller) throw new Error('The selected translation run is not currently active.');
    controller.pauseRequested = true;

    await this.store.withState(async state => {
      const run = state.runs[runId];
      if (!run) return;
      if (run.state === TranslationRunState.Running) {
        run.state = TranslationRunState.Pausing;
        run.updatedAt = new Date().toISOString();
      }
    });

    return this.publishProjectState(projectId);
  }

  async stopRun(projectId, runId) {
    const controller = this.activeRuns.get(runId);

    await this.store.withState(async state => {
      const run = state.runs[runId];
      if (!run) throw new Error('Translation run not found.');
      if (![TranslationRunState.Running, TranslationRunState.Pausing, TranslationRunState.Paused, TranslationRunState.Ready].includes(run.state)) {
        throw new Error('This translation run cannot be stopped in its current state.');
      }

      run.state = controller ? TranslationRunState.Stopping : TranslationRunState.Stopped;
      run.workerState = controller ? TranslationWorkerState.Busy : TranslationWorkerState.Stopped;
      run.stoppedAt = controller ? null : new Date().toISOString();
      run.updatedAt = new Date().toISOString();

      if (!controller) {
        for (const chunkId of run.selectedChunkIds) {
          const chunkState = run.chunkStates[chunkId];
          if (![TranslationChunkState.Completed, TranslationChunkState.Failed].includes(chunkState.state)) {
            chunkState.state = TranslationChunkState.Cancelled;
          }
        }
        run.progress = this.calculateProgress(run);
      }
    });

    if (controller) {
      controller.stopRequested = true;
    }

    return this.publishProjectState(projectId);
  }

  async retryFailedChunks(projectId, runId, command = {}) {
    const snapshot = await this.getProject(projectId);
    if (!snapshot.latestRun || snapshot.latestRun.id !== runId) {
      throw new Error('Retry currently works on the latest translation run for a project.');
    }

    const failedChunkNumbers = snapshot.latestRun.chunkStates
      .filter(chunk => chunk.state === TranslationChunkState.Failed)
      .map(chunk => chunk.chunkNumber);

    if (!failedChunkNumbers.length) {
      throw new Error('There are no failed chunks to retry.');
    }

    return this.retryRange(projectId, runId, {
      ...command,
      chunkFrom: Math.min(...failedChunkNumbers) - 1,
      chunkTo: Math.max(...failedChunkNumbers) - 1,
      failedOnly: true,
    });
  }

  async retryRange(projectId, runId, command = {}) {
    await this.validateWorkerAvailability(command);

    await this.store.withState(async state => {
      const project = state.projects[projectId];
      const sourceRun = state.runs[runId];
      if (!project || !sourceRun) throw new Error('Translation project or run not found.');

      const latestRun = project.latestRunId ? state.runs[project.latestRunId] : null;
      if (latestRun && ACTIVE_TRANSLATION_RUN_STATES.has(latestRun.state)) {
        throw new Error('Cannot retry while another translation run is active.');
      }

      const chunkFrom = Number.isInteger(command.chunkFrom) ? command.chunkFrom : sourceRun.options.chunkFrom;
      const chunkTo = Number.isInteger(command.chunkTo) ? command.chunkTo : sourceRun.options.chunkTo;
      let selectedChunkIds = this.getSelectedChunkIds(project, chunkFrom, chunkTo);
      if (command.failedOnly) {
        selectedChunkIds = selectedChunkIds.filter(chunkId => sourceRun.chunkStates[chunkId]?.state === TranslationChunkState.Failed);
      }

      if (!selectedChunkIds.length) {
        throw new Error(command.failedOnly ? 'No failed chunks in the selected range.' : 'No chunks selected for retry.');
      }

      const costEstimate = this.costEstimator.estimate({
        project,
        provider: command.provider || sourceRun.provider,
        model: command.model ?? sourceRun.model,
      });

      const retryRun = this.buildRun(project, {
        provider: command.provider || sourceRun.provider,
        model: command.model ?? sourceRun.model,
        sourceLanguage: command.sourceLanguage ?? sourceRun.sourceLanguage,
        targetLanguage: command.targetLanguage || sourceRun.targetLanguage,
        baseUrl: command.baseUrl ?? sourceRun.options.baseUrl,
        chunkSize: command.chunkSize || sourceRun.chunkSize,
        segmentationMode: command.segmentationMode || sourceRun.segmentationMode,
        chunkFrom,
        chunkTo,
        costEstimate,
      }, {
        retryOfRunId: sourceRun.id,
        selectedChunkIds,
      });

      retryRun.state = TranslationRunState.Ready;
      retryRun.workerState = TranslationWorkerState.Idle;
      retryRun.updatedAt = new Date().toISOString();

      state.runs[retryRun.id] = retryRun;
      project.sourceLanguage = retryRun.sourceLanguage || '';
      project.targetLanguage = retryRun.targetLanguage;
      project.provider = retryRun.provider;
      project.model = retryRun.model;
      project.latestRunId = retryRun.id;
      project.runIds.push(retryRun.id);
      project.updatedAt = new Date().toISOString();
    });

    const snapshot = await this.publishProjectState(projectId);
    this.launchRunLoop(projectId, snapshot.latestRun.id, command);
    return snapshot;
  }

  async getProject(projectId) {
    const state = await this.store.loadState();
    const project = state.projects[projectId];
    if (!project) throw new Error('Translation project not found.');
    const run = project.latestRunId ? state.runs[project.latestRunId] : null;
    return this.store.buildProjectSnapshot(project, run);
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
        if (!run) throw new Error('Translation run not found.');
        run.state = TranslationRunState.Running;
        run.workerState = TranslationWorkerState.Starting;
        run.startedAt = run.startedAt || new Date().toISOString();
        run.updatedAt = new Date().toISOString();
      });
      await this.publishProjectState(projectId);

      while (true) {
        const state = await this.store.loadState();
        const project = state.projects[projectId];
        const run = state.runs[runId];
        if (!project || !run) break;

        const nextChunkIds = run.selectedChunkIds.filter(chunkId =>
          run.chunkStates[chunkId].state === TranslationChunkState.Pending
        );

        if (!nextChunkIds.length) {
          await this.finalizeRun(projectId, runId);
          break;
        }

        if (controller.stopRequested) {
          await this.markRemainingChunks(projectId, runId, TranslationChunkState.Cancelled);
          await this.finalizeRun(projectId, runId, { stopped: true });
          break;
        }

        if (controller.pauseRequested) {
          await this.store.withState(async pauseState => {
            const runToPause = pauseState.runs[runId];
            if (!runToPause) return;
            runToPause.state = TranslationRunState.Paused;
            runToPause.workerState = TranslationWorkerState.Paused;
            runToPause.pausedAt = new Date().toISOString();
            runToPause.updatedAt = new Date().toISOString();
          });
          await this.publishProjectState(projectId);
          break;
        }

        const chunkId = nextChunkIds[0];
        await this.store.withState(async queueState => {
          const runToQueue = queueState.runs[runId];
          if (!runToQueue) return;
          runToQueue.workerState = TranslationWorkerState.Busy;
          if (runToQueue.chunkStates[chunkId].state === TranslationChunkState.Pending) {
            runToQueue.chunkStates[chunkId].state = TranslationChunkState.Queued;
          }
          runToQueue.progress = this.calculateProgress(runToQueue);
          runToQueue.updatedAt = new Date().toISOString();
        });

        await this.publishProjectState(projectId);
        await this.processChunk(projectId, runId, chunkId, command);
        await sleep(10);
      }
    } finally {
      this.activeRuns.delete(runId);
    }
  }

  async processChunk(projectId, runId, chunkId, command) {
    let payload;
    const settings = this.settingsService ? await this.settingsService.getSettingsForRuntime() : null;
    const runtimeConfig = this.settingsService ? this.settingsService.getRuntimeConfig(settings) : {};

    await this.store.withState(async state => {
      const project = state.projects[projectId];
      const run = state.runs[runId];
      if (!project || !run) throw new Error('Translation project or run not found.');
      const chunkState = run.chunkStates[chunkId];
      const chunk = project.chunks[chunkId];
      const providerKey = run.provider || command.provider || '';
      const resolvedApiKey = command.apiKey || (this.settingsService ? await this.settingsService.getSecret(providerKey) : '');

      chunkState.state = TranslationChunkState.Processing;
      chunkState.startedAt = new Date().toISOString();
      chunkState.attempts += 1;
      chunkState.error = null;
      chunkState.diagnostics = null;
      run.progress = this.calculateProgress(run);
      run.progress.currentChunkNumber = chunk.chunkNumber;
      run.updatedAt = new Date().toISOString();
      project.updatedAt = new Date().toISOString();

      payload = {
        projectId,
        runId,
        chunkId,
        provider: run.provider,
        model: run.model,
        apiKey: resolvedApiKey || '',
        baseUrl: command.baseUrl || run.options.baseUrl || settings?.runtimes?.ollamaBaseUrl || '',
        sourceLanguage: run.sourceLanguage || '',
        targetLanguage: run.targetLanguage,
        text: chunk.sourceText || '',
        runtimeConfig,
      };
    });

    await this.publishProjectState(projectId);

    const startedAt = Date.now();
    try {
      const result = await this.workerBridge.runChunk(payload);
      const durationMs = Date.now() - startedAt;

      await this.store.withState(async state => {
        const project = state.projects[projectId];
        const run = state.runs[runId];
        if (!project || !run) return;
        const chunkState = run.chunkStates[chunkId];
        const chunk = project.chunks[chunkId];

        chunkState.state = TranslationChunkState.Completed;
        chunkState.translatedText = result.text || '';
        chunkState.completedAt = new Date().toISOString();
        chunkState.durationMs = durationMs;
        chunkState.error = null;
        chunkState.diagnostics = result.diagnostics || null;

        chunk.translatedText = result.text || '';
        chunk.latestRunId = runId;
        chunk.latestTranslationState = TranslationChunkState.Completed;
        chunk.lastError = null;
        chunk.diagnostics = result.diagnostics || null;
        chunk.updatedAt = new Date().toISOString();

        run.workerState = TranslationWorkerState.Idle;
        run.progress = this.calculateProgress(run);
        run.updatedAt = new Date().toISOString();
        project.updatedAt = new Date().toISOString();
      });

      this.logger.info('translation.chunk.completed', { projectId, runId, chunkId, durationMs });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      await this.store.withState(async state => {
        const project = state.projects[projectId];
        const run = state.runs[runId];
        if (!project || !run) return;
        const chunkState = run.chunkStates[chunkId];
        const chunk = project.chunks[chunkId];

        chunkState.state = TranslationChunkState.Failed;
        chunkState.error = error.message;
        chunkState.completedAt = new Date().toISOString();
        chunkState.durationMs = durationMs;
        chunkState.diagnostics = {
          stage: 'translation',
          provider: run.provider,
          model: run.model,
          summary: error.message,
        };

        chunk.latestRunId = runId;
        chunk.latestTranslationState = TranslationChunkState.Failed;
        chunk.lastError = error.message;
        chunk.diagnostics = chunkState.diagnostics;
        chunk.updatedAt = new Date().toISOString();

        run.workerState = TranslationWorkerState.Error;
        run.lastError = error.message;
        run.progress = this.calculateProgress(run);
        run.updatedAt = new Date().toISOString();
        project.updatedAt = new Date().toISOString();
      });

      this.logger.error('translation.chunk.failed', {
        projectId,
        runId,
        chunkId,
        error: error.message,
      });
    } finally {
      await this.publishProjectState(projectId);
    }
  }

  async markRemainingChunks(projectId, runId, stateValue) {
    await this.store.withState(async state => {
      const project = state.projects[projectId];
      const run = state.runs[runId];
      if (!project || !run) return;

      for (const chunkId of run.selectedChunkIds) {
        const chunkState = run.chunkStates[chunkId];
        if (![TranslationChunkState.Completed, TranslationChunkState.Failed].includes(chunkState.state)) {
          chunkState.state = stateValue;
          project.chunks[chunkId].latestTranslationState = stateValue;
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
      const project = state.projects[projectId];
      const run = state.runs[runId];
      if (!project || !run) return;

      const progress = this.calculateProgress(run);
      run.progress = progress;
      run.workerState = TranslationWorkerState.Stopped;
      run.completedAt = new Date().toISOString();
      run.updatedAt = new Date().toISOString();

      if (stopped) {
        run.state = TranslationRunState.Stopped;
        run.stoppedAt = new Date().toISOString();
      } else if (progress.failed > 0 && progress.completed > 0) {
        run.state = TranslationRunState.CompletedWithFailures;
      } else if (progress.failed > 0 && progress.completed === 0) {
        run.state = TranslationRunState.Failed;
      } else {
        run.state = TranslationRunState.Completed;
      }

      project.updatedAt = new Date().toISOString();
    });

    await this.publishProjectState(projectId);
  }

  async reconcileInterruptedRuns() {
    await this.store.withState(async state => {
      for (const run of Object.values(state.runs)) {
        if (![TranslationRunState.Running, TranslationRunState.Pausing, TranslationRunState.Stopping].includes(run.state)) {
          continue;
        }

        const project = state.projects[run.projectId];
        if (!project) continue;

        run.state = TranslationRunState.Interrupted;
        run.workerState = TranslationWorkerState.Stopped;
        run.interruptionReason = 'App restarted before the translation run could finish.';
        run.updatedAt = new Date().toISOString();

        for (const chunkId of run.selectedChunkIds) {
          const chunkState = run.chunkStates[chunkId];
          if ([TranslationChunkState.Queued, TranslationChunkState.Processing, TranslationChunkState.Cancelled].includes(chunkState.state)) {
            chunkState.state = TranslationChunkState.Pending;
            chunkState.startedAt = null;
            chunkState.completedAt = null;
            chunkState.durationMs = null;
          }
        }

        run.progress = this.calculateProgress(run);
        project.updatedAt = new Date().toISOString();
        this.logger.warn('translation.run.reconciled_to_interrupted', {
          projectId: run.projectId,
          runId: run.id,
        });
      }
    });
  }
}

module.exports = { TranslationRunManager };
