import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { findRepository } from '../projects/repository'
import { currentLogPath, previousLogPath } from '../services/logfiles'
import { getProcessStatus } from '../services/processes'
import { type DiskFolder, type DiskReport, type DockerLeftovers, type Project, type ProjectDiskUse, type StaleWorktree } from '../types'

// What piles up across many projects: worktrees whose work has landed, folders a project can
// rebuild, and what Docker keeps after its containers stop. Nothing here deletes on its own;
// it finds, and the routes act only on what it found.

const execFileAsync = promisify(execFile)

const DAY_MS = 24 * 60 * 60 * 1000
// A worktree younger than this may be about to get its first commit.
const WORKTREE_MIN_AGE_MS = DAY_MS
const INACTIVE_DAYS = 30
const GIT_TIMEOUT_MS = 5000
const DOCKER_TIMEOUT_MS = 8000

const git = (cwd: string, args: string[]) =>
  execFileAsync('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS }).then((result) => result.stdout.trim())

const rootOf = (project: Project) => path.resolve(project.root_path ?? project.path)

export function projectRoots(projects: Project[]) {
  const roots = new Map<string, Project[]>()
  for (const project of projects) {
    const root = rootOf(project)
    roots.set(root, [...(roots.get(root) ?? []), project])
  }
  return roots
}

const isRunning = (services: Project[]) => services.some((service) => {
  const status = getProcessStatus(service.id)
  return status.running || status.phase === 'starting' || !!service.docker_running
})

// The branch the repository's work lands on: origin's default, else main or master.
async function defaultBranch(cwd: string) {
  const remote = await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')
  const candidates = [remote, 'main', 'master', 'origin/main', 'origin/master'].filter(Boolean)
  for (const candidate of candidates) {
    if (await git(cwd, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]).then(() => true, () => false)) return candidate
  }
  return null
}

// A worktree that is gone cannot be asked which repository it was; agents keep theirs
// in <repository>/.claude/worktrees/<name>.
const repositoryName = (root: string) => path.basename(root.match(/^(.*?)\/\.claude\/worktrees\//)?.[1] ?? root)

export async function staleWorktrees(projects: Project[], now = Date.now()): Promise<StaleWorktree[]> {
  const stale: StaleWorktree[] = []
  for (const [root, services] of projectRoots(projects)) {
    const base = { root, name: path.basename(root), service_ids: services.map((service) => service.id) }
    if (!fs.existsSync(root)) {
      // Only worktrees come and go like this; a main checkout that moved is worth a look too.
      stale.push({ ...base, project: repositoryName(root), branch: null, reason: 'missing', detail: 'Its folder no longer exists.', last_commit_at: null })
      continue
    }
    const repository = findRepository(root)
    if (!repository?.worktree || repository.root !== root || isRunning(services)) continue
    const created = fs.statSync(path.join(root, '.git')).mtimeMs
    if (now - created < WORKTREE_MIN_AGE_MS) continue
    try {
      // Uncommitted work is never stale, however old.
      if (await git(root, ['status', '--porcelain'])) continue
      const [branch, lastCommit, target] = await Promise.all([
        git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
        git(root, ['log', '-1', '--format=%cI']).catch(() => ''),
        defaultBranch(root)
      ])
      const entry = { ...base, project: path.basename(repository.main), branch: branch && branch !== 'HEAD' ? branch : null, last_commit_at: lastCommit || null }
      const landed = target ? await git(root, ['merge-base', '--is-ancestor', 'HEAD', target]).then(() => true, () => false) : false
      if (landed) {
        stale.push({ ...entry, reason: 'merged', detail: `Everything on it is already on ${target!.replace(/^origin\//, '')}.` })
        continue
      }
      const days = lastCommit ? Math.floor((now - Date.parse(lastCommit)) / DAY_MS) : null
      if (days !== null && days >= INACTIVE_DAYS) {
        stale.push({ ...entry, reason: 'inactive', detail: `No commits for ${days} days.` })
      }
    } catch (err) {
      // Not a readable checkout; leave it alone.
    }
  }
  return stale
}

type DockerRow = Record<string, string | undefined>

const jsonLines = (output: string) => output.split('\n').flatMap((line) => {
  if (!line.trim()) return []
  try {
    return [JSON.parse(line) as DockerRow]
  } catch (err) {
    return []
  }
})

const labelsOf = (row: DockerRow) => new Map((row.Labels ?? '').split(',').filter(Boolean).map((label) => {
  const equals = label.indexOf('=')
  return [label.slice(0, equals), label.slice(equals + 1)] as const
}))

// From `docker ps -a --filter status=exited --filter status=created`, `docker volume ls -f
// dangling=true` and `docker images -f dangling=true`, each with --format '{{json .}}'.
export function parseDockerLeftovers(containers: string, volumes: string, images: string): Omit<DockerLeftovers, 'available'> {
  return {
    containers: jsonLines(containers).filter((row) => row.ID).map((row) => ({
      id: row.ID!,
      name: row.Names ?? row.ID!,
      image: row.Image ?? '',
      project: labelsOf(row).get('com.docker.compose.project') ?? null,
      status: row.Status ?? row.State ?? ''
    })),
    volumes: jsonLines(volumes).filter((row) => row.Name).map((row) => ({
      name: row.Name!,
      project: labelsOf(row).get('com.docker.compose.project') ?? null
    })),
    images: jsonLines(images).filter((row) => row.ID).map((row) => ({
      id: row.ID!,
      size: row.Size ?? '',
      created: row.CreatedSince ?? ''
    }))
  }
}

const docker = (args: string[]) => execFileAsync('docker', args, { timeout: DOCKER_TIMEOUT_MS }).then((result) => result.stdout)

export async function dockerLeftovers(): Promise<DockerLeftovers> {
  const format = ['--format', '{{json .}}']
  try {
    const [containers, volumes, images] = await Promise.all([
      docker(['ps', '-a', '--filter', 'status=exited', '--filter', 'status=created', ...format]),
      docker(['volume', 'ls', '-f', 'dangling=true', ...format]),
      docker(['images', '-f', 'dangling=true', ...format])
    ])
    return { available: true, ...parseDockerLeftovers(containers, volumes, images) }
  } catch (err) {
    // Not installed, or its engine is not running: there is nothing to clean.
    return { available: false, containers: [], volumes: [], images: [] }
  }
}

// Removes only what dockerLeftovers still reports, so a container started since is never touched.
export async function removeDockerLeftovers(request: { containers?: string[]; volumes?: string[]; images?: string[] }) {
  const current = await dockerLeftovers()
  const pick = (asked: unknown, known: string[]) => (Array.isArray(asked) ? asked : []).filter((value): value is string => typeof value === 'string' && known.includes(value))
  const containers = pick(request.containers, current.containers.map((entry) => entry.id))
  const volumes = pick(request.volumes, current.volumes.map((entry) => entry.name))
  const images = pick(request.images, current.images.map((entry) => entry.id))
  if (containers.length) await docker(['rm', ...containers])
  if (volumes.length) await docker(['volume', 'rm', ...volumes])
  if (images.length) await docker(['rmi', ...images])
  return { containers, volumes, images }
}

// Folders a project rebuilds on its own. build and dist can hold sources in some projects,
// so a folder only counts when git ignores it (or, outside git, when its name leaves no doubt).
const ALWAYS_GENERATED = new Set(['node_modules', '.next', '.nuxt', '.output', '.svelte-kit', '.turbo', '.parcel-cache', '.vite', '.angular', '.expo'])
const MAYBE_GENERATED = new Set(['dist', 'build', 'out', 'coverage', 'target', '.venv', 'venv', '__pycache__', '.pytest_cache', '.gradle', 'DerivedData'])
const SKIP = new Set(['.git'])
const MAX_DEPTH = 4

async function candidateFolders(root: string) {
  const found: string[] = []
  const walk = async (dir: string, depth: number) => {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch (err) {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIP.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (ALWAYS_GENERATED.has(entry.name) || MAYBE_GENERATED.has(entry.name)) {
        found.push(full)
        continue
      }
      // A nested checkout (a worktree inside .claude/worktrees) is its own project.
      if (fs.existsSync(path.join(full, '.git'))) continue
      if (depth < MAX_DEPTH) await walk(full, depth + 1)
    }
  }
  await walk(root, 1)
  return found
}

async function ignoredByGit(root: string, folders: string[]) {
  if (!folders.length) return new Set<string>()
  if (!findRepository(root)) return new Set(folders.filter((folder) => ALWAYS_GENERATED.has(path.basename(folder))))
  // The trailing slash lets rules written for folders only (node_modules/) match.
  const relative = folders.map((folder) => `${path.relative(root, folder)}/`)
  // check-ignore prints the ignored ones and exits 1 when none are.
  const output = await execFileAsync('git', ['-C', root, 'check-ignore', ...relative], { timeout: GIT_TIMEOUT_MS })
    .then((result) => result.stdout, (err: { stdout?: string }) => err.stdout ?? '')
  return new Set(output.split('\n').filter(Boolean).map((line) => path.resolve(root, line)))
}

// `du -sk` output: kilobytes, then the path.
export function parseDu(output: string) {
  const sizes = new Map<string, number>()
  for (const line of output.split('\n')) {
    const match = line.match(/^(\d+)\s+(.+)$/)
    if (match) sizes.set(match[2], Number(match[1]) * 1024)
  }
  return sizes
}

async function folderSizes(folders: string[]) {
  if (!folders.length) return new Map<string, number>()
  const output = await execFileAsync('du', ['-sk', ...folders], { maxBuffer: 4 * 1024 * 1024, timeout: 120000 })
    .then((result) => result.stdout, (err: { stdout?: string }) => err.stdout ?? '')
  return parseDu(output)
}

function lastRun(services: Project[]) {
  let latest = 0
  for (const service of services) {
    for (const file of [currentLogPath(service.id), previousLogPath(service.id)]) {
      const modified = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0
      latest = Math.max(latest, modified)
    }
    const status = getProcessStatus(service.id)
    if (status.running) latest = Date.now()
  }
  return latest ? new Date(latest).toISOString() : null
}

async function measureProject(root: string, services: Project[]): Promise<ProjectDiskUse | null> {
  if (!fs.existsSync(root)) return null
  const candidates = await candidateFolders(root)
  const ignored = await ignoredByGit(root, candidates)
  const kept = candidates.filter((folder) => ignored.has(folder))
  const sizes = await folderSizes(kept)
  const folders: DiskFolder[] = kept
    .map((folder) => ({ path: folder, relative: path.relative(root, folder), bytes: sizes.get(folder) ?? 0 }))
    .filter((folder) => folder.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
  return {
    root,
    name: path.basename(root),
    bytes: folders.reduce((sum, folder) => sum + folder.bytes, 0),
    folders,
    last_run_at: lastRun(services),
    running: isRunning(services)
  }
}

// Measuring node_modules takes seconds per project, so it runs in the background and the last
// result answers in the meantime.
const DISK_CACHE_MS = 15 * 60 * 1000
let disk: { at: number; projects: ProjectDiskUse[] } | null = null
let measuring: Promise<void> | null = null

export function diskReport(projects: Project[], options: { refresh?: boolean } = {}): DiskReport {
  const stale = !disk || Date.now() - disk.at > DISK_CACHE_MS
  if (!measuring && (stale || options.refresh)) {
    measuring = (async () => {
      const measured: ProjectDiskUse[] = []
      for (const [root, services] of projectRoots(projects)) {
        const use = await measureProject(root, services).catch(() => null)
        if (use) measured.push(use)
      }
      disk = { at: Date.now(), projects: measured.sort((a, b) => b.bytes - a.bytes) }
    })().finally(() => { measuring = null })
  }
  const running = new Set([...projectRoots(projects)].filter(([, services]) => isRunning(services)).map(([root]) => root))
  return {
    // Whether it runs now, not when it was measured: it decides whether cleaning is allowed.
    projects: (disk?.projects ?? []).map((project) => ({ ...project, running: running.has(project.root) })),
    measured_at: disk ? new Date(disk.at).toISOString() : null,
    measuring: !!measuring
  }
}

export function diskMeasurement() {
  return measuring ?? Promise.resolve()
}

// Only folders the last measurement found, in projects that are not running: a dev server
// whose node_modules disappears under it breaks in confusing ways.
export function trashableFolders(projects: Project[], paths: unknown) {
  const asked = (Array.isArray(paths) ? paths : []).filter((value): value is string => typeof value === 'string')
  const roots = projectRoots(projects)
  const chosen: Array<{ root: string; folder: DiskFolder }> = []
  for (const project of disk?.projects ?? []) {
    const services = roots.get(project.root)
    if (!services) continue
    for (const folder of project.folders) {
      if (!asked.includes(folder.path)) continue
      if (isRunning(services)) throw new Error(`Stop ${project.name} before cleaning it.`)
      chosen.push({ root: project.root, folder })
    }
  }
  return chosen
}

export function forgetTrashed(paths: string[]) {
  if (!disk) return
  disk = {
    ...disk,
    projects: disk.projects
      .map((project) => {
        const folders = project.folders.filter((folder) => !paths.includes(folder.path))
        return { ...project, folders, bytes: folders.reduce((sum, folder) => sum + folder.bytes, 0) }
      })
      .sort((a, b) => b.bytes - a.bytes)
  }
}
