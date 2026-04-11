/**
 * DocumentWorkerBridge — manages the document-worker.js child process.
 * Sends messages and resolves promises when the worker responds.
 */
'use strict';

const path = require('path');
const { fork } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const WORKER_PATH = path.join(__dirname, '../../../workers/document-worker.js');

class DocumentWorkerBridge {
  constructor({ logger }) {
    this.logger = logger;
    this._worker = null;
    this._pending = new Map(); // id → { resolve, reject }
  }

  _ensureWorker() {
    if (this._worker && !this._worker.killed) return;
    this._worker = fork(WORKER_PATH, [], { silent: false });
    this._worker.on('message', msg => {
      const handler = this._pending.get(msg.id);
      if (!handler) return;
      this._pending.delete(msg.id);
      if (msg.ok) handler.resolve(msg.result);
      else handler.reject(new Error(msg.error || 'Worker error'));
    });
    this._worker.on('error', err => {
      this.logger?.error('document-worker error', { err: err.message });
    });
    this._worker.on('exit', () => {
      // Reject any pending on unexpected exit
      for (const [id, h] of this._pending) {
        h.reject(new Error('Worker exited unexpectedly'));
        this._pending.delete(id);
      }
      this._worker = null;
    });
  }

  send(type, payload) {
    this._ensureWorker();
    return new Promise((resolve, reject) => {
      const id = uuidv4();
      this._pending.set(id, { resolve, reject });
      this._worker.send({ id, type, payload });
    });
  }

  parsePdf(filePath) {
    return this.send('parse_pdf', { filePath });
  }

  exportPdf(document, outputPath) {
    return this.send('export_pdf', { document, outputPath });
  }

  removeBg(imagePath, outputPath) {
    return this.send('remove_bg', { imagePath, outputPath });
  }

  kill() {
    if (this._worker) { this._worker.kill(); this._worker = null; }
  }
}

module.exports = { DocumentWorkerBridge };
