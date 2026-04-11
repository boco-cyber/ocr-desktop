const path = require('path');
const { fork } = require('child_process');

class OCRWorkerBridge {
  constructor({ logger, workerTimeoutMs = 10 * 60 * 1000 }) {
    this.logger = logger;
    this.workerTimeoutMs = workerTimeoutMs;
    this.workerPath = path.join(__dirname, '..', '..', '..', 'workers', 'ocr-worker.js');
  }

  setWorkerTimeoutMs(timeoutMs) {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) return;
    this.workerTimeoutMs = timeoutMs;
  }

  async healthCheck() {
    return new Promise(resolve => {
      const child = fork(this.workerPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        resolve({ ok: false, error: stderr ? `OCR worker health check timed out. ${stderr.trim()}` : 'OCR worker health check timed out.' });
      }, 5000);

      child.stderr?.on('data', chunk => {
        stderr += chunk.toString();
      });

      child.on('message', message => {
        if (message?.type === 'ready') {
          child.send({ type: 'ping' });
          return;
        }
        if (message?.type === 'pong') {
          clearTimeout(timer);
          child.kill();
          resolve({ ok: true });
        }
      });

      child.on('error', error => {
        clearTimeout(timer);
        resolve({ ok: false, error: error.message });
      });

      child.on('exit', code => {
        if (code && code !== 0) {
          clearTimeout(timer);
          resolve({ ok: false, error: stderr.trim() || `OCR worker exited with code ${code}` });
        }
      });
    });
  }

  async runPage(payload) {
    return new Promise((resolve, reject) => {
      const child = fork(this.workerPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
      let stderr = '';
      let settled = false;
      const finalize = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill(); } catch {}
        fn(value);
      };

      const timer = setTimeout(() => {
        this.logger.error('ocr.worker.timeout', {
          runId: payload.runId,
          pageId: payload.pageId,
          projectId: payload.projectId,
          stderr: stderr.trim() || null,
        });
        finalize(reject, new Error('OCR worker timed out.'));
      }, this.workerTimeoutMs);

      child.stderr?.on('data', chunk => {
        stderr += chunk.toString();
      });

      child.on('message', message => {
        if (message?.type === 'ready') {
          this.logger.info('ocr.worker.ready', {
            runId: payload.runId,
            pageId: payload.pageId,
          });
          child.send({ type: 'ocr-page', payload });
          return;
        }

        if (message?.type !== 'ocr-page-result') return;
        if (!message.ok) {
          this.logger.error('ocr.worker.page_failed', {
            runId: payload.runId,
            pageId: payload.pageId,
            error: message.error,
          });
          finalize(reject, new Error(message.error));
          return;
        }

        this.logger.info('ocr.worker.page_completed', {
          runId: payload.runId,
          pageId: payload.pageId,
        });
        finalize(resolve, {
          text: message.text || '',
        });
      });

      child.on('error', error => {
        this.logger.error('ocr.worker.process_error', {
          runId: payload.runId,
          pageId: payload.pageId,
          error: error.message,
          stderr: stderr.trim() || null,
        });
        finalize(reject, error);
      });

      child.on('exit', code => {
        if (!settled && code !== 0) {
          const error = new Error(stderr.trim() || `OCR worker exited with code ${code}`);
          this.logger.error('ocr.worker.exit', {
            runId: payload.runId,
            pageId: payload.pageId,
            code,
            stderr: stderr.trim() || null,
          });
          finalize(reject, error);
        }
      });
    });
  }
}

module.exports = { OCRWorkerBridge };
