/**
 * PaddleOCR provider for ocr-desktop.
 * Spawns providers/paddleocr_worker.py via Python 3.11.
 *
 * Exports: { ocr({ imageBase64, lang }) }
 * lang: ISO language code (e.g. 'en', 'zh', 'ar') — mapped to PaddleOCR lang inside worker.
 */

const { spawn } = require('child_process');
const path = require('path');

const WORKER_SCRIPT = path.join(__dirname, 'paddleocr_worker.py');

// Candidates for the Python 3.11 executable on Windows
const PYTHON_CANDIDATES = ['py -3.11', 'python3.11', 'python3', 'python'];

/**
 * Detect which Python command has PaddleOCR available.
 * Returns e.g. ['py', ['-3.11']] or ['python3.11', []]
 */
async function findPython() {
  for (const candidate of PYTHON_CANDIDATES) {
    const parts = candidate.split(' ');
    const cmd = parts[0];
    const args = parts.slice(1);

    const ok = await new Promise((resolve) => {
      const child = spawn(cmd, [...args, '-c', 'import paddleocr; print("ok")'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.on('close', (code) => resolve(code === 0 && out.includes('ok')));
      child.on('error', () => resolve(false));
    });

    if (ok) return { cmd, args };
  }
  throw new Error(
    'PaddleOCR not found. Install with: py -3.11 -m pip install paddleocr paddlepaddle'
  );
}

let _pythonInfo = null;
async function getPython() {
  if (!_pythonInfo) _pythonInfo = await findPython();
  return _pythonInfo;
}

/**
 * Run OCR on a single image.
 * Matches the standard provider interface: { apiKey, model, imageBase64, prompt, baseUrl, lang }
 * For PaddleOCR, apiKey/model/prompt/baseUrl are ignored; lang is the ISO language code.
 * @param {object} opts
 * @param {string} opts.imageBase64 - PNG/JPG base64
 * @param {string} [opts.lang='en'] - ISO language code (optional, mapped internally)
 * @returns {Promise<string>} extracted text
 */
async function ocr({ imageBase64, lang = 'en' } = {}) {
  const { cmd, args } = await getPython();

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args, WORKER_SCRIPT, lang], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      try {
        const result = JSON.parse(stdout.trim());
        if (result.error) {
          return reject(new Error(`PaddleOCR worker error: ${result.error}`));
        }
        resolve(result.text || '');
      } catch {
        const errMsg = stderr || stdout || `Process exited with code ${code}`;
        reject(new Error(`PaddleOCR failed: ${errMsg.slice(0, 500)}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn PaddleOCR worker: ${err.message}`));
    });

    // Write base64 image to worker stdin
    child.stdin.write(imageBase64);
    child.stdin.end();
  });
}

module.exports = { ocr };
