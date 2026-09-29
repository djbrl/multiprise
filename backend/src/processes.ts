import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import { request } from 'node:http'
import { createConnection } from 'node:net'
import { publish } from './events'
import { classifyStartupFailure, failureMessage } from './failures'
import { readLogTail, startLogRun, writeLogLine } from './logfiles'
import { assertCommandAvailable } from './runtime'
import { type LogLine, type ProcessStatus } from './types'

const MAX_LOG_LINES = 5000
const EARLY_EXIT_WINDOW_MS = 1200
const LOOPBACK_HOSTS = ['127.0.0.1', '::1'] as const

type ManagedProcess = {
  child: ChildProcessWithoutNullStreams
  startedAt: string
  readyAt: string | null
  stdoutBuffer: string
  stderrBuffer: string
  stopping: boolean
  failureLocked: boolean
}

const processes = new Map<string, ManagedProcess>()
// Install/build commands that run before a service is spawned, so Stop can interrupt them.
const preparations = new Map<string, ChildProcess>()
const logs = new Map<string, LogLine[]>()
const statuses = new Map<string, ProcessStatus>()

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g
const OSC_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g

function cleanLogLine(line: string) {
  return line.replace(OSC_PATTERN, '').replace(ANSI_PATTERN, '')
}

let nextLogSeq = 1

function setStatus(id: string, status: ProcessStatus) {
  statuses.set(id, status)
  publish({ type: 'status', id, status })
}

// Consecutive identical lines (health checks, polling requests) collapse into one
// entry with a counter, so they neither flood the buffer nor silently disappear.
function pushLogEntry(existing: LogLine[], entry: Omit<LogLine, 'seq'>): { entry: LogLine; replace: boolean } {
  const last = existing[existing.length - 1]
  if (last && last.line === entry.line && last.stream === entry.stream) {
    last.repeat = (last.repeat ?? 1) + 1
    last.timestamp = entry.timestamp
    return { entry: last, replace: true }
  }
  const added = { ...entry, seq: nextLogSeq++ }
  existing.push(added)
  if (existing.length > MAX_LOG_LINES) existing.splice(0, existing.length - MAX_LOG_LINES)
  return { entry: added, replace: false }
}

// After a restart, a service's buffer is refilled from the last run written to disk.
function logsFor(id: string) {
  let existing = logs.get(id)
  if (!existing) {
    existing = []
    for (const entry of readLogTail(id)) pushLogEntry(existing, entry)
    logs.set(id, existing)
  }
  return existing
}

export function appendProcessLog(id: string, stream: 'stdout' | 'stderr', line: string) {
  const cleaned = cleanLogLine(line).replace(/\s+$/, '')
  if (cleaned.trim() === '') return
  const timestamp = new Date().toISOString()
  writeLogLine(id, { timestamp, stream, line: cleaned })
  const { entry, replace } = pushLogEntry(logsFor(id), { timestamp, stream, line: cleaned })
  publish({ type: 'log', id, entry: { ...entry }, replace })
}

function flushBuffer(id: string, stream: 'stdout' | 'stderr', buffer: string) {
  const lines = buffer.split(/[\r\n]/)
  const remainder = lines.pop() ?? ''
  for (const line of lines) appendProcessLog(id, stream, line)
  return remainder
}

function outputFor(id: string) {
  return (logs.get(id) ?? []).map((entry) => entry.line).join('\n')
}

function stoppedStatus(): ProcessStatus {
  return { phase: 'stopped', running: false, ready: false, pid: null, started_at: null, ready_at: null, error: null, exit_code: null }
}

export function getLogs(id: string, tail?: number): LogLine[] {
  const entries = logsFor(id)
  if (tail && tail > 0 && entries.length > tail) return entries.slice(entries.length - tail)
  return entries
}

// Starts a new run: the in-memory buffer empties and the previous run's file is kept on disk.
export function clearLogs(id: string) {
  startLogRun(id)
  logs.set(id, [])
  publish({ type: 'logs-cleared', id })
  setStatus(id, stoppedStatus())
}

export function forgetLogs(id: string) {
  logs.delete(id)
}

export function getProcessStatus(id: string): ProcessStatus {
  return statuses.get(id) ?? stoppedStatus()
}

export function markProcessFailed(id: string, error: string, exitCode: number | null = null) {
  setStatus(id, {
    phase: 'failed',
    running: false,
    ready: false,
    pid: null,
    started_at: null,
    ready_at: null,
    error,
    exit_code: exitCode
  })
  appendProcessLog(id, 'stderr', error)
}

export function markProcessStarting(id: string) {
  setStatus(id, {
    phase: 'starting',
    running: true,
    ready: false,
    pid: null,
    started_at: new Date().toISOString(),
    ready_at: null,
    error: null,
    exit_code: null
  })
}

export function markProcessStopped(id: string) {
  setStatus(id, stoppedStatus())
}

export function trackPreparation(id: string, child: ChildProcess) {
  preparations.set(id, child)
  child.once('close', () => {
    if (preparations.get(id) === child) preparations.delete(id)
  })
}

function cancelPreparation(id: string) {
  const child = preparations.get(id)
  if (!child?.pid) return
  preparations.delete(id)
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM')
    else child.kill('SIGTERM')
  } catch (err) {
    // Already finished.
  }
}

// Managed services are spawned as process-group leaders, so the shell, npm and the
// real server listening on the port all share the managed PID as their group id.
export function isManagedProcessGroup(id: string, pgid: number | null | undefined) {
  const pid = getProcessPid(id)
  return !!pid && !!pgid && pid === pgid
}

export function getProcessPid(id: string): number | null {
  return processes.get(id)?.child.pid ?? null
}

export function isProcessRunning(id: string): boolean {
  return processes.has(id)
}

function canConnect(host: string, port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host, port })
    const finish = (value: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(350)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

function httpStatus(host: string, port: number) {
  return new Promise<number | null>((resolve) => {
    const req = request({
      host,
      port,
      path: '/',
      method: 'GET',
      timeout: 700,
      headers: { Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' }
    }, (response) => {
      response.resume()
      resolve(response.statusCode ?? null)
    })
    req.once('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.once('error', () => resolve(null))
    req.end()
  })
}

// Any non-5xx answer means the server is up: dev servers with a base path or
// auth wall legitimately return 404/401 at "/".
function healthyHttpStatus(status: number | null) {
  return status !== null && status < 500
}

async function waitForReadiness(options: {
  port?: number
  timeoutMs: number
  hasExited: () => boolean
  readiness: 'tcp' | 'http'
}) {
  const { port, timeoutMs, hasExited, readiness } = options
  const started = Date.now()
  if (!port) {
    while (Date.now() - started < EARLY_EXIT_WINDOW_MS) {
      if (hasExited()) throw new Error('Process exited during startup')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return
  }

  let lastHttpStatus: number | null = null
  let consecutiveHealthyResponses = 0
  while (Date.now() - started < timeoutMs) {
    if (hasExited()) throw new Error('Process exited during startup')

    if (readiness === 'http') {
      const statuses = await Promise.all(LOOPBACK_HOSTS.map((host) => httpStatus(host, port)))
      const healthyStatus = statuses.find(healthyHttpStatus)
      if (healthyStatus !== undefined) {
        consecutiveHealthyResponses += 1
        if (consecutiveHealthyResponses >= 2) return
      } else {
        consecutiveHealthyResponses = 0
      }
      lastHttpStatus = statuses.find((status) => status !== null) ?? lastHttpStatus
    } else {
      const loopbackResults = await Promise.all(LOOPBACK_HOSTS.map((host) => canConnect(host, port)))
      if (loopbackResults.some(Boolean)) return
    }

    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  if (readiness === 'http' && lastHttpStatus !== null) {
    throw new Error(`HTTP readiness failed: service kept returning HTTP ${lastHttpStatus} on port ${port}`)
  }
  throw new Error(`Readiness timeout on port ${port}`)
}

function terminate(managed: ManagedProcess, signal: NodeJS.Signals = 'SIGTERM') {
  const pid = managed.child.pid ?? null
  try {
    if (pid && process.platform !== 'win32') process.kill(-pid, signal)
    else managed.child.kill(signal)
  } catch (err) {
    // The process may already be gone.
  }
}

export class LaunchCancelledError extends Error {
  constructor() {
    super('Launch cancelled')
  }
}

export async function startProcess(options: {
  id: string
  command: string
  cwd: string
  env?: Record<string, string>
  port?: number
  timeoutMs?: number
  readiness?: 'tcp' | 'http'
  onExit?: (code: number | null, error?: string | null) => void
}) {
  const { id, command, cwd, env, port, timeoutMs = 20000, readiness = 'tcp', onExit } = options
  if (processes.has(id)) throw new Error('Process already running')

  const cwdStats = await fs.stat(cwd).catch(() => null)
  if (!cwdStats?.isDirectory()) {
    throw new Error(`Service folder no longer exists: ${cwd}. Refresh or re-add the project so Multiprise can discover its current services.`)
  }

  const processEnv = { ...process.env, ...(env ?? {}) }
  assertCommandAvailable(command, processEnv)
  const child = spawn(command, {
    cwd,
    env: processEnv,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  }) as unknown as ChildProcessWithoutNullStreams

  const managed: ManagedProcess = {
    child,
    startedAt: new Date().toISOString(),
    readyAt: null,
    stdoutBuffer: '',
    stderrBuffer: '',
    stopping: false,
    failureLocked: false
  }
  processes.set(id, managed)
  setStatus(id, {
    phase: 'starting',
    running: true,
    ready: false,
    pid: child.pid ?? null,
    started_at: managed.startedAt,
    ready_at: null,
    error: null,
    exit_code: null
  })

  let exited = false
  let exitCode: number | null = null
  let spawnErrorMessage = ''
  const untrack = () => {
    if (processes.get(id) === managed) processes.delete(id)
  }
  child.once('error', (err) => {
    // Failed spawns emit asynchronously; consume them so Electron never shows a native crash dialog.
    spawnErrorMessage = err.message
    exited = true
    managed.failureLocked = true
    untrack()
    appendProcessLog(id, 'stderr', `Unable to start process: ${err.message}`)
  })
  child.stdout.on('data', (data) => {
    managed.stdoutBuffer = flushBuffer(id, 'stdout', managed.stdoutBuffer + data.toString())
  })
  child.stderr.on('data', (data) => {
    managed.stderrBuffer = flushBuffer(id, 'stderr', managed.stderrBuffer + data.toString())
  })
  child.on('close', (code) => {
    exited = true
    exitCode = code ?? null
    if (managed.stdoutBuffer.trim()) appendProcessLog(id, 'stdout', managed.stdoutBuffer.trim())
    if (managed.stderrBuffer.trim()) appendProcessLog(id, 'stderr', managed.stderrBuffer.trim())
    untrack()
    // Watchers and workers spawned by the service share its process group; don't leave them behind.
    terminate(managed, 'SIGKILL')

    if (managed.stopping) {
      setStatus(id, stoppedStatus())
      onExit?.(code ?? null, null)
      return
    }
    if (managed.failureLocked) return

    const failure = classifyStartupFailure(outputFor(id), `Service exited unexpectedly with code ${code ?? 'unknown'}.`, port)
    const message = failureMessage(failure)
    setStatus(id, {
      phase: 'failed',
      running: false,
      ready: false,
      pid: null,
      started_at: managed.startedAt,
      ready_at: managed.readyAt,
      error: message,
      exit_code: code ?? null
    })
    onExit?.(code ?? null, message)
  })

  try {
    await waitForReadiness({ port, timeoutMs, hasExited: () => exited, readiness })
    managed.readyAt = new Date().toISOString()
    setStatus(id, {
      phase: 'ready',
      running: true,
      ready: true,
      pid: child.pid ?? null,
      started_at: managed.startedAt,
      ready_at: managed.readyAt,
      error: null,
      exit_code: null
    })
    return managed
  } catch (err) {
    if (managed.stopping) {
      setStatus(id, stoppedStatus())
      throw new LaunchCancelledError()
    }
    const raw = `${spawnErrorMessage || (err instanceof Error ? err.message : 'Startup failed')}\n${outputFor(id)}`
    const failure = classifyStartupFailure(raw, `Service exited during startup with code ${exitCode ?? 'unknown'}.`, port)
    const message = failureMessage(failure)
    managed.failureLocked = true
    setStatus(id, {
      phase: 'failed',
      running: false,
      ready: false,
      pid: null,
      started_at: managed.startedAt,
      ready_at: null,
      error: message,
      exit_code: exitCode
    })
    if (!exited) {
      terminate(managed)
      setTimeout(() => {
        if (!exited) terminate(managed, 'SIGKILL')
      }, 3000).unref()
    }
    onExit?.(exitCode, message)
    throw new Error(message)
  }
}

export async function stopProcess(id: string, timeoutMs = 4000) {
  cancelPreparation(id)
  const managed = processes.get(id)
  if (!managed) {
    setStatus(id, stoppedStatus())
    return
  }
  const child = managed.child
  managed.stopping = true
  const untrack = () => {
    if (processes.get(id) === managed) processes.delete(id)
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    untrack()
    setStatus(id, stoppedStatus())
    return
  }

  terminate(managed)
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      terminate(managed, 'SIGKILL')
      resolve()
    }, timeoutMs)
    child.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  untrack()
  setStatus(id, stoppedStatus())
}

export async function stopAllProcesses(timeoutMs = 4000) {
  const ids = new Set([...processes.keys(), ...preparations.keys()])
  await Promise.all(Array.from(ids).map((id) => stopProcess(id, timeoutMs).catch(() => {})))
}
