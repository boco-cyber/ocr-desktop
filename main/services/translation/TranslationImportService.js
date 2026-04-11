const path = require('path');

const fse = require('fs-extra');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const WordExtractor = require('word-extractor');
const { v4: uuidv4 } = require('uuid');

const { TextNormalizationService } = require('./TextNormalizationService');
const { TextChunkingService } = require('./TextChunkingService');

/**
 * Detect the dominant script/language from a text sample using Unicode ranges.
 * Returns a display-name string matching the AI_LANGUAGES list in the UI,
 * or '' when the script is Latin (ambiguous — too many languages share it).
 */
function detectLanguageFromText(text) {
  const sample = (text || '').slice(0, 1500);
  if (!sample.trim()) return '';

  const arabic   = (sample.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g) || []).length;
  const hebrew   = (sample.match(/[\u0590-\u05FF]/g) || []).length;
  const cjkAll   = (sample.match(/[\u4E00-\u9FFF\u3400-\u4DBF]/g) || []).length;
  const hiragana = (sample.match(/[\u3040-\u309F]/g) || []).length;
  const katakana = (sample.match(/[\u30A0-\u30FF]/g) || []).length;
  const hangul   = (sample.match(/[\uAC00-\uD7AF]/g) || []).length;
  const cyrillic = (sample.match(/[\u0400-\u04FF]/g) || []).length;
  const thai     = (sample.match(/[\u0E00-\u0E7F]/g) || []).length;
  const devanag  = (sample.match(/[\u0900-\u097F]/g) || []).length;
  const bengali  = (sample.match(/[\u0980-\u09FF]/g) || []).length;
  const greek    = (sample.match(/[\u0370-\u03FF]/g) || []).length;
  const latin    = (sample.match(/[a-zA-Z]/g) || []).length;

  const total = arabic + hebrew + cjkAll + hiragana + katakana + hangul + cyrillic + thai + devanag + bengali + greek + latin || 1;
  const pct = v => v / total;

  if (pct(arabic)   > 0.25) return 'Arabic';
  if (pct(hebrew)   > 0.25) return 'Hebrew';
  if (hiragana + katakana > 20) return 'Japanese';
  if (pct(hangul)   > 0.20) return 'Korean';
  if (pct(cjkAll)   > 0.20) return 'Chinese (Simplified)';
  if (pct(cyrillic) > 0.25) return 'Russian';
  if (pct(thai)     > 0.20) return 'Thai';
  if (pct(devanag)  > 0.20) return 'Hindi';
  if (pct(bengali)  > 0.20) return 'Bengali';
  if (pct(greek)    > 0.20) return 'Greek';
  return ''; // Latin — too ambiguous without a full language model
}

const TEXT_FILE_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.csv',
  '.log',
  '.json',
  '.html',
  '.htm',
  '.xml',
  '.rtf',
]);

class TranslationImportService {
  constructor({ store, eventBus, logger, ocrProjectService }) {
    this.store = store;
    this.eventBus = eventBus;
    this.logger = logger;
    this.ocrProjectService = ocrProjectService;
    this.textNormalizationService = new TextNormalizationService();
    this.textChunkingService = new TextChunkingService();
    this.wordExtractor = new WordExtractor();
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

  async prepareProject({ filePath, originalName, sourceLanguage = '', targetLanguage = '', maxChars = 1400 }) {
    if (!filePath) {
      throw new Error('A local file path is required to create a translation project.');
    }

    const projectId = uuidv4();
    const projectDir = this.store.getProjectDir(projectId);
    const sourceDir = path.join(projectDir, 'source');
    const copiedSourcePath = path.join(sourceDir, path.basename(filePath));
    const normalizedTextPath = path.join(projectDir, 'normalized.txt');

    await this.store.withState(async state => {
      state.projects[projectId] = {
        id: projectId,
        title: path.basename(originalName || filePath, path.extname(originalName || filePath)),
        sourceKind: 'file-import',
        sourceFileName: originalName || path.basename(filePath),
        sourceFilePath: filePath,
        sourceCopyPath: copiedSourcePath,
        normalizedTextPath,
        projectDir,
        linkedOcrProjectId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastOpenedAt: new Date().toISOString(),
        importState: 'Preparing',
        importError: null,
        sourceLanguage,
        targetLanguage,
        provider: '',
        model: '',
        chunkSize: maxChars,
        chunkIds: [],
        chunks: {},
        runIds: [],
        latestRunId: null,
        latestEditorDocumentId: null,
        sourceStats: {},
      };
    });

    (async () => {
      try {
        await fse.ensureDir(sourceDir);
        await fse.copy(filePath, copiedSourcePath);

        const extractedText = await this.extractText(copiedSourcePath);
        const normalizedText = this.textNormalizationService.normalizeText(extractedText);
        const chunks = this.textChunkingService.buildFromPlainText({ text: normalizedText, maxChars });

        // Auto-detect source language if the caller did not provide one
        const detectedSourceLanguage = sourceLanguage || detectLanguageFromText(normalizedText);

        await fse.ensureDir(projectDir);
        await fse.writeFile(normalizedTextPath, normalizedText, 'utf8');

        await this.store.withState(async state => {
          const project = state.projects[projectId];
          if (!project) return;

          if (detectedSourceLanguage) project.sourceLanguage = detectedSourceLanguage;

          project.chunkIds = [];
          project.chunks = {};
          for (const chunk of chunks) {
            const chunkId = uuidv4();
            project.chunkIds.push(chunkId);
            project.chunks[chunkId] = {
              id: chunkId,
              index: chunk.chunkNumber - 1,
              chunkNumber: chunk.chunkNumber,
              pageNumber: chunk.pageNumber || null,
              sourceLabel: chunk.sourceLabel,
              sourceText: chunk.sourceText,
              translatedText: '',
              latestRunId: null,
              latestTranslationState: 'Pending',
              lastError: null,
              diagnostics: null,
              updatedAt: new Date().toISOString(),
            };
          }

          project.importState = 'Ready';
          project.importError = null;
          project.sourceStats = {
            characterCount: normalizedText.length,
            chunkCount: project.chunkIds.length,
          };
          project.updatedAt = new Date().toISOString();
        });

        this.logger.info('translation.project.prepare.completed', {
          projectId,
          chunkCount: chunks.length,
          sourceFileName: originalName || path.basename(filePath),
        });
      } catch (error) {
        await this.store.withState(async state => {
          const project = state.projects[projectId];
          if (!project) return;
          project.importState = 'Failed';
          project.importError = error.message;
          project.updatedAt = new Date().toISOString();
        });
        this.logger.error('translation.project.prepare.failed', { projectId, error: error.message });
      } finally {
        const state = await this.store.loadState();
        this.emitProjectUpdate(projectId, state);
      }
    })();

    const state = await this.store.loadState();
    return this.store.buildProjectSnapshot(state.projects[projectId], null);
  }

  async prepareProjectFromOCR({ ocrProjectId, targetLanguage = '', maxChars = 1400 }) {
    if (!ocrProjectId) {
      throw new Error('An OCR project id is required.');
    }

    const ocrSnapshot = await this.ocrProjectService.getProject(ocrProjectId);
    if (!ocrSnapshot?.pages?.length) {
      throw new Error('The OCR project does not have any pages to translate.');
    }

    const projectId = uuidv4();
    const projectDir = this.store.getProjectDir(projectId);
    const normalizedTextPath = path.join(projectDir, 'normalized.txt');
    const pagePayload = ocrSnapshot.pages.map(page => ({
      pageNumber: page.pageNumber,
      text: page.latestText || '',
    }));
    const chunks = this.textChunkingService.buildFromPages({ pages: pagePayload, maxChars });
    const normalizedText = pagePayload.map(page => page.text || '').join('\n\n');

    await this.store.withState(async state => {
      state.projects[projectId] = {
        id: projectId,
        title: `${ocrSnapshot.title || ocrSnapshot.sourceFileName} — Translation`,
        sourceKind: 'ocr-project',
        sourceFileName: ocrSnapshot.sourceFileName,
        sourceFilePath: null,
        sourceCopyPath: null,
        normalizedTextPath,
        projectDir,
        linkedOcrProjectId: ocrProjectId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastOpenedAt: new Date().toISOString(),
        importState: 'Preparing',
        importError: null,
        sourceLanguage: ocrSnapshot.latestRun?.resolvedLanguage?.displayName || ocrSnapshot.detectedLanguage?.displayName || '',
        targetLanguage,
        provider: '',
        model: '',
        chunkSize: maxChars,
        chunkIds: [],
        chunks: {},
        runIds: [],
        latestRunId: null,
        latestEditorDocumentId: null,
        sourceStats: {},
      };
    });

    try {
      await fse.ensureDir(projectDir);
      await fse.writeFile(normalizedTextPath, normalizedText, 'utf8');

      await this.store.withState(async state => {
        const project = state.projects[projectId];
        if (!project) return;
        project.chunkIds = [];
        project.chunks = {};

        for (const chunk of chunks) {
          const chunkId = uuidv4();
          project.chunkIds.push(chunkId);
          project.chunks[chunkId] = {
            id: chunkId,
            index: chunk.chunkNumber - 1,
            chunkNumber: chunk.chunkNumber,
            pageNumber: chunk.pageNumber || null,
            sourceLabel: chunk.sourceLabel || null,
            sourceText: chunk.sourceText,
            translatedText: '',
            latestRunId: null,
            latestTranslationState: 'Pending',
            lastError: null,
            diagnostics: null,
            updatedAt: new Date().toISOString(),
          };
        }

        project.importState = 'Ready';
        project.importError = null;
        project.sourceStats = {
          characterCount: normalizedText.length,
          chunkCount: project.chunkIds.length,
          linkedOcrProjectId: ocrProjectId,
        };
        project.updatedAt = new Date().toISOString();
      });

      this.logger.info('translation.project.prepare_from_ocr.completed', {
        projectId,
        ocrProjectId,
        chunkCount: chunks.length,
      });
    } catch (error) {
      await this.store.withState(async state => {
        const project = state.projects[projectId];
        if (!project) return;
        project.importState = 'Failed';
        project.importError = error.message;
        project.updatedAt = new Date().toISOString();
      });
      this.logger.error('translation.project.prepare_from_ocr.failed', {
        projectId,
        ocrProjectId,
        error: error.message,
      });
    } finally {
      const state = await this.store.loadState();
      this.emitProjectUpdate(projectId, state);
    }

    const state = await this.store.loadState();
    return this.store.buildProjectSnapshot(state.projects[projectId], null);
  }

  async extractText(filePath) {
    const extension = path.extname(filePath).toLowerCase();

    if (TEXT_FILE_EXTENSIONS.has(extension)) {
      return this.textNormalizationService.readFile(filePath);
    }

    if (extension === '.pdf') {
      const buffer = await fse.readFile(filePath);
      const parsed = await pdfParse(buffer);
      return parsed.text || '';
    }

    if (extension === '.docx') {
      const extracted = await mammoth.extractRawText({ path: filePath });
      return extracted.value || '';
    }

    if (extension === '.doc') {
      const doc = await this.wordExtractor.extract(filePath);
      return doc.getBody() || '';
    }

    throw new Error(`Unsupported translation import format: ${extension}`);
  }
}

module.exports = { TranslationImportService };
