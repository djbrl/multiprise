const { BrowserWindow, Menu, Notification, Tray, app, clipboard, nativeImage, shell } = require('electron');
const http = require('http');
const path = require('path');

// A service that took at least this long to become ready is worth a notification.
const SLOW_START_MS = 8000;
const STATUS_LABEL = { ready: '🟢', starting: '🟡', failed: '🔴', stopped: '⚪️' };

const serviceUrl = (port) => `http://localhost:${port}`;

const callApi = (backend, method, route, body) =>
  new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers = { 'x-multiprise-token': backend.token };
    if (data !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(data);
    }
    const req = http.request(new URL(route, backend.url), { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('end', () => {
        if ((res.statusCode ?? 500) >= 400) return reject(new Error(text || `HTTP ${res.statusCode}`));
        try {
          resolve(text ? JSON.parse(text) : null);
        } catch (err) {
          resolve(null);
        }
      });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });

const groupByRoot = (views) => {
  const groups = new Map();
  for (const view of views) {
    const root = view.project.root_path || view.project.path;
    if (!groups.has(root)) groups.set(root, { name: path.basename(root), items: [] });
    groups.get(root).items.push(view);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
};

// Mirrors the renderer: a service started on its own still learns its siblings' ports.
const linkedEnv = (view, group) => {
  const env = {};
  const backendView = group.items.find((item) => item.project.role === 'backend');
  const frontendView = group.items.find((item) => item.project.role === 'frontend');
  if (backendView?.project.port) env.BACKEND_PORT = String(backendView.project.port);
  if (frontendView?.project.port) env.FRONTEND_PORT = String(frontendView.project.port);
  return Object.keys(env).length ? env : undefined;
};

const notify = (title, body, onClick) => {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body: body || '' });
  notification.on('click', onClick);
  notification.show();
};

function createMenuBar({ backend, subscribe, showMainWindow, iconPath, commandLineTool }) {
  const icon = nativeImage.createFromPath(iconPath);
  icon.setTemplateImage(true);
  const tray = new Tray(icon);
  tray.setToolTip('Multiprise');

  // Starts triggered here report their own failure, so the status notification is skipped once.
  const reportedByMenu = new Set();
  let rebuildTimer = null;

  const notificationsEnabled = () => backend.state.settings.notifications !== false;
  const appInBackground = () => !BrowserWindow.getFocusedWindow();
  const projectById = (id) => backend.state.projects.find((project) => project.id === id);

  const startService = async (view, group) => {
    reportedByMenu.add(view.project.id);
    try {
      await callApi(backend, 'POST', `/api/projects/${view.project.id}/start`, {
        role: view.project.role,
        env: linkedEnv(view, group)
      });
    } catch (err) {
      if (notificationsEnabled()) {
        notify(`${view.project.name} could not start`, err instanceof Error ? err.message : String(err), showMainWindow);
      }
    } finally {
      reportedByMenu.delete(view.project.id);
    }
  };

  const stopService = (view) =>
    callApi(backend, 'POST', `/api/projects/${view.project.id}/stop`, {}).catch((err) => {
      notify(`${view.project.name} could not stop`, err instanceof Error ? err.message : String(err), showMainWindow);
    });

  let hostUrls = {};

  const serviceItem = (view, group) => {
    const { project, status } = view;
    const port = status.running ? project.port : null;
    const failedLabel = status.running ? '  not responding' : '  failed';
    const detail = status.phase === 'ready' && port ? `  :${port}` : status.phase === 'starting' ? '  starting…' : status.phase === 'failed' ? failedLabel : '';
    const submenu = [];
    if (status.phase === 'ready' && port) {
      submenu.push(
        { label: 'Open in Browser', click: () => shell.openExternal(serviceUrl(port)) },
        { label: 'Copy URL', click: () => clipboard.writeText(serviceUrl(port)) },
        ...(hostUrls[project.id] ? [{ label: 'Copy Stable URL', click: () => clipboard.writeText(hostUrls[project.id]) }] : []),
        { type: 'separator' }
      );
    }
    submenu.push(
      status.running
        ? { label: 'Stop', click: () => stopService(view) }
        : { label: status.phase === 'failed' ? 'Retry' : 'Start', click: () => startService(view, group) },
      { label: 'Show in Multiprise', click: showMainWindow }
    );
    return { label: `${STATUS_LABEL[status.phase] ?? STATUS_LABEL.stopped}  ${project.name}${detail}`, submenu };
  };

  const rebuild = async () => {
    let views = [];
    try {
      views = (await callApi(backend, 'GET', '/api/projects'))?.projects ?? [];
      hostUrls = (await callApi(backend, 'GET', '/api/hostnames'))?.urls ?? {};
    } catch (err) {
      console.error('[multiprise] menu bar refresh failed:', err);
    }
    const running = views.filter((view) => view.status.running);
    tray.setTitle(running.length ? String(running.length) : '', { fontType: 'monospacedDigit' });
    tray.setToolTip(running.length ? `Multiprise · ${running.length} running` : 'Multiprise');

    const template = [
      { label: running.length ? `${running.length} ${running.length === 1 ? 'service' : 'services'} running` : 'No services running', enabled: false },
      { type: 'separator' }
    ];
    for (const group of groupByRoot(views)) {
      template.push({ label: group.name, enabled: false });
      for (const view of group.items) template.push(serviceItem(view, group));
      template.push({ type: 'separator' });
    }
    // Like quitting, this leaves Docker Compose services to Docker.
    const managed = running.filter((view) => view.project.kind !== 'docker_compose');
    template.push(
      { label: 'Stop All Services', enabled: managed.length > 0, click: () => Promise.all(managed.map(stopService)) },
      { label: 'Open Multiprise', click: showMainWindow },
      ...(commandLineTool.isInstalled()
        ? []
        : [{ label: 'Install Command Line Tool…', click: () => commandLineTool.install().finally(scheduleRebuild) }]),
      { type: 'separator' },
      { label: 'Quit Multiprise', click: () => app.quit() }
    );
    tray.setContextMenu(Menu.buildFromTemplate(template));
  };

  const scheduleRebuild = () => {
    if (rebuildTimer) return;
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      rebuild();
    }, 200);
  };

  const phases = new Map();
  const startingSince = new Map();

  const notifyStatusChange = (id, status) => {
    const previous = phases.get(id);
    phases.set(id, status.phase);
    if (status.phase === 'starting' && previous !== 'starting') startingSince.set(id, Date.now());
    if (!notificationsEnabled() || !appInBackground()) return;
    const project = projectById(id);
    if (!project) return;

    if (status.phase === 'failed' && previous !== 'failed' && !reportedByMenu.has(id)) {
      const title = status.running ? `${project.name} is not responding` : previous === 'ready' ? `${project.name} crashed` : `${project.name} failed to start`;
      notify(title, status.error, showMainWindow);
    } else if (status.phase === 'ready' && previous === 'starting') {
      const since = startingSince.get(id);
      if (since && Date.now() - since >= SLOW_START_MS) {
        notify(`${project.name} is ready`, project.port ? serviceUrl(project.port) : '', showMainWindow);
      }
    }
  };

  subscribe((event) => {
    if (event.type === 'status') {
      notifyStatusChange(event.id, event.status);
      scheduleRebuild();
    } else if (event.type === 'projects') {
      scheduleRebuild();
    }
  });

  rebuild();
  return tray;
}

module.exports = { createMenuBar };
