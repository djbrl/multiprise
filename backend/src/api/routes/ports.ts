import { type Express, type Request, type Response } from 'express'
import { type AllocatePortsPayload, type Project, type UsedPort } from '../../types'
import { listListeningPorts, pickAvailablePort, processGroups } from '../../network/ports'
import { getProcessPid, isManagedProcessGroup } from '../../services/processes'
import { projectRoleFallback } from '../../projects/roles'
import { previousPortIfFree } from '../../services/launch'
import { handle, stringArray } from '../http'
import { type ApiContext } from './context'

export function registerPortRoutes(app: Express, { state, recentListeningPorts }: ApiContext) {
  app.get('/api/ports/used', handle(async (_req: Request, res: Response) => {
    const listening = await recentListeningPorts()
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
    const payload = (req.body && typeof req.body === 'object' ? req.body : {}) as AllocatePortsPayload
    const services = stringArray(payload.services)
      .map((id) => state.projects.find((project) => project.id === id))
      .filter((project): project is Project => !!project && project.kind !== 'docker_compose')
    const usedPorts = new Set<number>()
    const listening = await listListeningPorts()
    listening.forEach((entry) => usedPorts.add(entry.port))
    state.projects.forEach((entry) => {
      if (entry.port) usedPorts.add(entry.port)
    })

    const ports: Record<string, number> = {}
    for (const project of services) {
      const port = await previousPortIfFree(project, state, listening) ??
        await pickAvailablePort({ role: projectRoleFallback(project), used: usedPorts, preferredBase: state.settings.port_base })
      if (!port) {
        return res.status(400).send(`No ports available for ${project.name}`)
      }
      ports[project.id] = port
      usedPorts.add(port)
    }

    res.json({ ports })
  }))
}
