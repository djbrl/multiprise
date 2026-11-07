const assert = require('node:assert/strict')
const { execFile, spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

// Never let tests touch the developer's real backend/data directory.
process.env.MULTIPRISE_DATA_DIR = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'multiprise-running-data-'))

const { startServer, stopServer } = require('../dist/index.js')
const { findRepository, isWorktreeRoot } = require('../dist/repository.js')
const { redactText } = require('../dist/redact.js')
const { withInstructionBlock, withoutInstructionBlock, hasInstructionBlock } = require('../dist/agents.js')
const { chooseRunningServers } = require('../dist/cli/operations.js')
const {
  isDesktopApp,
  isProjectFolder,
  leftoverReason,
  parseDockerPs,
  parseProcessList,
  shortCommand
} = require('../dist/running.js')

const CLI = path.join(__dirname, '..', 'dist', 'cli', 'index.js')

function runCli(args, options = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: '1', ...options.env }
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }))
  })
}

async function startAdvertisedServer(context) {
  process.env.MULTIPRISE_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'multiprise-running-data-'))
  const backend = await startServer({ advertise: true, proxyPort: false })
  context.after(() => stopServer(backend))
  return backend
}

async function tempDir(name) {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), name)))
}

// A real server this test owns; only ever these are stopped, whatever else runs on the machine.
function startFixture(context, cwd) {
  const child = spawn(process.execPath, ['-e', `require('http').createServer((q,r)=>r.end('ok')).listen(0,'127.0.0.1',function(){console.log(this.address().port)})`], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
  context.after(() => child.kill('SIGKILL'))
  return new Promise((resolve) => child.stdout.once('data', (data) => resolve({ child, port: Number(String(data).trim()) })))
}

const serviceProject = async (root, script = `require('http').createServer((q,r)=>r.end('ok')).listen(Number(process.env.PORT),'127.0.0.1')`) => {
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: path.basename(root), scripts: { dev: 'node server.js' } }))
  await fs.writeFile(path.join(root, 'server.js'), script)
}

// A checkout's .git folder, and a worktree inside it pointing back at it.
async function fakeRepository(root, worktree) {
  await fs.mkdir(path.join(root, '.git', 'worktrees', path.basename(worktree)), { recursive: true })
  await fs.mkdir(worktree, { recursive: true })
  await fs.writeFile(path.join(worktree, '.git'), `gitdir: ${path.join(root, '.git', 'worktrees', path.basename(worktree))}\n`)
}

test('a worktree is told apart from its main checkout, and a submodule is not one', async () => {
  const root = await tempDir('multiprise-repo-')
  const worktree = path.join(root, '.claude', 'worktrees', 'task-a')
  await fakeRepository(root, worktree)
  await fs.mkdir(path.join(worktree, 'apps', 'web'), { recursive: true })

  assert.deepEqual(findRepository(path.join(root, 'anything')), { root, main: root, worktree: null })
  assert.deepEqual(findRepository(path.join(worktree, 'apps', 'web')), { root: worktree, main: root, worktree: 'task-a' })
  assert.equal(isWorktreeRoot(worktree), true)
  assert.equal(isWorktreeRoot(path.join(worktree, 'apps')), false)
  assert.equal(isWorktreeRoot(root), false)

  const submodule = path.join(root, 'vendor', 'lib')
  await fs.mkdir(submodule, { recursive: true })
  await fs.writeFile(path.join(submodule, '.git'), `gitdir: ${path.join(root, '.git', 'modules', 'lib')}\n`)
  assert.deepEqual(findRepository(submodule), { root, main: root, worktree: null })
})

test('only what looks like somebody\'s project counts as a dev server', () => {
  const home = os.homedir()
  for (const folder of ['/', '/System/Library', '/Applications/Foo.app', '/usr/local/var', '/opt/homebrew/var/postgres', '/private/var/db', `${home}/Library/Containers/com.docker.docker/Data`, `${home}/.claude/plugins/data/x`]) {
    assert.equal(isProjectFolder(folder), false, folder)
  }
  for (const folder of [home, `${home}/code/shop`, `${home}/shop/.claude/worktrees/a`, '/private/tmp/claude-501/-Users-me-shop/abc/scratchpad', '/private/var/folders/ab/T/x', '/Volumes/dev/shop']) {
    assert.equal(isProjectFolder(folder), true, folder)
  }
  assert.equal(isDesktopApp('/Applications/Discord.app/Contents/Frameworks/Discord Helper --type=renderer'), true)
  assert.equal(isDesktopApp('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --remote-debugging-port=9431'), false)
  assert.equal(isDesktopApp('/usr/libexec/rapportd'), true)
  assert.equal(isDesktopApp(`${home}/code/app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .`), false)
  assert.equal(isDesktopApp('/opt/homebrew/bin/node server.js'), false)
})

test('commands read short, and never carry a credential', () => {
  assert.equal(shortCommand('/Users/me/.fnm/node-versions/v24/bin/node dist/main.js'), 'node dist/main.js')
  assert.equal(shortCommand('node /Users/me/shop/node_modules/.bin/vite --port 5175'), 'node vite --port 5175')
  assert.equal(shortCommand('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new'), 'Google Chrome --headless=new')
  assert.equal(shortCommand('/opt/homebrew/Cellar/python/3.14/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python server.py'), 'Python server.py')
  assert.equal(shortCommand('node worker.js --api-key=abcd1234efgh'), 'node worker.js --api-key=[redacted]')
})

test('process details survive the way ps pads and truncates its columns', () => {
  const details = parseProcessList([
    '  4996     1  4996   501 Tue Oct 13 15:58:09 2026     node dist/main.js',
    ' 12345   900 12300   501 Sun Oct  4 03:30:49 2026     /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless',
    'garbage line'
  ].join('\n'))
  assert.equal(details.size, 2)
  assert.equal(details.get(4996).ppid, 1)
  assert.equal(details.get(12345).pgid, 12300)
  assert.equal(details.get(12345).startedAt.getDate(), 4)
  assert.match(details.get(12345).command, /Google Chrome --headless$/)
})

test('a leftover has lost what started it, or its folder, and has been around a while', () => {
  const hour = 3600 * 1000
  assert.equal(leftoverReason({ orphaned: false, folderExists: true, ageMs: 900 * hour, managed: false }), null)
  assert.equal(leftoverReason({ orphaned: true, folderExists: true, ageMs: 60 * 1000, managed: false }), null)
  assert.match(leftoverReason({ orphaned: true, folderExists: true, ageMs: 2 * hour, managed: false }), /gone/)
  assert.match(leftoverReason({ orphaned: false, folderExists: false, ageMs: 1000, managed: false }), /folder/)
  assert.equal(leftoverReason({ orphaned: true, folderExists: false, ageMs: 900 * hour, managed: true }), null)
})

test('containers with published ports are listed with their project', async () => {
  const root = await tempDir('multiprise-compose-')
  const line = (extra) => JSON.stringify({ ID: 'abc123', Names: 'shop-db-1', Image: 'postgres:17', CreatedAt: '2026-10-20 03:13:07 +0200 CEST', ...extra })
  const output = [
    line({ Ports: '0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp', Labels: `com.docker.compose.service=db,com.docker.compose.project.working_dir=${root}` }),
    line({ ID: 'internal', Ports: '5432/tcp', Labels: '' }),
    'not json'
  ].join('\n')
  const [server, ...others] = parseDockerPs(output, [])
  assert.equal(others.length, 0)
  assert.deepEqual(server.ports, [5433])
  assert.equal(server.key, 'docker:abc123')
  assert.equal(server.project, path.basename(root))
  assert.equal(server.command, 'db (postgres:17)')
  assert.equal(server.started_at, '2026-10-20T01:13:07.000Z')
  assert.equal(server.managed, false)

  const tracked = [{ id: 'p1', name: 'db', kind: 'docker_compose', path: root, docker_running: true }]
  const [own] = parseDockerPs(output, tracked)
  assert.equal(own.managed, true)
  assert.equal(own.service_id, 'p1')
  assert.equal(own.track_path, null)
})

test('secrets are masked, ordinary output is not', () => {
  const secret = 'hunter2-the-long-one'
  const cases = [
    [`connecting with ${secret} now`, ['hunter2-the-long-one'], 'connecting with [redacted] now'],
    ['token ghp_abcdefghijklmnopqrstuvwxyz123456', [], 'token [redacted]'],
    ['OPENAI sk-proj-abcdefghijklmnopqrstuvwx', [], 'OPENAI [redacted]'],
    ['postgres://shop:s3cretpw@db:5432/shop', [], 'postgres://shop:[redacted]@db:5432/shop'],
    ['Authorization: Bearer abcdefgh12345678', [], 'Authorization: Bearer [redacted]'],
    ['API_KEY=abcd1234', [], 'API_KEY=[redacted]'],
    ['{"password": "swordfish"}', [], '{"password": "[redacted]"}'],
    ['eyJhbGciOiJIUzI1 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijk', [], 'eyJhbGciOiJIUzI1 [redacted]']
  ]
  for (const [input, values, expected] of cases) assert.equal(redactText(input, values), expected)
  for (const untouched of [
    'VITE v5.4.2 ready in 312 ms',
    'Local: http://localhost:5173/',
    'GET /api/users 200 12ms',
    'token expired',
    'invalid token: expired',
    'password: required'
  ]) assert.equal(redactText(untouched, ['dev', 'true']), untouched)
})

test('the CLAUDE.md block goes in, refreshes in place, and comes out leaving the rest alone', () => {
  const mine = '# My rules\n\nAlways use tabs.\n'
  const added = withInstructionBlock(mine)
  assert.ok(added.startsWith('# My rules\n\nAlways use tabs.\n\n<!-- multiprise:start'))
  assert.ok(hasInstructionBlock(added))
  assert.equal(withInstructionBlock(added), added)
  assert.equal(withoutInstructionBlock(added), mine)
  assert.equal(withoutInstructionBlock(withInstructionBlock('')), '')
  assert.equal(withoutInstructionBlock(mine), mine)

  const stale = added.replace('Local dev servers', 'Old wording') + '\nWritten after it.\n'
  const refreshed = withInstructionBlock(stale)
  assert.ok(refreshed.includes('Local dev servers') && !refreshed.includes('Old wording'))
  assert.ok(refreshed.endsWith('\nWritten after it.\n'))
})

test('--leftovers and ports choose servers; asking about a free port is an error', () => {
  const servers = [
    { key: 'a', ports: [3000], leftover: true },
    { key: 'b', ports: [4000, 4001], leftover: false },
    { key: 'c', ports: [5000], leftover: true }
  ]
  assert.deepEqual(chooseRunningServers(servers, [], true).map((server) => server.key), ['a', 'c'])
  assert.deepEqual(chooseRunningServers(servers, [4001], false).map((server) => server.key), ['b'])
  assert.deepEqual(chooseRunningServers(servers, [3000], true).map((server) => server.key), ['a', 'c'])
  assert.deepEqual(chooseRunningServers(servers, [], false), [])
  assert.throws(() => chooseRunningServers(servers, [9999], false), /port 9999/)
})

test('`running` sees a server started outside Multiprise, and stops only that one', async (context) => {
  await startAdvertisedServer(context)
  const folder = await tempDir('multiprise-outside-')
  const { child, port } = await startFixture(context, folder)
  const bystander = await startFixture(context, folder)

  const listed = JSON.parse((await runCli(['running', '--json'])).stdout)
  const server = listed.find((entry) => entry.ports.includes(port))
  assert.ok(server, 'the fixture is listed')
  assert.equal(server.kind, 'process')
  assert.equal(server.pid, child.pid)
  assert.equal(server.path, folder)
  assert.equal(server.scratch, true)
  assert.equal(server.managed, false)
  assert.equal(server.leftover, false)
  assert.ok(!listed.some((entry) => entry.pid === process.pid), 'Multiprise does not list itself')

  // Scripts must opt in to stopping something.
  const refused = await runCli(['running', 'stop', String(port)])
  assert.equal(refused.code, 2)
  assert.match(refused.stderr, /--yes/)
  assert.equal(child.exitCode, null)

  const missing = await runCli(['running', 'stop', '1', '--yes'])
  assert.equal(missing.code, 2)
  assert.match(missing.stderr, /port 1\b/)

  const exited = new Promise((resolve) => child.once('exit', resolve))
  const stopped = await runCli(['running', 'stop', String(port), '--yes'])
  assert.equal(stopped.code, 0, stopped.stderr)
  await exited
  assert.equal(bystander.child.exitCode, null)
  assert.equal(bystander.child.signalCode, null)

  // A key whose process has since gone (or whose PID was reused) is refused.
  const client = await runCli(['api', 'POST', '/api/running/stop', JSON.stringify({ key: server.key })])
  assert.equal(client.code, 1)
  assert.match(client.stderr, /no longer running/)
})

test('`up` tracks a new folder, and in a worktree starts that worktree rather than the main checkout', async (context) => {
  await startAdvertisedServer(context)
  const main = await tempDir('multiprise-main-')
  const worktree = path.join(main, '.claude', 'worktrees', 'task-a')
  await fakeRepository(main, worktree)
  await serviceProject(main)
  await serviceProject(worktree)
  context.after(() => runCli(['down', main]).then(() => runCli(['down', worktree])))

  const first = await runCli(['up', '--json'], { cwd: main })
  assert.equal(first.code, 0, first.stderr)
  assert.equal(JSON.parse(first.stdout)[0].service.path, main)

  const second = await runCli(['up', '--json'], { cwd: worktree })
  assert.equal(second.code, 0, second.stderr)
  const [own] = JSON.parse(second.stdout)
  assert.equal(own.outcome, 'started')
  assert.equal(own.service.path, worktree)
  assert.equal(await (await fetch(own.service.url)).text(), 'ok')

  // Both checkouts are separate projects from here on, each reached from its own folder.
  const main2 = JSON.parse((await runCli(['ls', '--json'])).stdout).map((project) => project.path).sort()
  assert.deepEqual(main2, [main, worktree].sort())
  assert.equal((await runCli(['url'], { cwd: worktree })).stdout.trim(), own.service.url)
  assert.notEqual((await runCli(['url'], { cwd: main })).stdout.trim(), own.service.url)
})

test('`up` refuses a folder that is not a project, instead of tracking all that is below it', async (context) => {
  await startAdvertisedServer(context)
  const folder = await tempDir('multiprise-notproject-')
  await fs.mkdir(path.join(folder, 'inner'))
  await serviceProject(path.join(folder, 'inner'))
  const result = await runCli(['up'], { cwd: folder })
  assert.equal(result.code, 2)
  assert.match(result.stderr, /does not look like a project/)
  assert.deepEqual(JSON.parse((await runCli(['ls', '--json'])).stdout), [])
})

test('a failed start says why, with its logs, and masks secrets from .env files', async (context) => {
  await startAdvertisedServer(context)
  const root = await tempDir('multiprise-failing-')
  await fs.mkdir(path.join(root, '.git'))
  await serviceProject(root, `console.log('connecting with ' + 'hunter2-the-long-one'); console.error('boom: cannot reach database'); process.exit(3)`)
  await fs.writeFile(path.join(root, '.env'), 'DATABASE_PASSWORD=hunter2-the-long-one\nDEBUG=true\n')

  const result = await runCli(['up', '--json'], { cwd: root })
  assert.equal(result.code, 1)
  const [failure] = JSON.parse(result.stdout)
  assert.equal(failure.outcome, 'failed')
  assert.ok(failure.error)
  assert.equal(typeof failure.failure_code, 'string')
  assert.ok(failure.recent_logs.some((line) => line.includes('boom: cannot reach database')))
  assert.ok(failure.recent_logs.some((line) => line.includes('connecting with [redacted]')))
  assert.ok(!result.stdout.includes('hunter2-the-long-one'))

  const text = await runCli(['up'], { cwd: root })
  assert.match(text.stdout, /boom: cannot reach database/)
  assert.ok(!text.stdout.includes('hunter2-the-long-one'))

  const logs = await runCli(['logs'], { cwd: root })
  assert.ok(logs.stdout.includes('connecting with [redacted]'))
  assert.ok(!(logs.stdout + logs.stderr).includes('hunter2-the-long-one'))
})

test('`agents connect` sets up Claude Code, says so, and `disconnect` puts it all back', async () => {
  const home = await tempDir('multiprise-home-')
  const bin = await tempDir('multiprise-bin-')
  // Stands in for Claude Code's CLI, doing to ~/.claude.json what the real one does.
  await fs.writeFile(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('fs'), path = require('path')
const file = path.join(process.env.HOME, '.claude.json')
const args = process.argv.slice(2)
fs.appendFileSync(path.join(process.env.HOME, 'calls.log'), args.join(' ') + '\\n')
if (args[0] === '--version') { console.log('2.0.0'); process.exit(0) }
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { numStartups: 7 }
config.mcpServers = config.mcpServers || {}
if (args[1] === 'add') { const dash = args.indexOf('--'); config.mcpServers[args[4]] = { command: args[dash + 1], args: args.slice(dash + 2) } }
if (args[1] === 'remove') delete config.mcpServers[args[args.length - 1]]
fs.writeFileSync(file, JSON.stringify(config))
`, { mode: 0o755 })
  await fs.mkdir(path.join(home, '.claude'))
  const instructions = path.join(home, '.claude', 'CLAUDE.md')
  await fs.writeFile(instructions, '# My rules\n')
  const env = { HOME: home, PATH: `${bin}:${process.env.PATH}` }
  const calls = async () => (await fs.readFile(path.join(home, 'calls.log'), 'utf8')).split('\n').filter((line) => line.startsWith('mcp'))

  const before = JSON.parse((await runCli(['agents', '--json'], { env })).stdout)
  assert.deepEqual([before.installed, before.connected, before.instructions], [true, false, false])

  const connected = await runCli(['agents', 'connect', '--json'], { env })
  assert.equal(connected.code, 0, connected.stderr)
  const status = JSON.parse(connected.stdout)
  assert.deepEqual([status.connected, status.instructions], [true, true])
  assert.equal(status.instructions_path, instructions)
  const text = await fs.readFile(instructions, 'utf8')
  assert.ok(text.startsWith('# My rules\n\n<!-- multiprise:start'))
  assert.match(text, /multiprise up/)
  assert.match((await calls())[0], /^mcp add --scope user multiprise -- .*\bmcp$/)
  assert.equal(JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8')).numStartups, 7)

  // Doing it again changes nothing.
  await runCli(['agents', 'connect'], { env })
  assert.equal((await calls()).length, 1)
  assert.equal(await fs.readFile(instructions, 'utf8'), text)

  const disconnected = await runCli(['agents', 'disconnect', '--json'], { env })
  assert.deepEqual((({ connected: c, instructions: i }) => [c, i])(JSON.parse(disconnected.stdout)), [false, false])
  assert.equal(await fs.readFile(instructions, 'utf8'), '# My rules\n')
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8')).mcpServers, {})
})

test('`agents connect` without Claude Code explains itself and touches nothing', async () => {
  const home = await tempDir('multiprise-home-')
  const bin = await tempDir('multiprise-bin-')
  await fs.symlink(process.execPath, path.join(bin, 'node'))
  const env = { HOME: home, PATH: bin }
  const result = await runCli(['agents', 'connect'], { env })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /Claude Code is not installed/)
  await assert.rejects(fs.access(path.join(home, '.claude', 'CLAUDE.md')))
})

test('agents get the same over MCP: start a new folder by path, see and stop outside servers', async (context) => {
  await startAdvertisedServer(context)
  const root = await tempDir('multiprise-mcp-new-')
  await fs.mkdir(path.join(root, '.git'))
  await serviceProject(root)
  const outside = await startFixture(context, await tempDir('multiprise-mcp-outside-'))

  const child = spawn(process.execPath, [CLI, 'mcp'], { stdio: ['pipe', 'pipe', 'ignore'] })
  context.after(() => child.kill())
  const lines = require('node:readline').createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let id = 0
  const call = async (name, args) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })}\n`)
    return JSON.parse((await lines.next()).value).result
  }

  const [started] = JSON.parse((await call('start_service', { service: root })).content[0].text)
  assert.equal(started.outcome, 'started')
  assert.equal(started.path, root)
  context.after(() => runCli(['down', root]))

  const servers = JSON.parse((await call('list_running_servers', {})).content[0].text)
  assert.equal(servers.find((server) => server.ports.includes(started.port)).managed, true)
  assert.equal(servers.find((server) => server.ports.includes(outside.port)).managed, false)

  assert.equal((await call('stop_running_server', {})).isError, true)
  const exited = new Promise((resolve) => outside.child.once('exit', resolve))
  const stopped = JSON.parse((await call('stop_running_server', { ports: [outside.port] })).content[0].text)
  assert.deepEqual(stopped.stopped[0].ports, [outside.port])
  await exited

  // One of Multiprise's own goes through its normal stop, so it does not look like a crash.
  await call('stop_running_server', { ports: [started.port] })
  const [project] = JSON.parse((await call('list_services', { project: root })).content[0].text)
  assert.equal(project.services[0].status, 'stopped')
})
