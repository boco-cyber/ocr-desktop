/**
 * SetupService — detects Python and installs PaddleOCR / NLLB dependencies.
 * Streams installation output line-by-line via an emitter callback.
 */

const { spawn } = require('child_process');
const path = require('path');
const fse = require('fs-extra');

// Packages required for each feature
const PADDLE_PACKAGES = [
  'paddlepaddle==3.0.0',  // 3.1+ has a broken oneDNN executor on Windows
  'paddleocr',
  'Pillow',
];

const NLLB_PACKAGES = [
  'torch',
  'transformers',
  'sentencepiece',
  'sacremoses',
];

// Candidates to try when no python path is configured
const PYTHON_CANDIDATES = process.platform === 'win32'
  ? ['py', 'python', 'python3']
  : ['python3', 'python'];

function tryPythonCandidate(cmd, args = []) {
  return new Promise(resolve => {
    const child = spawn(cmd, [...args, '--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 8000,
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', () => resolve(null));
    child.on('close', code => {
      if (code === 0 && out.trim()) resolve({ cmd, args, version: out.trim() });
      else resolve(null);
    });
  });
}

async function detectPython(configuredPath = '') {
  // Try the configured path first
  if (configuredPath && configuredPath.trim()) {
    const parts = configuredPath.trim().match(/"[^"]+"|'[^']+'|\S+/g) || [];
    const normalized = parts.map(p => p.replace(/^['"]|['"]$/g, ''));
    const cmd = normalized[0];
    const extraArgs = normalized.slice(1);
    const result = await tryPythonCandidate(cmd, extraArgs);
    if (result) return { ...result, source: 'configured' };
  }

  // Auto-detect
  const candidates = [
    { cmd: 'py', args: ['-3'] },
    { cmd: 'py', args: [] },
    { cmd: 'python', args: [] },
    { cmd: 'python3', args: [] },
  ];

  for (const { cmd, args } of candidates) {
    const result = await tryPythonCandidate(cmd, args);
    if (result) return { ...result, source: 'auto' };
  }

  return null;
}

function buildPipCommand(pythonInfo, packages) {
  const pipArgs = [...pythonInfo.args, '-m', 'pip', 'install', '--upgrade', ...packages];
  return { cmd: pythonInfo.cmd, args: pipArgs };
}

function runInstall({ cmd, args, onLine, onDone }) {
  const child = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buf = '';

  const flush = chunk => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (line.trim()) onLine(line);
    }
  };

  child.stdout.on('data', flush);
  child.stderr.on('data', flush);

  child.on('error', err => {
    onLine(`ERROR: ${err.message}`);
    onDone(false, err.message);
  });

  child.on('close', code => {
    if (buf.trim()) onLine(buf.trim());
    onDone(code === 0, code !== 0 ? `pip exited with code ${code}` : null);
  });

  return child;
}

async function checkPackages(pythonInfo, packages) {
  const results = {};
  for (const pkg of packages) {
    // Use pip show to check if installed
    const baseName = pkg.split(/[>=<!]/)[0].trim().toLowerCase();
    await new Promise(resolve => {
      const child = spawn(pythonInfo.cmd, [...pythonInfo.args, '-m', 'pip', 'show', baseName], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
      });
      let out = '';
      child.stdout.on('data', d => { out += d; });
      child.on('error', () => { results[pkg] = false; resolve(); });
      child.on('close', code => { results[pkg] = code === 0 && out.includes('Name:'); resolve(); });
    });
  }
  return results;
}

class SetupService {
  constructor({ settingsService, logger }) {
    this.settingsService = settingsService;
    this.logger = logger;
  }

  async checkEnvironment() {
    const settings = await this.settingsService.getSettingsForRuntime();
    const pythonPath = settings.runtimes.pythonPath || '';
    const nllbPythonPath = settings.runtimes.nllbPythonPath || '';
    const paddlePythonPath = settings.runtimes.paddlePythonPath || '';

    const [generalPython, nllbPython, paddlePython] = await Promise.all([
      detectPython(pythonPath),
      detectPython(nllbPythonPath || pythonPath),
      detectPython(paddlePythonPath || pythonPath),
    ]);

    let paddlePackages = {};
    let nllbPackages = {};

    if (paddlePython) {
      paddlePackages = await checkPackages(paddlePython, PADDLE_PACKAGES);
    }
    if (nllbPython) {
      nllbPackages = await checkPackages(nllbPython, NLLB_PACKAGES);
    }

    const paddleInstalled = Object.values(paddlePackages).every(Boolean);
    const nllbInstalled = Object.values(nllbPackages).every(Boolean);

    return {
      python: generalPython ? { found: true, version: generalPython.version, cmd: generalPython.cmd } : { found: false },
      paddle: {
        python: paddlePython ? { found: true, version: paddlePython.version } : { found: false },
        installed: paddleInstalled,
        packages: paddlePackages,
      },
      nllb: {
        python: nllbPython ? { found: true, version: nllbPython.version } : { found: false },
        installed: nllbInstalled,
        packages: nllbPackages,
      },
    };
  }

  async installPackages({ feature, pythonPathOverride, onLine }) {
    const settings = await this.settingsService.getSettingsForRuntime();

    let configuredPath = '';
    let packages = [];

    if (feature === 'paddle') {
      configuredPath = pythonPathOverride || settings.runtimes.paddlePythonPath || settings.runtimes.pythonPath || '';
      packages = PADDLE_PACKAGES;
    } else if (feature === 'nllb') {
      configuredPath = pythonPathOverride || settings.runtimes.nllbPythonPath || settings.runtimes.pythonPath || '';
      packages = NLLB_PACKAGES;
    } else {
      throw new Error(`Unknown feature: ${feature}`);
    }

    const pythonInfo = await detectPython(configuredPath);
    if (!pythonInfo) {
      const msg = 'Python not found. Install Python 3.9+ and add it to PATH, or set the path in Settings.';
      onLine?.(`ERROR: ${msg}`);
      return { ok: false, error: msg };
    }

    onLine?.(`Found Python: ${pythonInfo.version}`);
    onLine?.(`Installing: ${packages.join(', ')}`);
    onLine?.('');

    const pip = buildPipCommand(pythonInfo, packages);
    onLine?.(`Running: ${pip.cmd} ${pip.args.join(' ')}`);
    onLine?.('');

    return new Promise(resolve => {
      runInstall({
        cmd: pip.cmd,
        args: pip.args,
        onLine: line => onLine?.(line),
        onDone: (ok, error) => {
          this.logger.info('setup.install.done', { feature, ok, error });
          resolve({ ok, error: error || null });
        },
      });
    });
  }
}

module.exports = { SetupService, PADDLE_PACKAGES, NLLB_PACKAGES };
