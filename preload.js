/**
 * Preload script — bridges renderer ↔ main process via contextBridge.
 * Exposed as window.electronAPI (undefined when running in browser).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Called when OCR starts — main process acquires power-save blocker
  ocrStarted: () => ipcRenderer.send('ocr-started'),
  // Called when OCR finishes — main process releases blocker, optionally shuts down
  ocrFinished: (shutdown) => ipcRenderer.send('ocr-finished', shutdown),
});
