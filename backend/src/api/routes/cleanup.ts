import { type Express, type Request, type Response } from 'express'
import { shell } from 'electron'
import { diskMeasurement, diskReport, dockerLeftovers, forgetTrashed, removeDockerLeftovers, staleWorktrees, trashableFolders } from '../../system/cleanup'
import { idleServers, memoryTrends } from '../../system/memory'
import { listRunningServers } from '../../system/running'
import { type CleanupReport } from '../../types'
import { handle } from '../http'
import { type ApiContext } from './context'

// The Cleanup page: what keeps growing, what sits idle, and what piles up.

const REPORT_CACHE_MS = 5000

export function registerCleanupRoutes(app: Express, { state, recentListeningPorts }: ApiContext) {
  // Git and Docker are asked on every report, so open windows share one.
  let cache: { at: number; report: Promise<CleanupReport> } | null = null
  const report = async (): Promise<CleanupReport> => {
    const [worktrees, servers, docker] = await Promise.all([
      staleWorktrees(state.projects),
      recentListeningPorts().then((listening) => listRunningServers(listening, state.projects)),
      dockerLeftovers()
    ])
    return {
      memory: memoryTrends(state.projects),
      idle: idleServers(state.projects),
      worktrees,
      leftovers: servers.filter((server) => server.leftover),
      docker
    }
  }

  app.get('/api/cleanup', handle(async (req: Request, res: Response) => {
    if (req.query.fresh || !cache || Date.now() - cache.at > REPORT_CACHE_MS) {
      cache = { at: Date.now(), report: report() }
    }
    res.json(await cache.report)
  }))

  // Memory alone is cheap: it is what the background sampler already holds.
  app.get('/api/cleanup/memory', (_req: Request, res: Response) => {
    res.json({ memory: memoryTrends(state.projects) })
  })

  // Answers right away with the last measurement; ?wait=1 waits for one in progress.
  app.get('/api/cleanup/disk', handle(async (req: Request, res: Response) => {
    const first = diskReport(state.projects, { refresh: !!req.query.refresh })
    if (req.query.wait && first.measuring) {
      await diskMeasurement()
      return res.json(diskReport(state.projects))
    }
    res.json(first)
  }))

  // Folders go to the Trash, so they can be put back.
  app.post('/api/cleanup/disk/trash', handle(async (req: Request, res: Response) => {
    let chosen
    try {
      chosen = trashableFolders(state.projects, req.body?.paths)
    } catch (err) {
      return res.status(409).send(err instanceof Error ? err.message : 'It is running')
    }
    if (!chosen.length) return res.status(404).send('Those folders are no longer there to clean')
    const trashed: string[] = []
    for (const { folder } of chosen) {
      await shell.trashItem(folder.path)
      trashed.push(folder.path)
    }
    forgetTrashed(trashed)
    res.json({ trashed, freed: chosen.reduce((sum, { folder }) => sum + folder.bytes, 0) })
  }))

  app.post('/api/cleanup/docker/remove', handle(async (req: Request, res: Response) => {
    try {
      const removed = await removeDockerLeftovers(req.body ?? {})
      cache = null
      res.json(removed)
    } catch (err) {
      const message = (err as { stderr?: string })?.stderr?.trim() || (err instanceof Error ? err.message : 'Docker could not remove them')
      res.status(400).send(message)
    }
  }))
}
