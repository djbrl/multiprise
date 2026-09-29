import { execFile } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { API_TOKEN_HEADER, packagedDataDir, readDiscoveryFile, type DiscoveryInfo } from '../discovery'
import type { AppEvent } from '../events'
import { dataDir } from '../store'

const APP_BUNDLE_ID = 'com.djbrl.multiprise'
const LAUNCH_TIMEOUT_MS = 30000

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export class NotRunningError extends Error {}

export type ConnectOptions = {
  // Open the installed app when no running instance is found.
  launch?: boolean
  // Progress messages; never written to stdout, which the MCP server owns.
  onStatus?: (message: string) => void
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// The packaged app first, then a development checkout's data folder.
function candidateDataDirs() {
  if (process.env.MULTIPRISE_DATA_DIR) return [path.resolve(process.env.MULTIPRISE_DATA_DIR)]
  return [...new Set([packagedDataDir(), dataDir()])]
}

export class MultipriseClient {
  constructor(private info: Pick<DiscoveryInfo, 'url' | 'token'>) {}

  get url() {
    return this.info.url
  }

  request<T>(method: string, route: string, body?: unknown, timeoutMs?: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body)
      const headers: Record<string, string | number> = { [API_TOKEN_HEADER]: this.info.token }
      if (data !== undefined) {
        headers['content-type'] = 'application/json'
        headers['content-length'] = Buffer.byteLength(data)
      }
      const req = http.request(new URL(route, this.info.url), { method, headers }, (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => {
          const status = res.statusCode ?? 500
          if (status >= 400) return reject(new ApiError(status, text || `HTTP ${status}`))
          try {
            resolve((text ? JSON.parse(text) : null) as T)
          } catch (err) {
            reject(new Error(`Unexpected response from ${route}`))
          }
        })
      })
      req.on('error', reject)
      if (timeoutMs) {
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request to ${route} timed out`)))
      }
      if (data !== undefined) req.write(data)
      req.end()
    })
  }

  // Resolves once the stream is open; the returned function closes it.
  events(onEvent: (event: AppEvent) => void, onClose?: () => void): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const req = http.get(new URL('/api/events', this.info.url), { headers: { [API_TOKEN_HEADER]: this.info.token } }, (res) => {
        if ((res.statusCode ?? 500) >= 400) {
          res.resume()
          return reject(new ApiError(res.statusCode ?? 500, 'Could not open the event stream'))
        }
        let buffer = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          buffer += chunk
          let boundary = buffer.indexOf('\n\n')
          while (boundary !== -1) {
            const message = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            for (const line of message.split('\n')) {
              if (!line.startsWith('data: ')) continue
              try {
                onEvent(JSON.parse(line.slice(6)) as AppEvent)
              } catch (err) {
                // Ignore a malformed event rather than dropping the stream.
              }
            }
            boundary = buffer.indexOf('\n\n')
          }
        })
        res.on('close', () => onClose?.())
        resolve(() => req.destroy())
      })
      req.on('error', reject)
    })
  }
}

async function reachable(info: DiscoveryInfo) {
  if (!isAlive(info.pid)) return false
  try {
    await new MultipriseClient(info).request('GET', '/api/health', undefined, 2000)
    return true
  } catch (err) {
    return false
  }
}

async function findRunningApp(): Promise<DiscoveryInfo | null> {
  for (const dir of candidateDataDirs()) {
    const info = await readDiscoveryFile(dir)
    if (info && await reachable(info)) return info
  }
  return null
}

function openInstalledApp() {
  return new Promise<boolean>((resolve) => {
    if (process.platform !== 'darwin') return resolve(false)
    execFile('open', ['-g', '-b', APP_BUNDLE_ID], (err) => resolve(!err))
  })
}

export async function connect(options: ConnectOptions = {}): Promise<MultipriseClient> {
  if (process.env.MULTIPRISE_API_URL && process.env.MULTIPRISE_API_TOKEN) {
    return new MultipriseClient({ url: process.env.MULTIPRISE_API_URL, token: process.env.MULTIPRISE_API_TOKEN })
  }
  const running = await findRunningApp()
  if (running) return new MultipriseClient(running)

  if (options.launch && !process.env.MULTIPRISE_DATA_DIR && await openInstalledApp()) {
    options.onStatus?.('Opening Multiprise…')
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300))
      const info = await findRunningApp()
      if (info) return new MultipriseClient(info)
    }
    throw new NotRunningError('Multiprise was opened but did not become ready in time. Try again in a moment.')
  }
  throw new NotRunningError('Multiprise is not running. Open the app and try again.')
}
