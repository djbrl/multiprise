const { app, BrowserWindow, WebContentsView, clipboard, dialog, ipcMain, session, shell } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createMenuBar } = require('./menu-bar.cjs');
const { hydrateShellPath } = require('./shell-path.cjs');
let startServer;
let stopServer;
let subscribeToBackend;

const loadBackendModule = () => {
  if (app.isPackaged) return require('./backend/dist/index.js');
  require('tsx/cjs');
  return require('./backend/src/index.ts');
};

let mainWindow;
let backend;
// Held for the app's lifetime so the menu bar icon is not garbage-collected.
let menuBar;
let splashWindow;
let browserTabs = [];
let activeBrowserTabId = null;
let browserBounds = null;
let browserVisible = false;
let browserTabSequence = 0;

const defaultDevUrl = 'http://127.0.0.1:5173';
const rendererDistPath = path.join(__dirname, 'renderer', 'dist', 'index.html');
// Read before the dev-only variables below are scrubbed from the environment.
const explicitDevUrl = app.isPackaged ? null : process.env.VITE_DEV_SERVER_URL || null;
const BROWSER_PARTITION = 'persist:multiprise-browser';
// Harmless capabilities pages in the in-app browser may use; everything else is denied.
const ALLOWED_BROWSER_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock']);
// The dev launcher sets these for Multiprise itself; managed services must not inherit them.
const DEV_LAUNCHER_ENV = ['PORT', 'BACKEND_PORT', 'FRONTEND_PORT', 'API_PORT', 'VITE_API_PORT', 'VITE_API_URL', 'VITE_DEV_SERVER_URL'];

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
}

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
        .spinner { width: 28px; height: 28px; border-radius: 999px; border: 3px solid #d9dbe0; border-top-color: #EA580C; animation: spin 0.9s linear infinite; }
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
        .spinner { width: 18px; height: 18px; border-radius: 999px; border: 2px solid #d9dbe0; border-top-color: #EA580C; animation: spin 0.9s linear infinite; }
        .mark { position: relative; width: 58px; height: 58px; border: 1.5px solid #FDBA74; border-radius: 18px; background: #FFF7ED; display: flex; align-items: center; justify-content: center; color: #EA580C; box-sizing: border-box; }
        .strip { width: 34px; height: 20px; border: 2.5px solid currentColor; border-radius: 7px; display: flex; align-items: center; justify-content: space-evenly; box-sizing: border-box; }
        .slot { width: 2.5px; height: 9px; border-radius: 2px; background: currentColor; }
        .light { position: absolute; top: 7px; right: 7px; width: 5px; height: 5px; border-radius: 999px; background: #F97316; }
        .title { font-family: 'Avenir Next', 'Segoe UI', sans-serif; font-size: 22px; font-weight: 600; letter-spacing: -.03em; }
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>
    </head>
    <body>
      <div class="wrap">
        <div class="mark"><span class="strip"><span class="slot"></span><span class="slot"></span><span class="slot"></span></span><span class="light"></span></div>
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
  const hasDist = fs.existsSync(rendererDistPath);

  if (app.isPackaged) {
    if (hasDist) {
      await safeLoadFile(window, rendererDistPath);
      return;
    }
    renderLoadingPage(window, 'The bundled renderer is missing.');
    return;
  }

  if (explicitDevUrl) {
    if (await checkDevServer(explicitDevUrl)) {
      const loaded = await safeLoadUrl(window, explicitDevUrl);
      if (loaded) return;
    }
    await loadDevServer(window, explicitDevUrl, { attempts: 25, keepTrying: true });
    return;
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
const browserTabById = (id) => browserTabs.find((tab) => tab.id === id) || null;

const browserState = () => ({
  activeTabId: activeBrowserTabId,
  visible: browserVisible,
  tabs: browserTabs.map((tab) => ({
    id: tab.id,
    title: tab.title || 'New tab',
    url: tab.url === 'about:blank' ? '' : tab.url,
    loading: tab.loading,
    error: tab.error || null,
    detached: Boolean(tab.detachedWindow && !tab.detachedWindow.isDestroyed()),
    canGoBack: tab.view.webContents.navigationHistory.canGoBack(),
    canGoForward: tab.view.webContents.navigationHistory.canGoForward()
  }))
});

const sendBrowserState = () => {
  const state = browserState();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('browser:state', state);
  }
  browserTabs.forEach((tab) => {
    if (tab.detachedWindow && !tab.detachedWindow.isDestroyed()) {
      tab.detachedWindow.webContents.send('browser:state', state);
    }
  });
};

const removeBrowserViewFromMain = (view) => {
  if (!mainWindow || mainWindow.isDestroyed() || !view) return;
  try {
    mainWindow.contentView.removeChildView(view);
  } catch (err) {
    // The view may already have another owner.
  }
};

const removeBrowserViewFromDetachedWindow = (tab) => {
  if (!tab?.detachedWindow || tab.detachedWindow.isDestroyed()) return;
  try {
    tab.detachedWindow.contentView.removeChildView(tab.view);
  } catch (err) {
    // The view may already be attached to the main window.
  }
};

const syncDetachedBrowserBounds = (tab) => {
  if (!tab?.detachedWindow || tab.detachedWindow.isDestroyed()) return;
  const [width, height] = tab.detachedWindow.getContentSize();
  tab.view.setBounds({ x: 0, y: 52, width: Math.max(0, width), height: Math.max(0, height - 52) });
};

const syncActiveBrowserView = () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  browserTabs.forEach((tab) => {
    if (!tab.detachedWindow || tab.detachedWindow.isDestroyed()) {
      removeBrowserViewFromMain(tab.view);
    }
  });
  const tab = activeBrowserTab();
  if (!browserVisible || !browserBounds || !tab || (tab.detachedWindow && !tab.detachedWindow.isDestroyed())) return;
  mainWindow.contentView.addChildView(tab.view);
  tab.view.setBounds(browserBounds);
};

const updateBrowserTab = (tab) => {
  if (!tab || tab.view.webContents.isDestroyed()) return;
  const loadedUrl = tab.view.webContents.getURL();
  tab.url = loadedUrl || tab.url;
  tab.title = tab.view.webContents.getTitle() || tab.title || 'New tab';
  if (tab.detachedWindow && !tab.detachedWindow.isDestroyed()) {
    tab.detachedWindow.setTitle(tab.title || 'Multiprise browser');
  }
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
    updateBrowserTab(tab);
  });
  contents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    tab.loading = false;
    tab.error = description || 'Unable to load page';
    tab.url = validatedUrl || tab.url;
    sendBrowserState();
  });
};

const detachedBrowserShell = (tabId) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{color-scheme:dark}*{box-sizing:border-box}html,body{height:100%;margin:0;overflow:hidden;background:#242424;color:#f5f5f5;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .bar{height:52px;display:flex;align-items:center;gap:7px;padding:8px 10px;border-bottom:1px solid #3d3d3d;background:#292929}
  button{height:32px;border:0;border-radius:8px;background:#383838;color:#eee;padding:0 10px;cursor:pointer}button:hover{background:#464646}button:disabled{opacity:.4;cursor:default}
  .icon{width:32px;padding:0;font-size:16px}.address{min-width:0;flex:1;height:32px;border:1px solid #484848;border-radius:8px;background:#1d1d1d;color:#fff;padding:0 11px;outline:none}.address:focus{border-color:#f97316}
  .attach{background:#f97316;color:#fff;font-weight:600}.attach:hover{background:#ea580c}
</style></head><body><div class="bar">
<button id="back" class="icon" title="Back">‹</button><button id="forward" class="icon" title="Forward">›</button><button id="reload" class="icon" title="Reload">↻</button>
<form id="form" style="display:flex;min-width:0;flex:1"><input id="address" class="address" placeholder="Enter a local URL"></form>
<button id="external" title="Open in system browser">External</button><button id="devtools" title="Toggle developer tools">DevTools</button><button id="attach" class="attach">Attach</button>
</div><script>
const tabId=${JSON.stringify(tabId)};let tab=null;
const back=document.getElementById('back'),forward=document.getElementById('forward'),reload=document.getElementById('reload'),form=document.getElementById('form'),address=document.getElementById('address'),external=document.getElementById('external'),devtools=document.getElementById('devtools'),attach=document.getElementById('attach');
const action=(name,payload={})=>window.vibe.browser.action(name,{id:tabId,...payload});
const render=(state)=>{tab=state.tabs.find((item)=>item.id===tabId)||null;if(!tab)return;document.title=tab.title||'Multiprise browser';if(document.activeElement!==address)address.value=tab.url||'';back.disabled=!tab.canGoBack;forward.disabled=!tab.canGoForward;reload.textContent=tab.loading?'×':'↻';};
window.vibe.browser.getState().then(render);window.vibe.browser.onState(render);
back.onclick=()=>action('back');forward.onclick=()=>action('forward');reload.onclick=()=>action('reload');external.onclick=()=>action('external');devtools.onclick=()=>action('devtools');attach.onclick=()=>action('attach');
form.onsubmit=(event)=>{event.preventDefault();action('navigate',{url:address.value});};
</script></body></html>`;

const attachBrowserTab = (id, options = {}) => {
  const tab = browserTabById(id);
  if (!tab) return browserState();
  const detachedWindow = tab.detachedWindow;
  if (detachedWindow && !detachedWindow.isDestroyed()) {
    removeBrowserViewFromDetachedWindow(tab);
    tab.closingDetachedWindow = true;
    detachedWindow.destroy();
  }
  tab.detachedWindow = null;
  tab.closingDetachedWindow = false;
  activeBrowserTabId = tab.id;
  browserVisible = true;
  syncActiveBrowserView();
  if (options.focus !== false && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
  sendBrowserState();
  return browserState();
};

const detachBrowserTab = async (id) => {
  const tab = browserTabById(id);
  if (!tab) return browserState();
  if (tab.detachedWindow && !tab.detachedWindow.isDestroyed()) {
    tab.detachedWindow.show();
    tab.detachedWindow.focus();
    return browserState();
  }

  removeBrowserViewFromMain(tab.view);
  const detachedWindow = new BrowserWindow({
    title: tab.title || 'Multiprise browser',
    width: 1080,
    height: 760,
    minWidth: 640,
    minHeight: 420,
    backgroundColor: '#242424',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  tab.detachedWindow = detachedWindow;
  tab.closingDetachedWindow = false;
  detachedWindow.on('resize', () => syncDetachedBrowserBounds(tab));
  detachedWindow.on('close', (event) => {
    if (tab.closingDetachedWindow) return;
    event.preventDefault();
    attachBrowserTab(tab.id);
  });
  detachedWindow.on('closed', () => {
    if (tab.detachedWindow === detachedWindow) tab.detachedWindow = null;
    sendBrowserState();
  });
  await detachedWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(detachedBrowserShell(tab.id))}`);
  if (detachedWindow.isDestroyed()) return browserState();
  detachedWindow.contentView.addChildView(tab.view);
  syncDetachedBrowserBounds(tab);
  detachedWindow.show();
  sendBrowserState();
  syncActiveBrowserView();
  return browserState();
};

async function openBrowserTab(value, options = {}) {
  const url = normalizeBrowserUrl(value, true);
  const existing = url !== 'about:blank' ? browserTabs.find((tab) => tab.url === url) : null;
  if (existing) {
    activeBrowserTabId = existing.id;
    browserVisible = true;
    if (existing.detachedWindow && !existing.detachedWindow.isDestroyed()) {
      existing.detachedWindow.show();
      existing.detachedWindow.focus();
    }
    syncActiveBrowserView();
    sendBrowserState();
    return browserState();
  }

  const view = new WebContentsView({
    webPreferences: {
      partition: BROWSER_PARTITION,
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
    view,
    detachedWindow: null,
    closingDetachedWindow: false
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
  const tab = browserTabById(id);
  if (!tab) return browserState();
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
  removeBrowserViewFromMain(tab.view);
  removeBrowserViewFromDetachedWindow(tab);
  if (tab.detachedWindow && !tab.detachedWindow.isDestroyed()) {
    tab.closingDetachedWindow = true;
    tab.detachedWindow.destroy();
  }
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
  if (action === 'new') return openBrowserTab('about:blank');
  if (action === 'activate') return activateBrowserTab(payload.id);
  if (action === 'close') return closeBrowserTab(payload.id);
  if (action === 'detach') return detachBrowserTab(payload.id || activeBrowserTabId);
  if (action === 'attach') return attachBrowserTab(payload.id || activeBrowserTabId);
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
  const tab = browserTabById(payload.id) || activeBrowserTab();
  if (!tab) return browserState();
  const contents = tab.view.webContents;
  if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
  if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
  if (action === 'reload') tab.loading ? contents.stop() : contents.reload();
  if (action === 'navigate') {
    const url = normalizeBrowserUrl(payload.url);
    tab.error = null;
    await contents.loadURL(url).catch((err) => {
      tab.error = err instanceof Error ? err.message : String(err);
    });
  }
  if (action === 'external' && tab.url && tab.url !== 'about:blank') await shell.openExternal(normalizeBrowserUrl(tab.url));
  if (action === 'devtools') contents.isDevToolsOpened() ? contents.closeDevTools() : contents.openDevTools({ mode: 'bottom', activate: true });
  updateBrowserTab(tab);
  return browserState();
};

const destroyBrowserTabs = () => {
  browserTabs.forEach((tab) => {
    removeBrowserViewFromMain(tab.view);
    removeBrowserViewFromDetachedWindow(tab);
    if (tab.detachedWindow && !tab.detachedWindow.isDestroyed()) {
      tab.closingDetachedWindow = true;
      tab.detachedWindow.destroy();
    }
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  });
  browserTabs = [];
  activeBrowserTabId = null;
  browserVisible = false;
};

const createWindow = () => {
  mainWindow = new BrowserWindow({
    title: 'multiprise',
    icon: path.join(__dirname, 'build', 'icon.png'),
    width: 1280,
    height: 820,
    // Below this the header, service cards and logs start to overlap.
    minWidth: 960,
    minHeight: 600,
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

  // The privileged renderer must never navigate away from the app or spawn windows.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow.webContents.getURL();
    let sameOrigin = false;
    try {
      const next = new URL(url);
      const here = new URL(current);
      sameOrigin = next.protocol === here.protocol && next.host === here.host && next.protocol !== 'data:';
    } catch (err) {
      sameOrigin = false;
    }
    if (!sameOrigin) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      openBrowserTab(url).catch(() => {});
    } catch (err) {
      // Non-HTTP URLs are ignored.
    }
    return { action: 'deny' };
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

// Closing the window keeps services running; the menu bar and the Dock bring it back.
const showMainWindow = () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (backend) createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
};

const rendererOrigins = () => {
  if (app.isPackaged) return ['null'];
  const origins = new Set(['null']);
  for (const url of [explicitDevUrl, defaultDevUrl]) {
    if (!url) continue;
    try {
      const parsed = new URL(url);
      origins.add(parsed.origin);
      if (parsed.hostname === '127.0.0.1') origins.add(`${parsed.protocol}//localhost:${parsed.port}`);
      if (parsed.hostname === 'localhost') origins.add(`${parsed.protocol}//127.0.0.1:${parsed.port}`);
    } catch (err) {
      // Ignore malformed dev URLs.
    }
  }
  return [...origins];
};

const restrictBrowserPermissions = (target) => {
  target.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(ALLOWED_BROWSER_PERMISSIONS.has(permission));
  });
  target.setPermissionCheckHandler((_contents, permission) => ALLOWED_BROWSER_PERMISSIONS.has(permission));
};

const isMainWindowSender = (event) =>
  Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);

const closeSplashWindow = () => {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  splashWindow = null;
};

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  if (process.platform === 'darwin' && app.dock && fs.existsSync(iconPath)) {
    app.dock.setIcon(iconPath);
  }
  restrictBrowserPermissions(session.defaultSession);
  restrictBrowserPermissions(session.fromPartition(BROWSER_PARTITION));
  createSplashWindow();

  try {
    await hydrateShellPath();
    if (app.isPackaged) {
      process.env.MULTIPRISE_DATA_DIR = path.join(app.getPath('userData'), 'data');
    }
    const backendPort = app.isPackaged ? 0 : undefined;
    ({ startServer, stopServer, subscribe: subscribeToBackend } = loadBackendModule());
    backend = await startServer({ port: backendPort, allowedOrigins: rendererOrigins() });
  } catch (err) {
    closeSplashWindow();
    dialog.showErrorBox(
      'Multiprise could not start',
      `The local service manager failed to start.\n\n${err instanceof Error ? err.message : String(err)}`
    );
    app.exit(1);
    return;
  }
  if (!app.isPackaged) {
    DEV_LAUNCHER_ENV.forEach((name) => delete process.env[name]);
  }

  ipcMain.handle('ping', () => ({
    ok: true,
    time: new Date().toISOString()
  }));

  ipcMain.handle('backend:health', (event) => {
    if (!isMainWindowSender(event)) throw new Error('Not allowed');
    return {
      ok: true,
      url: backend?.url || null,
      port: backend?.port || null,
      token: backend?.token || null,
      time: new Date().toISOString()
    };
  });

  ipcMain.handle('clipboard:write', (_event, value) => {
    clipboard.writeText(String(value ?? ''));
    return { ok: true };
  });

  ipcMain.handle('external:open', async (_event, value) => {
    const url = normalizeBrowserUrl(value);
    await shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('browser:open', (_event, url, options) => openBrowserTab(url, options));
  ipcMain.handle('browser:state', () => browserState());
  ipcMain.handle('browser:action', handleBrowserAction);

  createWindow();
  menuBar = createMenuBar({
    backend,
    subscribe: subscribeToBackend,
    showMainWindow,
    iconPath: path.join(__dirname, 'build', 'trayTemplate.png')
  });

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  });
});

let shutdownState = 'idle';

const shutdown = async () => {
  destroyBrowserTabs();
  if (stopServer) await stopServer(backend);
};

// Stopping services is asynchronous, so the first quit is deferred until they are gone.
app.on('before-quit', (event) => {
  if (shutdownState === 'done') return;
  event.preventDefault();
  if (shutdownState === 'running') return;
  shutdownState = 'running';
  shutdown()
    .catch((err) => console.error('[multiprise] shutdown failed:', err))
    .finally(() => {
      shutdownState = 'done';
      app.quit();
    });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => app.quit());
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
