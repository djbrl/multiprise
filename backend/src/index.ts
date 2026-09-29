import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { createApp } from './server'
import { stopAllProcesses } from './processes'
import { removeDiscoveryFile, writeDiscoveryFile } from './discovery'
import { dataDir } from './store'

export { subscribe } from './events'
import { createState, normalizeProjects, type AppState } from './state'

export type BackendInstance = {
  server: http.Server
  port: number | null
  url: string | null
  token: string
  state: AppState
  // The data directory whose discovery file advertises this server, if any.
  advertisedIn: string | null
}

type StartServerOptions = {
  port?: number
  strictPort?: boolean
  // Every request must carry this token; a random one is generated when omitted.
  token?: string
  // Browser origins allowed to call the API (the renderer's origin; "null" for file://).
  allowedOrigins?: string[]
  // Write the URL and token where the CLI and MCP server look for a running app.
  advertise?: boolean
}

const parsePort = (value?: string | null): number | undefined => {
  if (!value) return undefined
  const port = Number.parseInt(value, 10)
  if (!Number.isFinite(port) || port < 1 || port > 65535) return undefined
  return port
}

const envPort = () => parsePort(process.env.BACKEND_PORT ?? process.env.PORT ?? process.env.API_PORT)

const listen = (server: http.Server, port: number) =>
  new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })

const listenWithFallback = async (server: http.Server, preferredPort: number, strictPort: boolean) => {
  try {
    await listen(server, preferredPort)
    return
  } catch (err) {
    if (strictPort) throw err
  }

  for (let port = preferredPort + 1; port <= preferredPort + 100; port += 1) {
    try {
      await listen(server, port)
      return
    } catch (err) {
      // Try the next nearby port.
    }
  }

  throw new Error(`No free port found near ${preferredPort}.`)
}

export const startServer = async (options: StartServerOptions = {}): Promise<BackendInstance> => {
  const state = await createState()
  await normalizeProjects(state)
  const token = options.token || randomBytes(32).toString('hex')
  const app = await createApp(state, { token, allowedOrigins: options.allowedOrigins })
  const server = http.createServer(app)

  const requestedPort = options.port ?? envPort()
  const strictPort = options.strictPort ?? Boolean(requestedPort)
  if (requestedPort) {
    await listenWithFallback(server, requestedPort, strictPort)
  } else {
    await listen(server, 0)
  }
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : null
  const url = port ? `http://127.0.0.1:${port}` : null

  let advertisedIn: string | null = null
  if (options.advertise && url) {
    try {
      await writeDiscoveryFile(dataDir(), { url, token, pid: process.pid })
      advertisedIn = dataDir()
    } catch (err) {
      // The app works without it; only the CLI and MCP server cannot find it.
      console.error('[multiprise] failed to advertise the API:', err)
    }
  }

  return {
    server,
    port,
    url,
    token,
    state,
    advertisedIn
  }
}

export const stopServer = async (backend?: BackendInstance | null): Promise<void> => {
  // Managed services run in their own process groups, so they must be stopped explicitly.
  if (backend?.advertisedIn) {
    await removeDiscoveryFile(backend.advertisedIn).catch(() => {})
  }
  await stopAllProcesses()
  if (!backend?.server) return
  await new Promise<void>((resolve) => {
    backend.server.close(() => resolve())
    backend.server.closeAllConnections?.()
  })
}
