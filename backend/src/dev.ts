import { startServer, stopServer } from './index'

const parsePort = (value?: string | null): number | undefined => {
  if (!value) return undefined
  const port = Number.parseInt(value, 10)
  if (!Number.isFinite(port) || port < 1 || port > 65535) return undefined
  return port
}

const explicitPortValue = process.env.BACKEND_PORT ?? process.env.PORT ?? process.env.API_PORT
const preferredPort = parsePort(explicitPortValue) ?? 3000

const main = async () => {
  const backend = await startServer({
    port: preferredPort,
    strictPort: Boolean(explicitPortValue)
  })

  console.log(`Multiprise backend listening on ${backend.url}`)

  const shutdown = async () => {
    await stopServer(backend)
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
