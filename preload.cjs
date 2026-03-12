const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rmsDesktop', {
  platform: process.platform,
  isDesktop: true,
  getRuntimeInfo: () => ipcRenderer.invoke('desktop:get-runtime-info'),
  createBackup: () => ipcRenderer.invoke('desktop:create-backup'),
  listBackups: () => ipcRenderer.invoke('desktop:list-backups'),
  checkForUpdates: () => ipcRenderer.invoke('desktop:check-for-updates'),
  openLogsDirectory: () => ipcRenderer.invoke('desktop:open-path', 'logs'),
  openBackupsDirectory: () => ipcRenderer.invoke('desktop:open-path', 'backups'),
});
