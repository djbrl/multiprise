import fs from 'node:fs/promises'
import path from 'node:path'
import { type Project, type Settings } from './types'

const rootDir = path.resolve(__dirname, '..', '..')
const dataDir = process.env.MULTIPRISE_DATA_DIR
  ? path.resolve(process.env.MULTIPRISE_DATA_DIR)
  : path.join(rootDir, 'backend', 'data')
const projectsFile = path.join(dataDir, 'projects.json')
const settingsFile = path.join(dataDir, 'settings.json')

const defaultSettings: Settings = {
  auto_port: true,
  auto_install: true,
  port_base: 3000,
  startup_timeout_ms: 20000,
  scan_depth: 8,
  scan_ignore: [],
  theme: 'dark'
}

async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true })
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, 'utf-8')
    return JSON.parse(raw) as T
  } catch (err) {
    return null
  }
}

async function writeJson<T>(file: string, data: T) {
  await ensureDataDir()
  await fs.writeFile(file, JSON.stringify(data, null, 2))
}

export async function loadProjects(): Promise<Project[]> {
  const data = await readJson<Project[]>(projectsFile)
  if (!data || !Array.isArray(data)) return []
  return data
}

export async function saveProjects(projects: Project[]): Promise<void> {
  await writeJson(projectsFile, projects)
}

export async function loadSettings(): Promise<Settings> {
  const data = await readJson<Settings>(settingsFile)
  if (!data) return { ...defaultSettings }
  return {
    ...defaultSettings,
    ...data,
    scan_ignore: Array.isArray(data.scan_ignore) ? data.scan_ignore : [],
    startup_timeout_ms: Math.min(30000, Math.max(10000, Number(data.startup_timeout_ms) || defaultSettings.startup_timeout_ms))
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await writeJson(settingsFile, settings)
}
