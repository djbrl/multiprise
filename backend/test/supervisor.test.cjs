const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

// Never let tests touch the developer's real backend/data directory.
process.env.MULTIPRISE_DATA_DIR = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'multiprise-supervisor-data-'))

const { startServer, stopServer } = require('../dist/index.js')

const FAST = { healthIntervalMs: 150, probeTimeoutMs: 120, unresponsiveAfter: 2, restartDelaysMs: [100, 100], restartWindowMs: 60000 }

async function startApi(context, supervisor = FAST) {
  process.env.MULTIPRISE_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'multiprise-supervisor-data-'))
  const backend = await startServer({ supervisor, proxyPort: false })
  context.after(() => stopServer(backend))
  const call = async (method, route, body) => {
    const response = await fetch(`${backend.url}${route}`, {
      method,
      headers: { 'x-multiprise-token': backend.token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await response.text()
    return { status: response.status, body: text ? (() => { try { return JSON.parse(text) } catch (err) { return text } })() : null }
  }
  return { backend, call }
}

// A one-service project whose server.js is `source`; it listens on PORT.
async function addService(api, source) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'multiprise-supervised-'))
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'svc', scripts: { dev: 'node server.js' } }))
  await fs.writeFile(path.join(root, 'server.js'), source)
  const created = await api.call('POST', '/api/projects', { path: root })
  assert.equal(created.status, 200, created.body)
  return { root, id: created.body.projects[0].project.id }
}

const view = async (api, id) => (await api.call('GET', '/api/projects')).body.projects.find((entry) => entry.project.id === id)
const logText = async (api, id) => (await api.call('GET', `/api/projects/${id}/logs`)).body.logs.map((entry) => entry.line).join('\n')

async function waitFor(check, timeoutMs = 8000, label = 'condition') {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    last = await check()
    if (last) return last
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

const serve = "require('http').createServer((q, r) => r.end('ok')).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('listening on ' + process.env.PORT))"

test('a service that crashes after it was ready is restarted on the same port, keeping its crash output', async (context) => {
  const api = await startApi(context)
  // The first run crashes shortly after becoming ready; the restarted one stays up.
  const { root, id } = await addService(api, `
    const fs = require('fs')
    ${serve}
    if (!fs.existsSync('crashed-once')) setTimeout(() => { fs.writeFileSync('crashed-once', ''); console.error('boom: first run crashing'); process.exit(3) }, 400)`)

  assert.equal((await api.call('POST', `/api/projects/${id}/start`, { role: 'backend' })).status, 200)
  const port = (await view(api, id)).project.port
  await waitFor(() => fs.stat(path.join(root, 'crashed-once')).then(() => true, () => false), 5000, 'the crash')
  const restarted = await waitFor(async () => {
    const current = await view(api, id)
    return current.status.phase === 'ready' && (await logText(api, id)).includes('Restarted.') && current
  }, 8000, 'the restart')
  assert.equal(restarted.project.port, port)
  const logs = await logText(api, id)
  assert.match(logs, /boom: first run crashing/)
  assert.match(logs, /Restarting in \d+s \(attempt 1 of 2\)/)
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'ok')
})

test('a service that keeps crashing is restarted a bounded number of times, then left failed', async (context) => {
  const api = await startApi(context)
  const { id } = await addService(api, `${serve}\nsetTimeout(() => process.exit(4), 300)`)
  assert.equal((await api.call('POST', `/api/projects/${id}/start`, { role: 'backend' })).status, 200)
  await waitFor(async () => (await logText(api, id)).includes('leaving it stopped'), 10000, 'giving up')
  const logs = await logText(api, id)
  assert.equal((logs.match(/Restarted\./g) ?? []).length, 2)
  await new Promise((resolve) => setTimeout(resolve, 600))
  const final = await view(api, id)
  assert.equal(final.status.phase, 'failed')
  assert.equal(final.status.running, false)
})

test('no restart happens when auto-restart is off, or when the user stops the service during the backoff', async (context) => {
  const api = await startApi(context, { ...FAST, restartDelaysMs: [800] })
  const crashy = `${serve}\nsetTimeout(() => process.exit(5), 300)`
  const first = await addService(api, crashy)
  const second = await addService(api, crashy)

  assert.equal((await api.call('POST', `/api/projects/${first.id}/start`, { role: 'backend' })).status, 200)
  await waitFor(async () => (await logText(api, first.id)).includes('Restarting in'), 5000, 'a scheduled restart')
  assert.equal((await api.call('POST', `/api/projects/${first.id}/stop`, {})).status, 200)

  assert.equal((await api.call('PATCH', '/api/settings', { auto_restart: false })).body.auto_restart, false)
  assert.equal((await api.call('POST', `/api/projects/${second.id}/start`, { role: 'backend' })).status, 200)
  await waitFor(async () => (await view(api, second.id)).status.phase === 'failed', 5000, 'the crash')

  await new Promise((resolve) => setTimeout(resolve, 1300))
  assert.equal((await view(api, first.id)).status.phase, 'stopped')
  assert.doesNotMatch(await logText(api, first.id), /Restarted\./)
  assert.equal((await view(api, second.id)).status.phase, 'failed')
  assert.doesNotMatch(await logText(api, second.id), /Restarting in/)
})

test('a server that stops answering is flagged, keeps running, and is ready again once it recovers', async (context) => {
  const api = await startApi(context)
  // Blocks its event loop for 1.5s: connections are still accepted, requests are not answered.
  const { id } = await addService(api, `${serve}\nsetTimeout(() => { const end = Date.now() + 1500; while (Date.now() < end) {} }, 600)`)
  assert.equal((await api.call('POST', `/api/projects/${id}/start`, { role: 'backend' })).status, 200)

  const hung = await waitFor(async () => {
    const current = await view(api, id)
    return current.status.phase === 'failed' && current
  }, 5000, 'the hang to be noticed')
  assert.equal(hung.status.running, true)
  assert.ok(hung.status.pid)
  assert.match(hung.status.error, /Not responding on port \d+/)

  const recovered = await waitFor(async () => {
    const current = await view(api, id)
    return current.status.phase === 'ready' && current
  }, 5000, 'the recovery')
  assert.equal(recovered.status.error, null)
  assert.equal(recovered.status.pid, hung.status.pid)
  assert.match(await logText(api, id), /Responding again\./)
})

test('a service that accepts connections but never speaks HTTP stays ready', async (context) => {
  const api = await startApi(context)
  const { id } = await addService(api, "require('net').createServer(() => {}).listen(Number(process.env.PORT), '127.0.0.1')")
  assert.equal((await api.call('POST', `/api/projects/${id}/start`, { role: 'backend' })).status, 200)
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const current = await view(api, id)
  assert.equal(current.status.phase, 'ready')
})
