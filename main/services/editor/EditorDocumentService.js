const path = require('path');
const fse = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

class EditorDocumentService {
  constructor({ dataDir, logger, eventBus }) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.eventBus = eventBus;
    this.dbPath = path.join(dataDir, 'editor_documents.json');
    this.mutationChain = Promise.resolve();
  }

  async init() {
    await fse.ensureDir(this.dataDir);
    if (!(await fse.pathExists(this.dbPath))) {
      await fse.writeJson(this.dbPath, {
        version: 1,
        documents: {},
        meta: {
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }, { spaces: 2 });
    }
  }

  async loadState() {
    await this.init();
    return fse.readJson(this.dbPath);
  }

  async withState(mutator) {
    const runMutation = async () => {
      const state = await this.loadState();
      const result = await mutator(state);
      state.meta.updatedAt = new Date().toISOString();
      await fse.writeJson(this.dbPath, state, { spaces: 2 });
      return result;
    };

    const nextMutation = this.mutationChain.then(runMutation, runMutation);
    this.mutationChain = nextMutation.then(() => undefined, () => undefined);
    return nextMutation;
  }

  async createOrUpdateFromTranslation(snapshot) {
    return this.withState(async state => {
      const existingId = snapshot.latestEditorDocumentId || uuidv4();
      const text = snapshot.chunks
        .map(chunk => chunk.translatedText || chunk.sourceText || '')
        .join('\n\n')
        .trim();

      state.documents[existingId] = {
        id: existingId,
        sourceProjectId: snapshot.id,
        title: `${snapshot.title || 'Translation'} — Editor`,
        content: text,
        createdAt: state.documents[existingId]?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastOpenedAt: state.documents[existingId]?.lastOpenedAt || null,
      };

      this.emitDocumentUpdated(state.documents[existingId]);
      return state.documents[existingId];
    });
  }

  async getDocument(documentId) {
    const state = await this.loadState();
    const document = state.documents[documentId];
    if (!document) throw new Error('Editor document not found.');
    return document;
  }

  async getDocumentIfExists(documentId) {
    const state = await this.loadState();
    return state.documents[documentId] || null;
  }

  async updateDocument(documentId, content) {
    return this.withState(async state => {
      const document = state.documents[documentId];
      if (!document) throw new Error('Editor document not found.');
      document.content = content || '';
      document.updatedAt = new Date().toISOString();
      this.emitDocumentUpdated(document);
      return document;
    });
  }

  async markDocumentOpened(documentId) {
    return this.withState(async state => {
      const document = state.documents[documentId];
      if (!document) throw new Error('Editor document not found.');
      document.lastOpenedAt = new Date().toISOString();
      document.updatedAt = new Date().toISOString();
      this.emitDocumentUpdated(document);
      return document;
    });
  }

  async deleteDocument(documentId) {
    return this.withState(async state => {
      const document = state.documents[documentId];
      if (!document) return { ok: true };
      delete state.documents[documentId];
      if (this.eventBus) {
        this.eventBus.emit('editor:document-deleted', {
          documentId,
          sourceProjectId: document.sourceProjectId || null,
        });
      }
      return { ok: true };
    });
  }

  emitDocumentUpdated(document) {
    if (!this.eventBus || !document) return;
    this.eventBus.emit('editor:document-updated', {
      documentId: document.id,
      sourceProjectId: document.sourceProjectId || null,
      document: {
        id: document.id,
        sourceProjectId: document.sourceProjectId || null,
        title: document.title,
        updatedAt: document.updatedAt,
        lastOpenedAt: document.lastOpenedAt || null,
      },
    });
  }
}

module.exports = { EditorDocumentService };
