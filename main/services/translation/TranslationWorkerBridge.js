const path = require('path');
const { fork } = require('child_process');

class TranslationWorkerBridge {
  constructor({ logger, workerTimeoutMs = 10 * 60 * 1000 }) {
    this.logger = logger;
    this.workerTimeoutMs = workerTimeoutMs;
    this.workerPath = path.join(__dirname, '..', '..', '..', 'workers', 'translation-worker.js');
  }

  setWorkerTimeoutMs(timeoutMs) {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) return;
    this.workerTimeoutMs = timeoutMs;
  }

  async healthCheck(payload) {
    return new Promise(resolve => {
      const child = fork(this.workerPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
      let stderr = '';
      let settled = false;

      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill(); } catch {}
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish({
          ok: false,
          error: stderr ? `Translation worker health check timed out. ${stderr.trim()}` : 'Translation worker health check timed out.',
        });
      }, 20000);

      child.stderr?.on('data', chunk => {
        stderr += chunk.toString();
      });

      child.on('message', message => {
        if (message?.type === 'ready') {
          if (!payload?.provider) {
            child.send({ type: 'ping' });
            return;
          }
          child.send({ type: 'health-check', payload });
          return;
        }
        if (message?.type === 'pong') {
          finish({ ok: true, error: null });
          return;
        }
        if (message?.type === 'health-check-result') {
          finish({ ok: Boolean(message.ok), error: message.error || null });
        }
      });

      child.on('error', error => {
        finish({ ok: false, error: error.message });
      });

      child.on('exit', code => {
        if (!settled && code && code !== 0) {
          finish({ ok: false, error: stderr.trim() || `Translation worker exited with code ${code}` });
        }
      });
    });
  }

  async runChunk(payload) {
    return new Promise((resolve, reject) => {
      const child = fork(this.workerPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
      let stderr = '';
      let settled = false;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill(); } catch {}
        fn(value);
      };

      const timer = setTimeout(() => {
        this.logger.error('translation.worker.timeout', {
          runId: payload.runId,
          chunkId: payload.chunkId,
          projectId: payload.projectId,
          stderr: stderr.trim() || null,
        });
        finish(reject, new Error('Translation worker timed out.'));
      }, this.workerTimeoutMs);

      child.stderr?.on('data', chunk => {
        stderr += chunk.toString();
      });

      child.on('message', message => {
        if (message?.type === 'ready') {
          child.send({ type: 'translate-chunk', payload });
          return;
        }

        if (message?.type !== 'translate-chunk-result') return;
        if (!message.ok) {
          finish(reject, new Error(message.error));
          return;
        }

        finish(resolve, {
          text: message.text || '',
          diagnostics: message.diagnostics || null,
        });
      });

      child.on('error', error => {
        finish(reject, error);
      });

      child.on('exit', code => {
        if (!settled && code !== 0) {
          finish(reject, new Error(stderr.trim() || `Translation worker exited with code ${code}`));
        }
      });
    });
  }
}

module.exports = { TranslationWorkerBridge };
