const { app, BrowserWindow, WebContentsView, ipcMain, shell } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { hydrateShellPath } = require('./shell-path.cjs');
let startServer;
let stopServer;

const loadBackendModule = () => {
  if (app.isPackaged) return require('./backend/dist/index.js');
  require('tsx/cjs');
  return require('./backend/src/index.ts');
};

let mainWindow;
let backend;
let splashWindow;
let browserTabs = [];
let activeBrowserTabId = null;
let browserBounds = null;
let browserVisible = false;
let browserTabSequence = 0;

const defaultDevUrl = 'http://127.0.0.1:5173';
const rendererDistPath = path.join(__dirname, 'renderer', 'dist', 'index.html');

const checkDevServer = (url) =>
  new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(600, () => {
      req.destroy();
      resolve(false);
    });
  });

const renderLoadingPage = (window, message) => {
  const html = `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Loading multiprise</title>
      <style>
        :root { color-scheme: light; }
        html, body { height: 100%; margin: 0; background: #f3f4f6; color: #252529; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
        .wrap { height: 100%; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 12px; }
        .spinner { width: 28px; height: 28px; border-radius: 999px; border: 3px solid #d9dbe0; border-top-color: #3b82f6; animation: spin 0.9s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>
    </head>
    <body>
      <div class="wrap">
        <div class="spinner"></div>
        <div>${message}</div>
      </div>
    </body>
  </html>`;

  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  window.loadURL(dataUrl);
};

const renderSplashPage = (window) => {
  const html = `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>multiprise</title>
      <style>
        :root { color-scheme: light; }
        html, body { height: 100%; margin: 0; background: #f3f4f6; color: #252529; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
        .wrap { height: 100%; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 14px; }
        .spinner { width: 18px; height: 18px; border-radius: 999px; border: 2px solid #d9dbe0; border-top-color: #3b82f6; animation: spin 0.9s linear infinite; }
        .mark { position: relative; width: 56px; height: 42px; border-radius: 15px; background: #ece4cc; display: flex; align-items: center; justify-content: space-around; padding: 0 8px; box-sizing: border-box; }
        .socket { position: relative; width: 14px; height: 14px; border: 2px solid #6a6252; border-radius: 999px; }
        .socket::before, .socket::after { position: absolute; top: 3px; width: 2px; height: 5px; content: ''; border-radius: 2px; background: #49443d; }
        .socket::before { left: 3px; } .socket::after { right: 3px; }
        .light { position: absolute; top: 5px; right: 5px; width: 5px; height: 5px; border-radius: 999px; background: #3b82f6; }
        .title { font-family: 'Avenir Next', 'Segoe UI', sans-serif; font-size: 22px; font-weight: 600; letter-spacing: -.03em; }
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>
    </head>
    <body>
      <div class="wrap">
        <div class="mark"><span class="socket"></span><span class="socket"></span><span class="socket"></span><span class="light"></span></div>
        <div class="title">multiprise</div>
        <div class="spinner"></div>
      </div>
    </body>
  </html>`;

  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  window.loadURL(dataUrl);
};

const safeLoadUrl = async (window, url) => {
  try {
    await window.loadURL(url);
    return true;
  } catch (err) {
    return false;
  }
};

const safeLoadFile = async (window, filePath) => {
  try {
    await window.loadFile(filePath);
    return true;
  } catch (err) {
    return false;
  }
};

const loadDevServer = async (window, url, options = {}) => {
  const { keepTrying = false, intervalMs = 400, attempts = 15 } = options;
  renderLoadingPage(window, 'Waiting for the renderer...');

  const attemptLoad = async () => {
    if (window.isDestroyed()) return false;
    const ready = await checkDevServer(url);
    if (ready) {
      return await safeLoadUrl(window, url);
    }
    return false;
  };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await attemptLoad()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  if (!keepTrying) return false;

  const retry = async () => {
    if (window.isDestroyed()) return;
    const loaded = await attemptLoad();
    if (!loaded) {
      setTimeout(retry, intervalMs);
    }
  };
  setTimeout(retry, intervalMs);
  return false;
};

const loadRenderer = async (window) => {
  const explicitDevUrl = process.env.VITE_DEV_SERVER_URL;
  const hasDist = fs.existsSync(rendererDistPath);

  if (explicitDevUrl) {
    if (await checkDevServer(explicitDevUrl)) {
      const loaded = await safeLoadUrl(window, explicitDevUrl);
      if (loaded) return;
    }
    if (explicitDevUrl !== defaultDevUrl && (await checkDevServer(defaultDevUrl))) {
      const loaded = await safeLoadUrl(window, defaultDevUrl);
      if (loaded) return;
    }
    if (hasDist) {
      await safeLoadFile(window, rendererDistPath);
      return;
    }
    await loadDevServer(window, explicitDevUrl, { attempts: 25, keepTrying: true });
    return;
  }

  if (await checkDevServer(defaultDevUrl)) {
    const loaded = await safeLoadUrl(window, defaultDevUrl);
    if (loaded) return;
  }

  if (hasDist) {
    const loaded = await safeLoadFile(window, rendererDistPath);
    if (loaded) return;
  }

  await loadDevServer(window, defaultDevUrl, { attempts: 25, keepTrying: true });
};

const createSplashWindow = () => {
  splashWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    transparent: false,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    backgroundColor: '#f3f4f6',
    show: true
  });
  renderSplashPage(splashWindow);
};


const normalizeBrowserUrl = (value, allowBlank = false) => {
  const raw = String(value || '').trim();
  if (allowBlank && (!raw || raw === 'about:blank')) return 'about:blank';
  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(raw) ? raw : `http://${raw}`;
  const parsed = new URL(candidate);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP and HTTPS pages can be opened in Multiprise.');
  }
  return parsed.toString();
};

const activeBrowserTab = () => browserTabs.find((tab) => tab.id === activeBrowserTabId) || null;

const browserState = () => ({
  activeTabId: activeBrowserTabId,
  visible: browserVisible,
  tabs: browserTabs.map((tab) => ({
    id: tab.id,
    title: tab.title || 'New tab',
    url: tab.url === 'about:blank' ? '' : tab.url,
    loading: tab.loading,
    error: tab.error || null,
    canGoBack: tab.view.webContents.canGoBack(),
    canGoForward: tab.view.webContents.canGoForward()
  }))
});

const sendBrowserState = () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('browser:state', browserState());
  }
};

const removeBrowserView = (view) => {
  if (!mainWindow || mainWindow.isDestroyed() || !view) return;
  try {
    mainWindow.contentView.removeChildView(view);
  } catch (err) {
    // The view may already be detached.
  }
};

const syncActiveBrowserView = () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  browserTabs.forEach((tab) => removeBrowserView(tab.view));
  const tab = activeBrowserTab();
  if (!browserVisible || !browserBounds || !tab) return;
  mainWindow.contentView.addChildView(tab.view);
  tab.view.setBounds(browserBounds);
};

const updateBrowserTab = (tab) => {
  if (!tab || tab.view.webContents.isDestroyed()) return;
  const loadedUrl = tab.view.webContents.getURL();
  tab.url = loadedUrl || tab.url;
  tab.title = tab.view.webContents.getTitle() || tab.title || 'New tab';
  sendBrowserState();
};

const wireBrowserTab = (tab) => {
  const contents = tab.view.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    openBrowserTab(url).catch(() => {});
    return { action: 'deny' };
  });
  contents.on('did-start-loading', () => {
    tab.loading = true;
    tab.error = null;
    updateBrowserTab(tab);
  });
  contents.on('did-stop-loading', () => {
    tab.loading = false;
    updateBrowserTab(tab);
  });
  contents.on('did-navigate', () => updateBrowserTab(tab));
  contents.on('did-navigate-in-page', () => updateBrowserTab(tab));
  contents.on('page-title-updated', (event, title) => {
    event.preventDefault();
    tab.title = title || tab.title;
    sendBrowserState();
  });
  contents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    tab.loading = false;
    tab.error = description || 'Unable to load page';
    tab.url = validatedUrl || tab.url;
    sendBrowserState();
  });
};

async function openBrowserTab(value, options = {}) {
  const url = normalizeBrowserUrl(value, true);
  const existing = url !== 'about:blank' ? browserTabs.find((tab) => tab.url === url) : null;
  if (existing) {
    activeBrowserTabId = existing.id;
    browserVisible = true;
    syncActiveBrowserView();
    sendBrowserState();
    return browserState();
  }

  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  view.setBackgroundColor('#ffffff');
  const tab = {
    id: `browser-tab-${++browserTabSequence}`,
    title: options.title || 'New tab',
    url,
    loading: true,
    error: null,
    view
  };
  browserTabs.push(tab);
  activeBrowserTabId = tab.id;
  browserVisible = true;
  wireBrowserTab(tab);
  syncActiveBrowserView();
  sendBrowserState();
  try {
    await view.webContents.loadURL(url);
  } catch (err) {
    tab.loading = false;
    tab.error = err instanceof Error ? err.message : String(err);
    sendBrowserState();
  }
  return browserState();
}

const activateBrowserTab = (id) => {
  if (!browserTabs.some((tab) => tab.id === id)) return browserState();
  activeBrowserTabId = id;
  browserVisible = true;
  syncActiveBrowserView();
  sendBrowserState();
  return browserState();
};

const closeBrowserTab = (id) => {
  const index = browserTabs.findIndex((tab) => tab.id === id);
  if (index < 0) return browserState();
  const [tab] = browserTabs.splice(index, 1);
  removeBrowserView(tab.view);
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  if (activeBrowserTabId === id) {
    activeBrowserTabId = browserTabs[Math.min(index, browserTabs.length - 1)]?.id || null;
  }
  if (!browserTabs.length) browserVisible = false;
  syncActiveBrowserView();
  sendBrowserState();
  return browserState();
};

const handleBrowserAction = async (_event, action, payload = {}) => {
  const tab = activeBrowserTab();
  if (action === 'new') return openBrowserTab('about:blank');
  if (action === 'activate') return activateBrowserTab(payload.id);
  if (action === 'close') return closeBrowserTab(payload.id);
  if (action === 'set-bounds') {
    const source = payload.bounds || {};
    browserBounds = {
      x: Math.max(0, Math.round(Number(source.x) || 0)),
      y: Math.max(0, Math.round(Number(source.y) || 0)),
      width: Math.max(0, Math.round(Number(source.width) || 0)),
      height: Math.max(0, Math.round(Number(source.height) || 0))
    };
    browserVisible = browserBounds.width > 0 && browserBounds.height > 0;
    syncActiveBrowserView();
    sendBrowserState();
    return browserState();
  }
  if (action === 'hide') {
    browserVisible = false;
    syncActiveBrowserView();
    sendBrowserState();
    return browserState();
  }
  if (!tab) return browserState();
  const contents = tab.view.webContents;
  if (action === 'back' && contents.canGoBack()) contents.goBack();
  if (action === 'forward' && contents.canGoForward()) contents.goForward();
  if (action === 'reload') tab.loading ? contents.stop() : contents.reload();
  if (action === 'navigate') {
    const url = normalizeBrowserUrl(payload.url);
    tab.error = null;
    await contents.loadURL(url).catch((err) => {
      tab.error = err instanceof Error ? err.message : String(err);
    });
  }
  if (action === 'external' && tab.url && tab.url !== 'about:blank') await shell.openExternal(tab.url);
  if (action === 'devtools') contents.isDevToolsOpened() ? contents.closeDevTools() : contents.openDevTools({ mode: 'bottom', activate: true });
  updateBrowserTab(tab);
  return browserState();
};

const destroyBrowserTabs = () => {
  browserTabs.forEach((tab) => {
    removeBrowserView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  });
  browserTabs = [];
  activeBrowserTabId = null;
  browserVisible = false;
};

const createWindow = () => {
  mainWindow = new BrowserWindow({
    title: 'multiprise',
    width: 1280,
    height: 820,
    backgroundColor: '#f3f4f6',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 14 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
      splashWindow = null;
    }
    mainWindow.show();
  });

  loadRenderer(mainWindow).catch(() => {
    renderLoadingPage(mainWindow, 'Waiting for the renderer...');
  });
};

app.whenReady().then(async () => {
  await hydrateShellPath();
  if (app.isPackaged) {
    process.env.MULTIPRISE_DATA_DIR = path.join(app.getPath('userData'), 'data');
  }
  ({ startServer, stopServer } = loadBackendModule());
  backend = await startServer();

  ipcMain.handle('ping', () => ({
    ok: true,
    time: new Date().toISOString()
  }));

  ipcMain.handle('backend:health', () => ({
    ok: true,
    url: backend?.url || null,
    port: backend?.port || null,
    time: new Date().toISOString()
  }));

  ipcMain.handle('browser:open', (_event, url, options) => openBrowserTab(url, options));
  ipcMain.handle('browser:state', () => browserState());
  ipcMain.handle('browser:action', handleBrowserAction);

  createSplashWindow();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

const shutdown = async () => {
  destroyBrowserTabs();
  if (stopServer) await stopServer(backend);
};

app.on('before-quit', shutdown);

app.on('window-all-closed', async () => {
  if (process.platform !== 'darwin') {
    await shutdown();
    app.quit();
  }
});
