import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('meedoAgent', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config: unknown) => ipcRenderer.invoke('config:save', config),
  getStatus: () => ipcRenderer.invoke('status:get'),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  openLogs: () => ipcRenderer.invoke('logs:open'),
  uninstall: () => ipcRenderer.invoke('app:uninstall'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
});
