import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createConnection } from 'node:net'
import { classifyStartupFailure, failureMessage } from './failures'
import { assertCommandAvailable } from './runtime'
import { type LogLine, type ProcessStatus } from './types'

const MAX_LOG_LINES = 500
const EARLY_EXIT_WINDOW_MS = 1200

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
const logs = new Map<string, LogLine[]>()
const statuses = new Map<string, ProcessStatus>()

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g
const OSC_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g

function cleanLogLine(line: string) {
  return line.replace(OSC_PATTERN, '').replace(ANSI_PATTERN, '')
}

export function appendProcessLog(id: string, stream: 'stdout' | 'stderr', line: string) {
  const cleaned = cleanLogLine(line).replace(/\s+$/, '')
  if (cleaned.trim() === '') return
  const entry: LogLine = { timestamp: new Date().toISOString(), stream, line: cleaned }
  const existing = logs.get(id) ?? []
  const last = existing[existing.length - 1]
  if (last && last.line === cleaned) return
  existing.push(entry)
  if (existing.length > MAX_LOG_LINES) existing.splice(0, existing.length - MAX_LOG_LINES)
  logs.set(id, existing)
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
  const entries = logs.get(id) ?? []
  if (tail && tail > 0 && entries.length > tail) return entries.slice(entries.length - tail)
  return entries
}

export function clearLogs(id: string) {
  logs.delete(id)
  statuses.set(id, stoppedStatus())
}

export function getProcessStatus(id: string): ProcessStatus {
  return statuses.get(id) ?? stoppedStatus()
}

export function markProcessFailed(id: string, error: string, exitCode: number | null = null) {
  statuses.set(id, {
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

export function getProcessPid(id: string): number | null {
  return processes.get(id)?.child.pid ?? null
}

export function isProcessRunning(id: string): boolean {
  return processes.has(id)
}

function canConnect(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
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

async function waitForReadiness(options: {
  port?: number
  timeoutMs: number
  hasExited: () => boolean
}) {
  const { port, timeoutMs, hasExited } = options
  const started = Date.now()
  if (!port) {
    while (Date.now() - started < EARLY_EXIT_WINDOW_MS) {
      if (hasExited()) throw new Error('Process exited during startup')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return
  }

  while (Date.now() - started < timeoutMs) {
    if (hasExited()) throw new Error('Process exited during startup')
    if (await canConnect(port)) return
    await new Promise((resolve) => setTimeout(resolve, 150))
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

export async function startProcess(options: {
  id: string
  command: string
  cwd: string
  env?: Record<string, string>
  port?: number
  timeoutMs?: number
  onExit?: (code: number | null, error?: string | null) => void
}) {
  const { id, command, cwd, env, port, timeoutMs = 20000, onExit } = options
  if (processes.has(id)) throw new Error('Process already running')

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
  statuses.set(id, {
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
    processes.delete(id)

    if (managed.stopping) {
      statuses.set(id, stoppedStatus())
      onExit?.(code ?? null, null)
      return
    }
    if (managed.failureLocked) return

    const failure = classifyStartupFailure(outputFor(id), `Service exited unexpectedly with code ${code ?? 'unknown'}.`, port)
    const message = failureMessage(failure)
    statuses.set(id, {
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
    await waitForReadiness({ port, timeoutMs, hasExited: () => exited })
    managed.readyAt = new Date().toISOString()
    statuses.set(id, {
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
    const raw = `${err instanceof Error ? err.message : 'Startup failed'}\n${outputFor(id)}`
    const failure = classifyStartupFailure(raw, `Service exited during startup with code ${exitCode ?? 'unknown'}.`, port)
    const message = failureMessage(failure)
    managed.failureLocked = true
    statuses.set(id, {
      phase: 'failed',
      running: false,
      ready: false,
      pid: null,
      started_at: managed.startedAt,
      ready_at: null,
      error: message,
      exit_code: exitCode
    })
    if (!exited) terminate(managed)
    onExit?.(exitCode, message)
    throw new Error(message)
  }
}

export async function stopProcess(id: string, timeoutMs = 4000) {
  const managed = processes.get(id)
  if (!managed) {
    statuses.set(id, stoppedStatus())
    return
  }
  const child = managed.child
  managed.stopping = true
  if (child.killed) {
    processes.delete(id)
    statuses.set(id, stoppedStatus())
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
  processes.delete(id)
  statuses.set(id, stoppedStatus())
}
