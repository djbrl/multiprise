import express, { type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
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
import { detectProject, discoverProjectServices, scanProjects } from './scanner'
import { listListeningPorts, pickRandomPort } from './ports'
import { clearLogs, getLogs, getProcessPid, getProcessStatus, startProcess, stopProcess } from './processes'
import { persistProjects, persistSettings } from './state'
import { assertCommandAvailable } from './runtime'

const DEFAULT_DOCKER_STOP = 'docker compose down'

const cleanPath = (value: string) => value.replace(/\\/g, '/')

const ensureArray = <T>(value: T[] | undefined | null): T[] => Array.isArray(value) ? value : []

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
      error: cliResult.ok ? null : cliResult.error ?? cliResult.stderr?.trim() ?? 'Not found',
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
        running: !!project.docker_running,
        pid: null,
        started_at: project.docker_started_at ?? null
      }
    }
  }
  return {
    project,
    status: getProcessStatus(project.id)
  }
}

function projectRoleFallback(project: Project): 'backend' | 'frontend' | 'service' {
  const normalized = project.path.toLowerCase()
  if (normalized.includes('/frontend')) return 'frontend'
  if (normalized.includes('/backend')) return 'backend'
  if (project.role) return project.role
  return 'service'
}

async function spawnCommand(command: string, cwd: string, env?: Record<string, string>) {
  const processEnv = { ...process.env, ...(env ?? {}) }
  assertCommandAvailable(command, processEnv)
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env: processEnv,
      shell: true,
      stdio: 'ignore'
    })
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Command exited with code ${code ?? 'unknown'}`))
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

async function resolveStartCommand(project: Project) {
  if (project.kind === 'docker_compose') {
    return {
      command: project.command || 'docker compose up -d --build',
      cwd: project.path
    }
  }

  const detection = await detectProject(project.path, project.root_path ?? project.path)
  const command = detection.suggested_command
  if (!command || /^docker(?:-|\s)/.test(command)) {
    throw new Error(`No runnable development script found in ${project.path}`)
  }

  return { command, cwd: project.path }
}

async function buildStartEnv(options: {
  payloadEnv?: Record<string, string>
  role: 'backend' | 'frontend' | 'service'
  port?: number
}) {
  const { payloadEnv, role, port } = options
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
  }

  return merged
}

export async function createApp(state: AppState) {
  const app = express()

  app.use(express.json({ limit: '2mb' }))
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*')
    res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
    res.header('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200)
    }
    next()
  })

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, time: new Date().toISOString() })
  })

  app.get('/api/projects', (_req: Request, res: Response) => {
    res.json({ projects: state.projects.map(buildProjectView) })
  })

  app.get('/api/projects/:id/favicon', async (req: Request, res: Response) => {
    const project = state.projects.find((entry) => entry.id === req.params.id)
    if (!project) {
      return res.status(404).send('Project not found')
    }
    const iconPath = await resolveProjectIcon(project, state)
    if (!iconPath) {
      return res.status(404).send('Icon not found')
    }
    return res.sendFile(iconPath)
  })

  app.get('/api/system/vscode/test', async (_req: Request, res: Response) => {
    const report = await checkVSCodeAvailability()
    res.json(report)
  })

  app.post('/api/projects', async (req: Request, res: Response) => {
    const payload = req.body as CreateProjectPayload
    if (!payload?.path) {
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

    const services = await discoverProjectServices(projectPath, state.settings)
    if (!services.length) {
      return res.status(400).send('No runnable package.json, Cargo.toml, or Docker Compose services found')
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
      stop_command: service.kind === 'docker_compose' ? 'docker compose down' : null,
      port: null,
      icon_path: iconPath,
      kind: service.kind,
      role: service.role,
      docker_running: false,
      docker_started_at: null,
      last_exit_code: null,
      last_exit_at: null,
      created_at: createdAt
    }))

    state.projects = [...created, ...state.projects]
    await persistProjects(state)
    return res.json({ projects: created.map(buildProjectView) })
  })

  app.post('/api/projects/inspect', async (req: Request, res: Response) => {
    const roots = Array.isArray(req.body?.roots) ? req.body.roots : []
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
          error: services.length > 0 ? null : 'No runnable services found',
          services: services.map((service) => ({
            name: service.name,
            role: service.role,
            cwd: service.cwd,
            start: service.command,
            source: service.source
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
  })

  app.patch('/api/projects/:id', async (req: Request, res: Response) => {
    const id = req.params.id
    const payload = req.body as UpdateProjectPayload
    const project = state.projects.find((entry) => entry.id === id)
    if (!project) {
      return res.status(404).send('Project not found')
    }

    if (payload.name !== undefined) {
      project.name = payload.name
    }
    if (payload.command !== undefined) {
      project.command = payload.command
    }
    if (payload.stop_command !== undefined) {
      project.stop_command = payload.stop_command
    }
    if (payload.port !== undefined) {
      project.port = payload.port
    }

    await persistProjects(state)
    return res.json(buildProjectView(project))
  })

  app.delete('/api/projects/:id', async (req: Request, res: Response) => {
    const id = req.params.id
    const project = state.projects.find((entry) => entry.id === id)
    if (!project) {
      return res.status(404).send('Project not found')
    }

    await stopProcess(id)
    state.projects = state.projects.filter((entry) => entry.id !== id)
    await persistProjects(state)
    res.json({ ok: true })
  })

  app.post('/api/projects/:id/detect', async (req: Request, res: Response) => {
    const project = state.projects.find((entry) => entry.id === req.params.id)
    if (!project) {
      return res.status(404).send('Project not found')
    }
    const data: DetectResponse = await detectProject(project.path)
    return res.json(data)
  })

  app.post('/api/projects/:id/start', async (req: Request, res: Response) => {
    const project = state.projects.find((entry) => entry.id === req.params.id)
    if (!project) {
      return res.status(404).send('Project not found')
    }
    if (project.kind !== 'docker_compose' && getProcessPid(project.id)) {
      return res.status(400).send('Project already running')
    }

    const payload = req.body as StartProjectPayload
    const role = payload.role ?? projectRoleFallback(project)
    const usedPorts = new Set<number>()
    const listening = await listListeningPorts()
    listening.forEach((entry) => usedPorts.add(entry.port))
    state.projects.forEach((entry) => {
      if (entry.port) usedPorts.add(entry.port)
    })

    let port = payload.port ?? undefined
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      return res.status(400).send('Port must be an integer between 1 and 65535')
    }
    if (port && listening.some((entry) => entry.port === port)) {
      return res.status(400).send(`Port ${port} is already in use`)
    }
    if (!port && (payload.force_auto_port || state.settings.auto_port)) {
      const pickedPort = await pickRandomPort({ role, used: usedPorts, preferredBase: state.settings.port_base })
      if (!pickedPort) {
        return res.status(400).send('No ports available in range')
      }
      port = pickedPort
    }
    if (!port && project.kind !== 'docker_compose') {
      return res.status(400).send('Choose a port before launching this service')
    }

    try {
      const { command, cwd } = await resolveStartCommand(project)
      const env = await buildStartEnv({
        payloadEnv: payload.env,
        role,
        port
      })

      project.command = command
      project.port = port ?? project.port ?? null

      if (project.kind === 'docker_compose') {
        await spawnCommand(command, cwd, env)
        project.docker_running = true
        project.docker_started_at = new Date().toISOString()
        await persistProjects(state)
        return res.json(buildProjectView(project))
      }

      clearLogs(project.id)
      startProcess({
        id: project.id,
        command,
        cwd,
        env,
        onExit: async (code) => {
          project.last_exit_code = code ?? null
          project.last_exit_at = new Date().toISOString()
          await persistProjects(state)
        }
      })

      await persistProjects(state)
      return res.json(buildProjectView(project))
    } catch (err) {
      return res.status(400).send(err instanceof Error ? err.message : 'Failed to start')
    }
  })

  app.post('/api/projects/:id/stop', async (req: Request, res: Response) => {
    const project = state.projects.find((entry) => entry.id === req.params.id)
    if (!project) {
      return res.status(404).send('Project not found')
    }

    if (project.kind === 'docker_compose') {
      const stopCommand = project.stop_command || DEFAULT_DOCKER_STOP
      try {
        await spawnCommand(stopCommand, project.path)
      } catch (err) {
        return res.status(400).send('Failed to stop docker project')
      }
      project.docker_running = false
      project.docker_started_at = null
      await persistProjects(state)
      return res.json(buildProjectView(project))
    }

    await stopProcess(project.id)
    await persistProjects(state)
    return res.json(buildProjectView(project))
  })

  app.get('/api/projects/:id/logs', (req: Request, res: Response) => {
    const project = state.projects.find((entry) => entry.id === req.params.id)
    if (!project) {
      return res.status(404).send('Project not found')
    }
    const tail = req.query.tail ? Number(req.query.tail) : undefined
    const data = getLogs(project.id, tail)
    res.json({ logs: data })
  })

  app.get('/api/projects/:id/process/instances', async (req: Request, res: Response) => {
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

    if (project.port) {
      const listening = await listListeningPorts()
      for (const entry of listening) {
        if (entry.port !== project.port) continue
        if (managedPid && entry.pid === managedPid) continue
        instances.push({
          pid: entry.pid,
          port: entry.port,
          command: entry.command ?? null,
          source: 'external',
          cwd: project.path
        })
      }
    }

    res.json({ instances })
  })

  app.post('/api/projects/:id/process/kill', async (req: Request, res: Response) => {
    const project = state.projects.find((entry) => entry.id === req.params.id)
    if (!project) {
      return res.status(404).send('Project not found')
    }

    const payload = req.body as ProcessKillPayload
    const managedPid = getProcessPid(project.id)
    if (managedPid && payload?.pid === managedPid) {
      return res.status(400).send('Use stop for managed process')
    }

    let pid = payload?.pid
    if (!pid && project.port) {
      const listening = await listListeningPorts()
      const match = listening.find((entry) => entry.port === project.port)
      pid = match?.pid
    }

    if (!pid) {
      return res.status(404).send('No process found')
    }

    try {
      process.kill(pid)
    } catch (err) {
      return res.status(400).send('Failed to kill process')
    }

    res.json({ ok: true })
  })

  app.post('/api/projects/scan', async (req: Request, res: Response) => {
    const payload = req.body as ScanRequestPayload
    const roots = ensureArray(payload?.roots)
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
    res.json(scan)
  })

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

  app.post('/api/fs/pick', async (_req: Request, res: Response) => {
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
  })

  app.post('/api/projects/:id/open', async (req: Request, res: Response) => {
    const project = state.projects.find((entry) => entry.id === req.params.id)
    if (!project) {
      return res.status(404).send('Project not found')
    }
    const target = req.body?.target
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
  })

  app.get('/api/ports/used', async (_req: Request, res: Response) => {
    const listening = await listListeningPorts()
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
      const isExternal = !!listeningEntry && (!managedPid || listeningEntry.pid !== managedPid)
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
  })

  app.post('/api/ports/allocate', async (req: Request, res: Response) => {
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
      const port = await pickRandomPort({ role, used: usedPorts, preferredBase: state.settings.port_base })
      if (!port) {
        return res.status(400).send(`No ports available for ${role}`)
      }
      ports[role] = port
      usedPorts.add(port)
    }

    res.json({ ports })
  })

  app.get('/api/settings', (_req: Request, res: Response) => {
    res.json(state.settings)
  })

  app.patch('/api/settings', async (req: Request, res: Response) => {
    const payload = req.body as Partial<Settings>
    state.settings = {
      ...state.settings,
      ...payload,
      scan_ignore: ensureArray(payload.scan_ignore ?? state.settings.scan_ignore)
    }
    await persistSettings(state)
    res.json(state.settings)
  })

  return app
}
