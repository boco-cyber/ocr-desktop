const path = require('path');

const fse = require('fs-extra');
const { BrowserWindow, dialog, ipcMain, shell } = require('electron');

function registerOCRIpc({ runtime, dataDir }) {
  const {
    eventBus,
    setupService,
    importService,
    runManager,
    projectService,
    translationImportService,
    translationRunManager,
    translationProjectService,
    editorService,
    historyService,
    settingsService,
    documentService,
    documentWorkerBridge,
    logger,
  } = runtime;

  function broadcast(channel, payload) {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, payload);
      }
    }
  }

  eventBus.on('ocr:state-updated', payload => {
    broadcast('ocr:state-updated', payload);
    broadcast('history:updated', {
      scope: 'ocr',
      projectId: payload.projectId,
      runId: payload.runId || null,
      changedAt: new Date().toISOString(),
    });
  });

  eventBus.on('translation:state-updated', payload => {
    broadcast('translation:state-updated', payload);
    broadcast('history:updated', {
      scope: 'translation',
      projectId: payload.projectId,
      runId: payload.runId || null,
      changedAt: new Date().toISOString(),
    });
  });

  eventBus.on('editor:document-updated', payload => {
    broadcast('history:updated', {
      scope: 'editor',
      documentId: payload.documentId,
      sourceProjectId: payload.sourceProjectId || null,
      changedAt: new Date().toISOString(),
    });
  });

  eventBus.on('editor:document-deleted', payload => {
    broadcast('history:updated', {
      scope: 'editor',
      documentId: payload.documentId,
      sourceProjectId: payload.sourceProjectId || null,
      changedAt: new Date().toISOString(),
    });
  });

  ipcMain.handle('dialog:pick-file', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{
        name: 'Documents and Images',
        extensions: ['pdf', 'jpg', 'jpeg', 'png', 'tif', 'tiff', 'bmp', 'webp'],
      }],
    });

    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true };
    }

    const filePath = result.filePaths[0];
    return {
      canceled: false,
      filePath,
      originalName: path.basename(filePath),
    };
  });

  ipcMain.handle('dialog:pick-translation-file', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{
        name: 'Translation Sources',
        extensions: ['txt', 'md', 'csv', 'log', 'json', 'html', 'htm', 'xml', 'rtf', 'pdf', 'doc', 'docx'],
      }],
    });

    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true };
    }

    const filePath = result.filePaths[0];
    return {
      canceled: false,
      filePath,
      originalName: path.basename(filePath),
    };
  });

  ipcMain.handle('dialog:pick-directory', async (_event, payload) => {
    const result = await dialog.showOpenDialog({
      title: payload?.title || 'Select folder',
      defaultPath: payload?.defaultPath || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });

    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true };
    }

    return {
      canceled: false,
      directoryPath: result.filePaths[0],
    };
  });

  ipcMain.handle('dialog:pick-executable', async (_event, payload) => {
    const result = await dialog.showOpenDialog({
      title: payload?.title || 'Select executable',
      defaultPath: payload?.defaultPath || undefined,
      properties: ['openFile'],
      filters: process.platform === 'win32'
        ? [{ name: 'Executable', extensions: ['exe', 'cmd', 'bat', 'py'] }, { name: 'All files', extensions: ['*'] }]
        : [{ name: 'All files', extensions: ['*'] }],
    });

    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true };
    }

    return {
      canceled: false,
      filePath: result.filePaths[0],
    };
  });

  ipcMain.handle('ocr:prepare-project', async (_event, payload) => {
    return importService.prepareProject(payload || {});
  });

  ipcMain.handle('ocr:prepare-project-buffer', async (_event, payload) => {
    if (!payload?.name || !payload?.bytes) {
      throw new Error('A file name and byte payload are required.');
    }

    const settings = await settingsService.getSettingsForRuntime();
    const importDir = path.join(settingsService.getResolvedGeneralPaths(settings).tempPath, 'clipboard-imports');
    await fse.ensureDir(importDir);
    const filePath = path.join(importDir, `${Date.now()}-${payload.name}`);
    await fse.writeFile(filePath, Buffer.from(payload.bytes));
    return importService.prepareProject({
      filePath,
      originalName: payload.name,
    });
  });

  ipcMain.handle('ocr:list-projects', async () => {
    return projectService.listProjects();
  });

  ipcMain.handle('ocr:get-project', async (_event, projectId) => {
    return projectService.getProject(projectId);
  });

  ipcMain.handle('ocr:start-run', async (_event, payload) => {
    return runManager.startRun(payload.projectId, payload);
  });

  ipcMain.handle('ocr:pause-run', async (_event, payload) => {
    return runManager.pauseRun(payload.projectId, payload.runId);
  });

  ipcMain.handle('ocr:resume-run', async (_event, payload) => {
    return runManager.resumeRun(payload.projectId, payload.runId, payload);
  });

  ipcMain.handle('ocr:stop-run', async (_event, payload) => {
    return runManager.stopRun(payload.projectId, payload.runId);
  });

  ipcMain.handle('ocr:retry-failed', async (_event, payload) => {
    return runManager.retryFailedPages(payload.projectId, payload.runId, payload);
  });

  ipcMain.handle('ocr:retry-range', async (_event, payload) => {
    return runManager.retryPageRange(payload.projectId, payload.runId, payload);
  });

  ipcMain.handle('ocr:detect-language', async (_event, payload) => {
    return projectService.detectLanguage(payload);
  });

  ipcMain.handle('ocr:estimate-project', async (_event, payload) => {
    return projectService.estimateProject(payload);
  });

  ipcMain.handle('ocr:list-ollama-models', async (_event, payload) => {
    return projectService.listOllamaModels(payload?.baseUrl);
  });

  ipcMain.handle('ocr:test-provider', async (_event, payload) => {
    return projectService.testProvider(payload);
  });

  ipcMain.handle('ocr:list-provider-models', async (_event, payload) => {
    return projectService.listProviderModels(payload);
  });

  ipcMain.handle('ocr:update-page-text', async (_event, payload) => {
    return projectService.updatePageText(payload.projectId, payload.pageNumber, payload.text);
  });

  ipcMain.handle('ocr:delete-project', async (_event, projectId) => {
    return projectService.deleteProject(projectId);
  });

  ipcMain.handle('ocr:export-result', async (_event, payload) => {
    const built = await projectService.buildExport(payload.projectId, payload.format);
    const settings = await settingsService.getSettingsForRuntime();
    const exportRoot = settingsService.getResolvedGeneralPaths(settings).exportPath;
    await fse.ensureDir(exportRoot);
    const saveDialog = await dialog.showSaveDialog({
      defaultPath: path.join(exportRoot, built.defaultFileName),
      filters: [{
        name: payload.format === 'docx' ? 'DOCX document' : 'Text file',
        extensions: [payload.format],
      }],
    });

    if (saveDialog.canceled || !saveDialog.filePath) {
      return { canceled: true };
    }

    await fse.writeFile(saveDialog.filePath, built.data);
    logger.info('project.export.saved', {
      projectId: payload.projectId,
      format: payload.format,
      filePath: saveDialog.filePath,
    });

    return {
      canceled: false,
      filePath: saveDialog.filePath,
    };
  });

  ipcMain.handle('translation:import-file', async (_event, payload) => {
    return translationImportService.prepareProject(payload || {});
  });

  ipcMain.handle('translation:import-ocr-project', async (_event, payload) => {
    return translationImportService.prepareProjectFromOCR(payload || {});
  });

  ipcMain.handle('translation:list-projects', async () => {
    return translationProjectService.listProjects();
  });

  ipcMain.handle('translation:get-project', async (_event, projectId) => {
    return translationProjectService.getProject(projectId);
  });

  ipcMain.handle('translation:update-settings', async (_event, payload) => {
    return translationProjectService.updateSettings(payload.projectId, payload.changes || {});
  });

  ipcMain.handle('translation:update-chunk-text', async (_event, payload) => {
    return translationProjectService.updateChunkTranslation(payload.projectId, payload.chunkNumber, payload.text);
  });

  ipcMain.handle('translation:start-run', async (_event, payload) => {
    return translationRunManager.startRun(payload.projectId, payload);
  });

  ipcMain.handle('translation:pause-run', async (_event, payload) => {
    return translationRunManager.pauseRun(payload.projectId, payload.runId);
  });

  ipcMain.handle('translation:resume-run', async (_event, payload) => {
    return translationRunManager.resumeRun(payload.projectId, payload.runId, payload);
  });

  ipcMain.handle('translation:stop-run', async (_event, payload) => {
    return translationRunManager.stopRun(payload.projectId, payload.runId);
  });

  ipcMain.handle('translation:retry-failed', async (_event, payload) => {
    return translationRunManager.retryFailedChunks(payload.projectId, payload.runId, payload);
  });

  ipcMain.handle('translation:retry-range', async (_event, payload) => {
    return translationRunManager.retryRange(payload.projectId, payload.runId, payload);
  });

  ipcMain.handle('translation:estimate-cost', async (_event, payload) => {
    return translationProjectService.estimateCost(payload);
  });

  ipcMain.handle('translation:list-ollama-models', async (_event, payload) => {
    return translationProjectService.listOllamaModels(payload?.baseUrl);
  });

  ipcMain.handle('translation:test-provider', async (_event, payload) => {
    return translationProjectService.testProvider(payload);
  });

  ipcMain.handle('translation:list-importable-ocr-projects', async () => {
    return translationProjectService.listImportableOcrProjects();
  });

  ipcMain.handle('translation:get-failure-diagnostics', async (_event, payload) => {
    return translationProjectService.fetchFailureDiagnostics(payload.projectId);
  });

  ipcMain.handle('translation:delete-project', async (_event, projectId) => {
    return translationProjectService.deleteProject(projectId);
  });

  ipcMain.handle('translation:export-result', async (_event, payload) => {
    const built = await translationProjectService.buildExport(payload.projectId, payload.format);
    const settings = await settingsService.getSettingsForRuntime();
    const exportRoot = settingsService.getResolvedGeneralPaths(settings).exportPath;
    await fse.ensureDir(exportRoot);
    const saveDialog = await dialog.showSaveDialog({
      defaultPath: path.join(exportRoot, built.defaultFileName),
      filters: [{
        name: payload.format === 'json' ? 'JSON file' : 'Text file',
        extensions: [payload.format],
      }],
    });

    if (saveDialog.canceled || !saveDialog.filePath) {
      return { canceled: true };
    }

    await fse.writeFile(saveDialog.filePath, built.data);
    logger.info('translation.project.export.saved', {
      projectId: payload.projectId,
      format: payload.format,
      filePath: saveDialog.filePath,
    });

    return {
      canceled: false,
      filePath: saveDialog.filePath,
    };
  });

  ipcMain.handle('translation:send-to-editor', async (_event, payload) => {
    return translationProjectService.sendToEditor(payload.projectId);
  });

  ipcMain.handle('history:list-projects', async (_event, payload) => {
    return historyService.listProjects(payload || {});
  });

  ipcMain.handle('history:get-project-details', async (_event, payload) => {
    return historyService.getProjectDetails(payload?.projectId || payload);
  });

  ipcMain.handle('history:search-projects', async (_event, payload) => {
    return historyService.searchProjects(payload || {});
  });

  ipcMain.handle('history:filter-projects', async (_event, payload) => {
    return historyService.filterProjects(payload || {});
  });

  ipcMain.handle('history:delete-project', async (_event, payload) => {
    const result = await historyService.deleteProject(payload?.projectId || payload);
    broadcast('history:updated', {
      scope: 'history',
      projectId: payload?.projectId || payload,
      changedAt: new Date().toISOString(),
    });
    return result;
  });

  ipcMain.handle('history:open-project', async (_event, payload) => {
    return historyService.openProject(payload?.projectId, payload || {});
  });

  ipcMain.handle('history:get-active-summary', async (_event, payload) => {
    return historyService.getActiveSummary(payload?.projectId || payload);
  });

  ipcMain.handle('history:subscribe-updates', async event => {
    return { ok: true };
  });

  ipcMain.handle('history:unsubscribe-updates', async event => {
    return { ok: true };
  });

  ipcMain.handle('editor:get-document', async (_event, payload) => {
    return editorService.getDocument(payload.documentId);
  });

  ipcMain.handle('editor:update-document', async (_event, payload) => {
    return editorService.updateDocument(payload.documentId, payload.content);
  });

  ipcMain.handle('editor:run-ai', async (_event, payload) => {
    return editorService.runAi(payload || {});
  });

  ipcMain.handle('settings:get', async () => {
    return settingsService.getSanitizedSettings();
  });

  ipcMain.handle('settings:save', async (_event, payload) => {
    return settingsService.saveSettings(payload || {});
  });

  ipcMain.handle('settings:reset-section', async (_event, payload) => {
    return settingsService.resetSection(payload?.section || payload);
  });

  ipcMain.handle('settings:validate', async (_event, payload) => {
    return settingsService.validateSettings(payload?.settings || payload || {});
  });

  // Lightweight: save a single provider API key without touching other settings
  ipcMain.handle('settings:save-key', async (_event, payload) => {
    return settingsService.saveProviderKey(payload?.provider, payload?.apiKey);
  });

  // Lightweight: get a single decrypted provider API key (masked for display)
  ipcMain.handle('settings:get-key', async (_event, payload) => {
    return settingsService.getProviderKeyMasked(payload?.provider);
  });

  ipcMain.handle('settings:test-runtime', async (_event, payload) => {
    return settingsService.testRuntime(payload || {});
  });

  ipcMain.handle('settings:test-provider', async (_event, payload) => {
    return settingsService.testProvider(payload || {});
  });

  ipcMain.handle('settings:get-health-summary', async () => {
    return settingsService.getHealthSummary();
  });

  ipcMain.handle('settings:export-diagnostics', async () => {
    const built = await settingsService.buildDiagnosticsExport();
    const settings = await settingsService.getSettingsForRuntime();
    const exportRoot = settingsService.getResolvedGeneralPaths(settings).exportPath;
    await fse.ensureDir(exportRoot);
    const saveDialog = await dialog.showSaveDialog({
      defaultPath: path.join(exportRoot, built.defaultFileName),
      filters: [{ name: 'JSON file', extensions: ['json'] }],
    });

    if (saveDialog.canceled || !saveDialog.filePath) {
      return { canceled: true };
    }

    await fse.writeFile(saveDialog.filePath, built.data);
    return {
      canceled: false,
      filePath: saveDialog.filePath,
    };
  });

  ipcMain.handle('setup:check-environment', async () => {
    return setupService.checkEnvironment();
  });

  ipcMain.handle('setup:install', async (event, payload) => {
    const { feature, pythonPathOverride } = payload || {};
    const senderWindow = BrowserWindow.fromWebContents(event.sender);

    const onLine = line => {
      if (senderWindow && !senderWindow.isDestroyed()) {
        senderWindow.webContents.send('setup:install-line', { feature, line });
      }
    };

    return setupService.installPackages({ feature, pythonPathOverride, onLine });
  });

  // ── Document (PDF Editor) IPC ─────────────────────────────────────────────

  ipcMain.handle('doc:create-blank', async (_event, payload) => {
    return documentService.createBlank(payload || {});
  });

  ipcMain.handle('doc:create-from-pdf', async (_event, { filePath }) => {
    if (!filePath) throw new Error('filePath required');
    // Parse in worker — no blocking the main process
    const parsed = await documentWorkerBridge.parsePdf(filePath);
    return documentService.createFromParsed({
      name: parsed.name,
      originalFile: filePath,
      pages: parsed.pages,
    });
  });

  ipcMain.handle('doc:list', async () => {
    return documentService.listDocuments();
  });

  ipcMain.handle('doc:get', async (_event, { documentId }) => {
    return documentService.getDocument(documentId);
  });

  ipcMain.handle('doc:update', async (_event, { document }) => {
    return documentService.updateDocument(document);
  });

  ipcMain.handle('doc:add-page', async (_event, { documentId, afterPageId }) => {
    return documentService.addPage(documentId, afterPageId);
  });

  ipcMain.handle('doc:remove-page', async (_event, { documentId, pageId }) => {
    return documentService.removePage(documentId, pageId);
  });

  ipcMain.handle('doc:reorder-pages', async (_event, { documentId, orderedPageIds }) => {
    return documentService.reorderPages(documentId, orderedPageIds);
  });

  ipcMain.handle('doc:delete', async (_event, { documentId }) => {
    return documentService.deleteDocument(documentId);
  });

  ipcMain.handle('doc:export-pdf', async (_event, { documentId }) => {
    const doc = await documentService.getDocument(documentId);
    const settings = await settingsService.getSettingsForRuntime();
    const exportRoot = settingsService.getResolvedGeneralPaths(settings).exportPath;
    await fse.ensureDir(exportRoot);

    const safeName = (doc.name || 'document').replace(/[^a-zA-Z0-9_\-. ]/g, '_');
    const defaultPath = path.join(exportRoot, `${safeName}.pdf`);

    const saveDialog = await dialog.showSaveDialog({
      defaultPath,
      filters: [{ name: 'PDF File', extensions: ['pdf'] }],
    });
    if (saveDialog.canceled || !saveDialog.filePath) return { canceled: true };

    await documentWorkerBridge.exportPdf(doc, saveDialog.filePath);
    return { canceled: false, filePath: saveDialog.filePath };
  });

  ipcMain.handle('doc:pick-pdf', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return { canceled: false, filePath: result.filePaths[0] };
  });

  ipcMain.handle('doc:pick-image', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return { canceled: false, filePath: result.filePaths[0] };
  });

  ipcMain.handle('doc:read-image-base64', async (_event, { filePath }) => {
    const buf = await fse.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
    return { dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
  });

  ipcMain.handle('doc:remove-bg', async (_event, { documentId, pageId }) => {
    // Placeholder — returns ok without processing (Phase 3 feature)
    return { ok: true, documentId, pageId };
  });

  ipcMain.handle('settings:open-data-folder', async (_event, payload) => {
    const settings = await settingsService.getSettingsForRuntime();
    const resolved = settingsService.getResolvedGeneralPaths(settings);
    const target = payload?.target || 'data';
    let openPath = dataDir;

    if (target === 'logs') openPath = path.join(dataDir, 'logs');
    if (target === 'exports') openPath = resolved.exportPath;
    if (target === 'projects') openPath = resolved.projectStoragePath;
    if (target === 'temp') openPath = resolved.tempPath;

    await fse.ensureDir(openPath);
    const error = await shell.openPath(openPath);
    return {
      ok: !error,
      path: openPath,
      error: error || null,
    };
  });
}

module.exports = { registerOCRIpc };
