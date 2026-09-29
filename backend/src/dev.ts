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
    strictPort: Boolean(explicitPortValue),
    token: process.env.MULTIPRISE_API_TOKEN,
    advertise: true
  })

  console.log(`Multiprise backend listening on ${backend.url}`)
  console.log(`API token (send as the x-multiprise-token header): ${backend.token}`)

  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    await stopServer(backend).catch((err) => console.error(err))
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
