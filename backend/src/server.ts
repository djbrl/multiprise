import express, { type NextFunction, type Request, type Response } from 'express'
import { type AppState } from './state'
import { listListeningPorts } from './ports'
import { API_TOKEN_HEADER } from './discovery'
import { apiGuard, type ApiSecurityOptions } from './guard'
import { HttpError } from './http'
import { type Launches } from './launch'
import { type ApiContext } from './routes/context'
import { type HostnameController } from './hostnames'
import { registerSystemRoutes } from './routes/system'
import { registerProjectRoutes } from './routes/projects'
import { registerServiceRoutes } from './routes/services'
import { registerScanRoutes } from './routes/scans'
import { registerPortRoutes } from './routes/ports'
import { registerRunningRoutes } from './routes/running'

export { API_TOKEN_HEADER, type ApiSecurityOptions }

export type AppOptions = {
  // Shared with the supervisor, so its restarts and API launches never overlap.
  launches?: Launches
  hostnames?: HostnameController
}

export async function createApp(state: AppState, security: ApiSecurityOptions = {}, options: AppOptions = {}) {
  const app = express()

  // Every open window refreshes the ports list; they share one lsof run per second.
  let listeningCache: { at: number; ports: Promise<Awaited<ReturnType<typeof listListeningPorts>>> } | null = null
  const recentListeningPorts = () => {
    if (!listeningCache || Date.now() - listeningCache.at > 1000) {
      listeningCache = { at: Date.now(), ports: listListeningPorts() }
    }
    return listeningCache.ports
  }

  const context: ApiContext = {
    state,
    launches: options.launches ?? new Map(),
    recentListeningPorts,
    hostnames: options.hostnames
  }

  app.use(apiGuard(security))
  app.use(express.json({ limit: '2mb' }))

  registerSystemRoutes(app, context)
  registerProjectRoutes(app, context)
  registerServiceRoutes(app, context)
  registerScanRoutes(app, context)
  registerPortRoutes(app, context)
  registerRunningRoutes(app, context)

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
