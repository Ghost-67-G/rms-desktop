const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('rmsDesktop', {
  platform: process.platform,
  isDesktop: true,
});
