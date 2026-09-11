// Runs in a sandboxed context. It exposes three window buttons and the host
// platform, and nothing else. The page cannot reach Node or the file system.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sdaShell', {
  platform: process.platform,
  frameless: process.platform !== 'darwin',
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  hide: () => ipcRenderer.send('window:hide'),
});
