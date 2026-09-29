import { spawn, type ChildProcess } from 'node:child_process'
import { publish } from './events'
import { appendProcessLog, getLogs } from './processes'
import { type AppState, persistProjects } from './state'
import { type ContainerState, type ProcessStatus, type Project } from './types'

// Docker Compose services run in Docker, not under Multiprise, so their state is read
// from `docker compose ps` instead of being remembered: containers started or stopped
// outside the app, or left running across a restart, show up as they really are.

// Exit codes of containers that were asked to stop (SIGINT, SIGKILL, SIGTERM).
const STOP_SIGNAL_EXIT_CODES = new Set([130, 137, 143])
// Published ports of common data stores; the service URL prefers any other port.
const DATA_STORE_PORTS = new Set([1433, 2181, 3306, 5432, 5672, 6379, 9092, 9200, 11211, 27017])

const statuses = new Map<string, ProcessStatus>()
const followers = new Map<string, ChildProcess>()
// Where a project's log stream resumes; set when it is launched so no startup output is missed.
const followFrom = new Map<string, string>()

type RawContainer = {
  Name?: string
  Service?: string
  State?: string
  Health?: string
  ExitCode?: number
  Publishers?: Array<{ PublishedPort?: number; Protocol?: string }> | null
}

// Compose prints a JSON array (before v2.21) or one JSON object per line (since).
export function parseComposePs(output: string): ContainerState[] {
  const text = output.trim()
  if (!text) return []
  const raw: RawContainer[] = text.startsWith('[')
    ? JSON.parse(text)
    : text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
  return raw.map((container) => ({
    service: container.Service ?? container.Name ?? 'container',
    state: (container.State ?? 'unknown').toLowerCase(),
    health: (container.Health ?? '').toLowerCase(),
    exit_code: typeof container.ExitCode === 'number' ? container.ExitCode : null,
    ports: [...new Set((container.Publishers ?? [])
      .filter((publisher) => publisher.PublishedPort && (publisher.Protocol ?? 'tcp') === 'tcp')
      .map((publisher) => publisher.PublishedPort as number))]
      .sort((a, b) => a - b)
  }))
}

const failedExit = (container: ContainerState) =>
  container.state === 'exited' && !!container.exit_code && !STOP_SIGNAL_EXIT_CODES.has(container.exit_code)

function problemOf(container: ContainerState) {
  if (container.state === 'restarting') return `${container.service} keeps restarting`
  if (container.state === 'dead') return `${container.service} is dead`
  if (container.health === 'unhealthy') return `${container.service} is unhealthy`
  if (failedExit(container)) return `${container.service} exited with code ${container.exit_code}`
  return null
}

export function composeStatus(containers: ContainerState[], previous?: ProcessStatus): ProcessStatus {
  const running = containers.filter((container) => container.state === 'running')
  const problems = containers.map(problemOf).filter((problem): problem is string => !!problem)
  const isRunning = running.length > 0
  const phase: ProcessStatus['phase'] = problems.length
    ? 'failed'
    : !isRunning
      ? 'stopped'
      : running.some((container) => container.health === 'starting') ? 'starting' : 'ready'
  const startedAt = isRunning ? previous?.started_at ?? new Date().toISOString() : null
  return {
    phase,
    running: isRunning,
    ready: phase === 'ready',
    pid: null,
    started_at: startedAt,
    ready_at: phase === 'ready' ? (previous?.phase === 'ready' ? previous.ready_at ?? null : new Date().toISOString()) : null,
    error: problems.length ? `${problems.join('; ')}. See the logs for details.` : null,
    exit_code: null,
    containers
  }
}

// The URL of a compose project: its lowest published port that is not a data store.
function primaryPort(containers: ContainerState[]) {
  const ports = containers.filter((container) => container.state === 'running').flatMap((container) => container.ports)
  return ports.find((port) => !DATA_STORE_PORTS.has(port)) ?? ports[0] ?? null
}

// Before the first check, fall back to what the app last recorded.
export function dockerStatus(project: Project): ProcessStatus {
  return statuses.get(project.id) ?? {
    phase: project.docker_running ? 'ready' : 'stopped',
    running: !!project.docker_running,
    ready: !!project.docker_running,
    pid: null,
    started_at: project.docker_started_at ?? null,
    ready_at: project.docker_started_at ?? null,
    error: project.last_error ?? null,
    exit_code: project.last_exit_code ?? null
  }
}

function composePs(cwd: string) {
  return new Promise<ContainerState[]>((resolve, reject) => {
    const child = spawn('docker', ['compose', 'ps', '--all', '--format', 'json'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim().split('\n').pop() || `docker compose ps exited with code ${code}`))
      try {
        resolve(parseComposePs(stdout))
      } catch (err) {
        reject(new Error('Unexpected output from docker compose ps'))
      }
    })
  })
}

function stopFollowing(id: string) {
  const child = followers.get(id)
  followers.delete(id)
  child?.kill('SIGTERM')
}

// Streams the containers' output into the service log while any of them runs.
function follow(project: Project) {
  if (followers.has(project.id)) return
  const lastLine = getLogs(project.id).slice(-1)[0]
  const since = followFrom.get(project.id) ?? lastLine?.timestamp
  const args = ['compose', 'logs', '--follow', '--no-color', ...(since ? ['--since', since] : ['--tail', '100'])]
  const child = spawn('docker', args, { cwd: project.path, stdio: ['ignore', 'pipe', 'pipe'] })
  followers.set(project.id, child)
  followFrom.delete(project.id)
  const pipe = (stream: 'stdout' | 'stderr') => {
    let buffer = ''
    child[stream]?.on('data', (chunk) => {
      const lines = (buffer + chunk.toString()).split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) appendProcessLog(project.id, stream, line)
    })
  }
  pipe('stdout')
  pipe('stderr')
  child.on('error', () => {})
  child.on('close', () => {
    // The next refresh starts a new stream if the containers are still up.
    if (followers.get(project.id) === child) followers.delete(project.id)
  })
}

export function followDockerLogsFrom(project: Project, timestamp: string) {
  stopFollowing(project.id)
  followFrom.set(project.id, timestamp)
}

const sameStatus = (a: ProcessStatus | undefined, b: ProcessStatus) =>
  !!a && a.phase === b.phase && a.running === b.running && a.error === b.error &&
  JSON.stringify(a.containers) === JSON.stringify(b.containers)

// Reads the project's containers and publishes any change (always, after a start or stop,
// since relaunching resets the status other listeners saw).
export async function refreshDockerProject(state: AppState, project: Project, announce = false): Promise<ProcessStatus> {
  const previous = statuses.get(project.id)
  let status: ProcessStatus
  try {
    status = composeStatus(await composePs(project.path), previous)
  } catch (err) {
    // Without a reachable Docker, no container can be running.
    const wasRunning = previous?.running ?? !!project.docker_running
    status = {
      ...composeStatus([]),
      error: wasRunning ? `Docker is not available: ${err instanceof Error ? err.message : String(err)}` : null
    }
  }
  if (!state.projects.includes(project)) return status

  statuses.set(project.id, status)
  if (status.running) follow(project)
  else stopFollowing(project.id)

  const port = primaryPort(status.containers ?? [])
  const changed = project.docker_running !== status.running || (port !== null && project.port !== port)
  project.docker_running = status.running
  project.docker_started_at = status.started_at ?? null
  if (port !== null) project.port = port
  if (changed) await persistProjects(state)
  if (announce || !sameStatus(previous, status)) publish({ type: 'status', id: project.id, status })
  return status
}

export function forgetDockerProject(id: string) {
  stopFollowing(id)
  statuses.delete(id)
  followFrom.delete(id)
}

export type DockerWatcher = { stop: () => void }

export function watchDockerProjects(state: AppState, intervalMs = 5000): DockerWatcher {
  let stopped = false
  let refreshing = false
  const refreshAll = async () => {
    if (refreshing || stopped) return
    refreshing = true
    try {
      for (const project of state.projects.filter((entry) => entry.kind === 'docker_compose')) {
        if (stopped) break
        await refreshDockerProject(state, project).catch((err) => console.error('[multiprise] docker refresh failed:', err))
      }
    } finally {
      refreshing = false
    }
  }
  refreshAll()
  const timer = setInterval(refreshAll, intervalMs)
  timer.unref()
  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
      // Containers keep running after Multiprise quits; only the log streams end.
      for (const id of [...followers.keys()]) stopFollowing(id)
    }
  }
}
