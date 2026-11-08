import { type Express, type Request, type Response } from 'express'
import { connectAgents, disconnectAgents, agentStatus } from '../../system/agents'
import { stopService } from '../../services/launch'
import { listRunningServers, stopContainer, stopRunningProcess } from '../../system/running'
import { machineUsage, usageReport } from '../../system/usage'
import { type UsageReport } from '../../types'
import { handle } from '../http'
import { type ApiContext } from './context'

const USAGE_REPORT_CACHE_MS = 1500

export function registerRunningRoutes(app: Express, { state, launches, recentListeningPorts }: ApiContext) {
  const list = async () => listRunningServers(await recentListeningPorts(), state.projects)

  // Every open window asks on a timer; they share one reading.
  let usageCache: { at: number; report: Promise<UsageReport> } | null = null
  const recentUsageReport = async () => {
    if (!usageCache || Date.now() - usageCache.at > USAGE_REPORT_CACHE_MS) {
      usageCache = { at: Date.now(), report: recentListeningPorts().then((listening) => usageReport(listening, state.projects)) }
    }
    return usageCache.report
  }

  // Cheap enough to leave running in the sidebar.
  app.get('/api/usage/machine', handle(async (_req: Request, res: Response) => {
    res.json(await machineUsage())
  }))

  app.get('/api/usage', handle(async (_req: Request, res: Response) => {
    res.json(await recentUsageReport())
  }))

  app.get('/api/running', handle(async (_req: Request, res: Response) => {
    res.json({ servers: await list() })
  }))

  // Named by key rather than by PID: the key holds the start time too, so a PID that has
  // since been reused by something else is never signalled.
  app.post('/api/running/stop', handle(async (req: Request, res: Response) => {
    const server = (await list()).find((entry) => entry.key === req.body?.key)
    if (!server) return res.status(404).send('That server is no longer running')
    const owner = server.managed ? state.projects.find((project) => project.id === server.service_id) : null
    try {
      if (owner) await stopService(state, launches, owner)
      else if (server.kind === 'docker') await stopContainer(server.key.slice('docker:'.length))
      else await stopRunningProcess(server.pid!)
    } catch (err) {
      return res.status(400).send(err instanceof Error ? err.message : 'Failed to stop it')
    }
    res.json({ ok: true, server })
  }))

  app.get('/api/agents', handle(async (_req: Request, res: Response) => {
    res.json(await agentStatus())
  }))

  app.post('/api/agents/connect', handle(async (_req: Request, res: Response) => {
    res.json(await connectAgents())
  }))

  app.post('/api/agents/disconnect', handle(async (_req: Request, res: Response) => {
    res.json(await disconnectAgents())
  }))
}
