import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { type LogLine, type ProcessStatus } from './types'

const MAX_LOG_LINES = 500

type ManagedProcess = {
  child: ChildProcessWithoutNullStreams
  startedAt: string
  stdoutBuffer: string
  stderrBuffer: string
}

const processes = new Map<string, ManagedProcess>()
const logs = new Map<string, LogLine[]>()

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g
const OSC_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g

function cleanLogLine(line: string) {
  return line.replace(OSC_PATTERN, '').replace(ANSI_PATTERN, '')
}

function appendLog(id: string, stream: 'stdout' | 'stderr', line: string) {
  const cleaned = cleanLogLine(line).replace(/\s+$/, '')
  if (cleaned.trim() === '') return
  const entry: LogLine = {
    timestamp: new Date().toISOString(),
    stream,
    line: cleaned
  }
  const existing = logs.get(id) ?? []
  const last = existing[existing.length - 1]
  if (last && last.line === cleaned) {
    return
  }
  existing.push(entry)
  if (existing.length > MAX_LOG_LINES) {
    existing.splice(0, existing.length - MAX_LOG_LINES)
  }
  logs.set(id, existing)
}

function flushBuffer(id: string, stream: 'stdout' | 'stderr', buffer: string) {
  const lines = buffer.split(/[\r\n]/)
  const remainder = lines.pop() ?? ''
  for (const line of lines) {
    appendLog(id, stream, line)
  }
  return remainder
}

export function getLogs(id: string, tail?: number): LogLine[] {
  const entries = logs.get(id) ?? []
  if (tail && tail > 0 && entries.length > tail) {
    return entries.slice(entries.length - tail)
  }
  return entries
}

export function clearLogs(id: string) {
  logs.delete(id)
}

export function getProcessStatus(id: string): ProcessStatus {
  const process = processes.get(id)
  if (!process) {
    return { running: false, pid: null, started_at: null }
  }
  const pid = process.child.pid ?? null
  return {
    running: pid !== null,
    pid,
    started_at: process.startedAt
  }
}

export function getProcessPid(id: string): number | null {
  const process = processes.get(id)
  return process?.child.pid ?? null
}

export function isProcessRunning(id: string): boolean {
  return processes.has(id)
}

export function startProcess(options: {
  id: string
  command: string
  cwd: string
  env?: Record<string, string>
  onExit?: (code: number | null) => void
}) {
  const { id, command, cwd, env, onExit } = options
  if (processes.has(id)) {
    throw new Error('Process already running')
  }
  const child = spawn(command, {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  }) as unknown as ChildProcessWithoutNullStreams

  const managed: ManagedProcess = {
    child,
    startedAt: new Date().toISOString(),
    stdoutBuffer: '',
    stderrBuffer: ''
  }

  child.stdout.on('data', (data) => {
    managed.stdoutBuffer = flushBuffer(id, 'stdout', managed.stdoutBuffer + data.toString())
  })

  child.stderr.on('data', (data) => {
    managed.stderrBuffer = flushBuffer(id, 'stderr', managed.stderrBuffer + data.toString())
  })

  child.on('close', (code) => {
    if (managed.stdoutBuffer.trim()) {
      appendLog(id, 'stdout', managed.stdoutBuffer.trim())
    }
    if (managed.stderrBuffer.trim()) {
      appendLog(id, 'stderr', managed.stderrBuffer.trim())
    }
    processes.delete(id)
    onExit?.(code ?? null)
  })

  processes.set(id, managed)
  return managed
}

export async function stopProcess(id: string, timeoutMs = 4000) {
  const managed = processes.get(id)
  if (!managed) return
  const child = managed.child

  if (child.killed) {
    processes.delete(id)
    return
  }

  const pid = child.pid ?? null
  const useGroupKill = pid && process.platform !== 'win32'
  try {
    if (useGroupKill) {
      process.kill(-pid, 'SIGTERM')
    } else {
      child.kill('SIGTERM')
    }
  } catch (err) {
    // ignore
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        if (useGroupKill && pid) {
          process.kill(-pid, 'SIGKILL')
        } else if (!child.killed) {
          child.kill('SIGKILL')
        }
      } catch (err) {
        // ignore
      }
      resolve()
    }, timeoutMs)

    child.on('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
