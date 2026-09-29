import { type Express, type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { persistProjects } from '../state'
import {
  type CreateProjectPayload,
  type DetectResponse,
  type Project,
  type ProjectInspectResult,
  type UpdateProjectPayload
} from '../types'
import { detectProject, discoverProjectServices } from '../scanner'
import { forgetLogs, stopProcess } from '../processes'
import { deleteLogFiles } from '../logfiles'
import { openInFileManager, openInVSCode } from '../commands'
import { findProjectIcon, resolveProjectIcon } from '../icons'
import { buildProjectView, cancelLaunch } from '../launch'
import { cleanPath, handle, isSameOrInside, isValidPort, stringArray } from '../http'
import { type ApiContext } from './context'

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

export function registerProjectRoutes(app: Express, { state, launches, recentListeningPorts }: ApiContext) {
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

    cancelLaunch(launches, id)
    await stopProcess(id)
    state.projects = state.projects.filter((entry) => entry.id !== id)
    await persistProjects(state)
    forgetLogs(id)
    deleteLogFiles(id)
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
}
