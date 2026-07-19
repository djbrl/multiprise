const { clipboard, contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('vibe', {
  ping: () => ipcRenderer.invoke('ping'),
  backendHealth: () => ipcRenderer.invoke('backend:health'),
  openExternal: (url) => shell.openExternal(url),
  copyText: (text) => clipboard.writeText(String(text)),
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
