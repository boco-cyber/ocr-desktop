const path = require('path');
const fse = require('fs-extra');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');

class EditorDocumentService {
  constructor({ dataDir, logger, eventBus, settingsService }) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.eventBus = eventBus;
    this.settingsService = settingsService || null;
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

      // Build HTML content: each chunk becomes one or more <p> paragraphs
      const escapeHtml = s => s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      const html = snapshot.chunks
        .map(chunk => chunk.translatedText || chunk.sourceText || '')
        .filter(Boolean)
        .flatMap(text => text.split(/\n{2,}/))
        .map(para => `<p>${escapeHtml(para.trim()).replace(/\n/g, '<br>')}</p>`)
        .join('');

      state.documents[existingId] = {
        id: existingId,
        sourceProjectId: snapshot.id,
        title: `${snapshot.title || 'Translation'} — Editor`,
        content: html,
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

  /**
   * Run an AI text-editing task for the editor.
   * payload: { provider, model, apiKey, prompt }
   * Returns: { result: string }
   */
  async runAi({ provider, model, apiKey, baseUrl, prompt }) {
    if (!provider) throw new Error('provider is required');
    if (!prompt)   throw new Error('prompt is required');

    // Resolve saved API key for cloud providers when none is passed
    let resolvedKey = apiKey;
    if (!resolvedKey && ['anthropic', 'openai', 'gemini'].includes(provider) && this.settingsService) {
      resolvedKey = await this.settingsService.getSecret(provider);
    }

    switch (provider) {
      case 'anthropic': return this._runAiAnthropic({ model, apiKey: resolvedKey, prompt });
      case 'openai':    return this._runAiOpenAi({ model, apiKey: resolvedKey, prompt });
      case 'gemini':    return this._runAiGemini({ model, apiKey: resolvedKey, prompt });
      case 'ollama':    return this._runAiOllama({ model, baseUrl, prompt });
      default: throw new Error(`Unknown AI provider: ${provider}`);
    }
  }

  async _runAiAnthropic({ model, apiKey, prompt }) {
    if (!apiKey) throw new Error('Anthropic API key is required');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-6',
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Anthropic error ${response.status}: ${err?.error?.message || response.statusText}`);
    }
    const data = await response.json();
    return { ok: true, text: data.content?.[0]?.text || '' };
  }

  async _runAiOpenAi({ model, apiKey, prompt }) {
    if (!apiKey) throw new Error('OpenAI API key is required');
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'gpt-4o',
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`OpenAI error ${response.status}: ${err?.error?.message || response.statusText}`);
    }
    const data = await response.json();
    return { ok: true, text: data.choices?.[0]?.message?.content || '' };
  }

  async _runAiGemini({ model, apiKey, prompt }) {
    if (!apiKey) throw new Error('Gemini API key is required');
    const m = model || 'gemini-1.5-pro';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 8192 },
      }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Gemini error ${response.status}: ${err?.error?.message || response.statusText}`);
    }
    const data = await response.json();
    return { ok: true, text: data.candidates?.[0]?.content?.parts?.[0]?.text || '' };
  }

  async _runAiOllama({ model, baseUrl, prompt }) {
    const base = (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'llama3',
        stream: false,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) {
      throw new Error(`Ollama error ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    return { ok: true, text: data.message?.content || '' };
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
