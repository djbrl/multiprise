const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

// Never let tests touch the developer's real backend/data directory.
process.env.MULTIPRISE_DATA_DIR = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'multiprise-usage-data-'))

const {
  attributeProcesses,
  classifyProcess,
  dockerProjects,
  groupApps,
  heaviestApps,
  machineUsage,
  parseDockerStats,
  parseFootprints,
  parseProcessUsage,
  parseSystemMemory,
  parseTopMemory,
  parseVmStat,
  usageReport
} = require('../dist/usage.js')

test('memory in use is app memory, wired and compressed, not everything that is not free', () => {
  const output = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                                     4010.',
    'Pages inactive:                               206847.',
    'Pages wired down:                             200.',
    'Pages purgeable:                                   4.',
    'File-backed pages:                            135337.',
    'Anonymous pages:                              1004.',
    'Pages occupied by compressor:                 100.'
  ].join('\n')
  assert.equal(parseVmStat(output), (1000 + 200 + 100) * 16384)
  assert.equal(parseVmStat('nothing useful'), null)
})

test('pressure and swap are read from sysctl', () => {
  assert.deepEqual(parseSystemMemory('2\ntotal = 19456.00M  used = 18203.44M  free = 1252.56M  (encrypted)\n'), {
    pressure: 'warning',
    swapUsed: Math.round(18203.44 * 1024 * 1024)
  })
  assert.equal(parseSystemMemory('1\n').pressure, 'normal')
  assert.equal(parseSystemMemory('4\n').pressure, 'critical')
  assert.deepEqual(parseSystemMemory(''), { pressure: null, swapUsed: 0 })
})

test('the process list is parsed, skipping what it cannot read', () => {
  assert.deepEqual(parseProcessUsage('  101    1  101   12.5  2048\ngarbage\n'), [{ pid: 101, ppid: 1, pgid: 101, cpu: 12.5, rss: 2048 * 1024 }])
  assert.deepEqual(
    parseProcessUsage('  202  201  201   0.0  1024   501 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n'),
    [{ pid: 202, ppid: 201, pgid: 201, cpu: 0, rss: 1024 * 1024, uid: 501, command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }]
  )
})

test("top's memory column is read for every process, whatever its unit", () => {
  const output = 'Processes: 3 total\n\nPID    MEM\n10818  4830M+\n394    758M\n1      24K-\n7      2G\n'
  assert.deepEqual([...parseTopMemory(output)], [[10818, 4830 * 1024 ** 2], [394, 758 * 1024 ** 2], [1, 24 * 1024], [7, 2 * 1024 ** 3]])
})

test('everything else is added up by app, script, program or macOS', () => {
  const me = 501
  const entry = (pid, ppid, command, uid = me, cpu = 8, rss = 100) => ({ pid, ppid, pgid: pid, cpu, rss, uid, command })
  const kind = (command, uid = me) => classifyProcess(entry(9, 1, command, uid), me)
  assert.deepEqual(kind('/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)'),
    { key: 'app:/Applications/Google Chrome.app', kind: 'app', name: 'Google Chrome', path: '/Applications/Google Chrome.app' })
  assert.equal(kind('/Users/me/Library/Application Support/Claude/claude-code/2.1.317/91184d3d9ba3/claude.app/Contents/MacOS/claude').name, 'Claude Code')
  assert.equal(kind('node').kind, 'script')
  assert.equal(kind('/opt/homebrew/bin/python3.12').kind, 'script')
  assert.equal(kind('/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent').name, 'Web pages (Safari and other apps)')
  assert.equal(kind('kernel_task', 0).name, 'macOS kernel')
  assert.equal(kind('/usr/libexec/trustd').name, 'Other macOS processes')
  assert.equal(kind('/usr/sbin/bluetoothd', 0).name, 'Other macOS processes')
  // git or a shell run by the user is theirs; the same run by macOS is not.
  assert.deepEqual(kind('/usr/bin/git'), { key: 'program:git', kind: 'program', name: 'git', path: null })
  assert.equal(kind('/bin/zsh', 0).kind, 'system')
  assert.equal(kind('/opt/homebrew/bin/postgres').name, 'postgres')

  const processes = [
    entry(1, 0, '/sbin/launchd', 0),
    entry(10, 1, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    entry(11, 10, '/Applications/Google Chrome.app/Contents/Frameworks/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper'),
    entry(20, 1, '/bin/zsh'),
    entry(21, 20, 'node'), // a script run from a shell
    entry(22, 21, '/repo/node_modules/@esbuild/darwin-arm64/bin/esbuild'), // started by it
    entry(30, 1, 'node'), // a dev server, already counted
    entry(31, 30, '/repo/node_modules/.bin/esbuild')
  ]
  const memory = new Map([[10, 1000], [11, 3000]])
  const apps = groupApps(processes, new Set([30, 31]), (process) => memory.get(process.pid) ?? process.rss, 8, me)
  const find = (key) => apps.find((app) => app.key === key)
  assert.deepEqual(
    { ...find('app:/Applications/Google Chrome.app') },
    { key: 'app:/Applications/Google Chrome.app', kind: 'app', name: 'Google Chrome', path: '/Applications/Google Chrome.app', detail: null, processes: 2, cpu: 2, memory: 4000, pids: [10, 11] }
  )
  assert.deepEqual(find('script:21').pids, [21, 22])
  assert.deepEqual(find('program:zsh').pids, [20])
  assert.equal(apps.some((app) => app.pids.includes(30) || app.pids.includes(31)), false, 'dev servers are not counted twice')
})

test('the heaviest are listed, and the busiest too even when they are small', () => {
  const app = (key, memory, cpu) => ({ key, memory, cpu })
  const listed = heaviestApps([app('a', 900, 0), app('b', 800, 0), app('c', 700, 0), app('spinning', 10, 40), app('idle', 5, 0)], 2)
  assert.deepEqual(listed.map((entry) => entry.key), ['a', 'b', 'spinning'])
})

test('footprints are read per process', () => {
  const output = 'node [26040]: 64-bit    Footprint: 15728640 B (16384 bytes per page)\nnoise\nnpm [26041]: 64-bit    Footprint: 1024 B (16384 bytes per page)\n'
  assert.deepEqual([...parseFootprints(output)], [[26040, 15728640], [26041, 1024]])
})

test('each process counts once, for the nearest thing that owns it', () => {
  const entry = (pid, ppid, pgid = pid) => ({ pid, ppid, pgid, cpu: 1, rss: 1 })
  const owned = attributeProcesses([
    entry(1, 0), // launchd
    entry(50, 1), // a terminal: above the server, so not counted for it
    entry(100, 50), // an outside server
    entry(101, 100), // its helper
    entry(102, 100), // a second server it started
    entry(103, 102), // that server's helper
    entry(200, 1), // a managed group's leader
    entry(201, 200, 200),
    entry(300, 1, 200), // re-parented, still in the managed group
    entry(400, 1), // this app
    entry(401, 400), // its helper
    entry(402, 400, 402), // a managed service it spawned in its own group
    entry(500, 1) // nothing to do with any of it
  ], {
    pids: new Map([[100, 'outside'], [102, 'nested'], [400, 'app']]),
    groups: new Map([[200, 'managed'], [402, 'service']])
  })
  const pids = (key) => (owned.get(key) ?? []).map((process) => process.pid)
  assert.deepEqual(pids('outside'), [100, 101])
  assert.deepEqual(pids('nested'), [102, 103])
  assert.deepEqual(pids('managed'), [200, 201, 300])
  assert.deepEqual(pids('app'), [400, 401])
  assert.deepEqual(pids('service'), [402])
})

test('a parent loop in the process list cannot hang attribution', () => {
  const owned = attributeProcesses([{ pid: 2, ppid: 3, pgid: 2, cpu: 0, rss: 0 }, { pid: 3, ppid: 2, pgid: 3, cpu: 0, rss: 0 }], { pids: new Map(), groups: new Map() })
  assert.equal(owned.size, 0)
})

test('containers add up by Compose project, including those publishing no port', () => {
  const stats = parseDockerStats([
    '{"ID":"aaa","CPUPerc":"20.00%","MemUsage":"100MiB / 7.653GiB"}',
    '{"ID":"bbb","CPUPerc":"10.00%","MemUsage":"1GiB / 7.653GiB"}',
    '{"ID":"ccc","CPUPerc":"0.00%","MemUsage":"512KiB / 7.653GiB"}',
    'not json'
  ].join('\n'))
  assert.deepEqual(stats.get('aaa'), { cpu: 20, memory: 100 * 1024 ** 2 })
  const compose = (folder, name) => `com.docker.compose.project=${name},com.docker.compose.project.working_dir=${folder}`
  const ps = [
    JSON.stringify({ ID: 'aaa', Names: 'shop-web-1', Labels: compose('/code/shop', 'shop') }),
    JSON.stringify({ ID: 'bbb', Names: 'shop-db-1', Labels: compose('/code/shop', 'shop') }),
    JSON.stringify({ ID: 'ccc', Names: 'lonely', Labels: '' }),
    JSON.stringify({ ID: 'gone', Names: 'no-stats-yet', Labels: '' })
  ].join('\n')
  const usage = dockerProjects(ps, stats, [{ id: 'shop-id', kind: 'docker_compose', path: '/code/shop' }], 10)
  assert.deepEqual(usage, [
    { key: 'docker:shop', name: 'shop', path: '/code/shop', service_id: 'shop-id', containers: 2, cpu: 3, memory: 100 * 1024 ** 2 + 1024 ** 3 },
    { key: 'docker:lonely', name: 'lonely', path: null, service_id: null, containers: 1, cpu: 0, memory: 512 * 1024 }
  ])
})

test('the machine reading is real numbers', { skip: process.platform !== 'darwin' }, async () => {
  const machine = await machineUsage()
  assert.ok(machine.cores > 0)
  assert.equal(machine.memory_total, os.totalmem())
  assert.ok(machine.memory_used > 0 && machine.memory_used <= machine.memory_total)
  assert.ok(['normal', 'warning', 'critical'].includes(machine.memory_pressure))
})

// Only ever stops the server it starts.
test('a server started outside the app is measured, with the processes it started', { skip: process.platform !== 'darwin' }, async (context) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'multiprise-usage-'))
  const script = `const http=require('http');const {spawn}=require('child_process');const kid=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.on('SIGTERM',()=>{kid.kill('SIGKILL');process.exit(0)});http.createServer((q,r)=>r.end('x')).listen(0,'127.0.0.1',()=>process.stdout.write(String(kid.pid)))`
  const server = spawn(process.execPath, ['-e', script], { cwd: folder, stdio: ['ignore', 'pipe', 'ignore'] })
  context.after(() => server.kill('SIGTERM'))
  const kidPid = await new Promise((resolve) => server.stdout.once('data', (data) => resolve(Number(String(data)))))
  const { listListeningPorts } = require('../dist/ports.js')
  const report = await usageReport(await listListeningPorts(), [])
  const row = report.servers.find((entry) => entry.server.pid === server.pid)
  assert.ok(row, 'the server is listed')
  assert.ok(row.memory > 1024 * 1024, 'its memory is more than a rounding error')
  assert.ok(row.cpu >= 0)
  assert.ok(report.multiprise.memory > 0)
  assert.ok(kidPid > 0)
  assert.ok(report.apps.length > 0, 'the rest of the machine is listed')
  assert.ok(report.apps.every((app) => app.memory >= 0 && app.cpu >= 0 && app.processes > 0))
  assert.ok(!report.apps.some((app) => app.kind === 'script' && app.path === folder), 'the server is not listed again')
})
