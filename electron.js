const { app, BrowserWindow, shell, powerSaveBlocker, ipcMain, safeStorage } = require('electron');
const { exec } = require('child_process');
const path = require('path');

const { createOCRRuntime } = require('./main/createOCRRuntime');
const { registerOCRIpc } = require('./main/registerOCRIpc');

let mainWindow = null;
let blockerId = null;
let runtime = null;

function getAppFilePath(...segments) {
  return path.join(app.getAppPath(), ...segments);
}

function getDataDir() {
  return process.env.APP_DATA_DIR || path.join(app.getPath('userData'), 'data');
}

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

ipcMain.on('ocr-started', () => {
  acquireWakeLock();
});

ipcMain.on('ocr-finished', (_event, shutdown) => {
  releaseWakeLock();
  if (!shutdown) return;

  console.log('[power] shutdown requested - initiating in 30s');
  setTimeout(() => {
    if (process.platform === 'win32') {
      exec('shutdown /s /t 0');
    } else {
      exec('shutdown -h now');
    }
  }, 30000);
});

function createWindow() {
  const preloadPath = getAppFilePath('preload.js');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'OCR Desktop',
    webPreferences: {
      contextIsolation: true,
      preload: preloadPath,
    },
    show: false,
  });

  mainWindow.loadFile(getAppFilePath('index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  runtime = await createOCRRuntime({
    dataDir: getDataDir(),
    appInfo: {
      version: app.getVersion(),
      name: app.getName(),
    },
    safeStorageAdapter: safeStorage,
  });
  registerOCRIpc({ runtime, dataDir: getDataDir() });
  createWindow();
}).catch(error => {
  console.error('Failed to start OCR Desktop:', error);
  app.quit();
});

app.on('window-all-closed', () => {
  releaseWakeLock();
  app.quit();
});

app.on('before-quit', () => {
  releaseWakeLock();
});

app.on('activate', () => {
  if (!mainWindow) {
    createWindow();
  }
});
