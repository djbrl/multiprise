const assert = require('node:assert/strict')
const { execFile, spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const test = require('node:test')

// Never let tests touch the developer's real backend/data directory.
process.env.MULTIPRISE_DATA_DIR = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'multiprise-cli-data-'))

const { startServer, stopServer } = require('../dist/index.js')
const { readDiscoveryFile, writeDiscoveryFile, DISCOVERY_FILE } = require('../dist/discovery.js')
const { resolveTarget, resolveService, resolveCurrentProject, UsageError } = require('../dist/cli/services.js')

const CLI = path.join(__dirname, '..', 'dist', 'cli', 'index.js')

// Each test gets its own saved projects; the CLI finds the server through this folder.
async function startAdvertisedServer(context) {
  process.env.MULTIPRISE_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'multiprise-cli-data-'))
  const backend = await startServer({ advertise: true })
  context.after(() => stopServer(backend))
  return backend
}

function runCli(args, options = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: '1', ...options.env }
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }))
  })
}

async function addProject(backend, root) {
  const response = await fetch(`${backend.url}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-multiprise-token': backend.token },
    body: JSON.stringify({ path: root })
  })
  assert.equal(response.status, 200, await response.clone().text())
  return (await response.json()).projects
}

// A project with an api and a web service; web reports whether the api was already up.
async function twoServiceProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'multiprise-cli-shop-'))
  const serve = (body) => `require('http').createServer((q,r)=>r.end(${JSON.stringify(body)})).listen(Number(process.env.PORT),'127.0.0.1')`
  await fs.mkdir(path.join(root, 'api'))
  await fs.writeFile(path.join(root, 'api', 'package.json'), JSON.stringify({ name: 'api', scripts: { dev: 'node server.js' } }))
  await fs.writeFile(path.join(root, 'api', 'server.js'), `console.log('api ready');${serve('api')}`)
  await fs.mkdir(path.join(root, 'web'))
  await fs.writeFile(path.join(root, 'web', 'package.json'), JSON.stringify({ name: 'web', scripts: { dev: 'node server.js' } }))
  await fs.writeFile(path.join(root, 'web', 'server.js'), `
    const probe = require('net').connect(Number(process.env.BACKEND_PORT), '127.0.0.1')
    probe.on('connect', () => { console.log('backend reachable on ' + process.env.BACKEND_PORT); probe.end() })
    probe.on('error', () => console.log('backend unreachable'))
    ${serve('web')}`)
  return fs.realpath(root)
}

const service = (project, name, extra = {}) => ({
  id: `${project}-${name}-id`, name, project, path: `/code/${project}/${name}`, role: 'service', kind: 'command',
  phase: 'stopped', running: false, port: null, url: null, pid: null, command: null, error: null, ...extra
})

const fixtureProjects = () => [
  { name: 'shop', path: '/code/shop', services: [service('shop', 'api'), service('shop', 'web')] },
  { name: 'blog', path: '/code/blog', services: [{ ...service('blog', 'blog'), path: '/code/blog' }] },
  { name: 'admin', path: '/code/admin', services: [{ ...service('admin', 'web'), path: '/code/admin/web' }] }
]

test('names resolve to projects, services, project/service pairs and folders', () => {
  const projects = fixtureProjects()
  const names = (target) => target.services.map((entry) => `${entry.project}/${entry.name}`)

  assert.deepEqual(names(resolveTarget(projects, 'shop')), ['shop/api', 'shop/web'])
  assert.equal(resolveTarget(projects, 'Shop').whole, true)
  assert.deepEqual(names(resolveTarget(projects, 'api')), ['shop/api'])
  assert.deepEqual(names(resolveTarget(projects, 'admin/web')), ['admin/web'])
  assert.deepEqual(names(resolveTarget(projects, 'shop-web-id')), ['shop/web'])
  assert.deepEqual(names(resolveTarget(projects, './web', '/code/shop')), ['shop/web'])
  assert.deepEqual(names(resolveTarget(projects, '/code/shop/api/src')), ['shop/api', 'shop/web'])
  assert.throws(() => resolveTarget(projects, 'web'), (err) => err instanceof UsageError && /ambiguous.*shop\/web.*admin\/web/.test(err.message))
  assert.throws(() => resolveTarget(projects, 'nope'), UsageError)

  // Without a name: the whole project for up/down, the enclosing service for url/logs.
  assert.deepEqual(names(resolveCurrentProject(projects, '/code/shop/web/src')), ['shop/api', 'shop/web'])
  assert.equal(resolveService(projects, undefined, '/code/shop/web/src').name, 'web')
  assert.equal(resolveService(projects, undefined, '/code/blog').name, 'blog')
  assert.equal(resolveService(projects, 'blog').name, 'blog')
  assert.throws(() => resolveService(projects, undefined, '/code/shop'), /several services/)
  assert.throws(() => resolveCurrentProject(projects, '/elsewhere'), /No Multiprise project contains/)
})

test('the running app advertises its API privately and withdraws it on shutdown', async (context) => {
  const backend = await startAdvertisedServer(context)
  const file = path.join(process.env.MULTIPRISE_DATA_DIR, DISCOVERY_FILE)
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
  assert.deepEqual(await readDiscoveryFile(process.env.MULTIPRISE_DATA_DIR), { url: backend.url, token: backend.token, pid: process.pid })

  const listed = await runCli(['ls', '--json'])
  assert.equal(listed.code, 0, listed.stderr)
  assert.deepEqual(JSON.parse(listed.stdout), [])

  await stopServer(backend)
  await assert.rejects(fs.stat(file))
  const stopped = await runCli(['ls'])
  assert.equal(stopped.code, 1)
  assert.match(stopped.stderr, /Multiprise is not running/)
})

test('a discovery file left behind by a crashed app is ignored', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'multiprise-cli-stale-'))
  const exited = spawnSync(process.execPath, ['-e', '0'])
  await writeDiscoveryFile(dir, { url: 'http://127.0.0.1:9', token: 'stale', pid: exited.pid })
  const result = await runCli(['url', 'anything'], { env: { MULTIPRISE_DATA_DIR: dir } })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /Multiprise is not running/)
})

test('multiprise up starts a project backend first with linked ports, and down stops it', async (context) => {
  const backend = await startAdvertisedServer(context)
  const root = await twoServiceProject()
  const created = await addProject(backend, root)
  assert.deepEqual(created.map((view) => view.project.name).sort(), ['api', 'web'])

  // From inside a service folder, `up` still means the whole project.
  const up = await runCli(['up'], { cwd: path.join(root, 'web') })
  assert.equal(up.code, 0, up.stderr)
  assert.match(up.stderr, /Starting .*api[\s\S]*Starting .*web/)

  const listed = JSON.parse((await runCli(['ls', '--json'])).stdout)
  const services = Object.fromEntries(listed[0].services.map((entry) => [entry.name, entry]))
  assert.equal(services.api.phase, 'ready')
  assert.equal(services.web.phase, 'ready')
  assert.equal(services.api.url, `http://localhost:${services.api.port}`)

  const url = await runCli(['url', 'web'], { cwd: os.tmpdir() })
  assert.equal(url.stdout.trim(), services.web.url)
  assert.equal(await (await fetch(url.stdout.trim().replace('localhost', '127.0.0.1'))).text(), 'web')

  const logs = await runCli(['logs', path.join(root, 'web')])
  assert.match(logs.stdout, new RegExp(`backend reachable on ${services.api.port}`))

  const again = await runCli(['up', path.basename(root)])
  assert.equal(again.code, 0)
  assert.equal((again.stdout.match(/already running/g) ?? []).length, 2)

  const down = await runCli(['down', root])
  assert.equal(down.code, 0, down.stderr)
  const after = JSON.parse((await runCli(['ls', '--json'])).stdout)
  assert.deepEqual(after[0].services.map((entry) => entry.phase), ['stopped', 'stopped'])
  const stoppedUrl = await runCli(['url', 'api'])
  assert.equal(stoppedUrl.code, 2)
  assert.match(stoppedUrl.stderr, /is stopped/)
})

test('the MCP server exposes the service tools and answers over stdio', async (context) => {
  const backend = await startAdvertisedServer(context)
  const root = await twoServiceProject()
  await addProject(backend, root)

  const child = spawn(process.execPath, [CLI, 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] })
  context.after(() => child.kill())
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let nextId = 1
  const rpc = async (method, params) => {
    const id = nextId++
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    const message = JSON.parse((await lines.next()).value)
    assert.equal(message.id, id)
    return message
  }
  const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result

  const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
  assert.equal(init.result.protocolVersion, '2025-03-26')
  assert.equal(init.result.serverInfo.name, 'multiprise')
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

  const tools = (await rpc('tools/list')).result.tools.map((tool) => tool.name)
  assert.deepEqual(tools, ['list_services', 'start_service', 'stop_service', 'restart_service', 'tail_logs', 'get_url'])

  const started = JSON.parse((await call('start_service', { service: path.basename(root) })).content[0].text)
  assert.deepEqual(started.map((entry) => [entry.name.split('/').pop(), entry.outcome, entry.status]), [['api', 'started', 'ready'], ['web', 'started', 'ready']])

  const url = await call('get_url', { service: `${path.basename(root)}/api` })
  assert.equal(url.content[0].text, started[0].url)
  const logs = await call('tail_logs', { service: 'api', lines: 5 })
  assert.match(logs.content[0].text, /api ready/)

  const missing = await call('get_url', { service: 'nope' })
  assert.equal(missing.isError, true)
  assert.match(missing.content[0].text, /No project or service named "nope"/)
  assert.equal((await rpc('tools/call', { name: 'rm_rf', arguments: {} })).error.code, -32602)
  assert.equal((await rpc('resources/list')).error.code, -32601)

  const stopped = JSON.parse((await call('stop_service', { service: root })).content[0].text)
  assert.deepEqual(stopped.map((entry) => entry.outcome), ['stopped', 'stopped'])

  child.stdin.end()
  const code = await new Promise((resolve) => child.on('exit', resolve))
  assert.equal(code, 0)
})
