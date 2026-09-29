const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

// Never let tests touch the developer's real backend/data directory.
process.env.MULTIPRISE_DATA_DIR = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'multiprise-docker-data-'))

const { parseComposePs, composeStatus } = require('../dist/docker.js')
const { startServer, stopServer } = require('../dist/index.js')

const container = (service, extra = {}) => ({ service, state: 'running', health: '', exit_code: 0, ports: [], ...extra })

test('docker compose ps output is read in both the array and the line-per-container formats', () => {
  const entries = [
    { Service: 'web', State: 'running', Health: '', ExitCode: 0, Publishers: [{ PublishedPort: 8080, Protocol: 'tcp' }, { PublishedPort: 8080, Protocol: 'tcp' }, { PublishedPort: 0, Protocol: 'tcp' }] },
    { Service: 'db', State: 'exited', Health: 'unhealthy', ExitCode: 1, Publishers: null }
  ]
  const expected = [
    { service: 'web', state: 'running', health: '', exit_code: 0, ports: [8080] },
    { service: 'db', state: 'exited', health: 'unhealthy', exit_code: 1, ports: [] }
  ]
  assert.deepEqual(parseComposePs(JSON.stringify(entries)), expected)
  assert.deepEqual(parseComposePs(entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'), expected)
  assert.deepEqual(parseComposePs('  '), [])
})

test('container states map to the service status', () => {
  assert.equal(composeStatus([]).phase, 'stopped')
  assert.equal(composeStatus([container('web'), container('db', { health: 'healthy' })]).phase, 'ready')
  assert.equal(composeStatus([container('web'), container('db', { health: 'starting' })]).phase, 'starting')
  // One-off containers that finished, and containers that were stopped, are not failures.
  assert.equal(composeStatus([container('web'), container('migrate', { state: 'exited', exit_code: 0 })]).phase, 'ready')
  assert.equal(composeStatus([container('web', { state: 'exited', exit_code: 143 })]).phase, 'stopped')

  const crashed = composeStatus([container('web'), container('worker', { state: 'exited', exit_code: 2 })])
  assert.equal(crashed.phase, 'failed')
  assert.equal(crashed.running, true)
  assert.match(crashed.error, /worker exited with code 2/)
  assert.match(composeStatus([container('db', { state: 'restarting' })]).error, /db keeps restarting/)
  assert.match(composeStatus([container('db', { health: 'unhealthy' })]).error, /db is unhealthy/)
})

// A stand-in for the docker CLI: `ps` prints $FAKE_DOCKER_DIR/ps.json, `up` and `down`
// rewrite it, and `logs --follow` prints a line and stays open like the real command.
async function installFakeDocker(context) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'multiprise-fake-docker-'))
  const running = JSON.stringify([
    { Service: 'db', State: 'running', Health: 'healthy', ExitCode: 0, Publishers: [{ PublishedPort: 5432, Protocol: 'tcp' }] },
    { Service: 'web', State: 'running', Health: '', ExitCode: 0, Publishers: [{ PublishedPort: 8080, Protocol: 'tcp' }] }
  ])
  await fs.writeFile(path.join(dir, 'running.json'), running)
  await fs.writeFile(path.join(dir, 'docker'), `#!/bin/sh
state="$FAKE_DOCKER_DIR/ps.json"
case "$2" in
  ps) [ -f "$FAKE_DOCKER_DIR/daemon-down" ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
      cat "$state" 2>/dev/null ;;
  up) echo "Container web-1 Started"; cp "$FAKE_DOCKER_DIR/running.json" "$state" ;;
  down) echo "Container web-1 Removed"; echo "[]" > "$state" ;;
  logs) echo "$@" >> "$FAKE_DOCKER_DIR/logs-args"; echo "web-1  | hello from web"; exec sleep 30 ;;
esac
`, { mode: 0o755 })
  const previousPath = process.env.PATH
  process.env.PATH = `${dir}${path.delimiter}${previousPath}`
  process.env.FAKE_DOCKER_DIR = dir
  context.after(() => { process.env.PATH = previousPath })
  return dir
}

async function startApi(context) {
  process.env.MULTIPRISE_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'multiprise-docker-data-'))
  const backend = await startServer({ dockerIntervalMs: 100 })
  context.after(() => stopServer(backend))
  const call = async (method, route, body) => {
    const response = await fetch(`${backend.url}${route}`, {
      method,
      headers: { 'x-multiprise-token': backend.token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await response.text()
    return { status: response.status, body: text && text.startsWith('{') ? JSON.parse(text) : text }
  }
  return { backend, call }
}

async function waitFor(check, timeoutMs = 5000, label = 'condition') {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

test('Docker Compose services show their real container state, port and logs', async (context) => {
  const fake = await installFakeDocker(context)
  const api = await startApi(context)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'multiprise-compose-'))
  await fs.writeFile(path.join(root, 'compose.yaml'), 'services: {}\n')
  const created = await api.call('POST', '/api/projects', { path: root })
  assert.equal(created.status, 200, created.body)
  const id = created.body.projects[0].project.id
  const view = async () => (await api.call('GET', '/api/projects')).body.projects.find((entry) => entry.project.id === id)
  const logs = async () => (await api.call('GET', `/api/projects/${id}/logs`)).body.logs.map((entry) => entry.line).join('\n')

  const started = await api.call('POST', `/api/projects/${id}/start`, {})
  assert.equal(started.status, 200, started.body)
  assert.equal(started.body.status.phase, 'ready')
  assert.equal(started.body.project.port, 8080, 'the web port wins over the database port')
  assert.deepEqual(started.body.status.containers.map((entry) => entry.service), ['db', 'web'])
  await waitFor(async () => (await logs()).includes('hello from web'), 5000, 'container logs')
  assert.match(await fs.readFile(path.join(fake, 'logs-args'), 'utf8'), /--follow --no-color --since \d{4}-\d\d-\d\dT/)

  // Containers changing outside the app are picked up.
  await fs.writeFile(path.join(fake, 'ps.json'), JSON.stringify([{ Service: 'web', State: 'exited', ExitCode: 1 }]))
  const crashed = await waitFor(async () => { const current = await view(); return current.status.phase === 'failed' && current }, 3000, 'the crash')
  assert.match(crashed.status.error, /web exited with code 1/)
  assert.equal(crashed.project.docker_running, false)

  await fs.writeFile(path.join(fake, 'daemon-down'), '')
  await fs.copyFile(path.join(fake, 'running.json'), path.join(fake, 'ps.json'))
  const down = await waitFor(async () => { const current = await view(); return current.status.phase === 'stopped' && current }, 3000, 'Docker going away')
  assert.equal(down.status.running, false)
  await fs.rm(path.join(fake, 'daemon-down'))
  await waitFor(async () => (await view()).status.phase === 'ready', 3000, 'Docker coming back')

  const stopped = await api.call('POST', `/api/projects/${id}/stop`, {})
  assert.equal(stopped.body.status.phase, 'stopped')
  assert.match(await logs(), /Container web-1 Removed/)
})

test('containers left running while the app was closed show as running after it starts', async (context) => {
  const fake = await installFakeDocker(context)
  await fs.copyFile(path.join(fake, 'running.json'), path.join(fake, 'ps.json'))
  const api = await startApi(context)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'multiprise-compose-'))
  await fs.writeFile(path.join(root, 'docker-compose.yml'), 'services: {}\n')
  const created = await api.call('POST', '/api/projects', { path: root })
  const id = created.body.projects[0].project.id

  const running = await waitFor(async () => {
    const current = (await api.call('GET', '/api/projects')).body.projects.find((entry) => entry.project.id === id)
    return current.status.phase === 'ready' && current
  }, 3000, 'the running containers')
  assert.equal(running.status.running, true)
  assert.equal(running.project.port, 8080)
})
