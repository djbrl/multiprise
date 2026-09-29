const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('vibe', {
  ping: () => ipcRenderer.invoke('ping'),
  backendHealth: () => ipcRenderer.invoke('backend:health'),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  // Sandboxed pages cannot read a dropped file's path themselves.
  pathForFile: (file) => webUtils.getPathForFile(file),
  cli: {
    status: () => ipcRenderer.invoke('cli:status'),
    install: () => ipcRenderer.invoke('cli:install')
  },
  browser: {
    open: (url, options) => ipcRenderer.invoke('browser:open', url, options),
    getState: () => ipcRenderer.invoke('browser:state'),
    action: (action, payload) => ipcRenderer.invoke('browser:action', action, payload),
    setBounds: (bounds) => ipcRenderer.invoke('browser:action', 'set-bounds', { bounds }),
    hide: () => ipcRenderer.invoke('browser:action', 'hide'),
    onState: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('browser:state', listener);
      return () => ipcRenderer.removeListener('browser:state', listener);
    }
  }
});
