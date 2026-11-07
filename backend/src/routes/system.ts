import { type Express, type Request, type Response } from 'express'
import { dialog } from 'electron'
import { subscribe, type AppEvent } from '../events'
import { knownSecrets } from '../environment'
import { redactText } from '../redact'
import { type AppState } from '../state'
import { persistSettings } from '../state'
import { sanitizeSettings } from '../store'
import { checkVSCodeAvailability } from '../commands'
import { handle } from '../http'
import { hostUrls } from '../hostnames'
import { type ApiContext } from './context'

async function redactEvent(state: AppState, event: AppEvent): Promise<AppEvent> {
  if (event.type !== 'log' && event.type !== 'status') return event
  const project = state.projects.find((entry) => entry.id === event.id)
  const values = project ? await knownSecrets(project) : []
  if (event.type === 'log') return { ...event, entry: { ...event.entry, line: redactText(event.entry.line, values) } }
  return event.status.error ? { ...event, status: { ...event.status, error: redactText(event.status.error, values) } } : event
}

export function registerSystemRoutes(app: Express, { state, hostnames }: ApiContext) {
  app.get('/api/hostnames', (_req: Request, res: Response) => {
    const port = hostnames?.port ?? null
    res.json({
      enabled: state.settings.hostnames,
      port,
      error: hostnames?.error ?? null,
      urls: port ? hostUrls(state.projects, port) : {}
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
    const send = (event: AppEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`)
    // Redacting may read a secret store, so events queue up to keep their order.
    let queue = Promise.resolve()
    const unsubscribe = subscribe((event) => {
      if (!req.query.redact) return void send(event)
      queue = queue.then(async () => void send(await redactEvent(state, event))).catch(() => {})
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
    // Turning hostnames on or off, or moving the proxy, takes effect right away.
    await hostnames?.apply()
    res.json(state.settings)
  }))
}
