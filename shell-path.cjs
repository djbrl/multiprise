const { execFile } = require('node:child_process');
const path = require('node:path');

const FALLBACK_PATHS = process.platform === 'darwin'
  ? ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  : [];

const mergePaths = (...values) => {
  const entries = values
    .flatMap((value) => String(value || '').split(path.delimiter))
    .filter(Boolean);
  return [...new Set(entries)].join(path.delimiter);
};

const readLoginShellPath = (env = process.env) =>
  new Promise((resolve) => {
    if (process.platform === 'win32') {
      resolve('');
      return;
    }

    const shell = env.SHELL || '/bin/zsh';
    const marker = '__MULTIPRISE_PATH__';
    execFile(
      shell,
      ['-lc', `printf '${marker}%s' "$PATH"`],
      { env, timeout: 5000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve('');
          return;
        }
        const output = String(stdout || '');
        const markerIndex = output.lastIndexOf(marker);
        resolve(markerIndex >= 0 ? output.slice(markerIndex + marker.length).trim() : '');
      }
    );
  });

async function hydrateShellPath(env = process.env) {
  const shellPath = await readLoginShellPath(env);
  env.PATH = mergePaths(shellPath, env.PATH, FALLBACK_PATHS.join(path.delimiter));
  return env.PATH;
}

module.exports = { hydrateShellPath, readLoginShellPath };
