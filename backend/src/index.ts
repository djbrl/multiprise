import http from 'node:http'
import { createApp } from './server'
import { createState, normalizeProjects, type AppState } from './state'

export type BackendInstance = {
  server: http.Server
  port: number | null
  url: string | null
  state: AppState
}

type StartServerOptions = {
  port?: number
  strictPort?: boolean
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
  const app = await createApp(state)
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

  return {
    server,
    port,
    url,
    state
  }
}

export const stopServer = async (backend?: BackendInstance | null): Promise<void> => {
  if (!backend?.server) return
  await new Promise<void>((resolve) => backend.server.close(() => resolve()))
}
