import { type Express, type Request, type Response } from 'express'
import path from 'node:path'
import {
  type ProcessInstance,
  type ProcessKillPayload,
  type Project,
  type StartProjectPayload
} from '../types'
import { listListeningPorts, processGroups } from '../ports'
import { getLogs, getProcessPid, isManagedProcessGroup } from '../processes'
import { detectStartupConflict } from '../failures'
import { processExists, processWorkingDirectory, terminateExternalProcess } from '../commands'
import { launchWithDependencies, stopService } from '../launch'
import { runPreparationStep } from '../preparation'
import { handle, isSameOrInside } from '../http'
import { type ApiContext } from './context'

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

export function registerServiceRoutes(app: Express, { state, launches }: ApiContext) {
  app.post('/api/projects/:id/start', handle(async (req: Request, res: Response) => {
    const project = state.projects.find((entry) => entry.id === req.params.id)
    if (!project) {
      return res.status(404).send('Project not found')
    }
    const payload = (req.body && typeof req.body === 'object' ? req.body : {}) as StartProjectPayload
    res.json(await launchWithDependencies(state, launches, project, payload))
  }))

  // Fixes offered for a failed start: install dependencies or build, then the app retries.
  app.post('/api/projects/:id/prepare', handle(async (req: Request, res: Response) => {
    const project = state.projects.find((entry) => entry.id === req.params.id)
    if (!project) {
      return res.status(404).send('Project not found')
    }
    const step = req.body?.step
    if (step !== 'install' && step !== 'build') {
      return res.status(400).send('step must be "install" or "build"')
    }
    if (project.kind === 'docker_compose' || getProcessPid(project.id) || launches.has(project.id)) {
      return res.status(409).send('Stop the service first')
    }
    try {
      await runPreparationStep(project, step)
    } catch (err) {
      return res.status(400).send(err instanceof Error ? err.message : 'Preparation failed')
    }
    res.json({ ok: true })
  }))

  app.post('/api/projects/:id/stop', handle(async (req: Request, res: Response) => {
    const project = state.projects.find((entry) => entry.id === req.params.id)
    if (!project) {
      return res.status(404).send('Project not found')
    }
    res.json(await stopService(state, launches, project))
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
}
