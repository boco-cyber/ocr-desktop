const path = require('path');
const fse = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

class DocumentService {
  constructor({ dataDir, logger, eventBus }) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.eventBus = eventBus;
    this.dbPath = path.join(dataDir, 'documents.json');
    this.mutationChain = Promise.resolve();
  }

  async init() {
    await fse.ensureDir(this.dataDir);
    if (!(await fse.pathExists(this.dbPath))) {
      await fse.writeJson(this.dbPath, { version: 1, documents: {}, meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }, { spaces: 2 });
    }
  }

  async loadState() {
    await this.init();
    return fse.readJson(this.dbPath);
  }

  async withState(mutator) {
    const run = async () => {
      const state = await this.loadState();
      const result = await mutator(state);
      state.meta.updatedAt = new Date().toISOString();
      await fse.writeJson(this.dbPath, state, { spaces: 2 });
      return result;
    };
    const next = this.mutationChain.then(run, run);
    this.mutationChain = next.then(() => undefined, () => undefined);
    return next;
  }

  // ── Create blank document ─────────────────────────────────────────────────
  async createBlank({ name } = {}) {
    return this.withState(async state => {
      const id = uuidv4();
      const now = new Date().toISOString();
      const doc = {
        id,
        type: 'editable-pdf',
        name: name || 'Untitled Document',
        createdAt: now,
        updatedAt: now,
        originalFile: null,
        output: null,
        pages: [this._blankPage()],
      };
      state.documents[id] = doc;
      this._emit('document-updated', doc);
      return doc;
    });
  }

  // ── Store parsed document from worker ────────────────────────────────────
  async createFromParsed({ name, originalFile, pages }) {
    return this.withState(async state => {
      const id = uuidv4();
      const now = new Date().toISOString();
      const doc = {
        id,
        type: 'editable-pdf',
        name: name || path.basename(originalFile || 'document'),
        createdAt: now,
        updatedAt: now,
        originalFile: originalFile || null,
        output: null,
        pages: pages || [this._blankPage()],
      };
      state.documents[id] = doc;
      this._emit('document-updated', doc);
      return doc;
    });
  }

  async getDocument(documentId) {
    const state = await this.loadState();
    const doc = state.documents[documentId];
    if (!doc) throw new Error(`Document not found: ${documentId}`);
    return doc;
  }

  async listDocuments() {
    const state = await this.loadState();
    return Object.values(state.documents)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      .map(d => ({ id: d.id, name: d.name, createdAt: d.createdAt, updatedAt: d.updatedAt, pageCount: d.pages?.length || 0 }));
  }

  async updateDocument(doc) {
    return this.withState(async state => {
      if (!state.documents[doc.id]) throw new Error('Document not found');
      state.documents[doc.id] = { ...doc, updatedAt: new Date().toISOString() };
      this._emit('document-updated', state.documents[doc.id]);
      return state.documents[doc.id];
    });
  }

  async addPage(documentId, afterPageId) {
    return this.withState(async state => {
      const doc = state.documents[documentId];
      if (!doc) throw new Error('Document not found');
      const newPage = this._blankPage();
      if (afterPageId) {
        const idx = doc.pages.findIndex(p => p.id === afterPageId);
        doc.pages.splice(idx < 0 ? doc.pages.length : idx + 1, 0, newPage);
      } else {
        doc.pages.push(newPage);
      }
      doc.updatedAt = new Date().toISOString();
      this._emit('document-updated', doc);
      return doc;
    });
  }

  async removePage(documentId, pageId) {
    return this.withState(async state => {
      const doc = state.documents[documentId];
      if (!doc) throw new Error('Document not found');
      if (doc.pages.length <= 1) throw new Error('Cannot remove the last page');
      doc.pages = doc.pages.filter(p => p.id !== pageId);
      doc.updatedAt = new Date().toISOString();
      this._emit('document-updated', doc);
      return doc;
    });
  }

  async reorderPages(documentId, orderedPageIds) {
    return this.withState(async state => {
      const doc = state.documents[documentId];
      if (!doc) throw new Error('Document not found');
      const pageMap = Object.fromEntries(doc.pages.map(p => [p.id, p]));
      doc.pages = orderedPageIds.map(id => pageMap[id]).filter(Boolean);
      doc.updatedAt = new Date().toISOString();
      this._emit('document-updated', doc);
      return doc;
    });
  }

  async deleteDocument(documentId) {
    return this.withState(async state => {
      delete state.documents[documentId];
      return { ok: true };
    });
  }

  _blankPage() {
    return {
      id: uuidv4(),
      width: 794,   // A4 at 96dpi
      height: 1123,
      elements: [],
    };
  }

  _emit(event, data) {
    if (this.eventBus) this.eventBus.emit(`document:${event}`, data);
  }
}

module.exports = { DocumentService };
