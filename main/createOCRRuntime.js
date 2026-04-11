const { EventEmitter } = require('events');
const path = require('path');

const { OCRPersistenceService } = require('./services/ocr/OCRPersistenceService');
const { OCRImportService } = require('./services/ocr/OCRImportService');
const { OCRWorkerBridge } = require('./services/ocr/OCRWorkerBridge');
const { OCRRunManager } = require('./services/ocr/OCRRunManager');
const { OCRProjectService } = require('./services/ocr/OCRProjectService');
const { TranslationPersistenceService } = require('./services/translation/TranslationPersistenceService');
const { TranslationImportService } = require('./services/translation/TranslationImportService');
const { TranslationWorkerBridge } = require('./services/translation/TranslationWorkerBridge');
const { TranslationRunManager } = require('./services/translation/TranslationRunManager');
const { TranslationProjectService } = require('./services/translation/TranslationProjectService');
const { TranslationCostEstimator } = require('./services/translation/TranslationCostEstimator');
const { EditorDocumentService } = require('./services/editor/EditorDocumentService');
const { ProjectHistoryService } = require('./services/history/ProjectHistoryService');
const { SettingsService } = require('./services/settings/SettingsService');
const { SetupService } = require('./services/setup/SetupService');
const { Logger } = require('./services/logger');

async function createOCRRuntime({ dataDir, appInfo = {}, safeStorageAdapter = null }) {
  const logger = new Logger({
    logFilePath: path.join(dataDir, 'logs', 'app-orchestration.log'),
  });
  const eventBus = new EventEmitter();
  const settingsService = new SettingsService({
    dataDir,
    logger,
    appInfo,
    safeStorageAdapter,
  });
  await settingsService.init();
  const store = new OCRPersistenceService({
    dataDir,
    logger,
    getProjectsRoot: () => settingsService.getProjectAssetsRoot('ocr'),
  });
  const importService = new OCRImportService({ store, eventBus, logger, settingsService });
  const workerBridge = new OCRWorkerBridge({ logger });
  const runManager = new OCRRunManager({ store, workerBridge, eventBus, logger, settingsService });
  const projectService = new OCRProjectService({ store, logger, eventBus, settingsService });

  const translationStore = new TranslationPersistenceService({
    dataDir,
    logger,
    getProjectsRoot: () => settingsService.getProjectAssetsRoot('translation'),
  });
  const editorService = new EditorDocumentService({ dataDir, logger, eventBus, settingsService });
  const translationCostEstimator = new TranslationCostEstimator();
  const translationImportService = new TranslationImportService({
    store: translationStore,
    eventBus,
    logger,
    ocrProjectService: projectService,
  });
  const translationWorkerBridge = new TranslationWorkerBridge({ logger });
  const translationRunManager = new TranslationRunManager({
    store: translationStore,
    workerBridge: translationWorkerBridge,
    eventBus,
    logger,
    costEstimator: translationCostEstimator,
    settingsService,
  });
  const translationProjectService = new TranslationProjectService({
    store: translationStore,
    logger,
    eventBus,
    ocrProjectService: projectService,
    editorService,
    costEstimator: translationCostEstimator,
    settingsService,
  });
  const historyService = new ProjectHistoryService({
    ocrStore: store,
    translationStore,
    editorService,
    ocrProjectService: projectService,
    translationProjectService,
    logger,
  });
  const setupService = new SetupService({ settingsService, logger });

  settingsService.setRuntimeDependencies({
    ocrWorkerBridge: workerBridge,
    translationWorkerBridge,
    ocrProjectService: projectService,
    translationProjectService,
  });

  await store.init();
  await translationStore.init();
  await editorService.init();
  await runManager.reconcileInterruptedRuns();
  await translationRunManager.reconcileInterruptedRuns();

  return {
    logger,
    eventBus,
    setupService,
    store,
    importService,
    workerBridge,
    runManager,
    projectService,
    translationStore,
    translationImportService,
    translationWorkerBridge,
    translationRunManager,
    translationProjectService,
    editorService,
    historyService,
    settingsService,
  };
}

module.exports = { createOCRRuntime };
