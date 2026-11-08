import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { assertCommandAvailable } from '../services/runtime'

// Helpers for running one-off commands and talking to the rest of the system.

export async function spawnCommand(command: string, cwd: string, env?: Record<string, string>, onLine?: (stream: 'stdout' | 'stderr', line: string) => void) {
  const processEnv = { ...process.env, ...(env ?? {}) }
  assertCommandAvailable(command, processEnv)
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env: processEnv,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderrTail = ''
    child.stdout?.on('data', (chunk) => {
      chunk.toString().split(/\r?\n/).forEach((line: string) => onLine?.('stdout', line))
    })
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString()
      stderrTail = (stderrTail + text).slice(-600)
      text.split(/\r?\n/).forEach((line: string) => onLine?.('stderr', line))
    })
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (code === 0) return resolve()
      const detail = stderrTail.trim().split('\n').filter(Boolean).slice(-3).join(' ')
      reject(new Error(`Command exited with code ${code ?? 'unknown'}${detail ? `: ${detail}` : ''}`))
    })
  })
}

async function spawnAndWait(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {}
) {
  return new Promise<{ ok: boolean; code: number | null; error?: string }>((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: 'ignore'
    })
    let settled = false
    child.on('error', (err) => {
      if (settled) return
      settled = true
      resolve({ ok: false, code: null, error: err.message })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      resolve({ ok: code === 0, code, error: code === 0 ? undefined : `Exit ${code ?? 'unknown'}` })
    })
  })
}

async function spawnAndCapture(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {}
) {
  return new Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string; error?: string }>((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let settled = false
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      resolve({ ok: false, code: null, stdout, stderr, error: err.message })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      resolve({ ok: code === 0, code, stdout, stderr })
    })
  })
}

export function processExists(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return false
  }
}

export async function processWorkingDirectory(pid: number): Promise<string | null> {
  if (process.platform !== 'win32') {
    try {
      return await fs.readlink('/proc/' + pid + '/cwd')
    } catch (err) {
      // macOS does not expose /proc; fall back to lsof.
    }

    const result = await spawnAndCapture('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
    if (result.ok) {
      const cwdLine = result.stdout.split('\n').find((line) => line.startsWith('n'))
      if (cwdLine?.slice(1).trim()) return cwdLine.slice(1).trim()
    }
  }
  return null
}

export async function terminateExternalProcess(pid: number, timeoutMs = 1800) {
  if (!processExists(pid)) return

  try {
    process.kill(pid, 'SIGTERM')
  } catch (err) {
    throw new Error('Unable to unplug the external process.')
  }

  const started = Date.now()
  while (processExists(pid) && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  if (!processExists(pid)) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch (err) {
    throw new Error('The external process did not stop.')
  }

  await new Promise((resolve) => setTimeout(resolve, 120))
  if (processExists(pid)) {
    throw new Error('The external process did not stop.')
  }
}

export async function openInVSCode(targetPath: string) {
  const codeAttempt = await spawnAndWait('code', ['-r', targetPath], { cwd: process.cwd() })
  if (codeAttempt.ok) {
    return
  }

  if (process.platform === 'darwin') {
    const openAttempt = await spawnAndWait('open', ['-a', 'Visual Studio Code', targetPath], {
      cwd: process.cwd()
    })
    if (openAttempt.ok) {
      return
    }
    throw new Error(`VS Code launch failed (code: ${codeAttempt.error ?? 'missing'}, open: ${openAttempt.error ?? 'unknown'})`)
  }

  if (process.platform === 'win32') {
    const winAttempt = await spawnAndWait('cmd', ['/c', 'start', '', 'code', targetPath], {
      cwd: process.cwd()
    })
    if (winAttempt.ok) {
      return
    }
    throw new Error(`VS Code launch failed (code: ${codeAttempt.error ?? 'missing'}, start: ${winAttempt.error ?? 'unknown'})`)
  }

  const fallback = await spawnAndWait('code', ['-r', targetPath], { cwd: process.cwd() })
  if (fallback.ok) {
    return
  }

  throw new Error(`VS Code launch failed (code: ${codeAttempt.error ?? 'missing'})`)
}

export async function openInFileManager(targetPath: string) {
  if (process.platform === 'darwin') {
    const attempt = await spawnAndWait('open', [targetPath], { cwd: process.cwd() })
    if (attempt.ok) return
    throw new Error(`Open in Finder failed (${attempt.error ?? 'unknown'})`)
  }
  if (process.platform === 'win32') {
    const attempt = await spawnAndWait('cmd', ['/c', 'start', '', targetPath], { cwd: process.cwd() })
    if (attempt.ok) return
    throw new Error(`Open in Explorer failed (${attempt.error ?? 'unknown'})`)
  }
  const attempt = await spawnAndWait('xdg-open', [targetPath], { cwd: process.cwd() })
  if (attempt.ok) return
  throw new Error(`Open in file manager failed (${attempt.error ?? 'unknown'})`)
}

export async function checkVSCodeAvailability() {
  const platform = process.platform
  const cliResult =
    platform === 'win32'
      ? await spawnAndCapture('where', ['code'])
      : await spawnAndCapture('which', ['code'])

  const cliPath = cliResult.ok ? cliResult.stdout.trim().split('\n')[0] : null
  const cliVersion = cliPath ? await spawnAndCapture('code', ['--version']) : null

  const appPaths: string[] = []
  if (platform === 'darwin') {
    const candidates = [
      '/Applications/Visual Studio Code.app',
      '/Applications/Visual Studio Code - Insiders.app',
      path.join(process.env.HOME ?? '', 'Applications', 'Visual Studio Code.app')
    ]
    for (const candidate of candidates) {
      try {
        const stat = await fs.stat(candidate)
        if (stat.isDirectory()) {
          appPaths.push(candidate)
        }
      } catch (err) {
        // ignore
      }
    }
  }

  return {
    platform,
    cli: {
      ok: cliResult.ok,
      path: cliPath,
      error: cliResult.ok ? null : cliResult.error || cliResult.stderr?.trim() || 'Not found',
      version: cliVersion?.ok ? cliVersion.stdout.trim().split('\n')[0] : null
    },
    app: {
      paths: appPaths,
      ok: appPaths.length > 0
    }
  }
}

// Opens a file at a line in VS Code when its `code` command is available, otherwise with the
// file's default app (which cannot jump to the line).
export async function openFileInEditor(file: string, line?: number, column?: number) {
  const location = line ? `${file}:${line}${column ? `:${column}` : ''}` : file
  const code = await spawnAndWait('code', ['-g', location], { cwd: path.dirname(file) })
  if (code.ok) return 'vscode'
  const fallback = process.platform === 'darwin'
    ? await spawnAndWait('open', [file], { cwd: path.dirname(file) })
    : process.platform === 'win32'
      ? await spawnAndWait('cmd', ['/c', 'start', '', file], { cwd: path.dirname(file) })
      : await spawnAndWait('xdg-open', [file], { cwd: path.dirname(file) })
  if (fallback.ok) return 'default'
  throw new Error(`Could not open ${file} (${fallback.error ?? 'no editor found'})`)
}
