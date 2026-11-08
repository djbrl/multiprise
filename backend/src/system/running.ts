import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { terminateExternalProcess } from './commands'
import { isSameOrInside } from '../api/http'
import { type listListeningPorts } from '../network/ports'
import { getProcessPid, managedProcessIds } from '../services/processes'
import { redactText } from '../redact'
import { findRepository } from '../projects/repository'
import { type Project, type RunningServer } from '../types'

// Every dev server on this Mac, whoever started it: a terminal, a coding agent, or Multiprise.
// No setup is needed; what lsof can see is matched to the tracked projects where it can be.

const execFileAsync = promisify(execFile)

// An orphan younger than this may just be starting up behind a script that exited.
const LEFTOVER_MIN_AGE_MS = 60 * 60 * 1000
const DOCKER_TIMEOUT_MS = 3000
const DOCKER_CACHE_MS = 8000

type ProcessDetails = { pid: number; ppid: number; pgid: number; uid: number; startedAt: Date | null; command: string }

async function stdoutOf(file: string, args: string[], env?: NodeJS.ProcessEnv) {
  // Both exit non-zero when one of the PIDs is gone, and still print the rest.
  return execFileAsync(file, args, { env: env ?? process.env, maxBuffer: 8 * 1024 * 1024 })
    .then((result) => result.stdout)
    .catch((err: { stdout?: string }) => err.stdout ?? '')
}

export function parseProcessList(output: string) {
  const details = new Map<number, ProcessDetails>()
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ [\d:]+ \d{4})\s+(.*)$/)
    if (!match) continue
    const started = new Date(match[5].replace(/\s+/g, ' '))
    details.set(Number(match[1]), {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      uid: Number(match[4]),
      startedAt: Number.isNaN(started.getTime()) ? null : started,
      command: match[6].trim()
    })
  }
  return details
}

async function processDetails(pids: number[]) {
  if (!pids.length) return new Map<number, ProcessDetails>()
  const output = await stdoutOf('ps', ['-ww', '-o', 'pid=,ppid=,pgid=,uid=,lstart=,command=', '-p', pids.join(',')], { ...process.env, LC_ALL: 'C' })
  return parseProcessList(output)
}

export async function workingDirectories(pids: number[]) {
  const folders = new Map<number, string>()
  if (!pids.length) return folders
  let pid = 0
  for (const line of (await stdoutOf('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn'])).split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) folders.set(pid, line.slice(1))
  }
  return folders
}

const home = () => os.homedir()

// The machine's own folders; a process running from one of them is not somebody's project.
const SYSTEM_FOLDERS = ['/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/opt/homebrew', '/private/etc', '/dev', '/cores']

const isTemporary = (folder: string) => /^(?:\/private)?\/(?:tmp|var\/folders)\//.test(`${folder}/`)

export function isProjectFolder(folder: string) {
  if (folder === '/') return false
  if (isTemporary(folder)) return true
  if (/^\/(?:private\/)?var(?:\/|$)/.test(folder)) return false
  if (SYSTEM_FOLDERS.some((system) => isSameOrInside(folder, system))) return false
  const inHome = path.relative(home(), folder)
  if (inHome && !inHome.startsWith('..')) {
    // ~/Library and ~/.config, ~/.claude/plugins… hold tools and background helpers.
    const top = inHome.split(path.sep)[0]
    if (top === 'Library' || top.startsWith('.')) return false
  }
  return true
}

// Desktop apps listen on ports too (Discord, Adobe…). A headless browser is what a script left.
export function isDesktopApp(command: string) {
  const applications = [`${home()}/Applications/`, '/Applications/', '/System/', '/Library/', '/usr/libexec/', '/usr/sbin/']
  if (!applications.some((folder) => command.startsWith(folder))) return false
  return !/\s--(?:headless|remote-debugging-port)\b/.test(command)
}

// `/long/path/to/node dist/main.js` reads as `node dist/main.js`.
export function shortCommand(command: string) {
  // Inside an app bundle the executable's path may hold spaces (Google Chrome).
  const bundled = command.match(/\/([^/]+)\.app\/Contents\/MacOS\/(.*)$/)
  const short = bundled
    ? bundled[2].startsWith(bundled[1]) ? bundled[2] : bundled[2].replace(/^\S*\//, '')
    : command.replace(/^(\S*\/)?(\S+)/, '$2')
  return redactText(short.replace(/\S*node_modules\/\.bin\//g, '')).slice(0, 240)
}

type Place = Pick<RunningServer, 'project' | 'path' | 'worktree' | 'scratch' | 'track_path'>

export function describeFolder(folder: string): Place {
  if (isTemporary(folder)) {
    // Claude Code's session scratchpads are named after the project they belong to.
    const session = folder.match(/\/claude-\d+\/-([^/]+)\//)
    const project = session ? session[1].replace(/^Users-[^-]+-/, '') : path.basename(folder)
    return { project, path: folder, worktree: null, scratch: true, track_path: null }
  }
  const repository = findRepository(folder)
  if (!repository) return { project: path.basename(folder) || folder, path: folder, worktree: null, scratch: false, track_path: folder }
  return {
    project: path.basename(repository.main),
    path: folder,
    worktree: repository.worktree,
    scratch: false,
    // A worktree comes and goes with its task; offering to save it would pile them up.
    track_path: repository.worktree ? null : repository.root
  }
}

// The deepest tracked service whose folder holds this one. A worktree is its own checkout,
// so a project tracked in the main checkout does not count.
function trackedService(projects: Project[], folder: string) {
  const repository = findRepository(folder)
  const belongs = (candidate: string) => isSameOrInside(folder, candidate) && (!repository?.worktree || isSameOrInside(candidate, repository.root))
  const service = projects
    .filter((project) => belongs(project.path))
    .sort((a, b) => b.path.length - a.path.length)[0]
  return { service: service ?? null, tracked: !!service || projects.some((project) => belongs(project.root_path ?? project.path)) }
}

export function leftoverReason(options: { orphaned: boolean; folderExists: boolean; ageMs: number | null; managed: boolean }) {
  if (options.managed) return null
  if (!options.folderExists) return 'Its folder no longer exists.'
  if (options.orphaned && options.ageMs !== null && options.ageMs >= LEFTOVER_MIN_AGE_MS) return 'Its terminal or agent is gone.'
  return null
}

async function runningProcesses(listening: Awaited<ReturnType<typeof listListeningPorts>>, projects: Project[]) {
  const ports = new Map<number, Set<number>>()
  for (const entry of listening) {
    if (entry.pid === process.pid) continue
    if (!ports.has(entry.pid)) ports.set(entry.pid, new Set())
    ports.get(entry.pid)!.add(entry.port)
  }
  const pids = [...ports.keys()]
  const [details, folders] = await Promise.all([processDetails(pids), workingDirectories(pids)])
  const managedGroups = new Map(managedProcessIds().map((id) => [getProcessPid(id), id]))
  const uid = process.getuid?.()

  const servers: RunningServer[] = []
  for (const pid of pids) {
    const info = details.get(pid)
    const folder = folders.get(pid)
    if (!info || !folder || (uid !== undefined && info.uid !== uid)) continue
    if (!isProjectFolder(folder) || isDesktopApp(info.command)) continue
    const managedId = managedGroups.get(info.pgid) ?? managedGroups.get(pid) ?? null
    const { service, tracked } = trackedService(projects, folder)
    const owner = managedId ? projects.find((project) => project.id === managedId) ?? service : service
    const ageMs = info.startedAt ? Date.now() - info.startedAt.getTime() : null
    const folderExists = fs.existsSync(folder)
    const reason = leftoverReason({ orphaned: info.ppid === 1, folderExists, ageMs, managed: !!managedId })
    const place = describeFolder(folder)
    servers.push({
      key: `pid:${pid}:${info.startedAt?.getTime() ?? 0}`,
      kind: 'process',
      pid,
      ports: [...ports.get(pid)!].sort((a, b) => a - b),
      command: shortCommand(info.command),
      started_at: info.startedAt?.toISOString() ?? null,
      service_id: owner?.id ?? null,
      service_name: owner?.name ?? null,
      tracked: tracked || !!managedId,
      managed: !!managedId,
      leftover: !!reason,
      leftover_reason: reason,
      ...place,
      track_path: tracked || !folderExists ? null : place.track_path
    })
  }
  return servers
}

type DockerRow = { ID?: string; Names?: string; Image?: string; Ports?: string; Labels?: string; CreatedAt?: string }

// One JSON object per line, from `docker ps --format '{{json .}}'`. Containers that publish
// no port are not servers anyone can reach.
export function parseDockerPs(output: string, projects: Project[]): RunningServer[] {
  const servers: RunningServer[] = []
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    let row: DockerRow
    try {
      row = JSON.parse(line) as DockerRow
    } catch (err) {
      continue
    }
    const ports = [...new Set([...(row.Ports ?? '').matchAll(/:(\d+)->\d+\/tcp/g)].map((match) => Number(match[1])))].sort((a, b) => a - b)
    if (!row.ID || !ports.length) continue
    const labels = new Map((row.Labels ?? '').split(',').map((label) => {
      const equals = label.indexOf('=')
      return [label.slice(0, equals), label.slice(equals + 1)] as const
    }))
    const folder = labels.get('com.docker.compose.project.working_dir') ?? null
    const created = (row.CreatedAt ?? '').match(/^(\S+) (\S+) ([+-]\d{2})(\d{2})/)
    const startedAt = created ? new Date(`${created[1]}T${created[2]}${created[3]}:${created[4]}`) : null
    const tracked = folder ? projects.find((project) => project.kind === 'docker_compose' && project.path === folder) ?? null : null
    const place: Place = folder
      ? describeFolder(folder)
      : { project: row.Names ?? row.ID, path: null, worktree: null, scratch: false, track_path: null }
    servers.push({
      key: `docker:${row.ID}`,
      kind: 'docker',
      pid: null,
      ports,
      command: `${labels.get('com.docker.compose.service') ?? row.Names ?? 'container'} (${row.Image ?? 'docker'})`,
      started_at: startedAt && !Number.isNaN(startedAt.getTime()) ? startedAt.toISOString() : null,
      service_id: tracked?.id ?? null,
      service_name: tracked?.name ?? null,
      tracked: !!tracked,
      managed: !!tracked?.docker_running,
      leftover: false,
      leftover_reason: null,
      ...place,
      track_path: tracked ? null : place.track_path
    })
  }
  return servers
}

let dockerCache: { at: number; output: Promise<string> } | null = null

// Docker may be missing or not started, which is normal; there is just nothing to list.
export function dockerPs() {
  if (!dockerCache || Date.now() - dockerCache.at > DOCKER_CACHE_MS) {
    dockerCache = {
      at: Date.now(),
      output: execFileAsync('docker', ['ps', '--format', '{{json .}}'], { timeout: DOCKER_TIMEOUT_MS }).then((result) => result.stdout, () => '')
    }
  }
  return dockerCache.output
}

export async function listRunningServers(listening: Awaited<ReturnType<typeof listListeningPorts>>, projects: Project[]) {
  const [processes, docker] = await Promise.all([runningProcesses(listening, projects), dockerPs()])
  const containers = parseDockerPs(docker, projects)
  const age = (server: RunningServer) => server.started_at ? Date.parse(server.started_at) : 0
  // Leftovers first, oldest first, since they are what needs a decision; then the newest.
  return [...processes, ...containers].sort((a, b) =>
    Number(b.leftover) - Number(a.leftover) || (a.leftover ? age(a) - age(b) : age(b) - age(a)))
}

// Only the process it was asked about, unless that process leads its own group: killing a
// group led by something else could take down the shell or agent that started it.
export async function stopRunningProcess(pid: number) {
  const details = (await processDetails([pid])).get(pid)
  if (details?.pgid === pid) {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch (err) {
      // Already gone, or the group went with it.
    }
  }
  await terminateExternalProcess(pid)
}

export async function stopContainer(id: string) {
  dockerCache = null
  await execFileAsync('docker', ['stop', '-t', '5', id], { timeout: 20000 })
  dockerCache = null
}
