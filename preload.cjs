const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('meedoAgent', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  getStatus: () => ipcRenderer.invoke('status:get'),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  getLogs: () => ipcRenderer.invoke('logs:get'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  copyLogs: (text) => ipcRenderer.invoke('logs:copy', text),
  onOpenLogs: (callback) => ipcRenderer.on('logs:open-viewer', callback),
  uninstall: () => ipcRenderer.invoke('app:uninstall'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
});
