const { BrowserWindow, nativeImage } = require('electron');
const path = require('path');

// The small window shown while the service manager starts, and the same look for the
// main window's "waiting for the renderer" page. Follows the system light/dark setting.

const iconDataUrl = () => {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'));
  return icon.isEmpty() ? '' : icon.resize({ width: 192, height: 192, quality: 'best' }).toDataURL();
};

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const page = ({ status, card }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Multiprise</title>
<style>
  :root { color-scheme: light dark; --bg: #f4f4f5; --card: #ffffff; --text: #18181b; --muted: #71717a; --track: #e4e4e7; --orange: #f26a1b; }
  @media (prefers-color-scheme: dark) { :root { --bg: #18181a; --card: #232326; --text: #fafafa; --muted: #a1a1aa; --track: #3f3f46; } }
  html, body { height: 100%; margin: 0; background: ${card ? 'transparent' : 'var(--bg)'}; color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; -webkit-user-select: none; cursor: default; }
  body { display: flex; align-items: center; justify-content: center; -webkit-app-region: drag; }
  .card { display: flex; flex-direction: column; align-items: center; justify-content: center;
    ${card ? 'width: 100%; height: 100%; box-sizing: border-box; border-radius: 22px; background: var(--card); border: 1px solid color-mix(in srgb, var(--text) 10%, transparent);' : ''} }
  .icon { width: 84px; height: 84px; border-radius: 20px; animation: breathe 2.4s ease-in-out infinite; }
  .name { margin-top: 16px; font-size: 22px; font-weight: 600; letter-spacing: -0.03em; }
  .bar { position: relative; width: 132px; height: 3px; margin-top: 22px; overflow: hidden; border-radius: 99px; background: var(--track); }
  .bar::after { content: ''; position: absolute; inset: 0 auto 0 0; width: 40%; border-radius: 99px; background: var(--orange); animation: slide 1.1s ease-in-out infinite; }
  .status { margin-top: 12px; min-height: 16px; font-size: 12px; color: var(--muted); transition: opacity .2s; }
  @keyframes slide { from { transform: translateX(-110%); } to { transform: translateX(260%); } }
  @keyframes breathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.04); } }
  @media (prefers-reduced-motion: reduce) { .icon, .bar::after { animation: none; } }
</style></head>
<body><div class="card">
  ${iconDataUrl() ? `<img class="icon" src="${iconDataUrl()}" alt="" />` : ''}
  <div class="name">Multiprise</div>
  <div class="bar"></div>
  <div class="status" id="status">${escapeHtml(status)}</div>
</div>
<script>window.setStatus = (text) => { document.getElementById('status').textContent = text; };</script>
</body></html>`;

const loadPage = (window, html) => window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

function createSplashWindow() {
  const splash = new BrowserWindow({
    width: 440,
    height: 300,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    show: false,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  splash.once('ready-to-show', () => splash.show());
  loadPage(splash, page({ status: 'Starting…', card: true }));
  return splash;
}

// Updates the line under the progress bar; harmless once the splash is gone.
function setSplashStatus(splash, text) {
  if (!splash || splash.isDestroyed()) return;
  splash.webContents.executeJavaScript(`window.setStatus && window.setStatus(${JSON.stringify(text)})`).catch(() => {});
}

function renderLoadingPage(window, message) {
  return loadPage(window, page({ status: message, card: false }));
}

module.exports = { createSplashWindow, renderLoadingPage, setSplashStatus };
