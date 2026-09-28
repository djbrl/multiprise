import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { dialog } from 'electron'
import { type AppState } from './state'
import {
  type CreateProjectPayload,
  type DetectResponse,
  type AllocatePortsPayload,
  type ProcessInstance,
  type ProcessKillPayload,
  type Project,
  type ProjectKind,
  type ProjectInspectResult,
  type ProjectView,
  type ScanRequestPayload,
  type ScanState,
  type Settings,
  type StartProjectPayload,
  type UpdateProjectPayload,
  type UsedPort
} from './types'
import { adaptCommandForFramework, detectProject, discoverProjectServices, scanProjects } from './scanner'
import { listListeningPorts, pickAvailablePort, processGroups } from './ports'
import {
  LaunchCancelledError,
  appendProcessLog,
  clearLogs,
  getLogs,
  getProcessPid,
  getProcessStatus,
  isManagedProcessGroup,
  markProcessFailed,
  markProcessStarting,
  markProcessStopped,
  startProcess,
  stopProcess
} from './processes'
import { prepareService } from './preparation'
import { detectStartupConflict } from './failures'
import { persistProjects, persistSettings } from './state'
import { sanitizeSettings } from './store'
import { assertCommandAvailable, resolveProjectNodeRuntime } from './runtime'

const DEFAULT_DOCKER_STOP = 'docker compose down'
const MAX_RETAINED_SCANS = 10

const cleanPath = (value: string) => value.replace(/\\/g, '/')

const ensureArray = <T>(value: T[] | undefined | null): T[] => Array.isArray(value) ? value : []

const isValidPort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : []

const ICON_EXTENSIONS = new Set(['.ico', '.png', '.svg', '.jpg', '.jpeg'])
const ICON_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache'
])
const MAX_ICON_DEPTH = 4

async function fileExists(filePath: string) {
  try {
    const stat = await fs.stat(filePath)
    return stat.isFile()
  } catch (err) {
    return false
  }
}

async function findProjectIcon(rootDir: string): Promise<string | null> {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }]
  while (queue.length) {
    const current = queue.shift()
    if (!current) break
    let entries: Array<import('node:fs').Dirent> = []
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true })
    } catch (err) {
      continue
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue
      const lowerName = entry.name.toLowerCase()
      const ext = path.extname(lowerName)
      if (!ICON_EXTENSIONS.has(ext)) continue
      if (
        lowerName.includes('favicon') ||
        lowerName.startsWith('icon') ||
        lowerName.startsWith('logo') ||
        lowerName.startsWith('apple-touch-icon')
      ) {
        return path.join(current.dir, entry.name)
      }
    }

    if (current.depth >= MAX_ICON_DEPTH) continue
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (ICON_IGNORE_DIRS.has(entry.name)) continue
      queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 })
    }
  }
  return null
}

async function resolveProjectIcon(project: Project, state: AppState): Promise<string | null> {
  if (project.icon_path && (await fileExists(project.icon_path))) {
    return project.icon_path
  }
  const found = await findProjectIcon(project.root_path ?? project.path)
  project.icon_path = found
  await persistProjects(state)
  return found
}

async function checkVSCodeAvailability() {
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

const buildProjectView = (project: Project): ProjectView => {
  if (project.kind === 'docker_compose') {
    return {
      project,
      status: {
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
  }
  return {
    project,
    status: getProcessStatus(project.id)
  }
}

function isSameOrInside(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function noServicesMessage(projectPath: string) {
  const raw = await fs.readFile(path.join(projectPath, 'package.json'), 'utf8').catch(() => null)
  if (raw !== null) {
    try {
      JSON.parse(raw)
    } catch (err) {
      return `package.json is not valid JSON: ${err instanceof Error ? err.message : 'parse error'}`
    }
  }
  return 'No runnable package.json, Cargo.toml, or Docker Compose services found'
}

function projectRoleFallback(project: Project): 'backend' | 'frontend' | 'service' {
  if (project.role) return project.role
  const root = project.root_path ?? project.path
  const segments = path.relative(root, project.path).toLowerCase().split(/[\\/]/)
  if (segments.some((segment) => ['frontend', 'client', 'web', 'ui', 'app'].includes(segment))) return 'frontend'
  if (segments.some((segment) => ['backend', 'server', 'api'].includes(segment))) return 'backend'
  return 'service'
}

const SERVICE_ROLES = new Set(['backend', 'frontend', 'service'])

async function spawnCommand(command: string, cwd: string, env?: Record<string, string>, onLine?: (stream: 'stdout' | 'stderr', line: string) => void) {
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

function processExists(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return false
  }
}

async function processWorkingDirectory(pid: number): Promise<string | null> {
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

function pathBelongsToProject(project: Project, candidate: string) {
  return isSameOrInside(path.resolve(candidate), path.resolve(project.root_path ?? project.path))
}

async function startupConflictInstance(
  project: Project,
  knownListening?: Awaited<ReturnType<typeof listListeningPorts>>
): Promise<ProcessInstance | null> {
  const output = [
    ...getLogs(project.id).map((entry) => entry.line),
    project.last_error ?? ''
  ].filter(Boolean).join('\n')
  const conflict = detectStartupConflict(output)
  if (!conflict || !processExists(conflict.pid)) return null

  const listening = knownListening ?? await listListeningPorts()
  const listener = listening.find((entry) =>
    entry.pid === conflict.pid && (!conflict.port || entry.port === conflict.port)
  )
  if (!listener) return null

  const actualCwd = await processWorkingDirectory(conflict.pid)
  const candidateCwd = actualCwd ?? conflict.cwd
  if (!candidateCwd || !pathBelongsToProject(project, candidateCwd)) return null

  return {
    pid: conflict.pid,
    port: listener.port,
    command: listener.command ?? null,
    source: 'external',
    cwd: candidateCwd,
    reason: 'startup-conflict'
  }
}

async function terminateExternalProcess(pid: number, timeoutMs = 1800) {
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

async function openInVSCode(targetPath: string) {
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

async function openInFileManager(targetPath: string) {
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

export async function resolveStartCommand(project: Project, payload: StartProjectPayload) {
  const detection = await detectProject(project.path, project.root_path ?? project.path)
  const projectCommand = project.command?.trim() ?? ''
  const payloadCommand = payload.command?.trim() ?? ''
  const payloadIsUserOverride = !!payloadCommand && payloadCommand !== projectCommand

  if (project.kind === 'docker_compose') {
    return {
      command: payloadCommand || projectCommand || 'docker compose up -d --build',
      commandSource: payloadIsUserOverride || project.command_source === 'user' ? 'user' as const : 'auto' as const,
      cwd: project.path,
      detection
    }
  }

  const commandSource = payloadIsUserOverride || project.command_source === 'user' ? 'user' as const : 'auto' as const
  const command = commandSource === 'user'
    ? payloadCommand || projectCommand
    : detection.suggested_command?.trim() || payloadCommand || projectCommand

  if (!command || /^docker(?:-|\s)/.test(command)) {
    throw new Error(`No runnable development script found in ${project.path}`)
  }

  return { command, commandSource, cwd: project.path, detection }
}

async function buildStartEnv(options: {
  payloadEnv?: Record<string, string>
  role: 'backend' | 'frontend' | 'service'
  framework?: Project['framework']
  port?: number
}) {
  const { payloadEnv, role, framework, port } = options
  const merged: Record<string, string> = { ...(payloadEnv ?? {}) }
  const backendPort = merged.BACKEND_PORT ? Number(merged.BACKEND_PORT) : role === 'backend' ? port : undefined
  const frontendPort = merged.FRONTEND_PORT ? Number(merged.FRONTEND_PORT) : role === 'frontend' ? port : undefined

  if (backendPort) {
    merged.BACKEND_PORT ||= String(backendPort)
    merged.API_PORT ||= String(backendPort)
    if (role === 'frontend') {
      merged.VITE_API_PORT ||= String(backendPort)
      merged.VITE_API_URL ||= `http://localhost:${backendPort}`
    }
  }
  if (frontendPort) {
    merged.FRONTEND_PORT ||= String(frontendPort)
    merged.VITE_PORT ||= String(frontendPort)
  }
  if (port) {
    merged.PORT ||= String(port)
    merged.SERVICE_PORT ||= String(port)
    if (framework === 'nuxt') {
      merged.NUXT_PORT ||= String(port)
      merged.NITRO_PORT ||= String(port)
    }
    if (framework === 'cargo') {
      merged.ROCKET_PORT ||= String(port)
      merged.LEPTOS_SITE_ADDR ||= `127.0.0.1:${port}`
    }
  }

  return merged
}

export type ApiSecurityOptions = {
  token?: string | null
  allowedOrigins?: string[]
}

export const API_TOKEN_HEADER = 'x-multiprise-token'
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

// Express 4 does not forward rejected promises to the error handler.
const handle = (fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }

function tokensMatch(expected: string, provided: unknown) {
  if (typeof provided !== 'string' || provided.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
}

function requestHostname(req: Request) {
  const host = (req.headers.host ?? '').toLowerCase()
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '')
}

function apiGuard(security: ApiSecurityOptions): RequestHandler {
  const token = security.token ?? null
  const allowedOrigins = new Set(security.allowedOrigins ?? ['null'])
  return (req, res, next) => {
    // Rejecting foreign Host headers blocks DNS-rebinding pages from reaching the API.
    if (!LOOPBACK_HOSTNAMES.has(requestHostname(req))) {
      return res.status(403).send('Forbidden host')
    }
    const origin = req.headers.origin
    if (origin !== undefined) {
      if (!allowedOrigins.has(origin)) return res.status(403).send('Forbidden origin')
      res.header('Access-Control-Allow-Origin', origin)
      res.header('Vary', 'Origin')
      res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
      res.header('Access-Control-Allow-Headers', `Content-Type, ${API_TOKEN_HEADER}`)
    }
    if (req.method === 'OPTIONS') {
      return res.sendStatus(origin !== undefined ? 204 : 403)
    }
    if (token) {
      // Image requests cannot carry headers, so GETs may pass the token as a query parameter.
      const provided = req.get(API_TOKEN_HEADER) ?? (req.method === 'GET' ? req.query.token : undefined)
      if (!tokensMatch(token, provided)) return res.status(401).send('Unauthorized')
    }
    next()
  }
}

export async function createApp(state: AppState, security: ApiSecurityOptions = {}) {
  const app = express()

  // Launches in progress, keyed by project id; Stop and Delete flag them as cancelled.
  const launches = new Map<string, { cancelled: boolean }>()
  const cancelLaunch = (id: string) => {
    const launch = launches.get(id)
    if (launch) launch.cancelled = true
  }

  app.use(apiGuard(security))
  app.use(express.json({ limit: '2mb' }))

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, time: new Date().toISOString() })
  })

  app.get('/api/projects', (_req: Request, res: Response) => {
    res.json({ projects: state.projects.map(buildProjectView) })
  })

  app.get('/api/projects/:id/favicon', handle(async (req: Request, res: Response) => {
    const project = state.projects.find((entry) => entry.id === req.params.id)
    if (!project) {
      return res.status(404).send('Project not found')
    }
    const iconPath = await resolveProjectIcon(project, state)
    if (!iconPath) {
      return res.status(404).send('Icon not found')
    }
    return res.sendFile(iconPath)
  }))

  app.get('/api/system/vscode/test', handle(async (_req: Request, res: Response) => {
    const report = await checkVSCodeAvailability()
    res.json(report)
  }))

  app.post('/api/projects', handle(async (req: Request, res: Response) => {
    const payload = req.body as CreateProjectPayload
    if (typeof payload?.path !== 'string' || !payload.path.trim()) {
      return res.status(400).send('Path is required')
    }
    const projectPath = cleanPath(path.resolve(payload.path))
    const stats = await fs.stat(projectPath).catch(() => null)
    if (!stats) {
      return res.status(400).send(`Path does not exist: ${projectPath}`)
    }
    if (!stats.isDirectory()) {
      return res.status(400).send(`Path is not a folder: ${projectPath}`)
    }
    if (state.projects.some((project) => cleanPath(project.root_path ?? project.path) === projectPath)) {
      return res.status(400).send('Project already exists')
    }
    const overlapping = state.projects.find((project) => {
      const existingRoot = cleanPath(project.root_path ?? project.path)
      return isSameOrInside(projectPath, existingRoot) || isSameOrInside(existingRoot, projectPath)
    })
    if (overlapping) {
      return res.status(400).send(`This folder overlaps the tracked project at ${cleanPath(overlapping.root_path ?? overlapping.path)}`)
    }

    const services = await discoverProjectServices(projectPath, state.settings)
    if (!services.length) {
      return res.status(400).send(await noServicesMessage(projectPath))
    }

    const iconPath = await findProjectIcon(projectPath)
    const createdAt = new Date().toISOString()
    const created: Project[] = services.map((service) => ({
      id: randomUUID(),
      name: service.name,
      path: cleanPath(service.path),
      root_path: projectPath,
      tags: [],
      command: service.command,
      command_source: service.command_source,
      package_manager: service.package_manager ?? null,
      install_root: service.install_root ?? null,
      framework: service.framework,
      stop_command: service.kind === 'docker_compose' ? 'docker compose down' : null,
      port: null,
      icon_path: iconPath,
      kind: service.kind,
      role: service.role,
      docker_running: false,
      docker_started_at: null,
      last_exit_code: null,
      last_exit_at: null,
      last_error: null,
      created_at: createdAt
    }))

    state.projects = [...created, ...state.projects]
    await persistProjects(state)
    return res.json({ projects: created.map(buildProjectView) })
  }))

  app.post('/api/projects/inspect', handle(async (req: Request, res: Response) => {
    const roots = stringArray(req.body?.roots)
    if (!roots.length) {
      return res.json({ projects: [] })
    }

    const results: ProjectInspectResult[] = []
    for (const root of roots) {
      const projectPath = cleanPath(path.resolve(root))
      const name = path.basename(projectPath)
      const stats = await fs.stat(projectPath).catch(() => null)
      if (!stats || !stats.isDirectory()) {
        results.push({
          path: projectPath,
          name,
          has_services: false,
          error: 'Folder not found'
        })
        continue
      }

      try {
        const services = await discoverProjectServices(projectPath, state.settings)
        results.push({
          path: projectPath,
          name,
          has_services: services.length > 0,
          error: services.length > 0 ? null : await noServicesMessage(projectPath),
          services: services.map((service) => ({
            name: service.name,
            role: service.role,
            cwd: service.cwd,
            start: service.command,
            source: service.source,
            framework: service.framework
          }))
        })
      } catch (err) {
        results.push({
          path: projectPath,
          name,
          has_services: false,
          error: err instanceof Error ? err.message : 'Service discovery failed'
        })
      }
    }

    return res.json({ projects: results })
  }))

  app.patch('/api/projects/:id', handle(async (req: Request, res: Response) => {
    const id = req.params.id
    const payload = req.body as UpdateProjectPayload
    const project = state.projects.find((entry) => entry.id === id)
    if (!project) {
      return res.status(404).send('Project not found')
    }

    if (!payload || typeof payload !== 'object') {
      return res.status(400).send('Expected a JSON object')
    }
    if (payload.name !== undefined && (typeof payload.name !== 'string' || !payload.name.trim())) {
      return res.status(400).send('Name must be a non-empty string')
    }
    if (payload.command !== undefined && payload.command !== null && typeof payload.command !== 'string') {
      return res.status(400).send('Command must be a string')
    }
    if (payload.command_source !== undefined && payload.command_source !== 'auto' && payload.command_source !== 'user') {
      return res.status(400).send('command_source must be "auto" or "user"')
    }
    if (payload.stop_command !== undefined && payload.stop_command !== null && typeof payload.stop_command !== 'string') {
      return res.status(400).send('Stop command must be a string')
    }
    if (payload.port !== undefined && payload.port !== null && !isValidPort(payload.port)) {
      return res.status(400).send('Port must be an integer between 1 and 65535')
    }

    if (payload.name !== undefined) {
      project.name = payload.name.trim()
    }
    if (payload.command !== undefined || payload.command_source !== undefined) {
      const requestedSource = payload.command_source ?? (payload.command !== undefined ? 'user' : project.command_source ?? 'auto')
      project.command_source = requestedSource
      if (requestedSource === 'auto') {
        const detection = await detectProject(project.path, project.root_path ?? project.path)
        project.command = detection.suggested_command ?? null
        project.package_manager = detection.package_manager ?? null
        project.install_root = detection.package_root ?? null
        project.framework = detection.framework
      } else if (payload.command !== undefined) {
        project.command = payload.command
      }
    }
    if (payload.stop_command !== undefined) {
      project.stop_command = payload.stop_command
    }
    if (payload.port !== undefined) {
      project.port = payload.port
    }

    await persistProjects(state)
    return res.json(buildProjectView(project))
  }))

  app.delete('/api/projects/:id', handle(async (req: Request, res: Response) => {
    const id = req.params.id
    const project = state.projects.find((entry) => entry.id === id)
    if (!project) {
      return res.status(404).send('Project not found')
    }

    cancelLaunch(id)
    await stopProcess(id)
    state.projects = state.projects.filter((entry) => entry.id !== id)
    await persistProjects(state)
    res.json({ ok: true })
  }))

  app.post('/api/projects/:id/detect', handle(async (req: Request, res: Response) => {
    const project = state.projects.find((entry) => entry.id === req.params.id)
    if (!project) {
      return res.status(404).send('Project not found')
    }
    const data: DetectResponse = await detectProject(project.path, project.root_path ?? project.path)
    return res.json(data)
  }))

  app.post('/api/projects/:id/start', handle(async (req: Request, res: Response) => {
    const project = state.projects.find((entry) => entry.id === req.params.id)
    if (!project) {
      return res.status(404).send('Project not found')
    }
    if (project.kind !== 'docker_compose' && getProcessPid(project.id)) {
      return res.status(400).send('Project already running')
    }

    const payload = (req.body && typeof req.body === 'object' ? req.body : {}) as StartProjectPayload
    if (payload.role !== undefined && !SERVICE_ROLES.has(payload.role)) {
      return res.status(400).send('Role must be backend, frontend, or service')
    }
    if (payload.command !== undefined && payload.command !== null && typeof payload.command !== 'string') {
      return res.status(400).send('Command must be a string')
    }
    if (payload.env !== undefined && (typeof payload.env !== 'object' || payload.env === null ||
      Object.values(payload.env).some((value) => typeof value !== 'string'))) {
      return res.status(400).send('Environment values must be strings')
    }
    const role = payload.role ?? projectRoleFallback(project)
    if (launches.has(project.id)) {
      return res.status(409).send('This service is already starting')
    }
    // Claimed synchronously so overlapping requests cannot both pass the running check.
    const launch = { cancelled: false }
    launches.set(project.id, launch)
    try {
      const usedPorts = new Set<number>()
      const listening = await listListeningPorts()
      listening.forEach((entry) => usedPorts.add(entry.port))
      state.projects.forEach((entry) => {
        if (entry.port) usedPorts.add(entry.port)
      })

      let port = payload.port ?? undefined
      if (port !== undefined && !isValidPort(port)) {
        return res.status(400).send('Port must be an integer between 1 and 65535')
      }
      const autoPort = payload.force_auto_port || state.settings.auto_port
      if (port === undefined && !autoPort && project.port) {
        port = project.port
      }
      if (port && listening.some((entry) => entry.port === port)) {
        return res.status(400).send(`Port ${port} is already in use`)
      }
      // Compose files declare their own ports, so none is reserved for them.
      if (!port && autoPort && project.kind !== 'docker_compose') {
        const pickedPort = await pickAvailablePort({ role, used: usedPorts, preferredBase: state.settings.port_base })
        if (!pickedPort) {
          return res.status(400).send('No ports available in range')
        }
        port = pickedPort
      }
      if (!port && project.kind !== 'docker_compose') {
        return res.status(400).send('Choose a port before launching this service')
      }

      clearLogs(project.id)
      if (project.kind !== 'docker_compose') markProcessStarting(project.id)
      const ensureNotCancelled = () => {
        if (launch.cancelled) throw new LaunchCancelledError()
      }
      try {
        const { command, commandSource, cwd, detection } = await resolveStartCommand(project, payload)
        const framework = detection.framework ?? project.framework ?? 'unknown'
        const startEnv = await buildStartEnv({
          payloadEnv: payload.env,
          role,
          framework,
          port
        })
        const runtime = await resolveProjectNodeRuntime({
          command,
          cwd,
          rootBoundary: project.root_path ?? project.path,
          framework,
          env: startEnv,
          autoInstall: state.settings.auto_install,
          onLog: (line) => appendProcessLog(project.id, 'stdout', line)
        })
        const env = {
          ...startEnv,
          ...(runtime.path ? { PATH: runtime.path } : {})
        }
        ensureNotCancelled()

        project.command = command
        project.command_source = commandSource
        project.package_manager = detection.package_manager ?? project.package_manager ?? null
        project.install_root = detection.package_root ?? project.install_root ?? null
        project.framework = framework
        project.port = port ?? project.port ?? null
        project.last_error = null

        if (project.kind === 'docker_compose') {
          await spawnCommand(command, cwd, env, (stream, line) => appendProcessLog(project.id, stream, line))
          project.docker_running = true
          project.docker_started_at = new Date().toISOString()
          await persistProjects(state)
          return res.json(buildProjectView(project))
        }

        await prepareService({
          id: project.id,
          project,
          detection,
          command,
          autoInstall: state.settings.auto_install,
          env
        })
        ensureNotCancelled()
        const launchCommand = adaptCommandForFramework({
          command,
          framework,
          packageManager: project.package_manager,
          port
        })

        await startProcess({
          id: project.id,
          command: launchCommand,
          cwd,
          env,
          port,
          readiness: ['vite', 'next', 'nuxt'].includes(framework) || role === 'frontend' ? 'http' : 'tcp',
          // A first `cargo run` compiles the whole crate before it can listen.
          timeoutMs: framework === 'cargo' ? Math.max(state.settings.startup_timeout_ms, 180000) : state.settings.startup_timeout_ms,
          onExit: (code, error) => {
            project.last_exit_code = code ?? null
            project.last_exit_at = new Date().toISOString()
            project.last_error = error ?? null
            persistProjects(state).catch((err) => console.error('[multiprise] failed to save projects:', err))
          }
        })

        await persistProjects(state)
        return res.json(buildProjectView(project))
      } catch (err) {
        if (err instanceof LaunchCancelledError || launch.cancelled) {
          if (project.kind !== 'docker_compose') markProcessStopped(project.id)
          return res.status(409).send('Launch cancelled')
        }
        const message = err instanceof Error ? err.message : 'Failed to start'
        if (project.kind !== 'docker_compose' && getProcessStatus(project.id).phase !== 'failed') {
          markProcessFailed(project.id, message)
        }
        project.last_error = message
        project.last_exit_at = new Date().toISOString()
        await persistProjects(state)
        return res.status(400).send(message)
      }
    } finally {
      if (launches.get(project.id) === launch) launches.delete(project.id)
    }
  }))

  app.post('/api/projects/:id/stop', handle(async (req: Request, res: Response) => {
    const project = state.projects.find((entry) => entry.id === req.params.id)
    if (!project) {
      return res.status(404).send('Project not found')
    }

    if (project.kind === 'docker_compose') {
      const stopCommand = project.stop_command || DEFAULT_DOCKER_STOP
      try {
        await spawnCommand(stopCommand, project.path, undefined, (stream, line) => appendProcessLog(project.id, stream, line))
      } catch (err) {
        return res.status(400).send(`Failed to stop docker project. ${err instanceof Error ? err.message : ''}`.trim())
      }
      project.docker_running = false
      project.docker_started_at = null
      await persistProjects(state)
      return res.json(buildProjectView(project))
    }

    cancelLaunch(project.id)
    await stopProcess(project.id)
    await persistProjects(state)
    return res.json(buildProjectView(project))
  }))

  app.get('/api/projects/:id/logs', (req: Request, res: Response) => {
    const project = state.projects.find((entry) => entry.id === req.params.id)
    if (!project) {
      return res.status(404).send('Project not found')
    }
    const tail = req.query.tail ? Number(req.query.tail) : undefined
    const data = getLogs(project.id, tail)
    res.json({ logs: data })
  })

  app.get('/api/projects/:id/process/instances', handle(async (req: Request, res: Response) => {
    const project = state.projects.find((entry) => entry.id === req.params.id)
    if (!project) {
      return res.status(404).send('Project not found')
    }

    const instances: ProcessInstance[] = []

    if (project.kind === 'docker_compose') {
      if (project.docker_running) {
        instances.push({
          pid: 0,
          port: project.port ?? null,
          command: 'docker compose',
          source: 'docker',
          cwd: project.path
        })
      }
      return res.json({ instances })
    }

    const managedPid = getProcessPid(project.id)
    if (managedPid) {
      instances.push({
        pid: managedPid,
        port: project.port ?? null,
        command: project.command ?? null,
        source: 'managed',
        cwd: project.path
      })
    }

    const listening = await listListeningPorts()
    const groups = managedPid ? await processGroups(listening.map((entry) => entry.pid)) : new Map<number, number>()
    if (project.port) {
      for (const entry of listening) {
        if (entry.port !== project.port) continue
        // The real server is usually a child of the managed shell/npm process.
        if (managedPid && (entry.pid === managedPid || isManagedProcessGroup(project.id, groups.get(entry.pid)))) continue
        instances.push({
          pid: entry.pid,
          port: entry.port,
          command: entry.command ?? null,
          source: 'external',
          cwd: project.path,
          reason: 'assigned-port'
        })
      }
    }

    const conflict = await startupConflictInstance(project, listening)
    if (conflict && !instances.some((instance) => instance.pid === conflict.pid && instance.port === conflict.port)) {
      instances.push(conflict)
    }

    res.json({ instances })
  }))

  app.post('/api/projects/:id/process/kill', handle(async (req: Request, res: Response) => {
    const project = state.projects.find((entry) => entry.id === req.params.id)
    if (!project) {
      return res.status(404).send('Project not found')
    }

    const payload = req.body as ProcessKillPayload
    const listening = await listListeningPorts()
    let pid = payload?.pid
    if (!pid && payload?.port) {
      pid = listening.find((entry) => entry.port === payload.port)?.pid
    }
    if (!pid && project.port) {
      pid = listening.find((entry) => entry.port === project.port)?.pid
    }
    if (!pid || !Number.isInteger(pid) || pid <= 1) {
      return res.status(404).send('No process found')
    }

    const managedPid = getProcessPid(project.id)
    const pidGroup = managedPid ? (await processGroups([pid])).get(pid) : undefined
    if (managedPid && (pid === managedPid || isManagedProcessGroup(project.id, pidGroup))) {
      return res.status(400).send('Use stop for managed process')
    }

    const assignedPortInstance = !!project.port && listening.some(
      (entry) => entry.pid === pid && entry.port === project.port
    )
    const conflict = await startupConflictInstance(project, listening)
    const startupConflict = conflict?.pid === pid
    if (!assignedPortInstance && !startupConflict) {
      return res.status(403).send('This process could not be verified as part of the selected project')
    }

    try {
      await terminateExternalProcess(pid)
    } catch (err) {
      return res.status(400).send(err instanceof Error ? err.message : 'Failed to kill process')
    }

    res.json({ ok: true, pid })
  }))

  app.post('/api/projects/scan', handle(async (req: Request, res: Response) => {
    const payload = req.body as ScanRequestPayload
    const roots = stringArray(payload?.roots)
    if (roots.length === 0) {
      return res.status(400).send('No roots provided')
    }
    const id = randomUUID()

    const projects = await scanProjects(roots, state.settings)
    const scan: ScanState = {
      id,
      status: 'done',
      projects,
      created_at: new Date().toISOString()
    }
    state.scans.set(id, scan)
    // Scan results are only polled briefly; keep the most recent few.
    for (const key of Array.from(state.scans.keys()).slice(0, -MAX_RETAINED_SCANS)) state.scans.delete(key)
    res.json(scan)
  }))

  app.get('/api/projects/scan/:id', (req: Request, res: Response) => {
    const scan = state.scans.get(req.params.id)
    if (!scan) {
      return res.status(404).send('Scan not found')
    }
    res.json(scan)
  })

  app.post('/api/projects/scan/:id/stop', (req: Request, res: Response) => {
    const scan = state.scans.get(req.params.id)
    if (!scan) {
      return res.status(404).send('Scan not found')
    }
    scan.status = 'stopped'
    state.scans.set(req.params.id, scan)
    res.json(scan)
  })

  app.post('/api/fs/pick', handle(async (_req: Request, res: Response) => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory', 'multiSelections']
      })
      if (result.canceled) {
        return res.json({ paths: [] })
      }
      res.json({ paths: result.filePaths })
    } catch (err) {
      res.status(500).send('Folder picker failed')
    }
  }))

  app.post('/api/projects/:id/open', handle(async (req: Request, res: Response) => {
    const project = state.projects.find((entry) => entry.id === req.params.id)
    if (!project) {
      return res.status(404).send('Project not found')
    }
    const target = req.body?.target
    if (target !== 'vscode' && target !== 'finder') {
      return res.status(400).send('Target must be "vscode" or "finder"')
    }
    if (target === 'vscode') {
      try {
        await openInVSCode(project.path)
      } catch (err) {
        return res.status(400).send('Unable to open VS Code')
      }
    }
    if (target === 'finder') {
      try {
        await openInFileManager(project.root_path ?? project.path)
      } catch (err) {
        return res.status(400).send('Unable to open folder')
      }
    }
    res.json({ ok: true })
  }))

  app.get('/api/ports/used', handle(async (_req: Request, res: Response) => {
    const listening = await listListeningPorts()
    const groups = await processGroups(listening.map((entry) => entry.pid))
    const ports: UsedPort[] = []
    const listeningByPort = new Map<number, { pid: number; command: string | null }>()
    listening.forEach((entry) => {
      if (!listeningByPort.has(entry.port)) {
        listeningByPort.set(entry.port, { pid: entry.pid, command: entry.command ?? null })
      }
    })

    for (const project of state.projects) {
      if (!project.port) continue
      const managedPid = getProcessPid(project.id)
      const listeningEntry = listeningByPort.get(project.port)
      const isDocker = project.kind === 'docker_compose' && project.docker_running
      const isManaged = !!managedPid
      const isExternal = !!listeningEntry && (!managedPid ||
        (listeningEntry.pid !== managedPid && !isManagedProcessGroup(project.id, groups.get(listeningEntry.pid))))
      const isActive = isDocker || isManaged || !!listeningEntry
      if (!isActive) continue

      const source = isManaged ? 'managed' : isDocker ? 'docker' : isExternal ? 'external' : 'none'
      ports.push({
        port: project.port,
        project_id: project.id,
        project_name: project.name,
        project_path: project.root_path ?? project.path,
        source,
        pid: isManaged ? managedPid : listeningEntry?.pid ?? null,
        command: isManaged ? project.command ?? null : listeningEntry?.command ?? null
      })
    }

    res.json({ ports })
  }))

  app.post('/api/ports/allocate', handle(async (req: Request, res: Response) => {
    const payload = req.body as AllocatePortsPayload
    const roles = ensureArray(payload.roles)
    const usedPorts = new Set<number>()
    const listening = await listListeningPorts()
    listening.forEach((entry) => usedPorts.add(entry.port))
    state.projects.forEach((entry) => {
      if (entry.port) usedPorts.add(entry.port)
    })

    const ports: Partial<Record<'backend' | 'frontend' | 'service', number>> = {}
    for (const role of roles) {
      if (!['backend', 'frontend', 'service'].includes(role)) continue
      if (ports[role]) continue
      const port = await pickAvailablePort({ role, used: usedPorts, preferredBase: state.settings.port_base })
      if (!port) {
        return res.status(400).send(`No ports available for ${role}`)
      }
      ports[role] = port
      usedPorts.add(port)
    }

    res.json({ ports })
  }))

  app.get('/api/settings', (_req: Request, res: Response) => {
    res.json(state.settings)
  })

  app.patch('/api/settings', handle(async (req: Request, res: Response) => {
    state.settings = sanitizeSettings(req.body, state.settings)
    await persistSettings(state)
    res.json(state.settings)
  }))

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError
      ? err.status
      : typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 500
    const message = err instanceof Error ? err.message : 'Unexpected error'
    if (status >= 500) console.error('[multiprise] API error:', err)
    if (res.headersSent) return
    res.status(status).type('text/plain').send(status >= 500 ? `Internal error: ${message}` : message)
  })

  return app
}
