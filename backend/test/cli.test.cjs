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

// Secrets normally go to the macOS Keychain through Electron; tests keep them in memory.
const secretValues = new Map()
require('../dist/environment.js').setSecretStore({
  get: async (id, key) => secretValues.get(`${id}:${key}`) ?? null,
  set: async (id, key, value) => { secretValues.set(`${id}:${key}`, value) },
  remove: async (id, key) => { for (const name of [...secretValues.keys()]) if (name.startsWith(`${id}:${key ?? ''}`)) secretValues.delete(name) }
})

// Each test gets its own saved projects; the CLI finds the server through this folder.
async function startAdvertisedServer(context) {
  process.env.MULTIPRISE_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'multiprise-cli-data-'))
  const backend = await startServer({ advertise: true, proxyPort: false })
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
  assert.deepEqual(tools, [
    'list_services', 'start_service', 'stop_service', 'restart_service', 'tail_logs', 'get_url', 'get_service', 'add_project',
    'remove_project', 'configure_service', 'set_environment', 'set_dependencies', 'list_ports', 'list_processes', 'kill_process',
    'prepare_service', 'get_settings', 'update_settings'
  ])

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

  const project = path.basename(root)
  const configured = JSON.parse((await call('set_environment', { service: `${project}/web`, set: { API_URL: '{{services.api.url}}', TOKEN: 's3cret' }, secret: false })).content[0].text)
  assert.deepEqual(configured.variables.map((variable) => variable.key), ['API_URL', 'TOKEN'])
  await call('set_environment', { service: `${project}/web`, unset: ['TOKEN'] })
  await call('set_dependencies', { service: `${project}/web`, depends_on: ['api'] })
  await call('configure_service', { service: `${project}/web`, command: 'node server.js' })
  const details = JSON.parse((await call('get_service', { service: `${project}/web` })).content[0].text)
  assert.equal(details.command, 'node server.js')
  assert.equal(details.command_source, 'user')
  assert.deepEqual(details.depends_on, [`${project}/api`])
  assert.deepEqual(details.variables, [{ key: 'API_URL', value: '{{services.api.url}}', secret: false }])
  const preview = JSON.parse((await call('add_project', { folder: root, dry_run: true })).content[0].text)
  assert.deepEqual(preview[0].services.map((entry) => entry.name).sort(), ['api', 'web'])
  const badSetting = await call('update_settings', { settings: { colour: 'blue' } })
  assert.equal(badSetting.isError, true)
  assert.match(logs.content[0].text, /api ready/)
  const merged = await call('tail_logs', { service: project, grep: 'ready' })
  assert.match(merged.content[0].text, /\[.*api\] api ready/)

  const stopped = JSON.parse((await call('stop_service', { service: root })).content[0].text)
  assert.deepEqual(stopped.map((entry) => entry.outcome), ['stopped', 'stopped'])

  child.stdin.end()
  const code = await new Promise((resolve) => child.on('exit', resolve))
  assert.equal(code, 0)
})

test('the CLI configures services, projects and settings end to end', async (context) => {
  await startAdvertisedServer(context)
  const root = await twoServiceProject()
  const project = path.basename(root)
  const cli = async (...args) => {
    const result = await runCli(args, { cwd: os.tmpdir() })
    return { ...result, json: () => JSON.parse(result.stdout) }
  }
  const ok = async (...args) => {
    const result = await cli(...args)
    assert.equal(result.code, 0, `multiprise ${args.join(' ')}\n${result.stderr}\n${result.stdout}`)
    return result
  }

  // Adding: a dry run saves nothing, then the folder is tracked once.
  const preview = (await ok('add', root, '--dry-run', '--json')).json()
  assert.deepEqual(preview[0].services.map((entry) => entry.name).sort(), ['api', 'web'])
  assert.deepEqual((await ok('ls', '--json')).json(), [])
  const added = (await ok('add', root, '--json')).json()
  assert.deepEqual(added[0].services.sort(), ['api', 'web'])
  const again = await cli('add', root)
  assert.equal(again.code, 1)
  assert.match(again.stdout, /already exists/)

  // Command, port, environment and dependencies of one service.
  assert.equal((await ok('command', `${project}/web`, '--', 'node', 'server.js', '--verbose')).stdout.trim(), 'node server.js --verbose  (set by you)')
  assert.match((await ok('command', `${project}/web`, '--auto')).stdout, /npm run dev.*\(detected\)/)
  assert.equal((await ok('port', `${project}/api`, '4567', '--json')).json().port, 4567)
  assert.equal((await ok('port', `${project}/api`, '--clear', '--json')).json().port, null)
  assert.equal((await cli('port', `${project}/api`, '70000')).code, 2)

  await ok('env', `${project}/web`, 'set', 'API_URL={{services.api.url}}', 'MODE=a=b')
  await ok('env', `${project}/web`, 'set', 'TOKEN=hunter2', '--secret')
  const env = (await ok('env', `${project}/web`, '--json')).json()
  assert.deepEqual(env.variables, [
    { key: 'API_URL', value: '{{services.api.url}}', secret: false },
    { key: 'MODE', value: 'a=b', secret: false },
    { key: 'TOKEN', value: null, secret: true }
  ])
  assert.doesNotMatch((await ok('env', `${project}/web`)).stdout, /hunter2/)
  await ok('env', `${project}/web`, 'unset', 'MODE')
  assert.equal((await cli('env', `${project}/web`, 'unset', 'NOPE')).code, 2)
  assert.equal((await cli('env', `${project}/web`, 'set', '1BAD=x')).code, 2)

  assert.deepEqual((await ok('deps', `${project}/web`, 'add', 'api', '--json')).json().depends_on, [`${project}/api`])
  assert.match((await cli('deps', `${project}/api`, 'add', 'web')).stderr, /loop/)
  assert.deepEqual((await ok('deps', `${project}/web`, 'clear', '--json')).json().depends_on, [])
  await ok('deps', `${project}/web`, 'set', 'api')

  const info = (await ok('info', `${project}/web`, '--json')).json()
  assert.equal(info.name, `${project}/web`)
  assert.deepEqual(info.depends_on, [`${project}/api`])
  assert.deepEqual(info.variables.map((variable) => variable.key), ['API_URL', 'TOKEN'])

  // Logs read the whole project, interleaved and filtered.
  await ok('up', project)
  const logs = (await ok('logs', project, '--grep', 'ready', '--json')).json()
  assert.deepEqual(logs.map((entry) => [entry.service, entry.line]), [[`${project}/api`, 'api ready']])
  assert.equal((await ok('ps', `${project}/api`, '--json')).json()[0].source, 'managed')
  assert.ok((await ok('ports', '--json')).json().some((entry) => entry.source === 'managed'))
  assert.equal((await cli('kill', `${project}/api`)).code, 1)
  await ok('down', project)

  // Settings take typed values and reject unknown names.
  const settings = (await ok('settings', 'set', 'auto_restart=off', 'startup_timeout_ms=25000', 'scan_ignore=dist, build', '--json')).json()
  assert.equal(settings.auto_restart, false)
  assert.equal(settings.startup_timeout_ms, 25000)
  assert.deepEqual(settings.scan_ignore, ['dist', 'build'])
  assert.equal((await cli('settings', 'set', 'colour=blue')).code, 2)
  assert.equal((await ok('api', 'GET', '/api/settings')).json().auto_restart, false)

  // Renaming, then untracking, which needs --yes without a terminal.
  await ok('rename', `${project}/web`, 'storefront')
  assert.ok((await ok('ls', '--json')).json()[0].services.some((entry) => entry.name === 'storefront'))
  const unconfirmed = await cli('remove', project)
  assert.equal(unconfirmed.code, 2)
  assert.match(unconfirmed.stderr, /--yes/)
  assert.deepEqual((await ok('remove', project, '--yes', '--json')).json().removed.sort(), [`${project}/api`, `${project}/storefront`])
  assert.deepEqual((await ok('ls', '--json')).json(), [])

  // Help lists every command, and each has its own page.
  const help = await ok('help')
  for (const command of ['add', 'remove', 'env', 'deps', 'settings', 'kill', 'events', 'api']) assert.match(help.stdout, new RegExp(`\\n  ${command} `))
  assert.match((await ok('help', 'env')).stdout, /services\.api\.url/)
  assert.equal((await cli('frobnicate')).code, 2)
})
