const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

// Never let tests touch the developer's real backend/data directory.
process.env.MULTIPRISE_DATA_DIR = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'multiprise-test-data-'))

const scanner = require('../dist/scanner.js')
const processes = require('../dist/processes.js')
const runtime = require('../dist/runtime.js')
const { prepareService } = require('../dist/preparation.js')
const { classifyStartupFailure, detectStartupConflict } = require('../dist/failures.js')

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`))
}

async function freePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close(() => resolve(port))
    })
  })
}

test('development scripts outrank a broken production start command', () => {
  const selected = scanner.pickScript({
    start: 'node dist/main.js',
    'start:dev': 'nest start --watch'
  })
  assert.equal(selected, 'start:dev')
  assert.ok(scanner.scoreScript('start', 'node dist/main.js') < scanner.scoreScript('start:dev', 'nest start --watch'))
})

test('packageManager metadata wins over lockfile inference', async () => {
  const root = await temporaryDirectory('multiprise-manager')
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    packageManager: 'pnpm@9.15.0',
    scripts: { dev: 'vite' },
    devDependencies: { vite: '^7.0.0' }
  }))
  await fs.writeFile(path.join(root, 'package-lock.json'), '{}')

  const detection = await scanner.detectProject(root, root)
  assert.equal(detection.package_manager, 'pnpm')
  assert.equal(detection.suggested_command, 'pnpm dev')
  assert.equal(detection.framework, 'vite')
})

test('Vite receives a strict selected port through CLI arguments', () => {
  assert.equal(
    scanner.adaptCommandForFramework({ command: 'npm run dev', framework: 'vite', packageManager: 'npm', port: 5178 }),
    'npm run dev -- --port 5178 --host 127.0.0.1'
  )
})

test('Nuxt receives a strict selected port through CLI arguments', () => {
  assert.equal(
    scanner.adaptCommandForFramework({ command: 'npm run dev', framework: 'nuxt', packageManager: 'npm', port: 4836 }),
    'npm run dev -- --port 4836 --host 127.0.0.1'
  )
})


test('Node runtime declarations are inherited from the selected project root', async () => {
  const root = await temporaryDirectory('multiprise-runtime')
  const service = path.join(root, 'apps', 'web')
  await fs.mkdir(service, { recursive: true })
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    engines: { node: '>=22.13.0 <23' }
  }))

  const engineDeclaration = await runtime.findNodeRuntimeDeclaration(service, root)
  assert.deepEqual(engineDeclaration, {
    spec: '22',
    source: 'package.json#engines.node',
    directory: root,
    range: '>=22.13.0 <23'
  })

  await fs.writeFile(path.join(root, '.node-version'), '22.14.0\n')
  const pinnedDeclaration = await runtime.findNodeRuntimeDeclaration(service, root)
  assert.deepEqual(pinnedDeclaration, {
    spec: '22.14.0',
    source: '.node-version',
    directory: root
  })
})

test('automatic preparation builds a missing compiled startup target once', async () => {
  const root = await temporaryDirectory('multiprise-build')
  await fs.mkdir(path.join(root, 'scripts'))
  await fs.writeFile(path.join(root, 'scripts', 'build.cjs'), "const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/main.js','console.log(\\'ready\\')')")
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: {
      start: 'node dist/main.js',
      build: 'node scripts/build.cjs'
    }
  }))
  const detection = await scanner.detectProject(root, root)
  const project = {
    id: 'fixture-build', name: 'fixture-build', path: root, root_path: root, tags: [], command: 'npm start',
    command_source: 'user', package_manager: 'npm', install_root: root, framework: 'node', kind: 'command',
    role: 'backend', created_at: new Date().toISOString()
  }

  await prepareService({ id: project.id, project, detection, command: 'npm start', autoInstall: true })
  assert.equal(await fs.readFile(path.join(root, 'dist', 'main.js'), 'utf8'), "console.log('ready')")
})

test('a managed process is only ready after its port accepts connections', async () => {
  const root = await temporaryDirectory('multiprise-ready')
  const port = await freePort()
  await fs.writeFile(path.join(root, 'server.cjs'), "const net=require('net');setTimeout(()=>net.createServer(()=>{}).listen(Number(process.argv[2]),'127.0.0.1'),250)")
  const id = 'fixture-ready'

  await processes.startProcess({ id, command: `node server.cjs ${port}`, cwd: root, port, timeoutMs: 3000 })
  const status = processes.getProcessStatus(id)
  assert.equal(status.phase, 'ready')
  assert.equal(status.ready, true)
  await processes.stopProcess(id)
  assert.equal(processes.getProcessStatus(id).phase, 'stopped')
})

test('an IPv6-loopback-only service is accepted as ready', async (context) => {
  const root = await temporaryDirectory('multiprise-ready-ipv6')
  let port
  try {
    port = await freePort('::1')
  } catch (error) {
    context.skip('IPv6 loopback is unavailable on this host')
    return
  }
  await fs.writeFile(path.join(root, 'server.cjs'), "const net=require('net');setTimeout(()=>net.createServer(()=>{}).listen(Number(process.argv[2]),'::1'),250)")
  const id = 'fixture-ready-ipv6'

  await processes.startProcess({ id, command: `node server.cjs ${port}`, cwd: root, port, timeoutMs: 3000 })
  const status = processes.getProcessStatus(id)
  assert.equal(status.phase, 'ready')
  assert.equal(status.ready, true)
  await processes.stopProcess(id)
  assert.equal(processes.getProcessStatus(id).phase, 'stopped')
})


test('HTTP readiness waits through a temporary 503 startup response', async () => {
  const root = await temporaryDirectory('multiprise-http-ready')
  const port = await freePort()
  await fs.writeFile(
    path.join(root, 'server.cjs'),
    "const http=require('http');const started=Date.now();http.createServer((_,res)=>{res.statusCode=Date.now()-started<350?503:200;res.end()}).listen(Number(process.argv[2]),'127.0.0.1')"
  )
  const id = 'fixture-http-ready'

  await processes.startProcess({
    id,
    command: `node server.cjs ${port}`,
    cwd: root,
    port,
    readiness: 'http',
    timeoutMs: 3000
  })
  assert.equal(processes.getProcessStatus(id).phase, 'ready')
  await processes.stopProcess(id)
})

test('HTTP readiness rejects a service that remains on a 503 startup page', async () => {
  const root = await temporaryDirectory('multiprise-http-unhealthy')
  const port = await freePort()
  await fs.writeFile(
    path.join(root, 'server.cjs'),
    "require('http').createServer((_,res)=>{res.statusCode=503;res.end('Starting Nuxt')}).listen(Number(process.argv[2]),'127.0.0.1')"
  )
  const id = 'fixture-http-unhealthy'

  await assert.rejects(
    processes.startProcess({
      id,
      command: `node server.cjs ${port}`,
      cwd: root,
      port,
      readiness: 'http',
      timeoutMs: 900
    }),
    /HTTP 503/i
  )
  assert.equal(processes.getProcessStatus(id).phase, 'failed')
  assert.match(processes.getProcessStatus(id).error, /HTTP 503/i)
})

test('an early process exit is retained as a failed state with final logs', async () => {
  const root = await temporaryDirectory('multiprise-failure')
  await fs.writeFile(path.join(root, 'fail.cjs'), "console.error('missing environment variable API_KEY');process.exit(1)")
  const id = 'fixture-failure'

  await assert.rejects(
    processes.startProcess({ id, command: 'node fail.cjs', cwd: root, timeoutMs: 2000 }),
    /environment/i
  )
  assert.equal(processes.getProcessStatus(id).phase, 'failed')
  assert.match(processes.getProcessStatus(id).error, /API_KEY|environment/i)
  assert.ok(processes.getLogs(id).some((line) => line.line.includes('API_KEY')))
})

test('a removed service folder fails cleanly instead of emitting an unhandled spawn error', async () => {
  const root = await temporaryDirectory('multiprise-missing-cwd')
  const missing = path.join(root, 'apps', 'api')
  const id = 'fixture-missing-cwd'

  await assert.rejects(
    processes.startProcess({ id, command: 'npm run dev', cwd: missing, timeoutMs: 1000 }),
    /folder no longer exists/i
  )
  assert.equal(processes.getProcessStatus(id).phase, 'stopped')
})

test('common startup errors are classified into actionable categories', () => {
  assert.equal(classifyStartupFailure('Error: listen EADDRINUSE', 'failed', 4000).code, 'port-in-use')
  assert.equal(classifyStartupFailure("Cannot find module '/app/dist/main.js'", 'failed').code, 'missing-build')
  assert.equal(classifyStartupFailure('/bin/sh: pnpm: command not found', 'failed').code, 'runtime-missing')
  assert.equal(classifyStartupFailure('HTTP readiness failed: service kept returning HTTP 503 on port 4000', 'failed', 4000).code, 'unhealthy-response')
})

test('an already-running dev server exposes a recoverable process conflict', () => {
  const output = [
    'Another vinext dev server is already running.',
    '- Local: http://127.0.0.1:5808.',
    '- PID: 3102',
    '- Dir: /Users/dev/DakarDemDikk',
    "or run 'kill 3102' to stop it and start a new one."
  ].join('\n')

  assert.deepEqual(detectStartupConflict(output), {
    pid: 3102,
    port: 5808,
    url: 'http://127.0.0.1:5808',
    cwd: '/Users/dev/DakarDemDikk'
  })
  assert.equal(classifyStartupFailure(output, 'failed', 5295).code, 'existing-instance')
  assert.match(classifyStartupFailure(output, 'failed', 5295).message, /5808.*3102/)
})

test('unrelated PID output is not treated as a process conflict', () => {
  assert.equal(detectStartupConflict('Server failed. PID: 3102'), null)
})

test('current compatibility fixtures discover the intended development command', async () => {
  const fixtures = [
    { name: 'vue-vite', packageJson: { scripts: { dev: 'vite' }, dependencies: { vue: '^3' }, devDependencies: { vite: '^7' } }, command: 'npm run dev', framework: 'vite' },
    { name: 'react-vite', packageJson: { scripts: { dev: 'vite' }, dependencies: { react: '^19' }, devDependencies: { vite: '^7' } }, command: 'npm run dev', framework: 'vite' },
    { name: 'next', packageJson: { scripts: { dev: 'next dev', start: 'next start' }, dependencies: { next: '^15' } }, command: 'npm run dev', framework: 'next' },
    { name: 'nest', packageJson: { scripts: { start: 'node dist/main.js', 'start:dev': 'nest start --watch' }, dependencies: { '@nestjs/core': '^11' } }, command: 'npm run start:dev', framework: 'nest' },
    { name: 'pnpm-turbo', packageJson: { packageManager: 'pnpm@9', scripts: { dev: 'turbo dev' } }, command: 'pnpm dev', framework: 'node' },
    { name: 'yarn-nx', packageJson: { packageManager: 'yarn@4', scripts: { dev: 'nx serve app' } }, command: 'yarn dev', framework: 'node' },
    { name: 'bun', packageJson: { packageManager: 'bun@1.2', scripts: { dev: 'bun --watch src/index.ts' } }, command: 'bun run dev', framework: 'node' }
  ]

  for (const fixture of fixtures) {
    const root = await temporaryDirectory(`multiprise-${fixture.name}`)
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(fixture.packageJson))
    const detection = await scanner.detectProject(root, root)
    assert.equal(detection.suggested_command, fixture.command, fixture.name)
    assert.equal(detection.framework, fixture.framework, fixture.name)
  }

  const cargoRoot = await temporaryDirectory('multiprise-cargo')
  await fs.writeFile(path.join(cargoRoot, 'Cargo.toml'), '[package]\nname="fixture"\nversion="0.1.0"')
  assert.equal((await scanner.detectProject(cargoRoot, cargoRoot)).suggested_command, 'cargo run')

  const dockerRoot = await temporaryDirectory('multiprise-docker')
  await fs.writeFile(path.join(dockerRoot, 'compose.yml'), 'services: {}')
  assert.equal((await scanner.detectProject(dockerRoot, dockerRoot)).suggested_command, 'docker compose up -d --build')
})

test('startup reconciliation replaces removed nested services with the current root package', async () => {
  const root = await temporaryDirectory('multiprise-reconcile-root')
  const data = await temporaryDirectory('multiprise-reconcile-data')
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: { dev: 'nuxt dev' },
    dependencies: { nuxt: '^4.0.0' }
  }))
  process.env.MULTIPRISE_DATA_DIR = data
  const { normalizeProjects } = require('../dist/state.js')
  const state = {
    settings: { auto_port: true, auto_install: true, port_base: 3000, startup_timeout_ms: 20000, scan_depth: 8, scan_ignore: [], theme: 'dark' },
    scans: new Map(),
    projects: [
      { id: 'old-api', name: 'api', path: path.join(root, 'apps/api'), root_path: root, tags: [], command: 'npm run start:dev', command_source: 'auto', kind: 'command', role: 'backend', created_at: new Date().toISOString() },
      { id: 'old-web', name: 'web', path: path.join(root, 'apps/web'), root_path: root, tags: [], command: 'npm run dev', command_source: 'auto', kind: 'command', role: 'frontend', port: 4836, created_at: new Date().toISOString() }
    ]
  }

  await normalizeProjects(state)
  assert.equal(state.projects.length, 1)
  assert.equal(state.projects[0].id, 'old-web')
  assert.equal(state.projects[0].path, root)
  assert.equal(state.projects[0].framework, 'nuxt')
  assert.equal(state.projects[0].port, 4836)
})

test('an edited command wins while auto commands continue following detection', async () => {
  const root = await temporaryDirectory('multiprise-command-owner')
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', start: 'node dist/main.js' } }))
  const { resolveStartCommand } = require('../dist/launch.js')
  const base = {
    id: 'command-owner', name: 'command-owner', path: root, root_path: root, tags: [], command: 'npm run dev',
    command_source: 'auto', framework: 'vite', kind: 'command', role: 'frontend', created_at: new Date().toISOString()
  }

  const automatic = await resolveStartCommand(base, { command: 'npm run dev' })
  assert.equal(automatic.command, 'npm run dev')
  assert.equal(automatic.commandSource, 'auto')

  const edited = await resolveStartCommand(base, { command: 'npm run custom' })
  assert.equal(edited.command, 'npm run custom')
  assert.equal(edited.commandSource, 'user')
})

test('generated deployment output is never discovered as another service', async () => {
  const root = await temporaryDirectory('multiprise-generated-output')
  const backend = path.join(root, 'backend')
  const generated = path.join(backend, '.vercel', 'output', 'functions', 'index.func')
  await fs.mkdir(generated, { recursive: true })
  await fs.writeFile(path.join(backend, 'package.json'), JSON.stringify({ scripts: { 'start:dev': 'nest start --watch' }, dependencies: { '@nestjs/core': '^11' } }))
  await fs.writeFile(path.join(generated, 'package.json'), JSON.stringify({ scripts: { 'start:dev': 'nest start --watch' }, dependencies: { '@nestjs/core': '^11' } }))

  const services = await scanner.discoverProjectServices(root, {
    auto_port: true, auto_install: true, port_base: 3000, startup_timeout_ms: 20000,
    scan_depth: 8, scan_ignore: [], theme: 'dark'
  })
  assert.deepEqual(services.filter((service) => service.kind === 'command').map((service) => service.path), [backend])
})

async function startTestApi(options = {}) {
  const http = require('node:http')
  const { createApp } = require('../dist/server.js')
  const { sanitizeSettings } = require('../dist/store.js')
  const state = { projects: [], settings: sanitizeSettings({}), scans: new Map() }
  const app = await createApp(state, { token: 'test-token', allowedOrigins: ['null'], ...options })
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const call = (route, init = {}) => {
    const headers = { 'x-multiprise-token': 'test-token', ...(init.headers ?? {}) }
    for (const [key, value] of Object.entries(headers)) if (value === null) delete headers[key]
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: route, method: init.method ?? 'GET', headers }, (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
      })
      req.on('error', reject)
      if (init.body !== undefined) req.write(init.body)
      req.end()
    })
  }
  const json = (method, route, value, headers = {}) =>
    call(route, { method, body: typeof value === 'string' ? value : JSON.stringify(value), headers: { 'content-type': 'application/json', ...headers } })
  return { state, port, call, json, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('the API rejects requests without the launch token, from foreign origins, or via foreign hosts', async (context) => {
  const api = await startTestApi()
  context.after(api.close)

  assert.equal((await api.call('/api/projects')).status, 200)
  assert.equal((await api.call('/api/projects', { headers: { 'x-multiprise-token': null } })).status, 401)
  assert.equal((await api.call('/api/projects', { headers: { 'x-multiprise-token': 'wrong-token' } })).status, 401)
  assert.equal((await api.call('/api/projects?token=test-token', { headers: { 'x-multiprise-token': null } })).status, 200)
  assert.equal((await api.call('/api/settings?token=test-token', { method: 'PATCH', headers: { 'x-multiprise-token': null } })).status, 401)
  assert.equal((await api.call('/api/projects', { headers: { origin: 'https://evil.example' } })).status, 403)
  assert.equal((await api.call('/api/projects', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })).status, 403)
  assert.equal((await api.call('/api/projects', { headers: { host: 'attacker.example' } })).status, 403)

  const preflight = await api.call('/api/projects', { method: 'OPTIONS', headers: { origin: 'null', 'x-multiprise-token': null } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers['access-control-allow-origin'], 'null')
  assert.match(preflight.headers['access-control-allow-headers'], /x-multiprise-token/)

  const formPost = await api.call('/api/projects/any/start', {
    method: 'POST',
    body: 'x',
    headers: { origin: 'https://evil.example', 'content-type': 'text/plain', 'x-multiprise-token': null }
  })
  assert.equal(formPost.status, 403)
})

test('malformed request bodies are rejected without crashing the API', async (context) => {
  const api = await startTestApi()
  context.after(api.close)

  assert.equal((await api.json('POST', '/api/projects/inspect', { roots: [123, null, { a: 1 }] })).status, 200)
  assert.equal((await api.json('POST', '/api/projects', { path: { a: 1 } })).status, 400)
  assert.equal((await api.json('POST', '/api/projects/scan', { roots: [null] })).status, 400)
  assert.equal((await api.json('POST', '/api/projects', '{bad')).status, 400)
  assert.equal((await api.call('/api/health')).status, 200)
})

test('settings updates only persist known keys with valid values', async (context) => {
  const api = await startTestApi()
  context.after(api.close)

  const response = await api.json('PATCH', '/api/settings', { port_base: 'abc', scan_depth: -1, auto_port: 'no', theme: 'light', extra: 1 })
  const settings = JSON.parse(response.body)
  assert.equal(settings.port_base, 3000)
  assert.equal(settings.scan_depth, 1)
  assert.equal(settings.auto_port, true)
  assert.equal(settings.theme, 'light')
  assert.equal('extra' in settings, false)
})

test('project updates reject invalid ports and names', async (context) => {
  const api = await startTestApi()
  context.after(api.close)
  api.state.projects.push({ id: 'p1', name: 'web', path: os.tmpdir(), root_path: os.tmpdir(), tags: [], kind: 'command', role: 'frontend', created_at: new Date().toISOString() })

  assert.equal((await api.json('PATCH', '/api/projects/p1', { port: 'abc' })).status, 400)
  assert.equal((await api.json('PATCH', '/api/projects/p1', { port: 99999999 })).status, 400)
  assert.equal((await api.json('PATCH', '/api/projects/p1', { name: { x: 1 } })).status, 400)
  assert.equal((await api.json('PATCH', '/api/projects/p1', { command_source: 'bogus' })).status, 400)
  assert.equal((await api.json('PATCH', '/api/projects/p1', { port: 5173 })).status, 200)
})

test('concurrent project saves always leave a valid file and corrupt files are preserved', async () => {
  const store = require('../dist/store.js')
  const file = path.join(process.env.MULTIPRISE_DATA_DIR, 'projects.json')
  const saves = Array.from({ length: 40 }, (_, index) =>
    store.saveProjects(Array.from({ length: 40 - index }, (__, item) => ({ id: `p${item}`, name: 'x'.repeat(200) })))
  )
  await Promise.all(saves)
  const saved = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.equal(saved.length, 1)

  await fs.writeFile(file, '[{"id":"keep-me"}\n]garbage')
  assert.deepEqual(await store.loadProjects(), [])
  const backups = (await fs.readdir(process.env.MULTIPRISE_DATA_DIR)).filter((name) => name.startsWith('projects.json.corrupt-'))
  assert.equal(backups.length, 1)
  assert.match(await fs.readFile(path.join(process.env.MULTIPRISE_DATA_DIR, backups[0]), 'utf8'), /keep-me/)
})

test('stopping the server stops every managed service and its child processes', async () => {
  const root = await temporaryDirectory('multiprise-stop-all')
  const pidFile = path.join(root, 'grandchild.pid')
  await fs.writeFile(path.join(root, 'server.cjs'), `
    const { spawn } = require('child_process')
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
    require('net').createServer(() => {}).listen(Number(process.argv[2]), '127.0.0.1')
  `)
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  const ids = ['stop-all-a', 'stop-all-b']
  const pids = []
  for (const id of ids) {
    const port = await freePort()
    await processes.startProcess({ id, command: `node server.cjs ${port}`, cwd: root, port, timeoutMs: 5000 })
    pids.push(processes.getProcessPid(id))
  }
  const grandchild = Number(await fs.readFile(pidFile, 'utf8'))
  assert.ok(pids.every(alive) && alive(grandchild))

  const { stopServer } = require('../dist/index.js')
  await stopServer(null)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.ok(pids.every((pid) => !alive(pid)))
  assert.equal(alive(grandchild), false)
  assert.ok(ids.every((id) => processes.getProcessPid(id) === null))
})

test('HTTP readiness accepts a dev server that answers 404 at the root path', async () => {
  const root = await temporaryDirectory('multiprise-http-404')
  const port = await freePort()
  await fs.writeFile(
    path.join(root, 'server.cjs'),
    "require('http').createServer((req,res)=>{res.statusCode=req.url.startsWith('/app/')?200:404;res.end()}).listen(Number(process.argv[2]),'127.0.0.1')"
  )
  await processes.startProcess({ id: 'http-404', command: `node server.cjs ${port}`, cwd: root, port, readiness: 'http', timeoutMs: 5000 })
  try {
    assert.equal(processes.getProcessStatus('http-404').phase, 'ready')
  } finally {
    await processes.stopProcess('http-404')
  }
})

test('an engines range satisfied by the active Node keeps the active runtime', async () => {
  assert.equal(runtime.versionSatisfies('v24.13.1', '>=18'), true)
  assert.equal(runtime.versionSatisfies('16.20.0', '>=18'), false)
  assert.equal(runtime.versionSatisfies('20.19.0', '^20.19 || >=22.12'), true)
  assert.equal(runtime.versionSatisfies('22.11.0', '^20.19 || >=22.12'), false)
  assert.equal(runtime.versionSatisfies('20.1.0', '>=16 <21'), true)
  assert.equal(runtime.versionSatisfies('18.18.0', '~18.17'), false)

  const root = await temporaryDirectory('multiprise-engines')
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ engines: { node: `>=${process.versions.node.split('.')[0] - 4}` } }))
  const resolved = await runtime.resolveProjectNodeRuntime({
    command: 'npm run dev',
    cwd: root,
    env: { PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` }
  })
  assert.equal(resolved.version, process.version)
})

test('dependencies install in the service folder when no lockfile or workspace exists', async () => {
  const root = await temporaryDirectory('multiprise-install-root')
  const web = path.join(root, 'web')
  await fs.mkdir(web)
  await fs.writeFile(path.join(web, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^7.0.0' } }))
  assert.equal((await scanner.detectProject(web, root)).package_root, web)

  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['web'] }))
  assert.equal((await scanner.detectProject(web, root)).package_root, root)
})

test('a parent folder name never changes a discovered service role', async () => {
  const parent = await temporaryDirectory('multiprise-role')
  const root = path.join(parent, 'api', 'tool')
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'node index.js' } }))
  const { normalizeProjects } = require('../dist/state.js')
  const state = {
    settings: { auto_port: true, auto_install: true, port_base: 3000, startup_timeout_ms: 20000, scan_depth: 8, scan_ignore: [], theme: 'dark' },
    scans: new Map(),
    projects: [{ id: 'tool', name: 'tool', path: root, root_path: root, tags: [], command: 'npm run dev', command_source: 'auto', kind: 'command', role: 'service', created_at: new Date().toISOString() }]
  }
  await normalizeProjects(state)
  assert.equal(state.projects[0].role, 'service')
})

async function httpServiceFixture(prefix, packageJson = {}) {
  const root = await temporaryDirectory(prefix)
  await fs.writeFile(path.join(root, 'server.js'), "require('http').createServer((q,r)=>r.end('ok')).listen(Number(process.env.PORT),'127.0.0.1')")
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'svc', scripts: { dev: 'node server.js' }, ...packageJson }))
  return root
}

test('simultaneous starts launch the service once and keep its port consistent', async (context) => {
  const api = await startTestApi()
  const root = await httpServiceFixture('multiprise-concurrent')
  const [created] = JSON.parse((await api.json('POST', '/api/projects', { path: root })).body).projects
  const id = created.project.id
  context.after(async () => { await processes.stopProcess(id); await api.close() })

  const responses = await Promise.all([1, 2, 3].map(() => api.json('POST', `/api/projects/${id}/start`, { role: 'backend' })))
  const statuses = responses.map((response) => response.status).sort()
  assert.deepEqual(statuses, [200, 409, 409])

  const view = JSON.parse((await api.call('/api/projects')).body).projects[0]
  assert.equal(view.status.phase, 'ready')
  assert.equal(view.project.last_error, null)
  const { listListeningPorts } = require('../dist/ports.js')
  const listeners = (await listListeningPorts()).filter((entry) => entry.port === view.project.port)
  assert.equal(listeners.length > 0, true)

  // The node server is a child of npm, but it belongs to this service rather than being "external".
  const instances = JSON.parse((await api.call(`/api/projects/${id}/process/instances`)).body).instances
  assert.deepEqual(instances.map((instance) => instance.source), ['managed'])
  const kill = await api.json('POST', `/api/projects/${id}/process/kill`, { pid: listeners[0].pid })
  assert.equal(kill.status, 400)
})

test('stopping during the build phase cancels the launch', async (context) => {
  const api = await startTestApi()
  const root = await temporaryDirectory('multiprise-cancel-build')
  await fs.writeFile(path.join(root, 'build.js'), "setTimeout(()=>{require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/main.js',\"require('http').createServer((q,r)=>r.end()).listen(Number(process.env.PORT),'127.0.0.1')\")},1500)")
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'slow', scripts: { start: 'node dist/main.js', build: 'node build.js' } }))
  const [created] = JSON.parse((await api.json('POST', '/api/projects', { path: root })).body).projects
  const id = created.project.id
  context.after(async () => { await processes.stopProcess(id); await api.close() })

  const starting = api.json('POST', `/api/projects/${id}/start`, { role: 'backend' })
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(JSON.parse((await api.call('/api/projects')).body).projects[0].status.phase, 'starting')
  assert.equal((await api.json('POST', `/api/projects/${id}/stop`, {})).status, 200)

  assert.equal((await starting).status, 409)
  await new Promise((resolve) => setTimeout(resolve, 1800))
  assert.equal(processes.getProcessPid(id), null)
  assert.equal(JSON.parse((await api.call('/api/projects')).body).projects[0].status.phase, 'stopped')
  // The interrupted build never produced its output.
  assert.equal(await fs.stat(path.join(root, 'dist')).then(() => true, () => false), false)
})

test('a root app stays a service unless its script only orchestrates the nested services', async () => {
  const settings = { scan_depth: 8, scan_ignore: [] }
  const layout = async (files) => {
    const root = await temporaryDirectory('multiprise-orchestration')
    for (const [file, contents] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await fs.writeFile(path.join(root, file), JSON.stringify(contents))
    }
    const services = await scanner.discoverProjectServices(root, settings)
    return services.map((service) => service.path === root ? '.' : path.relative(root, service.path)).sort()
  }

  assert.deepEqual(await layout({
    'package.json': { scripts: { dev: 'vite' }, devDependencies: { vite: '^7' } },
    'docs/package.json': { scripts: { dev: 'vitepress dev' } }
  }), ['.', 'docs'])
  assert.deepEqual(await layout({
    'package.json': { scripts: { dev: 'concurrently "npm:dev:*"' } },
    'backend/package.json': { scripts: { dev: 'nodemon index.js' } },
    'frontend/package.json': { scripts: { dev: 'vite' } }
  }), ['backend', 'frontend'])
  assert.deepEqual(await layout({
    'package.json': { scripts: { dev: 'nodemon server.js' } },
    'client/package.json': { scripts: { dev: 'vite' } }
  }), ['.', 'client'])
})

test('a project folder named like a build directory is still discovered', async () => {
  const parent = await temporaryDirectory('multiprise-build-root')
  const root = path.join(parent, 'build')
  await fs.mkdir(root)
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'node index.js' } }))
  const services = await scanner.discoverProjectServices(root, { scan_depth: 8, scan_ignore: [] })
  assert.equal(services.length, 1)
})

test('overlapping folders and broken manifests are rejected with a clear reason', async (context) => {
  const api = await startTestApi()
  context.after(api.close)
  const root = await httpServiceFixture('multiprise-overlap')
  await fs.mkdir(path.join(root, 'nested'))
  await fs.writeFile(path.join(root, 'nested', 'package.json'), JSON.stringify({ scripts: { dev: 'node x.js' } }))

  assert.equal((await api.json('POST', '/api/projects', { path: root })).status, 200)
  const nested = await api.json('POST', '/api/projects', { path: path.join(root, 'nested') })
  assert.equal(nested.status, 400)
  assert.match(nested.body, /overlaps the tracked project/)

  const broken = await temporaryDirectory('multiprise-broken-manifest')
  await fs.writeFile(path.join(broken, 'package.json'), '{ "scripts": { "dev": ')
  const response = await api.json('POST', '/api/projects', { path: broken })
  assert.equal(response.status, 400)
  assert.match(response.body, /package\.json is not valid JSON/)

  assert.equal((await api.json('POST', `/api/projects/${api.state.projects[0].id}/open`, { target: 'bogus' })).status, 400)
})

test('a relaunched service keeps its previous port while it is free', async (context) => {
  const api = await startTestApi()
  const root = await httpServiceFixture('multiprise-sticky')
  const [created] = JSON.parse((await api.json('POST', '/api/projects', { path: root })).body).projects
  const id = created.project.id
  context.after(async () => { await processes.stopProcess(id); await api.close() })

  assert.equal((await api.json('POST', `/api/projects/${id}/start`, { role: 'backend' })).status, 200)
  const first = api.state.projects[0].port
  assert.equal((await api.json('POST', `/api/projects/${id}/stop`, {})).status, 200)
  assert.equal((await api.json('POST', `/api/projects/${id}/start`, { role: 'backend' })).status, 200)
  assert.equal(api.state.projects[0].port, first)

  const allocated = JSON.parse((await api.json('POST', '/api/ports/allocate', { services: [id] })).body).ports
  assert.notEqual(allocated[id], first, 'a running service holds its port, so allocation picks another')
  assert.equal((await api.json('POST', `/api/projects/${id}/stop`, {})).status, 200)
  const reallocated = JSON.parse((await api.json('POST', '/api/ports/allocate', { services: [id] })).body).ports
  assert.equal(reallocated[id], first)
})

test('repeated log lines collapse into a counter and are published as updates', () => {
  const { subscribe } = require('../dist/events.js')
  const id = 'repeat-test'
  const events = []
  const unsubscribe = subscribe((event) => { if (event.id === id) events.push(event) })
  processes.appendProcessLog(id, 'stdout', 'GET /health 200')
  processes.appendProcessLog(id, 'stdout', 'GET /health 200')
  processes.appendProcessLog(id, 'stdout', 'GET /health 200')
  processes.appendProcessLog(id, 'stderr', 'GET /health 200')
  unsubscribe()

  const lines = processes.getLogs(id)
  assert.deepEqual(lines.map((line) => [line.stream, line.repeat ?? 1]), [['stdout', 3], ['stderr', 1]])
  assert.deepEqual(events.map((event) => event.replace), [false, true, true, false])
  assert.equal(events[2].entry.seq, events[0].entry.seq)
})

test('service logs survive a restart and the previous run is kept on relaunch', async () => {
  const { currentLogPath, previousLogPath } = require('../dist/logfiles.js')
  const id = 'persist-test'
  processes.appendProcessLog(id, 'stdout', 'first run')
  processes.appendProcessLog(id, 'stderr', 'first run crashed')
  await new Promise((resolve) => setTimeout(resolve, 50))

  // A restarted backend has an empty buffer and refills it from disk.
  processes.forgetLogs(id)
  assert.deepEqual(processes.getLogs(id).map((line) => [line.stream, line.line]), [['stdout', 'first run'], ['stderr', 'first run crashed']])

  processes.clearLogs(id)
  processes.appendProcessLog(id, 'stdout', 'second run')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(processes.getLogs(id).map((line) => line.line), ['second run'])
  assert.match(await fs.readFile(previousLogPath(id), 'utf8'), /first run crashed/)
  assert.doesNotMatch(await fs.readFile(currentLogPath(id), 'utf8'), /first run/)
})

test('the event stream pushes status changes to connected clients', async (context) => {
  const http = require('node:http')
  const api = await startTestApi()
  context.after(() => api.close())
  const received = []
  const request = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: api.port, path: '/api/events', headers: { 'x-multiprise-token': 'test-token' } }, (res) => {
      assert.equal(res.headers['content-type'], 'text/event-stream')
      res.setEncoding('utf8')
      res.on('data', (chunk) => received.push(chunk))
      resolve(req)
    })
    req.on('error', reject)
    req.end()
  })
  processes.markProcessStarting('stream-test')
  await new Promise((resolve) => setTimeout(resolve, 50))
  request.destroy()
  const events = received.join('').split('\n\n').filter((frame) => frame.startsWith('data: ')).map((frame) => JSON.parse(frame.slice(6)))
  assert.ok(events.some((event) => event.type === 'status' && event.id === 'stream-test' && event.status.phase === 'starting'))
})

test('ports that browsers refuse to open are never assigned', async () => {
  const { pickRandomPort, BROWSER_BLOCKED_PORTS } = require('../dist/ports.js')
  // Everything in the frontend ranges is taken except two blocked ports and one ordinary one.
  const used = new Set()
  for (let port = 3000; port <= 5999; port += 1) used.add(port)
  used.delete(4045)
  used.delete(5060)
  used.delete(5555)
  assert.ok(BROWSER_BLOCKED_PORTS.has(4045) && BROWSER_BLOCKED_PORTS.has(5060))
  for (let attempt = 0; attempt < 20; attempt += 1) {
    assert.equal(await pickRandomPort({ role: 'frontend', used }), 5555)
  }
  // With the ordinary one taken too, nothing is left: the blocked ports are still refused.
  used.add(5555)
  assert.equal(await pickRandomPort({ role: 'frontend', used }), null)
})
