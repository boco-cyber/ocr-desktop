const { app, BrowserWindow, shell, powerSaveBlocker, ipcMain } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const { exec } = require('child_process');
const http = require('http');

const PORT = 3444;
const URL  = `http://localhost:${PORT}`;

let win, serverProcess;
let blockerId = null;   // powerSaveBlocker ID while OCR is running

// ── Power management ────────────────────────────────────────────────────────
function acquireWakeLock() {
  if (blockerId === null) {
    blockerId = powerSaveBlocker.start('prevent-app-suspension');
    console.log('[power] wake lock acquired, id:', blockerId);
  }
}
function releaseWakeLock() {
  if (blockerId !== null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
    console.log('[power] wake lock released');
  }
}

// ── IPC handlers ─────────────────────────────────────────────────────────────
ipcMain.on('ocr-started', () => {
  acquireWakeLock();
});

ipcMain.on('ocr-finished', (_event, shutdown) => {
  releaseWakeLock();
  if (shutdown) {
    // Give user 30 seconds to cancel, then shut down
    console.log('[power] shutdown requested — initiating in 30s');
    setTimeout(() => {
      if (process.platform === 'win32') {
        exec('shutdown /s /t 0');
      } else {
        exec('shutdown -h now');
      }
    }, 30000);
  }
});

// ── Server ────────────────────────────────────────────────────────────────────
function startServer() {
  const serverPath = app.isPackaged
    ? path.join(process.resourcesPath, 'server.js')
    : path.join(__dirname, 'server.js');
  serverProcess = fork(serverPath, [], {
    env: { ...process.env, ELECTRON_RUN: '1', PORT: String(PORT) },
    stdio: 'inherit',
  });
  serverProcess.on('error', err => console.error('Server error:', err));
}

function waitForServer(retries = 40) {
  http.get(URL, res => { res.resume(); createWindow(); })
    .on('error', () => {
      if (retries > 0) setTimeout(() => waitForServer(retries - 1), 300);
    });
}

function createWindow() {
  const preloadPath = app.isPackaged
    ? path.join(process.resourcesPath, 'preload.js')
    : path.join(__dirname, 'preload.js');

  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    title: 'OCR Desktop',
    webPreferences: {
      contextIsolation: true,
      preload: preloadPath,
    },
    show: false,
  });
  win.loadURL(URL);
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => { startServer(); waitForServer(); });
app.on('window-all-closed', () => { releaseWakeLock(); if (serverProcess) serverProcess.kill(); app.quit(); });
app.on('before-quit', () => { releaseWakeLock(); if (serverProcess) serverProcess.kill(); });
app.on('activate', () => { if (!win) createWindow(); });
