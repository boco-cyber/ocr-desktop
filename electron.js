const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const http = require('http');

const PORT = 3444;
const URL  = `http://localhost:${PORT}`;

let win, serverProcess;

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
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    title: 'OCR Desktop',
    webPreferences: { contextIsolation: true },
    show: false,
  });
  win.loadURL(URL);
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => { startServer(); waitForServer(); });
app.on('window-all-closed', () => { if (serverProcess) serverProcess.kill(); app.quit(); });
app.on('before-quit', () => { if (serverProcess) serverProcess.kill(); });
app.on('activate', () => { if (!win) createWindow(); });
