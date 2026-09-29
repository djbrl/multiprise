import { type Express, type Request, type Response } from 'express'
import { dialog } from 'electron'
import { subscribe } from '../events'
import { persistSettings } from '../state'
import { sanitizeSettings } from '../store'
import { checkVSCodeAvailability } from '../commands'
import { handle } from '../http'
import { hostUrls } from '../hostnames'
import { type ApiContext } from './context'

export function registerSystemRoutes(app: Express, { state, hostnames }: ApiContext) {
  app.get('/api/hostnames', (_req: Request, res: Response) => {
    res.json({
      enabled: state.settings.hostnames,
      port: hostnames.port,
      error: hostnames.error,
      urls: hostnames.port ? hostUrls(state.projects, hostnames.port) : {}
    })
  })

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, time: new Date().toISOString() })
  })

  // Server-sent events: status changes, log lines and project edits are pushed
  // as they happen instead of the renderer polling for them.
  app.get('/api/events', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    res.write(': connected\n\n')
    const unsubscribe = subscribe((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    })
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000)
    req.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })

  app.get('/api/system/vscode/test', handle(async (_req: Request, res: Response) => {
    const report = await checkVSCodeAvailability()
    res.json(report)
  }))

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

  app.get('/api/settings', (_req: Request, res: Response) => {
    res.json(state.settings)
  })

  app.patch('/api/settings', handle(async (req: Request, res: Response) => {
    state.settings = sanitizeSettings(req.body, state.settings)
    await persistSettings(state)
    res.json(state.settings)
  }))
}
