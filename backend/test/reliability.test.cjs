const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const scanner = require('../dist/scanner.js')
const processes = require('../dist/processes.js')
const { prepareService } = require('../dist/preparation.js')
const { classifyStartupFailure } = require('../dist/failures.js')

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`))
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
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
  const { resolveStartCommand } = require('../dist/server.js')
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
