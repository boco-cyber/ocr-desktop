/**
 * Local OCR provider for ocr-desktop — powered by PaddleOCR (Python subprocess).
 *
 * Exports: { ocr({ imageBase64, lang, runtimeConfig }) }
 * lang: ISO language code (e.g. 'en', 'ar', 'zh', 'fr')
 *
 * Spawns paddleocr_worker.py once per (lang, device) combination and reuses
 * the process for subsequent pages (persistent server mode).
 */

const path = require('path');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const WORKER_PATH = path.join(__dirname, 'paddleocr_worker.py');

// Cache: key = `${lang}:${device}` → { process, pending: Map<id, {resolve, reject}>, ready: bool }
const _procs = new Map();

function getPythonCommand(runtimeConfig = {}) {
  const raw = (runtimeConfig.paddlePythonPath || runtimeConfig.pythonPath || '').trim();
  if (!raw) {
    return process.platform === 'win32' ? { cmd: 'py', args: ['-3'] } : { cmd: 'python3', args: [] };
  }
  const parts = raw.match(/"[^"]+"|'[^']+'|\S+/g) || [];
  const normalized = parts.map(p => p.replace(/^['"]|['"]$/g, ''));
  return { cmd: normalized[0], args: normalized.slice(1) };
}

function launchWorker(lang, device, runtimeConfig) {
  const key = `${lang}:${device}`;
  if (_procs.has(key)) return _procs.get(key);

  const { cmd, args } = getPythonCommand(runtimeConfig);
  const child = spawn(cmd, [...args, WORKER_PATH, lang, device], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const entry = {
    process: child,
    pending: new Map(),
    ready: false,
    readyWaiters: [],
    runtimeConfig,
  };
  _procs.set(key, entry);

  let buf = '';
  let stderrBuf = '';

  child.stdout.on('data', chunk => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'ready') {
          entry.ready = true;
          for (const fn of entry.readyWaiters) fn(null);
          entry.readyWaiters = [];
          continue;
        }
        if (msg.id && entry.pending.has(msg.id)) {
          const { resolve, reject } = entry.pending.get(msg.id);
          entry.pending.delete(msg.id);
          if (msg.error) {
            reject(new Error(msg.error));
          } else {
            resolve(msg.text || '');
          }
        }
      } catch {}
    }
  });

  child.stderr.on('data', chunk => {
    stderrBuf += chunk.toString();
    // Keep only the last 3000 chars to avoid unbounded growth
    if (stderrBuf.length > 3000) stderrBuf = stderrBuf.slice(-3000);
  });

  child.on('error', err => {
    const detail = stderrBuf.trim() ? `\n${stderrBuf.trim()}` : '';
    const msg = `PaddleOCR worker failed to start: ${err.message}. Install paddlepaddle + paddleocr and check your Python path in Settings.${detail}`;
    for (const fn of entry.readyWaiters) fn(new Error(msg));
    entry.readyWaiters = [];
    for (const { reject } of entry.pending.values()) reject(new Error(msg));
    entry.pending.clear();
    _procs.delete(key);
  });

  child.on('close', code => {
    if (!entry.ready) {
      // Process exited before signalling ready — surface stderr immediately
      const detail = stderrBuf.trim()
        ? `\nPython output:\n${stderrBuf.trim()}`
        : '';
      const msg = `PaddleOCR worker exited (code ${code}) before becoming ready. Check that paddlepaddle and paddleocr are installed for your Python.${detail}`;
      const err = new Error(msg);
      for (const fn of entry.readyWaiters) fn(err);
      entry.readyWaiters = [];
      for (const { reject } of entry.pending.values()) reject(err);
      entry.pending.clear();
    } else if (code !== 0 && entry.pending.size > 0) {
      const detail = stderrBuf.trim() ? `\n${stderrBuf.trim()}` : '';
      const msg = `PaddleOCR worker exited unexpectedly (code ${code}). Check Settings → PaddleOCR for Python path.${detail}`;
      for (const { reject } of entry.pending.values()) reject(new Error(msg));
      entry.pending.clear();
    }
    _procs.delete(key);
  });

  return entry;
}

function waitReady(entry) {
  if (entry.ready) return Promise.resolve();
  return new Promise((resolve, reject) => {
    entry.readyWaiters.push(err => err ? reject(err) : resolve());
  });
}

async function ocr({ imageBase64, lang = 'en', runtimeConfig = {} } = {}) {
  const device = runtimeConfig.paddleDevice || 'auto';
  const key = `${lang}:${device}`;
  const entry = launchWorker(lang, device, runtimeConfig);

  // Wait for the worker to signal ready (model loaded)
  await Promise.race([
    waitReady(entry),
    new Promise((_, reject) => setTimeout(() => reject(new Error('PaddleOCR worker did not start within 120s. Check your Python environment.')), 120000)),
  ]);

  const id = uuidv4();
  return new Promise((resolve, reject) => {
    entry.pending.set(id, { resolve, reject });
    try {
      entry.process.stdin.write(JSON.stringify({ id, imageBase64, lang, device }) + '\n');
    } catch (err) {
      entry.pending.delete(id);
      _procs.delete(key);
      reject(new Error(`Could not send request to PaddleOCR worker: ${err.message}`));
    }
  });
}

/** Terminate all cached workers (e.g. when settings change) */
async function resetPythonCache() {
  for (const [key, entry] of _procs) {
    try {
      entry.process.stdin.write(JSON.stringify({ type: 'exit' }) + '\n');
    } catch {}
    try { entry.process.kill(); } catch {}
    _procs.delete(key);
  }
}

module.exports = { ocr, resetPythonCache };
