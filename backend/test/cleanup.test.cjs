const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

// Never let tests touch the developer's real backend/data directory.
process.env.MULTIPRISE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'multiprise-cleanup-data-'))

const { analyzeGrowth, chartPoints, quietSince, WARMUP_MS, IDLE_MS } = require('../dist/system/memory.js')
const { parseDockerLeftovers, parseDu, staleWorktrees } = require('../dist/system/cleanup.js')

const MB = 1024 * 1024
const MINUTE = 60 * 1000
const start = Date.parse('2026-11-22T10:00:00Z')

// A reading every 30 seconds for `minutes`, memory given by `at(minutesSinceStart)`.
const run = (minutes, at) => Array.from({ length: minutes * 2 + 1 }, (_, index) => {
  const elapsed = index / 2
  return { at: start + elapsed * MINUTE, memory: Math.round(at(elapsed) * MB), cpu: 0.2 }
})

test('memory that keeps climbing after warm-up is growing', () => {
  const samples = run(60, (minute) => 300 + minute * 2)
  const result = analyzeGrowth(samples, start)
  assert.equal(result.status, 'growing')
  assert.ok(Math.abs(result.growth_per_hour - 120 * MB) < 2 * MB, `about 120 MB an hour, got ${result.growth_per_hour / MB}`)
  assert.equal(result.first, 300 * MB)
})

test('the climb of the first minutes does not count', () => {
  // Grows fast while starting, then holds.
  const samples = run(40, (minute) => minute < 5 ? 100 + minute * 60 : 400)
  assert.equal(analyzeGrowth(samples, start).status, 'steady')
})

test('too little settled time is still warming up', () => {
  assert.equal(analyzeGrowth(run(15, (minute) => 300 + minute * 10), start).status, 'warming-up')
  assert.equal(analyzeGrowth([], start).status, 'warming-up')
})

test('memory that is freed again is a cache, not growth', () => {
  // A sawtooth: climbs and is collected every 10 minutes.
  const samples = run(60, (minute) => 300 + (minute % 10) * 15)
  assert.equal(analyzeGrowth(samples, start).status, 'steady')
  // Climbed for most of the hour, then dropped back down.
  const dropped = run(60, (minute) => minute < 55 ? 300 + minute * 4 : 320)
  assert.equal(analyzeGrowth(dropped, start).status, 'steady')
})

test('slow drift is not growth', () => {
  // 6 MB an hour on 400 MB.
  assert.equal(analyzeGrowth(run(90, (minute) => 400 + minute * 0.1), start).status, 'steady')
})

test('a chart has at most the points asked for, first and last kept', () => {
  const samples = run(60, (minute) => minute)
  const points = chartPoints(samples, 10)
  assert.equal(points.length, 10)
  assert.equal(points[0], samples[0].memory)
  assert.equal(points[9], samples[samples.length - 1].memory)
  assert.equal(chartPoints(samples.slice(0, 3), 10).length, 3)
  assert.ok(WARMUP_MS > 0)
})

test('a server is idle after hours without output and without CPU', () => {
  const now = start + IDLE_MS + 30 * MINUTE
  assert.equal(quietSince({ startedAtMs: start, lastOutputMs: start + 10 * MINUTE, samples: [], now }), start + 10 * MINUTE)
  // Recent output.
  assert.equal(quietSince({ startedAtMs: start, lastOutputMs: now - MINUTE, samples: [], now }), null)
  // Started recently, even if silent.
  assert.equal(quietSince({ startedAtMs: now - MINUTE, lastOutputMs: null, samples: [], now }), null)
  // Silent but busy.
  const busy = [{ at: now - MINUTE, memory: 1, cpu: 25 }]
  assert.equal(quietSince({ startedAtMs: start, lastOutputMs: start, samples: busy, now }), null)
})

test('Docker leftovers are read from docker ps, volume ls and images', () => {
  const containers = JSON.stringify({ ID: 'abc123', Names: 'atlas-db-1', Image: 'postgres:16', Status: 'Exited (0) 3 weeks ago', Labels: 'com.docker.compose.project=atlas,com.docker.compose.service=db' })
  const volumes = [JSON.stringify({ Name: 'atlas_pgdata', Labels: 'com.docker.compose.project=atlas' }), JSON.stringify({ Name: '9f2c', Labels: '' }), 'not json'].join('\n')
  const images = JSON.stringify({ ID: 'd34db33f', Repository: '<none>', Tag: '<none>', Size: '1.2GB', CreatedSince: '5 weeks ago' })
  const parsed = parseDockerLeftovers(containers, volumes, images)
  assert.deepEqual(parsed.containers, [{ id: 'abc123', name: 'atlas-db-1', image: 'postgres:16', project: 'atlas', status: 'Exited (0) 3 weeks ago' }])
  assert.deepEqual(parsed.volumes, [{ name: 'atlas_pgdata', project: 'atlas' }, { name: '9f2c', project: null }])
  assert.deepEqual(parsed.images, [{ id: 'd34db33f', size: '1.2GB', created: '5 weeks ago' }])
})

test('du output is read in bytes, paths with spaces included', () => {
  const sizes = parseDu('1024\t/Users/me/app/node_modules\n8\t/Users/me/My App/dist\n')
  assert.equal(sizes.get('/Users/me/app/node_modules'), 1024 * 1024)
  assert.equal(sizes.get('/Users/me/My App/dist'), 8 * 1024)
})

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })

test('a worktree whose work is on main, or that is gone, is stale; one with work in progress is not', async () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multiprise-stale-')))
  git(repo, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'first')
  const worktree = (name, branch) => {
    const dir = path.join(repo, '.claude', 'worktrees', name)
    git(repo, 'worktree', 'add', '-q', '-b', branch, dir)
    return dir
  }
  const merged = worktree('merged', 'feature-merged')
  const ahead = worktree('ahead', 'feature-ahead')
  fs.writeFileSync(path.join(ahead, 'new.txt'), 'work\n')
  git(ahead, 'add', '.')
  git(ahead, 'commit', '-qm', 'not merged yet')
  const dirty = worktree('dirty', 'feature-dirty')
  fs.writeFileSync(path.join(dirty, 'README.md'), 'changed\n')
  const gone = path.join(repo, '.claude', 'worktrees', 'gone')

  const project = (id, root) => ({ id, name: path.basename(root), path: root, root_path: root, tags: [], kind: 'command', created_at: '' })
  const projects = [project('a', merged), project('b', ahead), project('c', dirty), project('d', gone), project('e', repo)]
  // As if a day has passed since the worktrees were made.
  const stale = await staleWorktrees(projects, Date.now() + 2 * 24 * 60 * MINUTE)
  const byName = new Map(stale.map((entry) => [entry.name, entry]))
  assert.equal(byName.get('merged')?.reason, 'merged')
  assert.equal(byName.get('merged')?.project, path.basename(repo))
  assert.equal(byName.get('merged')?.branch, 'feature-merged')
  assert.deepEqual(byName.get('merged')?.service_ids, ['a'])
  assert.equal(byName.get('gone')?.reason, 'missing')
  assert.equal(byName.get('gone')?.project, path.basename(repo))
  assert.ok(!byName.has('ahead'), 'unmerged commits are work')
  assert.ok(!byName.has('dirty'), 'uncommitted changes are work')
  assert.ok(!byName.has(path.basename(repo)), 'the main checkout is not a worktree')
  // A worktree made today may be about to get its first commit.
  assert.ok(!(await staleWorktrees(projects)).some((entry) => entry.name === 'merged'))
  fs.rmSync(repo, { recursive: true, force: true })
})
