const path = require('path');
const { fork, spawn } = require('child_process');
const { NLLB_LANGUAGE_CODES } = require('./translationHelpers');

const NLLB_WORKER_PATH = path.join(__dirname, '..', '..', '..', 'workers', 'nllb-translate.py');

// Give NLLB chunks a generous timeout: the first chunk must load the model into memory,
// which can take several minutes for the 1.3B variant on CPU.
const NLLB_CHUNK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function parsePythonCommand(commandInput) {
  const trimmed = (commandInput || '').trim();
  if (!trimmed) {
    return process.platform === 'win32'
      ? { command: 'py', args: ['-3'] }
      : { command: 'python3', args: [] };
  }
  const parts = trimmed.match(/"[^"]+"|'[^']+'|\S+/g) || [];
  const normalized = parts.map(p => p.replace(/^['"]|['"]$/g, ''));
  return { command: normalized[0], args: normalized.slice(1) };
}

function detectNllbSourceLang(text) {
  const sample = text.slice(0, 500);
  const arabicChars   = (sample.match(/[\u0600-\u06FF]/g) || []).length;
  const cjkChars      = (sample.match(/[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
  const cyrillicChars = (sample.match(/[\u0400-\u04FF]/g) || []).length;
  const latinChars    = (sample.match(/[a-zA-Z]/g) || []).length;
  const total = arabicChars + cjkChars + cyrillicChars + latinChars || 1;
  if (arabicChars / total > 0.3) return 'arb_Arab';
  if (cyrillicChars / total > 0.3) return 'rus_Cyrl';
  if (cjkChars / total > 0.3) return 'zho_Hans';
  return 'eng_Latn';
}

/**
 * Manages a persistent Python NLLB process.
 *
 * The Python daemon loads the model once and stays alive across chunks,
 * communicating via newline-delimited JSON over stdin/stdout.
 */
class NllbDaemon {
  constructor({ pythonCmd, logger }) {
    this.pythonCmd = pythonCmd;
    this.logger = logger;
    this._proc = null;
    this._ready = false;
    this._buffer = '';
    this._stderr = '';
    this._pending = null;       // { resolve, reject, timer }
    this._readyResolve = null;
    this._readyReject = null;
  }

  async start() {
    this._proc = spawn(
      this.pythonCmd.command,
      [...this.pythonCmd.args, NLLB_WORKER_PATH, '--daemon'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    this._proc.stderr?.on('data', chunk => { this._stderr += chunk.toString(); });

    this._proc.stdout.on('data', chunk => {
      this._buffer += chunk.toString();
      const lines = this._buffer.split('\n');
      this._buffer = lines.pop(); // keep the incomplete trailing fragment
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) this._onLine(trimmed);
      }
    });

    this._proc.on('error', err => {
      this._ready = false;
      const msg = `Could not start Python: ${err.message}. Set the Python path in Settings → Runtimes.`;
      if (this._readyReject) {
        const fn = this._readyReject;
        this._readyResolve = null;
        this._readyReject = null;
        fn(new Error(msg));
      }
      this._settlePending(null, new Error(msg));
    });

    this._proc.on('close', () => {
      this._ready = false;
      const msg = this._stderr.trim() || 'NLLB daemon exited unexpectedly.';
      if (this._readyReject) {
        const fn = this._readyReject;
        this._readyResolve = null;
        this._readyReject = null;
        fn(new Error(msg));
      }
      this._settlePending(null, new Error(msg));
      this._proc = null;
    });

    // Wait for the "ready" JSON line from the Python process (fast — no model load yet)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`NLLB daemon did not start within 60 seconds. ${this._stderr.trim()}`));
      }, 60 * 1000);

      this._readyResolve = () => { clearTimeout(timer); resolve(); };
      this._readyReject  = (err) => { clearTimeout(timer); reject(err); };
    });
  }

  _onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    // Startup handshake
    if (msg.status === 'ready') {
      if (msg.ok && this._readyResolve) {
        const fn = this._readyResolve;
        this._readyResolve = null;
        this._readyReject  = null;
        this._ready = true;
        fn();
      } else if (!msg.ok && this._readyReject) {
        const fn = this._readyReject;
        this._readyResolve = null;
        this._readyReject  = null;
        fn(new Error(msg.error || 'NLLB daemon failed to initialize.'));
      }
      return;
    }

    // Response to a translate (or health-check) request
    this._settlePending(msg, null);
  }

  _settlePending(result, error) {
    if (!this._pending) return;
    const { resolve, reject, timer } = this._pending;
    this._pending = null;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve(result);
  }

  send(payload, timeoutMs) {
    if (!this._ready || !this._proc) {
      return Promise.reject(new Error('NLLB daemon is not running.'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending = null;
        reject(new Error('Translation worker timed out.'));
      }, timeoutMs);
      this._pending = { resolve, reject, timer };
      try {
        this._proc.stdin.write(JSON.stringify(payload) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this._pending = null;
        reject(err);
      }
    });
  }

  isAlive() {
    return this._ready && this._proc !== null;
  }

  kill() {
    if (this._proc) {
      try { this._proc.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n'); } catch {}
      // Give Python a moment to clean up before we SIGKILL
      setTimeout(() => { try { this._proc?.kill(); } catch {} }, 500);
      this._proc = null;
    }
    this._ready = false;
  }
}

class TranslationWorkerBridge {
  constructor({ logger, workerTimeoutMs = 10 * 60 * 1000 }) {
    this.logger = logger;
    this.workerTimeoutMs = workerTimeoutMs;
    this.workerPath = path.join(__dirname, '..', '..', '..', 'workers', 'translation-worker.js');
    this._nllbDaemon    = null;
    this._nllbDaemonKey = null; // tracks config fingerprint; restart daemon if it changes
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
    // NLLB uses a persistent Python daemon (model loaded once, reused per chunk).
    // All other providers use the standard forked JS worker.
    if (payload?.provider === 'nllb') {
      return this._runNllbChunk(payload);
    }

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

  async _runNllbChunk(payload) {
    const runtimeConfig = payload.runtimeConfig || {};
    const pythonCmdStr  = runtimeConfig.nllbPythonPath || runtimeConfig.pythonPath || '';
    const pythonCmd     = parsePythonCommand(pythonCmdStr);
    const modelName     = payload.model || 'facebook/nllb-200-distilled-600M';
    const device        = runtimeConfig.nllbDevice || 'auto';

    // Fingerprint the daemon config so we can detect when it needs to restart
    const daemonKey = `${pythonCmd.command}|${pythonCmd.args.join(' ')}|${modelName}|${device}`;

    if (!this._nllbDaemon?.isAlive() || this._nllbDaemonKey !== daemonKey) {
      if (this._nllbDaemon) {
        this._nllbDaemon.kill();
        this._nllbDaemon = null;
      }
      this.logger.info('translation.nllb.daemon_start', { modelName, device });
      const daemon = new NllbDaemon({ pythonCmd, logger: this.logger });
      await daemon.start(); // waits for Python "ready" signal (fast — no model load yet)
      this._nllbDaemon    = daemon;
      this._nllbDaemonKey = daemonKey;
    }

    const targetNllb = NLLB_LANGUAGE_CODES[payload.targetLanguage];
    if (!targetNllb) {
      throw new Error(`NLLB does not support target language: "${payload.targetLanguage}". Choose a supported language.`);
    }
    const sourceNllb        = payload.sourceLanguage ? (NLLB_LANGUAGE_CODES[payload.sourceLanguage] || null) : null;
    const resolvedSourceLang = sourceNllb || detectNllbSourceLang(payload.text || '');

    // First chunk will be slow (model load + inference); subsequent chunks only pay inference.
    const result = await this._nllbDaemon.send({
      type:           'translate',
      text:           payload.text || '',
      model:          modelName,
      targetLanguage: targetNllb,
      sourceLanguage: resolvedSourceLang,
      device,
      maxMemoryGb:    runtimeConfig.nllbMemoryGb || 0,
    }, NLLB_CHUNK_TIMEOUT_MS);

    if (!result.ok) {
      throw new Error(result.error || 'NLLB translation failed.');
    }

    return {
      text:        result.text || '',
      diagnostics: { provider: 'nllb', model: modelName },
    };
  }
}

module.exports = { TranslationWorkerBridge };
