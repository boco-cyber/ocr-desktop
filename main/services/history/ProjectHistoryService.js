const path = require('path');

const TERMINAL_RUN_STATES = new Set([
  'Completed',
  'CompletedWithFailures',
  'Failed',
]);

const RESUMABLE_RUN_STATES = new Set([
  'Ready',
  'Paused',
  'Interrupted',
  'Stopped',
]);

function lower(value) {
  return String(value || '').toLowerCase();
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function statusCategory(status) {
  if (!status) return 'idle';
  if (status === 'Preparing') return 'preparing';
  if (status === 'Ready') return 'ready';
  if (['Running', 'Pausing'].includes(status)) return 'running';
  if (['Paused', 'Interrupted'].includes(status)) return 'paused';
  if (['Stopping', 'Stopped'].includes(status)) return 'stopped';
  if (status === 'Completed') return 'completed';
  if (['CompletedWithFailures', 'Failed'].includes(status)) return 'failed';
  return 'idle';
}

function getFileExtension(fileName) {
  return path.extname(fileName || '').replace(/^\./, '').toLowerCase() || 'unknown';
}

function getSourceType(projectLike) {
  if (projectLike?.sourceKind === 'ocr-project') {
    return 'ocr-output';
  }

  const extension = getFileExtension(projectLike?.sourceFileName);
  if (['png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff', 'webp'].includes(extension)) {
    return 'image';
  }
  if (extension === 'pdf') {
    return 'pdf';
  }
  if (['txt', 'md', 'csv', 'json', 'xml', 'html', 'htm', 'rtf', 'log'].includes(extension)) {
    return 'text';
  }
  if (['doc', 'docx'].includes(extension)) {
    return 'document';
  }
  return extension;
}

function buildOcrMetrics(project, run) {
  const pages = Object.values(project.pages || {});
  const latestStatus = run?.state || project.importState || 'Ready';
  const completed = run?.progress?.completed ?? pages.filter(page => hasText(page.latestText)).length;
  const failed = run?.progress?.failed ?? pages.filter(page => page.lastError).length;
  const total = project.pageIds?.length || 0;
  const remaining = run?.progress?.remaining ?? Math.max(0, total - completed - failed);
  const provider = run?.options?.provider || '';
  const model = run?.options?.model || '';

  return {
    projectId: project.id,
    title: project.title,
    sourceFileName: project.sourceFileName,
    sourceCopyPath: project.sourceCopyPath || null,
    sourceType: getSourceType(project),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    lastOpenedAt: project.lastOpenedAt || null,
    importState: project.importState,
    status: latestStatus,
    statusCategory: statusCategory(latestStatus),
    provider,
    model,
    totalPages: total,
    totalChunks: 0,
    completedCount: completed,
    failedCount: failed,
    remainingCount: remaining,
    hasPreparedPages: total > 0,
    hasOcrResults: pages.some(page => hasText(page.latestText)),
    hasTranslationResults: false,
    exportReady: pages.some(page => hasText(page.latestText)),
    editorReady: false,
    lastErrorSummary: run?.lastError || pages.find(page => page.lastError)?.lastError || project.importError || null,
    latestRunState: run?.state || null,
    latestWorkerState: run?.workerState || null,
    progressLabel: run
      ? `${completed}/${run.progress?.total ?? total} pages completed${failed ? ` · ${failed} failed` : ''}${remaining ? ` · ${remaining} remaining` : ''}`
      : project.importState === 'Preparing'
        ? 'Preparing pages'
        : total
          ? `${total} pages ready`
          : 'No pages prepared',
    isIncomplete: project.importState === 'Preparing'
      || (run ? !TERMINAL_RUN_STATES.has(run.state) : true),
    canContinue: project.importState === 'Ready' && (
      !run || RESUMABLE_RUN_STATES.has(run.state)
    ),
    canOpenOcr: project.importState !== 'Failed',
  };
}

function buildTranslationMetrics(project, run, editorDocument) {
  const chunks = Object.values(project.chunks || {});
  const latestStatus = run?.state || project.importState || 'Ready';
  const completed = run?.progress?.completed ?? chunks.filter(chunk => hasText(chunk.translatedText)).length;
  const failed = run?.progress?.failed ?? chunks.filter(chunk => chunk.lastError).length;
  const total = project.chunkIds?.length || 0;
  const remaining = run?.progress?.remaining ?? Math.max(0, total - completed - failed);
  const provider = run?.provider || project.provider || '';
  const model = run?.model || project.model || '';

  return {
    projectId: project.id,
    title: project.title,
    sourceFileName: project.sourceFileName,
    sourceCopyPath: project.sourceCopyPath || null,
    sourceType: getSourceType(project),
    sourceKind: project.sourceKind || 'file-import',
    linkedOcrProjectId: project.linkedOcrProjectId || null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    lastOpenedAt: project.lastOpenedAt || null,
    importState: project.importState,
    status: latestStatus,
    statusCategory: statusCategory(latestStatus),
    provider,
    model,
    totalPages: 0,
    totalChunks: total,
    completedCount: completed,
    failedCount: failed,
    remainingCount: remaining,
    hasPreparedPages: false,
    hasOcrResults: false,
    hasTranslationResults: chunks.some(chunk => hasText(chunk.translatedText)),
    exportReady: chunks.some(chunk => hasText(chunk.translatedText) || hasText(chunk.sourceText)),
    editorReady: Boolean(project.latestEditorDocumentId && editorDocument),
    editorDocumentId: project.latestEditorDocumentId || null,
    lastErrorSummary: run?.lastError || chunks.find(chunk => chunk.lastError)?.lastError || project.importError || null,
    latestRunState: run?.state || null,
    latestWorkerState: run?.workerState || null,
    progressLabel: run
      ? `${completed}/${run.progress?.total ?? total} chunks completed${failed ? ` · ${failed} failed` : ''}${remaining ? ` · ${remaining} remaining` : ''}`
      : project.importState === 'Preparing'
        ? 'Preparing chunks'
        : total
          ? `${total} chunks ready`
          : 'No chunks prepared',
    isIncomplete: project.importState === 'Preparing'
      || (run ? !TERMINAL_RUN_STATES.has(run.state) : true),
    canContinue: project.importState === 'Ready' && (
      !run || RESUMABLE_RUN_STATES.has(run.state)
    ),
    canOpenTranslator: project.importState !== 'Failed',
  };
}

function buildEngineSummary(ocrMetrics, translationMetrics) {
  const parts = [];
  if (ocrMetrics?.provider) {
    parts.push(`OCR: ${ocrMetrics.provider}${ocrMetrics.model ? ` · ${ocrMetrics.model}` : ''}`);
  }
  if (translationMetrics?.provider) {
    parts.push(`Translation: ${translationMetrics.provider}${translationMetrics.model ? ` · ${translationMetrics.model}` : ''}`);
  }
  return parts.join(' | ') || 'No engine recorded yet';
}

function pickPrimaryStage(ocrMetrics, translationMetrics) {
  if (!translationMetrics) return 'ocr';
  if (!ocrMetrics) return 'translation';

  if (translationMetrics.statusCategory === 'running') return 'translation';
  if (ocrMetrics.statusCategory === 'running') return 'ocr';
  if (translationMetrics.isIncomplete) return 'translation';
  if (ocrMetrics.isIncomplete) return 'ocr';
  return 'translation';
}

function computeOverallStatus(ocrMetrics, translationMetrics) {
  if (!ocrMetrics && !translationMetrics) return 'Ready';
  const primaryStage = pickPrimaryStage(ocrMetrics, translationMetrics);
  return primaryStage === 'translation'
    ? (translationMetrics?.status || 'Ready')
    : (ocrMetrics?.status || 'Ready');
}

function buildProgressSummary(workflowType, ocrMetrics, translationMetrics) {
  if (workflowType === 'mixed') {
    return `OCR ${ocrMetrics.progressLabel} | Translation ${translationMetrics.progressLabel}`;
  }
  return ocrMetrics?.progressLabel || translationMetrics?.progressLabel || 'No progress recorded';
}

function buildCompletionCategory(item) {
  if (item.statusCategory === 'failed') return 'failed';
  if (item.statusCategory === 'completed') return 'completed';
  if (item.statusCategory === 'paused' || item.statusCategory === 'running' || item.statusCategory === 'stopped' || item.statusCategory === 'ready' || item.statusCategory === 'preparing') {
    return 'incomplete';
  }
  return 'incomplete';
}

class ProjectHistoryService {
  constructor({
    ocrStore,
    translationStore,
    editorService,
    ocrProjectService,
    translationProjectService,
    logger,
  }) {
    this.ocrStore = ocrStore;
    this.translationStore = translationStore;
    this.editorService = editorService;
    this.ocrProjectService = ocrProjectService;
    this.translationProjectService = translationProjectService;
    this.logger = logger;
  }

  async loadData() {
    const [ocrState, translationState, editorState] = await Promise.all([
      this.ocrStore.loadState(),
      this.translationStore.loadState(),
      this.editorService.loadState(),
    ]);

    return {
      ocrState,
      translationState,
      editorState,
    };
  }

  buildHistoryItems({ ocrState, translationState, editorState }) {
    const items = [];
    const consumedOcrProjectIds = new Set();
    const editorDocuments = editorState.documents || {};
    const ocrProjects = ocrState.projects || {};
    const translationProjects = Object.values(translationState.projects || {})
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

    for (const translationProject of translationProjects) {
      const translationRun = translationProject.latestRunId ? translationState.runs?.[translationProject.latestRunId] : null;
      const linkedOcrProject = translationProject.linkedOcrProjectId
        ? ocrProjects[translationProject.linkedOcrProjectId]
        : null;
      const linkedOcrRun = linkedOcrProject?.latestRunId
        ? ocrState.runs?.[linkedOcrProject.latestRunId]
        : null;
      const editorDocument = translationProject.latestEditorDocumentId
        ? editorDocuments[translationProject.latestEditorDocumentId] || null
        : null;
      const translationMetrics = buildTranslationMetrics(translationProject, translationRun, editorDocument);
      const ocrMetrics = linkedOcrProject
        ? buildOcrMetrics(linkedOcrProject, linkedOcrRun)
        : null;

      if (linkedOcrProject) {
        consumedOcrProjectIds.add(linkedOcrProject.id);
      }

      items.push(this.composeHistoryItem({
        workflowType: linkedOcrProject ? 'mixed' : 'translation',
        ocrMetrics,
        translationMetrics,
        editorDocument,
      }));
    }

    for (const ocrProject of Object.values(ocrProjects)) {
      if (consumedOcrProjectIds.has(ocrProject.id)) {
        continue;
      }
      const ocrRun = ocrProject.latestRunId ? ocrState.runs?.[ocrProject.latestRunId] : null;
      const ocrMetrics = buildOcrMetrics(ocrProject, ocrRun);
      items.push(this.composeHistoryItem({
        workflowType: 'ocr',
        ocrMetrics,
        translationMetrics: null,
        editorDocument: null,
      }));
    }

    return items.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  }

  composeHistoryItem({ workflowType, ocrMetrics, translationMetrics, editorDocument }) {
    const overallStatus = computeOverallStatus(ocrMetrics, translationMetrics);
    const overallStatusCategory = statusCategory(overallStatus);
    const primaryStage = pickPrimaryStage(ocrMetrics, translationMetrics);
    const primaryMetrics = primaryStage === 'translation' ? translationMetrics : ocrMetrics;
    const title = translationMetrics?.title || ocrMetrics?.title || translationMetrics?.sourceFileName || ocrMetrics?.sourceFileName || 'Untitled project';
    const sourceName = translationMetrics?.sourceFileName || ocrMetrics?.sourceFileName || title;
    const createdAt = [ocrMetrics?.createdAt, translationMetrics?.createdAt].filter(Boolean).sort()[0] || null;
    const updatedAt = [ocrMetrics?.updatedAt, translationMetrics?.updatedAt, editorDocument?.updatedAt]
      .filter(Boolean)
      .sort((a, b) => new Date(b) - new Date(a))[0] || null;
    const lastOpenedAt = [ocrMetrics?.lastOpenedAt, translationMetrics?.lastOpenedAt, editorDocument?.lastOpenedAt]
      .filter(Boolean)
      .sort((a, b) => new Date(b) - new Date(a))[0] || null;

    const item = {
      projectId: translationMetrics?.projectId || ocrMetrics?.projectId,
      title,
      sourceName,
      sourceType: translationMetrics?.sourceType || ocrMetrics?.sourceType || 'unknown',
      workflowType,
      projectType: workflowType,
      createdAt,
      updatedAt,
      lastOpenedAt,
      overallStatus,
      statusCategory: overallStatusCategory,
      completionCategory: 'incomplete',
      ocrStatus: ocrMetrics?.status || null,
      translationStatus: translationMetrics?.status || null,
      editorReady: Boolean(translationMetrics?.editorReady),
      exportReady: Boolean(ocrMetrics?.exportReady || translationMetrics?.exportReady),
      hasOcrResults: Boolean(ocrMetrics?.hasOcrResults),
      hasTranslationResults: Boolean(translationMetrics?.hasTranslationResults),
      totalPages: ocrMetrics?.totalPages || 0,
      totalChunks: translationMetrics?.totalChunks || 0,
      completedCount: primaryMetrics?.completedCount || 0,
      failedCount: primaryMetrics?.failedCount || 0,
      remainingCount: primaryMetrics?.remainingCount || 0,
      lastErrorSummary: translationMetrics?.lastErrorSummary || ocrMetrics?.lastErrorSummary || null,
      engineSummary: buildEngineSummary(ocrMetrics, translationMetrics),
      progressSummary: buildProgressSummary(workflowType, ocrMetrics, translationMetrics),
      ocrProjectId: ocrMetrics?.projectId || null,
      translationProjectId: translationMetrics?.projectId || null,
      editorDocumentId: translationMetrics?.editorDocumentId || null,
      sourceCopyPath: translationMetrics?.sourceCopyPath || ocrMetrics?.sourceCopyPath || null,
      sourceKind: translationMetrics?.sourceKind || null,
      availableTargets: {
        ocr: Boolean(ocrMetrics?.canOpenOcr),
        translator: Boolean(translationMetrics?.canOpenTranslator),
        editor: Boolean(translationMetrics?.editorReady),
      },
      canContinue: this.canContinue({ workflowType, ocrMetrics, translationMetrics }),
      continueTarget: this.resolveContinueTarget({ workflowType, ocrMetrics, translationMetrics }),
      openTarget: this.resolveOpenTarget({ workflowType, ocrMetrics, translationMetrics }),
    };

    item.completionCategory = buildCompletionCategory(item);
    return item;
  }

  canContinue({ workflowType, ocrMetrics, translationMetrics }) {
    if (workflowType === 'mixed') {
      return Boolean(translationMetrics?.canContinue || ocrMetrics?.canContinue);
    }
    if (workflowType === 'translation') {
      return Boolean(translationMetrics?.canContinue);
    }
    return Boolean(ocrMetrics?.canContinue);
  }

  resolveContinueTarget({ workflowType, ocrMetrics, translationMetrics }) {
    if (workflowType === 'mixed') {
      if (translationMetrics?.canContinue) return 'translator';
      if (ocrMetrics?.canContinue) return 'ocr';
      if (translationMetrics?.editorReady) return 'editor';
      return translationMetrics ? 'translator' : 'ocr';
    }
    if (workflowType === 'translation') {
      if (translationMetrics?.editorReady && !translationMetrics?.canContinue) {
        return 'editor';
      }
      return 'translator';
    }
    return 'ocr';
  }

  resolveOpenTarget({ workflowType, ocrMetrics, translationMetrics }) {
    if (workflowType === 'mixed') {
      return translationMetrics ? 'translator' : 'ocr';
    }
    if (workflowType === 'translation') {
      return 'translator';
    }
    return 'ocr';
  }

  filterItems(items, options = {}) {
    const search = lower(options.search || options.query || '');
    const workflowType = lower(options.workflowType || 'all');
    const status = lower(options.status || 'all');
    const sourceType = lower(options.sourceType || 'all');
    const engine = lower(options.engine || 'all');
    const output = lower(options.output || 'all');
    const completion = lower(options.completion || 'all');

    return items.filter(item => {
      if (workflowType !== 'all' && lower(item.workflowType) !== workflowType) {
        return false;
      }
      if (status !== 'all' && lower(item.statusCategory) !== status && lower(item.overallStatus) !== status) {
        return false;
      }
      if (completion !== 'all' && lower(item.completionCategory) !== completion) {
        return false;
      }
      if (sourceType !== 'all' && lower(item.sourceType) !== sourceType) {
        return false;
      }
      if (engine !== 'all' && !lower(item.engineSummary).includes(engine)) {
        return false;
      }
      if (output === 'has-ocr' && !item.hasOcrResults) return false;
      if (output === 'has-translation' && !item.hasTranslationResults) return false;
      if (output === 'editor-ready' && !item.editorReady) return false;
      if (output === 'export-ready' && !item.exportReady) return false;
      if (!search) return true;

      const haystack = lower([
        item.title,
        item.sourceName,
        item.workflowType,
        item.overallStatus,
        item.ocrStatus,
        item.translationStatus,
        item.engineSummary,
        item.lastErrorSummary,
      ].join(' '));

      return haystack.includes(search);
    });
  }

  sortItems(items, options = {}) {
    const sortBy = options.sortBy || 'updatedAt';
    const direction = lower(options.sortDirection || 'desc') === 'asc' ? 1 : -1;
    const sorted = [...items];

    sorted.sort((a, b) => {
      if (sortBy === 'title') {
        return a.title.localeCompare(b.title) * direction;
      }

      const aValue = new Date(a[sortBy] || 0).getTime();
      const bValue = new Date(b[sortBy] || 0).getTime();
      return (aValue - bValue) * direction;
    });

    return sorted;
  }

  paginateItems(items, options = {}) {
    const offset = Math.max(0, parseInt(options.offset, 10) || 0);
    const limit = Math.max(1, parseInt(options.limit, 10) || 200);
    return items.slice(offset, offset + limit);
  }

  async listProjects(options = {}) {
    const rawData = await this.loadData();
    const items = this.buildHistoryItems(rawData);
    const filtered = this.filterItems(items, options);
    const sorted = this.sortItems(filtered, options);
    const paged = this.paginateItems(sorted, options);

    return {
      items: paged,
      totalCount: filtered.length,
      generatedAt: new Date().toISOString(),
      filters: {
        search: options.search || options.query || '',
        workflowType: options.workflowType || 'all',
        status: options.status || 'all',
        completion: options.completion || 'all',
        sourceType: options.sourceType || 'all',
        engine: options.engine || 'all',
        output: options.output || 'all',
        sortBy: options.sortBy || 'updatedAt',
        sortDirection: options.sortDirection || 'desc',
      },
    };
  }

  async findItem(projectId) {
    const rawData = await this.loadData();
    const items = this.buildHistoryItems(rawData);
    const item = items.find(candidate => candidate.projectId === projectId);
    if (!item) {
      throw new Error('History project not found.');
    }
    return { item, rawData };
  }

  buildActions(item) {
    return {
      openProject: Boolean(item.openTarget),
      continue: Boolean(item.canContinue),
      openInOcr: Boolean(item.availableTargets.ocr),
      openInTranslator: Boolean(item.availableTargets.translator),
      openInEditor: Boolean(item.availableTargets.editor),
      export: Boolean(item.exportReady),
      delete: true,
      deleteScope: item.workflowType === 'mixed'
        ? 'Deletes the translation/output history item and keeps the linked OCR source project.'
        : item.workflowType === 'translation'
          ? 'Deletes the translation project and its linked editor document, if present.'
          : 'Deletes the OCR project and its stored page assets.',
    };
  }

  async getProjectDetails(projectId) {
    const { item } = await this.findItem(projectId);
    const ocrSnapshot = item.ocrProjectId
      ? await this.ocrProjectService.getProject(item.ocrProjectId)
      : null;
    const translationSnapshot = item.translationProjectId
      ? await this.translationProjectService.getProject(item.translationProjectId)
      : null;
    const editorDocument = item.editorDocumentId
      ? await this.editorService.getDocumentIfExists(item.editorDocumentId)
      : null;

    const ocrCounts = ocrSnapshot?.latestRun?.progress || {
      total: ocrSnapshot?.pageCount || 0,
      completed: ocrSnapshot?.pages?.filter(page => hasText(page.latestText)).length || 0,
      failed: ocrSnapshot?.pages?.filter(page => page.lastError).length || 0,
      remaining: 0,
    };
    const translationCounts = translationSnapshot?.latestRun?.progress || {
      total: translationSnapshot?.chunkCount || 0,
      completed: translationSnapshot?.chunks?.filter(chunk => hasText(chunk.translatedText)).length || 0,
      failed: translationSnapshot?.chunks?.filter(chunk => chunk.lastError).length || 0,
      remaining: 0,
    };

    const exportOptions = [];
    if (item.hasOcrResults && item.ocrProjectId) {
      exportOptions.push({ scope: 'ocr', format: 'txt', label: 'Export OCR TXT' });
      exportOptions.push({ scope: 'ocr', format: 'docx', label: 'Export OCR DOCX' });
    }
    if (item.hasTranslationResults && item.translationProjectId) {
      exportOptions.push({ scope: 'translation', format: 'txt', label: 'Export Translation TXT' });
      exportOptions.push({ scope: 'translation', format: 'json', label: 'Export Translation JSON' });
    }

    return {
      ...item,
      projectRef: item.projectId,
      source: {
        name: item.sourceName,
        type: item.sourceType,
        filePath: translationSnapshot?.sourceCopyPath || ocrSnapshot?.sourceCopyPath || item.sourceCopyPath || null,
        sourceKind: translationSnapshot?.sourceKind || null,
      },
      references: {
        ocrProjectId: item.ocrProjectId,
        translationProjectId: item.translationProjectId,
        editorDocumentId: item.editorDocumentId,
      },
      status: {
        overall: item.overallStatus,
        category: item.statusCategory,
        ocr: item.ocrStatus,
        translation: item.translationStatus,
        ocrWorker: ocrSnapshot?.latestRun?.workerState || null,
        translationWorker: translationSnapshot?.latestRun?.workerState || null,
        lastActiveStep: item.translationStatus
          ? `Translation ${item.translationStatus}`
          : item.ocrStatus
            ? `OCR ${item.ocrStatus}`
            : 'Prepared',
        lastErrorSummary: item.lastErrorSummary,
      },
      counts: {
        pages: {
          total: ocrSnapshot?.pageCount || 0,
          completed: ocrCounts.completed || 0,
          failed: ocrCounts.failed || 0,
          remaining: ocrCounts.remaining || 0,
        },
        chunks: {
          total: translationSnapshot?.chunkCount || 0,
          completed: translationCounts.completed || 0,
          failed: translationCounts.failed || 0,
          remaining: translationCounts.remaining || 0,
        },
      },
      availability: {
        preparedPages: Boolean(ocrSnapshot?.pageCount),
        ocrText: item.hasOcrResults,
        translationText: item.hasTranslationResults,
        editorReady: item.editorReady,
        exportReady: item.exportReady,
      },
      providers: {
        ocr: ocrSnapshot?.latestRun?.options?.provider
          ? {
              provider: ocrSnapshot.latestRun.options.provider,
              model: ocrSnapshot.latestRun.options.model || '',
            }
          : null,
        translation: translationSnapshot?.latestRun?.provider || translationSnapshot?.provider
          ? {
              provider: translationSnapshot?.latestRun?.provider || translationSnapshot.provider,
              model: translationSnapshot?.latestRun?.model || translationSnapshot.model || '',
            }
          : null,
      },
      actions: this.buildActions(item),
      exportOptions,
    };
  }

  async searchProjects(options = {}) {
    return this.listProjects(options);
  }

  async filterProjects(options = {}) {
    return this.listProjects(options);
  }

  async getActiveSummary(projectId) {
    const { item } = await this.findItem(projectId);
    return item;
  }

  async openProject(projectId, options = {}) {
    const { item } = await this.findItem(projectId);
    const action = lower(options.action || 'open');
    let targetScreen = item.openTarget;

    if (action === 'continue') {
      targetScreen = item.continueTarget;
      if (!item.canContinue) {
        throw new Error('This project does not have resumable work.');
      }
    } else if (action === 'ocr') {
      if (!item.ocrProjectId) throw new Error('This history item does not have OCR content.');
      targetScreen = 'ocr';
    } else if (action === 'translator') {
      if (!item.translationProjectId) throw new Error('This history item does not have translation content.');
      targetScreen = 'translator';
    } else if (action === 'editor') {
      if (!item.editorDocumentId) throw new Error('This history item does not have an editor document.');
      targetScreen = 'editor';
    }

    if (targetScreen === 'ocr' && item.ocrProjectId) {
      await this.ocrProjectService.markProjectOpened(item.ocrProjectId);
    }
    if (targetScreen === 'translator' && item.translationProjectId) {
      await this.translationProjectService.markProjectOpened(item.translationProjectId);
    }
    if (targetScreen === 'editor' && item.editorDocumentId) {
      await this.editorService.markDocumentOpened(item.editorDocumentId);
    }

    this.logger.info('history.project.opened', {
      projectId,
      targetScreen,
      action: action || 'open',
      ocrProjectId: item.ocrProjectId,
      translationProjectId: item.translationProjectId,
      editorDocumentId: item.editorDocumentId,
    });

    return {
      projectId,
      workflowType: item.workflowType,
      targetScreen,
      ocrProjectId: item.ocrProjectId,
      translationProjectId: item.translationProjectId,
      editorDocumentId: item.editorDocumentId,
    };
  }

  async deleteProject(projectId) {
    const { item } = await this.findItem(projectId);

    if (item.translationProjectId) {
      await this.translationProjectService.deleteProject(item.translationProjectId);
      this.logger.info('history.project.deleted', {
        projectId,
        workflowType: item.workflowType,
        deletedTranslationProjectId: item.translationProjectId,
        preservedOcrProjectId: item.workflowType === 'mixed' ? item.ocrProjectId : null,
      });
      return {
        ok: true,
        workflowType: item.workflowType,
        deleted: {
          translationProjectId: item.translationProjectId,
          editorDocumentId: item.editorDocumentId,
        },
        preserved: {
          ocrProjectId: item.workflowType === 'mixed' ? item.ocrProjectId : null,
        },
      };
    }

    await this.ocrProjectService.deleteProject(item.ocrProjectId);
    this.logger.info('history.project.deleted', {
      projectId,
      workflowType: item.workflowType,
      deletedOcrProjectId: item.ocrProjectId,
    });

    return {
      ok: true,
      workflowType: item.workflowType,
      deleted: {
        ocrProjectId: item.ocrProjectId,
      },
      preserved: {},
    };
  }
}

module.exports = { ProjectHistoryService };
