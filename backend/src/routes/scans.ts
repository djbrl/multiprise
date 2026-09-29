import { type Express, type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import { type ScanRequestPayload, type ScanState } from '../types'
import { scanProjects } from '../scanner'
import { handle, stringArray } from '../http'
import { type ApiContext } from './context'

const MAX_RETAINED_SCANS = 10

export function registerScanRoutes(app: Express, { state }: ApiContext) {
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
}
