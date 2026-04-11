const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  ocrStarted: () => ipcRenderer.send('ocr-started'),
  ocrFinished: shutdown => ipcRenderer.send('ocr-finished', shutdown),
  pickFile: () => ipcRenderer.invoke('dialog:pick-file'),
  pickTranslationFile: () => ipcRenderer.invoke('dialog:pick-translation-file'),
  pickDirectory: payload => ipcRenderer.invoke('dialog:pick-directory', payload),
  pickExecutable: payload => ipcRenderer.invoke('dialog:pick-executable', payload),
  ocr: {
    prepareProject: payload => ipcRenderer.invoke('ocr:prepare-project', payload),
    prepareProjectBuffer: payload => ipcRenderer.invoke('ocr:prepare-project-buffer', payload),
    listProjects: () => ipcRenderer.invoke('ocr:list-projects'),
    getProject: projectId => ipcRenderer.invoke('ocr:get-project', projectId),
    startRun: payload => ipcRenderer.invoke('ocr:start-run', payload),
    pauseRun: payload => ipcRenderer.invoke('ocr:pause-run', payload),
    resumeRun: payload => ipcRenderer.invoke('ocr:resume-run', payload),
    stopRun: payload => ipcRenderer.invoke('ocr:stop-run', payload),
    retryFailed: payload => ipcRenderer.invoke('ocr:retry-failed', payload),
    retryRange: payload => ipcRenderer.invoke('ocr:retry-range', payload),
    detectLanguage: payload => ipcRenderer.invoke('ocr:detect-language', payload),
    estimateProject: payload => ipcRenderer.invoke('ocr:estimate-project', payload),
    listOllamaModels: payload => ipcRenderer.invoke('ocr:list-ollama-models', payload),
    listProviderModels: payload => ipcRenderer.invoke('ocr:list-provider-models', payload),
    testProvider: payload => ipcRenderer.invoke('ocr:test-provider', payload),
    updatePageText: payload => ipcRenderer.invoke('ocr:update-page-text', payload),
    deleteProject: projectId => ipcRenderer.invoke('ocr:delete-project', projectId),
    exportResult: payload => ipcRenderer.invoke('ocr:export-result', payload),
    onStateUpdated: callback => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('ocr:state-updated', handler);
      return () => ipcRenderer.removeListener('ocr:state-updated', handler);
    },
  },
  translation: {
    importFile: payload => ipcRenderer.invoke('translation:import-file', payload),
    importOcrProject: payload => ipcRenderer.invoke('translation:import-ocr-project', payload),
    listProjects: () => ipcRenderer.invoke('translation:list-projects'),
    getProject: projectId => ipcRenderer.invoke('translation:get-project', projectId),
    updateSettings: payload => ipcRenderer.invoke('translation:update-settings', payload),
    updateChunkText: payload => ipcRenderer.invoke('translation:update-chunk-text', payload),
    startRun: payload => ipcRenderer.invoke('translation:start-run', payload),
    pauseRun: payload => ipcRenderer.invoke('translation:pause-run', payload),
    resumeRun: payload => ipcRenderer.invoke('translation:resume-run', payload),
    stopRun: payload => ipcRenderer.invoke('translation:stop-run', payload),
    retryFailed: payload => ipcRenderer.invoke('translation:retry-failed', payload),
    retryRange: payload => ipcRenderer.invoke('translation:retry-range', payload),
    estimateCost: payload => ipcRenderer.invoke('translation:estimate-cost', payload),
    listOllamaModels: payload => ipcRenderer.invoke('translation:list-ollama-models', payload),
    testProvider: payload => ipcRenderer.invoke('translation:test-provider', payload),
    listImportableOcrProjects: () => ipcRenderer.invoke('translation:list-importable-ocr-projects'),
    getFailureDiagnostics: payload => ipcRenderer.invoke('translation:get-failure-diagnostics', payload),
    deleteProject: projectId => ipcRenderer.invoke('translation:delete-project', projectId),
    exportResult: payload => ipcRenderer.invoke('translation:export-result', payload),
    sendToEditor: payload => ipcRenderer.invoke('translation:send-to-editor', payload),
    onStateUpdated: callback => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('translation:state-updated', handler);
      return () => ipcRenderer.removeListener('translation:state-updated', handler);
    },
  },
  editor: {
    getDocument: payload => ipcRenderer.invoke('editor:get-document', payload),
    updateDocument: payload => ipcRenderer.invoke('editor:update-document', payload),
    runAi: payload => ipcRenderer.invoke('editor:run-ai', payload),
  },
  doc: {
    createBlank:    payload => ipcRenderer.invoke('doc:create-blank', payload),
    createFromPdf:  payload => ipcRenderer.invoke('doc:create-from-pdf', payload),
    list:           ()      => ipcRenderer.invoke('doc:list'),
    get:            payload => ipcRenderer.invoke('doc:get', payload),
    update:         payload => ipcRenderer.invoke('doc:update', payload),
    addPage:        payload => ipcRenderer.invoke('doc:add-page', payload),
    removePage:     payload => ipcRenderer.invoke('doc:remove-page', payload),
    reorderPages:   payload => ipcRenderer.invoke('doc:reorder-pages', payload),
    deletDoc:       payload => ipcRenderer.invoke('doc:delete', payload),
    exportPdf:      payload => ipcRenderer.invoke('doc:export-pdf', payload),
    pickPdf:        ()      => ipcRenderer.invoke('doc:pick-pdf'),
    pickImage:      ()      => ipcRenderer.invoke('doc:pick-image'),
    readImageBase64:payload => ipcRenderer.invoke('doc:read-image-base64', payload),
    removeBg:       payload => ipcRenderer.invoke('doc:remove-bg', payload),
  },
  history: {
    listProjects: payload => ipcRenderer.invoke('history:list-projects', payload),
    getProjectDetails: payload => ipcRenderer.invoke('history:get-project-details', payload),
    searchProjects: payload => ipcRenderer.invoke('history:search-projects', payload),
    filterProjects: payload => ipcRenderer.invoke('history:filter-projects', payload),
    deleteProject: payload => ipcRenderer.invoke('history:delete-project', payload),
    openProject: payload => ipcRenderer.invoke('history:open-project', payload),
    getActiveSummary: payload => ipcRenderer.invoke('history:get-active-summary', payload),
    onUpdated: callback => {
      ipcRenderer.invoke('history:subscribe-updates');
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('history:updated', handler);
      return () => {
        ipcRenderer.removeListener('history:updated', handler);
        ipcRenderer.invoke('history:unsubscribe-updates');
      };
    },
  },
  setup: {
    checkEnvironment: () => ipcRenderer.invoke('setup:check-environment'),
    install: payload => ipcRenderer.invoke('setup:install', payload),
    onInstallLine: callback => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('setup:install-line', handler);
      return () => ipcRenderer.removeListener('setup:install-line', handler);
    },
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: payload => ipcRenderer.invoke('settings:save', payload),
    saveKey: payload => ipcRenderer.invoke('settings:save-key', payload),
    getKey: payload => ipcRenderer.invoke('settings:get-key', payload),
    resetSection: payload => ipcRenderer.invoke('settings:reset-section', payload),
    validate: payload => ipcRenderer.invoke('settings:validate', payload),
    testRuntime: payload => ipcRenderer.invoke('settings:test-runtime', payload),
    testProvider: payload => ipcRenderer.invoke('settings:test-provider', payload),
    getHealthSummary: () => ipcRenderer.invoke('settings:get-health-summary'),
    exportDiagnostics: () => ipcRenderer.invoke('settings:export-diagnostics'),
    openDataFolder: payload => ipcRenderer.invoke('settings:open-data-folder', payload),
  },
});
