const { app, clipboard, dialog } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const INSTALL_DIR = '/usr/local/bin';
const INSTALL_PATH = path.join(INSTALL_DIR, 'multiprise');
const MCP_SETUP = 'multiprise agents connect';

// The wrapper script shipped in the app bundle (see bin/multiprise and extraResources).
const bundledCliPath = () => path.join(process.resourcesPath, 'bin', 'multiprise');

const currentLink = () => {
  try {
    return fs.readlinkSync(INSTALL_PATH);
  } catch (err) {
    return err.code === 'EINVAL' ? 'not-a-link' : null;
  }
};

const isCommandLineToolInstalled = () => app.isPackaged && currentLink() === bundledCliPath();

const commandLineToolStatus = () => ({ installed: isCommandLineToolInstalled(), packaged: app.isPackaged, path: INSTALL_PATH });

const linkWithAdminRights = (source, target) =>
  new Promise((resolve, reject) => {
    // Paths travel as arguments, never inside the script text.
    const script = [
      'on run argv',
      'do shell script "mkdir -p " & quoted form of item 3 of argv & " && ln -sfn " & quoted form of item 1 of argv & " " & quoted form of item 2 of argv with administrator privileges',
      'end run'
    ];
    execFile('osascript', [...script.flatMap((line) => ['-e', line]), source, target, INSTALL_DIR], (err, _stdout, stderr) => {
      if (err) reject(new Error(/User canceled/i.test(stderr) ? 'cancelled' : stderr.trim() || err.message));
      else resolve();
    });
  });

async function installCommandLineTool() {
  if (!app.isPackaged) {
    await dialog.showMessageBox({
      type: 'info',
      message: 'The command line tool is installed from the packaged app.',
      detail: 'From a source checkout, run it with `npm run cli -- <command>`, for example `npm run cli -- ls`.'
    });
    return;
  }
  const source = bundledCliPath();
  if (source.startsWith('/Volumes/')) {
    await dialog.showMessageBox({
      type: 'warning',
      message: 'Move Multiprise to your Applications folder first.',
      detail: 'The command links to the app, so it would stop working once this disk image is ejected.'
    });
    return;
  }
  const existing = currentLink();
  if (existing && existing !== source) {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Replace', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `${INSTALL_PATH} already exists.`,
      detail: existing === 'not-a-link' ? 'Replace it with the Multiprise command?' : `It points to ${existing}. Replace it with this copy of Multiprise?`
    });
    if (response !== 0) return;
  }

  try {
    try {
      fs.mkdirSync(INSTALL_DIR, { recursive: true });
      fs.rmSync(INSTALL_PATH, { force: true });
      fs.symlinkSync(source, INSTALL_PATH);
    } catch (err) {
      if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
      await linkWithAdminRights(source, INSTALL_PATH);
    }
  } catch (err) {
    if (err.message === 'cancelled') return;
    dialog.showErrorBox('Could not install the command line tool', err.message);
    return;
  }

  const { response } = await dialog.showMessageBox({
    type: 'info',
    buttons: ['OK', 'Copy Setup Command'],
    defaultId: 0,
    message: 'The multiprise command is installed.',
    detail: 'Try `multiprise ls` or `multiprise up` in a project folder.\n\n' +
      `To have Claude Code run dev servers through Multiprise, run:\n${MCP_SETUP}`
  });
  if (response === 1) clipboard.writeText(MCP_SETUP);
}

module.exports = { commandLineToolStatus, installCommandLineTool, isCommandLineToolInstalled };
