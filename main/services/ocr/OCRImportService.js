const path = require('path');
const fse = require('fs-extra');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');

const imageConverter = require('../../../converters/image');
const pdfConverter = require('../../../converters/pdf');
const { detectScriptFromImage } = require('./ocrHelpers');

const THUMB_WIDTH = 240;

class OCRImportService {
  constructor({ store, eventBus, logger, settingsService }) {
    this.store = store;
    this.eventBus = eventBus;
    this.logger = logger;
    this.settingsService = settingsService;
  }

  emitProjectUpdate(projectId, state) {
    const project = state.projects[projectId];
    const run = project?.latestRunId ? state.runs[project.latestRunId] : null;
    if (!project) return;
    this.eventBus.emit('ocr:state-updated', {
      projectId,
      runId: run?.id || null,
      snapshot: this.store.buildProjectSnapshot(project, run),
    });
  }

  async prepareProject({ filePath, originalName }) {
    if (!filePath) {
      throw new Error('A local file path is required to create a project.');
    }

    const projectId = uuidv4();
    const projectDir = this.store.getProjectDir(projectId);
    const sourceDir = path.join(projectDir, 'source');
    const originalPagesDir = path.join(projectDir, 'pages', 'original');
    const preparedPagesDir = path.join(projectDir, 'pages', 'prepared');
    const thumbsDir = path.join(projectDir, 'thumbs');
    const copiedSourcePath = path.join(sourceDir, path.basename(filePath));

    await this.store.withState(async state => {
      state.projects[projectId] = {
        id: projectId,
        title: path.basename(originalName || filePath, path.extname(originalName || filePath)),
        sourceFileName: originalName || path.basename(filePath),
        sourceFilePath: filePath,
        projectDir,
        sourceCopyPath: copiedSourcePath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastOpenedAt: new Date().toISOString(),
        importState: 'Preparing',
        importError: null,
        detectedLanguage: null,
        pageIds: [],
        pages: {},
        latestRunId: null,
        runIds: [],
      };
    });

    this.logger.info('project.prepare.started', { projectId, filePath });

    (async () => {
      try {
        await fse.ensureDir(sourceDir);
        await fse.ensureDir(originalPagesDir);
        await fse.ensureDir(preparedPagesDir);
        await fse.ensureDir(thumbsDir);
        await fse.copy(filePath, copiedSourcePath);

        const extension = path.extname(filePath).toLowerCase();
        const converter = extension === '.pdf' ? pdfConverter : imageConverter;

        // Throttle progress updates — write to disk + emit at most every 2s or every 10 pages
        // to avoid serializing hundreds of disk writes for large PDFs
        let lastProgressEmit = 0;
        let lastProgressDone = 0;

        const pages = await converter.toPages(copiedSourcePath, {
          onPage: async (done, total) => {
            lastProgressDone = done;
            const now = Date.now();
            const shouldEmit = (now - lastProgressEmit > 2000) || done === total || done === 1;
            if (!shouldEmit) return;
            lastProgressEmit = now;

            await this.store.withState(async state => {
              const project = state.projects[projectId];
              if (!project) return;
              project.importProgress = { done, total };
              project.updatedAt = new Date().toISOString();
            });

            const state = await this.store.loadState();
            this.emitProjectUpdate(projectId, state);
          },
        });

        let detectedLanguage = null;

        // ── Write page files outside withState ──────────────────────────────
        // Keeping heavy I/O (disk writes + sharp thumbnails) out of the state
        // lock prevents blocking the mutation chain and keeps memory bounded:
        // we decode each page buffer, write it, then drop it before moving on.
        const pageMetaList = [];
        for (const page of pages) {
          const pageId = uuidv4();
          const baseName = `page_${String(page.index + 1).padStart(4, '0')}.png`;
          const originalImagePath = path.join(originalPagesDir, baseName);
          const preparedImagePath = path.join(preparedPagesDir, baseName);
          const thumbnailPath = path.join(thumbsDir, baseName);

          const buffer = Buffer.from(page.imageBase64, 'base64');
          page.imageBase64 = null; // free memory immediately after decoding

          await fse.writeFile(originalImagePath, buffer);
          await fse.copy(originalImagePath, preparedImagePath);
          await sharp(buffer)
            .resize({ width: THUMB_WIDTH, fit: 'inside', withoutEnlargement: true })
            .png()
            .toFile(thumbnailPath);

          pageMetaList.push({
            id: pageId,
            index: page.index,
            pageNumber: page.index + 1,
            width: page.width,
            height: page.height,
            originalImagePath,
            preparedImagePath,
            thumbnailPath,
            latestText: '',
            latestRunId: null,
            latestOcrState: 'Pending',
            lastError: null,
            updatedAt: new Date().toISOString(),
          });
        }

        // Lightweight state update — no I/O inside the lock
        await this.store.withState(async state => {
          const project = state.projects[projectId];
          if (!project) return;
          for (const pageMeta of pageMetaList) {
            project.pageIds.push(pageMeta.id);
            project.pages[pageMeta.id] = pageMeta;
          }
          project.updatedAt = new Date().toISOString();
        });

        // Use the already-written first page file — base64 was freed above
        if (pageMetaList[0]?.originalImagePath) {
          try {
            const firstPageBase64 = (await fse.readFile(pageMetaList[0].originalImagePath)).toString('base64');
            const runtimeConfig = this.settingsService ? this.settingsService.getRuntimeConfig(await this.settingsService.getSettingsForRuntime()) : {};
            detectedLanguage = await detectScriptFromImage(firstPageBase64, runtimeConfig);
          } catch (_) { /* non-critical — proceed without language detection */ }
        }

        await this.store.withState(async state => {
          const project = state.projects[projectId];
          if (!project) return;
          project.importState = 'Ready';
          project.importError = null;
          project.importProgress = {
            done: project.pageIds.length,
            total: project.pageIds.length,
          };
          project.detectedLanguage = detectedLanguage || null;
          project.updatedAt = new Date().toISOString();
        });

        this.logger.info('project.prepare.completed', {
          projectId,
          pageCount: pages.length,
          detectedLanguage: detectedLanguage?.displayName || null,
        });
      } catch (error) {
        await this.store.withState(async state => {
          const project = state.projects[projectId];
          if (!project) return;
          project.importState = 'Failed';
          project.importError = error.message;
          project.updatedAt = new Date().toISOString();
        });
        this.logger.error('project.prepare.failed', { projectId, error: error.message });
      } finally {
        const state = await this.store.loadState();
        this.emitProjectUpdate(projectId, state);
      }
    })();

    const state = await this.store.loadState();
    const project = state.projects[projectId];
    return this.store.buildProjectSnapshot(project, null);
  }
}

module.exports = { OCRImportService };
