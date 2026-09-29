const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

// Never let tests touch the developer's real backend/data directory.
process.env.MULTIPRISE_DATA_DIR = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'multiprise-actions-data-'))

const { startServer, stopServer } = require('../dist/index.js')

async function startApi(context) {
  process.env.MULTIPRISE_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'multiprise-actions-data-'))
  const backend = await startServer({ proxyPort: false })
  context.after(() => stopServer(backend))
  const call = async (method, route, body) => {
    const response = await fetch(`${backend.url}${route}`, {
      method,
      headers: { 'x-multiprise-token': backend.token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await response.text()
    let parsed = text
    try { parsed = JSON.parse(text) } catch (err) { /* plain-text error */ }
    return { status: response.status, body: parsed }
  }
  return { call }
}

// A one-service project whose server.js is `source`.
async function service(api, source, packageJson = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'multiprise-actions-'))
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'svc', scripts: { dev: 'node server.js' }, ...packageJson }))
  await fs.writeFile(path.join(root, 'server.js'), source)
  const created = await api.call('POST', '/api/projects', { path: root })
  assert.equal(created.status, 200, created.body)
  return { root, id: created.body.projects[0].project.id }
}

const status = async (api, id) => (await api.call('GET', '/api/projects')).body.projects.find((entry) => entry.project.id === id).status

test('a failed start reports what kind of failure it was, so the app can offer a fix', async (context) => {
  const api = await startApi(context)

  const crashing = await service(api, "console.error('boom'); process.exit(1)")
  assert.equal((await api.call('POST', `/api/projects/${crashing.id}/start`, { role: 'backend' })).status, 400)
  assert.equal((await status(api, crashing.id)).failure_code, 'early-exit')

  const portTaken = await service(api, "console.error('Error: listen EADDRINUSE: address already in use :::3000'); process.exit(1)")
  assert.equal((await api.call('POST', `/api/projects/${portTaken.id}/start`, { role: 'backend' })).status, 400)
  assert.equal((await status(api, portTaken.id)).failure_code, 'port-in-use')

  const badEnv = await service(api, "require('http').createServer().listen(Number(process.env.PORT), '127.0.0.1')")
  await api.call('PUT', `/api/projects/${badEnv.id}/environment`, { variables: [{ key: 'API_URL', value: '{{services.nope.url}}' }] })
  assert.equal((await api.call('POST', `/api/projects/${badEnv.id}/start`, { role: 'backend' })).status, 400)
  const failed = await status(api, badEnv.id)
  assert.equal(failed.failure_code, 'environment-missing')
  assert.match(failed.error, /API_URL refers to "nope"/)
})

test('the build fix runs the project build script, and preparing needs a stopped service', async (context) => {
  const api = await startApi(context)
  const { root, id } = await service(api, "require('http').createServer((q, r) => r.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')", {
    scripts: { dev: 'node server.js', build: "node -e \"require('fs').writeFileSync('built.txt', 'ok')\"" }
  })
  assert.equal((await api.call('POST', `/api/projects/${id}/prepare`, { step: 'deploy' })).status, 400)
  assert.equal((await api.call('POST', `/api/projects/${id}/prepare`, { step: 'build' })).status, 200)
  assert.equal(await fs.readFile(path.join(root, 'built.txt'), 'utf8'), 'ok')
  const logs = (await api.call('GET', `/api/projects/${id}/logs`)).body.logs.map((entry) => entry.line).join('\n')
  assert.match(logs, /\[prepare\] Building: npm run build/)

  assert.equal((await api.call('POST', `/api/projects/${id}/start`, { role: 'backend' })).status, 200)
  assert.equal((await api.call('POST', `/api/projects/${id}/prepare`, { step: 'build' })).status, 409)
})

test('only files inside the project can be opened from the logs', async (context) => {
  const api = await startApi(context)
  const { id } = await service(api, '')
  const open = (body) => api.call('POST', `/api/projects/${id}/open-file`, body)
  assert.equal((await open({})).status, 400)
  assert.equal((await open({ path: '/etc/hosts', line: 1 })).status, 403)
  assert.equal((await open({ path: '../../../../etc/hosts' })).status, 403)
  assert.equal((await open({ path: 'file:///etc/hosts' })).status, 403)
  const missing = await open({ path: 'src/missing.ts', line: 3 })
  assert.equal(missing.status, 404)
  assert.match(missing.body, /src\/missing\.ts was not found/)
})
