/**
 * SetupService — detects Python and installs PaddleOCR / NLLB dependencies.
 * Streams installation output line-by-line via an emitter callback.
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const os = require('os');
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

// Check whether pip and venv modules are available for a given python
async function checkPrerequisites(pythonInfo) {
  if (!pythonInfo) return { pip: false, venv: false };

  const check = (extraArgs) => new Promise(resolve => {
    const child = spawn(pythonInfo.cmd, [...pythonInfo.args, ...extraArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 8000,
    });
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
  });

  const [pip, venv] = await Promise.all([
    check(['-m', 'pip', '--version']),
    check(['-m', 'venv', '--help']),
  ]);

  return { pip, venv };
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
  let fullOutput = '';

  const flush = chunk => {
    const text = chunk.toString();
    fullOutput += text;
    buf += text;
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
    onDone(code === 0, code !== 0 ? `pip exited with code ${code}` : null, fullOutput);
  });

  return child;
}

// Creates a venv at venvDir using the given python cmd, returns the venv's python path
function createVenv(pythonCmd, venvDir) {
  execSync(`"${pythonCmd}" -m venv "${venvDir}"`, { stdio: 'pipe', timeout: 30000 });
  const pythonBin = process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
  return pythonBin;
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

    const prerequisites = await checkPrerequisites(generalPython);

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

    // Derive the apt package name for venv based on the Python minor version
    const versionMatch = generalPython?.version?.match(/(\d+\.\d+)/);
    const venvAptPackage = versionMatch
      ? `python${versionMatch[1]}-venv`
      : 'python3-venv python3-full';

    return {
      python: generalPython ? { found: true, version: generalPython.version, cmd: generalPython.cmd } : { found: false },
      prerequisites: {
        pip: prerequisites.pip,
        venv: prerequisites.venv,
        venvAptPackage,
      },
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

    onLine?.('── Pre-flight checks ─────────────────────────────');

    if (!pythonInfo) {
      onLine?.('STEP_FAIL Python  →  not found on PATH');
      const aptCmd = 'sudo apt-get install -y python3 python3-pip python3-venv';
      onLine?.(`STEP_CMD ${aptCmd}`);
      const msg = 'Python not found. Install Python 3.9+ first.';
      onLine?.('');
      onLine?.(`ERROR: ${msg}`);
      return { ok: false, error: msg };
    }

    onLine?.(`STEP_OK Python  →  ${pythonInfo.version}`);

    const prereqs = await checkPrerequisites(pythonInfo);

    if (!prereqs.pip) {
      onLine?.('STEP_FAIL pip  →  not available');
      const versionMatch = pythonInfo.version.match(/(\d+\.\d+)/);
      const pyMinor = versionMatch ? versionMatch[1] : null;
      const aptCmd = pyMinor
        ? `sudo apt-get install -y python${pyMinor}-distutils python3-pip`
        : 'sudo apt-get install -y python3-pip';
      onLine?.(`STEP_CMD ${aptCmd}`);
      const msg = 'pip is not available for this Python installation.';
      onLine?.('');
      onLine?.(`ERROR: ${msg}`);
      return { ok: false, error: msg };
    }
    onLine?.('STEP_OK pip  →  available');

    if (!prereqs.venv) {
      onLine?.('STEP_WARN venv  →  not available (will attempt to continue)');
      const versionMatch = pythonInfo.version.match(/(\d+\.\d+)/);
      const pyMinor = versionMatch ? versionMatch[1] : null;
      const aptCmd = pyMinor
        ? `sudo apt-get install -y python${pyMinor}-venv`
        : 'sudo apt-get install -y python3-venv python3-full';
      onLine?.(`STEP_CMD ${aptCmd}`);
    } else {
      onLine?.('STEP_OK venv  →  available');
    }

    onLine?.('──────────────────────────────────────────────────');
    onLine?.('');
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
        onDone: async (ok, error, output) => {
          // On Linux/Mac, pip may refuse due to "externally managed environment".
          // Automatically create a venv and retry.
          if (!ok && process.platform !== 'win32' && output && output.includes('externally-managed-environment')) {
            const venvDir = path.join(os.homedir(), `.ocr-desktop-venv-${feature}`);
            onLine?.('');
            onLine?.(`⚠ System Python is externally managed. Creating a virtual environment at ${venvDir}…`);
            try {
              const venvPython = createVenv(pythonInfo.cmd, venvDir);
              onLine?.(`✓ Virtual environment created. Retrying install…`);
              onLine?.('');

              // Save the venv python path to settings for future use
              const settingsKey = feature === 'nllb' ? 'nllbPythonPath' : 'paddlePythonPath';
              const currentSettings = await this.settingsService.getSettingsForRuntime();
              await this.settingsService.saveSettings({
                settings: {
                  ...currentSettings,
                  runtimes: { ...currentSettings.runtimes, [settingsKey]: venvPython },
                },
              });

              const venvPip = buildPipCommand({ cmd: venvPython, args: [] }, packages);
              onLine?.(`Running: ${venvPip.cmd} ${venvPip.args.join(' ')}`);
              onLine?.('');
              runInstall({
                cmd: venvPip.cmd,
                args: venvPip.args,
                onLine: line => onLine?.(line),
                onDone: (ok2, error2) => {
                  this.logger.info('setup.install.done', { feature, ok: ok2, error: error2, venv: true });
                  resolve({ ok: ok2, error: error2 || null });
                },
              });
            } catch (venvErr) {
              // Extract Python minor version to give a precise apt package name
              const versionMatch = pythonInfo.version.match(/(\d+\.\d+)/);
              const pyMinor = versionMatch ? versionMatch[1] : null;
              const aptPkg = pyMinor ? `python${pyMinor}-venv` : 'python3-venv python3-full';
              const msg = `python3-venv is not installed`;
              onLine?.(`ERROR: ${msg}`);
              onLine?.(`Fix: open a terminal and run:`);
              onLine?.(`  sudo apt-get install -y ${aptPkg}`);
              onLine?.(`Then click Install again.`);
              resolve({ ok: false, error: msg });
            }
            return;
          }

          this.logger.info('setup.install.done', { feature, ok, error });
          resolve({ ok, error: error || null });
        },
      });
    });
  }
}

module.exports = { SetupService, PADDLE_PACKAGES, NLLB_PACKAGES };
