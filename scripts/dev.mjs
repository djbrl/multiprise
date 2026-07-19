import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DEFAULT_BACKEND_PORT = 3000;
const DEFAULT_FRONTEND_PORT = 5173;
const MAX_PORT_SCAN = 100;

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const commandForPlatform = (cmd) => (process.platform === 'win32' ? `${cmd}.cmd` : cmd);

const readCliPort = (name) => {
  const flag = `--${name}`;
  const inline = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = process.argv.indexOf(flag);
  if (index !== -1) return process.argv[index + 1] ?? '';
  return undefined;
};

const normalizePort = (value, label) => {
  if (value === undefined || value === null || value === '') return undefined;
  const port = Number.parseInt(String(value), 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be a valid TCP port between 1 and 65535.`);
  }
  return port;
};

const canConnect = (host, port) =>
  new Promise((resolve) => {
    const socket = createConnection({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(250, () => {
      socket.destroy();
      resolve(false);
    });
  });

const canListen = async (port) => {
  if (await canConnect('127.0.0.1', port)) return false;
  if (await canConnect('::1', port)) return false;

  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
};

const findPort = async (preferred, explicit, reserved = new Set()) => {
  if (reserved.has(preferred) && explicit) {
    throw new Error(`Port ${preferred} is already reserved by another dev service.`);
  }
  if (!reserved.has(preferred) && (await canListen(preferred))) return preferred;
  if (explicit) throw new Error(`Port ${preferred} is already in use.`);

  for (let port = preferred + 1; port <= preferred + MAX_PORT_SCAN; port += 1) {
    if (!reserved.has(port) && (await canListen(port))) return port;
  }

  throw new Error(`No free port found near ${preferred}.`);
};

const run = (cmd, args, opts = {}) =>
  spawn(commandForPlatform(cmd), args, {
    cwd: rootDir,
    stdio: 'inherit',
    ...opts
  });

const backendCliPort = normalizePort(readCliPort('backend-port'), '--backend-port');
const frontendCliPort = normalizePort(readCliPort('frontend-port'), '--frontend-port');
const backendEnvPort = normalizePort(process.env.BACKEND_PORT ?? process.env.PORT ?? process.env.API_PORT, 'BACKEND_PORT/PORT/API_PORT');
const frontendEnvPort = normalizePort(process.env.FRONTEND_PORT, 'FRONTEND_PORT');

const backendExplicit = Boolean(backendCliPort || backendEnvPort);
const frontendExplicit = Boolean(frontendCliPort || frontendEnvPort);

const backendPreferred = backendCliPort ?? backendEnvPort ?? DEFAULT_BACKEND_PORT;
const backendPort = await findPort(backendPreferred, backendExplicit);
const frontendPreferred = frontendCliPort ?? frontendEnvPort ?? DEFAULT_FRONTEND_PORT;
const frontendPort = await findPort(frontendPreferred, frontendExplicit, new Set([backendPort]));

const devUrl = `http://127.0.0.1:${frontendPort}`;
const childEnv = {
  ...process.env,
  PORT: String(backendPort),
  BACKEND_PORT: String(backendPort),
  FRONTEND_PORT: String(frontendPort),
  VITE_API_PORT: String(backendPort),
  VITE_API_URL: `http://localhost:${backendPort}/api`,
  VITE_DEV_SERVER_URL: devUrl
};

console.log(`Multiprise dev ports: backend ${backendPort}, renderer ${frontendPort}`);

const renderer = run('npm', ['run', 'dev:renderer'], { env: childEnv });

const electron = run('npm', ['run', 'dev:electron'], { env: childEnv });

const shutdown = () => {
  electron.kill('SIGINT');
  renderer.kill('SIGINT');
};

renderer.on('exit', (code) => {
  if (code && code !== 0) electron.kill('SIGINT');
});

electron.on('exit', () => {
  renderer.kill('SIGINT');
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
