import fs from 'node:fs/promises'
import path from 'node:path'
import { exec } from 'node:child_process'
import { createServer } from 'node:net'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

type PortRange = { start: number; end: number }

type PortRangeGroup = {
  ranges: PortRange[]
  common_defaults?: number[]
}

type PortRangeConfig = {
  frontend: PortRangeGroup
  backend: PortRangeGroup
  service?: PortRangeGroup
}

type ListeningPort = {
  pid: number
  port: number
  command?: string
}

const rootDir = path.resolve(__dirname, '..', '..')
const portConfigPath = path.join(rootDir, 'port-ranges.json')

let cachedConfig: PortRangeConfig | null = null

const fallbackConfig: PortRangeConfig = {
  frontend: { ranges: [{ start: 3000, end: 3999 }] },
  backend: { ranges: [{ start: 5000, end: 5999 }] }
}

export async function loadPortConfig(): Promise<PortRangeConfig> {
  if (cachedConfig) return cachedConfig
  try {
    const raw = await fs.readFile(portConfigPath, 'utf-8')
    const parsed = JSON.parse(raw) as PortRangeConfig
    if (!parsed?.frontend?.ranges || !parsed?.backend?.ranges) {
      cachedConfig = fallbackConfig
      return cachedConfig
    }
    cachedConfig = parsed
    return cachedConfig
  } catch (err) {
    cachedConfig = fallbackConfig
    return cachedConfig
  }
}

function rangesForRole(config: PortRangeConfig, role: 'backend' | 'frontend' | 'service', preferredBase?: number) {
  if (role === 'frontend') return config.frontend.ranges
  if (role === 'service' && config.service?.ranges?.length) return config.service.ranges
  if (role === 'service' && preferredBase) {
    return [{ start: preferredBase, end: Math.min(preferredBase + 999, 65535) }]
  }
  return config.backend.ranges
}

export async function pickRandomPort(options: {
  role: 'backend' | 'frontend' | 'service'
  used: Set<number>
  preferredBase?: number
}): Promise<number | null> {
  const config = await loadPortConfig()
  const ranges = rangesForRole(config, options.role, options.preferredBase)
  const used = options.used

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const range = ranges[Math.floor(Math.random() * ranges.length)]
    const candidate = range.start + Math.floor(Math.random() * (range.end - range.start + 1))
    if (!used.has(candidate)) return candidate
  }

  for (const range of ranges) {
    for (let port = range.start; port <= range.end; port += 1) {
      if (!used.has(port)) return port
    }
  }

  return null
}

export async function listListeningPorts(): Promise<ListeningPort[]> {
  try {
    const { stdout } = await execAsync('lsof -nP -iTCP -sTCP:LISTEN')
    const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    if (lines.length <= 1) return []

    return lines.slice(1).map<ListeningPort | null>((line) => {
      const parts = line.split(/\s+/)
      const command = parts[0]
      const pid = Number(parts[1])
      const match = line.match(/:(\d+)\s*\(LISTEN\)/)
      const port = match ? Number(match[1]) : NaN
      if (!Number.isFinite(pid) || !Number.isFinite(port)) {
        return null
      }
      return { pid, port, command }
    }).filter((item): item is ListeningPort => item !== null)
  } catch (err) {
    return []
  }
}

// Maps each PID to its process group id (macOS/Linux).
export async function processGroups(pids: number[]): Promise<Map<number, number>> {
  const groups = new Map<number, number>()
  const unique = Array.from(new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0)))
  if (!unique.length || process.platform === 'win32') return groups
  const stdout = await execAsync(`ps -o pid=,pgid= -p ${unique.join(',')}`)
    .then((result) => result.stdout)
    // ps exits non-zero when some PIDs are gone but still prints the rest.
    .catch((err: { stdout?: string }) => err.stdout ?? '')
  for (const line of stdout.split('\n')) {
    const [pid, pgid] = line.trim().split(/\s+/).map(Number)
    if (Number.isInteger(pid) && Number.isInteger(pgid)) groups.set(pid, pgid)
  }
  return groups
}

function canBind(port: number, host: string) {
  return new Promise<boolean>((resolve) => {
    const server = createServer()
    server.once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT'))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, host)
  })
}

export async function isPortAvailable(port: number) {
  return await canBind(port, '127.0.0.1') && await canBind(port, '::1')
}

// lsof cannot see listeners owned by other users (e.g. root daemons), so confirm
// a candidate really is free by binding it before handing it to a service.
export async function pickAvailablePort(options: Parameters<typeof pickRandomPort>[0]): Promise<number | null> {
  const used = new Set(options.used)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await pickRandomPort({ ...options, used })
    if (!port) return null
    if (await isPortAvailable(port)) return port
    used.add(port)
    options.used.add(port)
  }
  return null
}
