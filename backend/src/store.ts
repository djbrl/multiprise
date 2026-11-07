import fs from 'node:fs/promises'
import path from 'node:path'
import { type Project, type Settings } from './types'

const rootDir = path.resolve(__dirname, '..', '..')
// Read on every use: Electron sets MULTIPRISE_DATA_DIR before the backend starts, and
// nothing should depend on which module happened to import the store first.
export const dataDir = () => process.env.MULTIPRISE_DATA_DIR
  ? path.resolve(process.env.MULTIPRISE_DATA_DIR)
  : path.join(rootDir, 'backend', 'data')
const projectsFile = () => path.join(dataDir(), 'projects.json')
const settingsFile = () => path.join(dataDir(), 'settings.json')

const defaultSettings: Settings = {
  auto_port: true,
  auto_install: true,
  notifications: true,
  auto_restart: true,
  hostnames: true,
  proxy_port: 7331,
  onboarded: false,
  port_base: 3000,
  startup_timeout_ms: 20000,
  scan_depth: 8,
  scan_ignore: [],
  theme: 'system'
}

async function ensureDataDir() {
  await fs.mkdir(dataDir(), { recursive: true })
}

async function readJson<T>(file: string): Promise<T | null> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch (err) {
    return null
  }
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    // Keep the unreadable file so a later save cannot silently erase the user's data.
    const backup = `${file}.corrupt-${Date.now()}`
    await fs.rename(file, backup).catch(() => {})
    console.error(`[multiprise] ${path.basename(file)} could not be parsed; moved it to ${backup}`)
    return null
  }
}

const writeQueues = new Map<string, Promise<void>>()

// Writes to the same file are serialized and land atomically via rename, so
// overlapping saves can never interleave into a truncated or mixed file.
function writeJson<T>(file: string, data: T): Promise<void> {
  const contents = JSON.stringify(data, null, 2)
  const previous = writeQueues.get(file) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(async () => {
    await ensureDataDir()
    const temporary = `${file}.${process.pid}.tmp`
    await fs.writeFile(temporary, contents)
    await fs.rename(temporary, file)
  })
  writeQueues.set(file, next)
  next.finally(() => {
    if (writeQueues.get(file) === next) writeQueues.delete(file)
  }).catch(() => {})
  return next
}

export async function loadProjects(): Promise<Project[]> {
  const data = await readJson<Project[]>(projectsFile())
  if (!data || !Array.isArray(data)) return []
  return data
}

export async function saveProjects(projects: Project[]): Promise<void> {
  await writeJson(projectsFile(), projects)
}

const clampInteger = (value: unknown, min: number, max: number, fallback: number) => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback
}

// Only known keys with well-typed values ever reach the settings file.
export function sanitizeSettings(input: unknown, base: Settings = defaultSettings): Settings {
  const data = (input && typeof input === 'object' ? input : {}) as Partial<Record<keyof Settings, unknown>>
  return {
    auto_port: typeof data.auto_port === 'boolean' ? data.auto_port : base.auto_port,
    auto_install: typeof data.auto_install === 'boolean' ? data.auto_install : base.auto_install,
    notifications: typeof data.notifications === 'boolean' ? data.notifications : base.notifications,
    auto_restart: typeof data.auto_restart === 'boolean' ? data.auto_restart : base.auto_restart,
    hostnames: typeof data.hostnames === 'boolean' ? data.hostnames : base.hostnames,
    proxy_port: clampInteger(data.proxy_port, 1024, 65535, base.proxy_port),
    onboarded: typeof data.onboarded === 'boolean' ? data.onboarded : base.onboarded,
    port_base: clampInteger(data.port_base, 1024, 64535, base.port_base),
    startup_timeout_ms: clampInteger(data.startup_timeout_ms, 10000, 30000, base.startup_timeout_ms),
    scan_depth: clampInteger(data.scan_depth, 1, 64, base.scan_depth),
    scan_ignore: Array.isArray(data.scan_ignore)
      ? data.scan_ignore.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      : base.scan_ignore,
    theme: data.theme === 'system' || data.theme === 'light' || data.theme === 'dark' || data.theme === 'socket' ? data.theme : base.theme
  }
}

export async function loadSettings(): Promise<Settings> {
  const data = await readJson<Settings>(settingsFile())
  return sanitizeSettings(data)
}

export async function saveSettings(settings: Settings): Promise<void> {
  await writeJson(settingsFile(), settings)
}
