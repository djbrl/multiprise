import fs from 'node:fs/promises'
import path from 'node:path'
import { type DetectResponse, type ScanResult, type Settings } from './types'

const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.cache',
  '.venv',
  '.ruff_cache'
])

const DOCKER_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']
const BUN_LOCK_FILES = ['bun.lockb', 'bun.lock']

async function pathExists(target: string) {
  try {
    await fs.access(target)
    return true
  } catch (err) {
    return false
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, 'utf-8')
    return JSON.parse(raw) as T
  } catch (err) {
    return null
  }
}

function pickPackageManager(dir: string, files: string[]): 'bun' | 'pnpm' | 'yarn' | 'npm' {
  if (files.some((file) => BUN_LOCK_FILES.includes(file))) return 'bun'
  if (files.includes('pnpm-lock.yaml')) return 'pnpm'
  if (files.includes('yarn.lock')) return 'yarn'
  return 'npm'
}

function pickScript(scripts: Record<string, string>): string | null {
  const preferred = ['dev', 'start', 'serve', 'preview']
  for (const key of preferred) {
    if (scripts[key]) return key
  }
  return null
}

function commandForScript(pm: string, script: string) {
  if (pm === 'npm') return `npm run ${script}`
  if (pm === 'bun') return `bun run ${script}`
  return `${pm} ${script}`
}

export async function detectProject(dir: string): Promise<DetectResponse> {
  const files: string[] = await fs.readdir(dir).catch(() => [])
  const hasDocker = DOCKER_FILES.some((file) => files.includes(file))
  const packageJsonPath = path.join(dir, 'package.json')
  const cargoTomlPath = path.join(dir, 'Cargo.toml')

  const packageJson = (await readJson<{ scripts?: Record<string, string> }>(packageJsonPath)) ?? null
  const scripts = packageJson?.scripts ?? {}

  let suggested_command: string | null = null
  let package_manager: string | null = null

  if (Object.keys(scripts).length > 0) {
    const pm = pickPackageManager(dir, files)
    package_manager = pm
    const script = pickScript(scripts)
    if (script) {
      suggested_command = commandForScript(pm, script)
    }
  }

  if (!suggested_command && (await pathExists(cargoTomlPath))) {
    suggested_command = 'cargo run'
  }

  if (!suggested_command && hasDocker) {
    suggested_command = 'docker compose up -d --build'
  }

  return {
    scripts,
    suggested_command,
    package_manager,
    has_docker_compose: hasDocker
  }
}

export async function scanProjects(roots: string[], settings: Settings): Promise<ScanResult[]> {
  const results: ScanResult[] = []
  const visited = new Set<string>()
  const ignore = new Set([...DEFAULT_IGNORED_DIRS, ...settings.scan_ignore])

  async function walk(dir: string, depth: number) {
    if (visited.has(dir)) return
    visited.add(dir)
    if (depth > settings.scan_depth) return

    const baseName = path.basename(dir)
    if (ignore.has(baseName)) return

    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    const entryNames = entries.map((entry) => entry.name)

    const hasDocker = DOCKER_FILES.some((file) => entryNames.includes(file))
    const hasPackageJson = entryNames.includes('package.json')
    const hasCargo = entryNames.includes('Cargo.toml')

    if (hasDocker || hasPackageJson || hasCargo) {
      const detection = await detectProject(dir)
      results.push({
        path: dir,
        name: path.basename(dir),
        scripts: detection.scripts,
        suggested_command: detection.suggested_command ?? null,
        package_manager: detection.package_manager ?? null,
        has_docker_compose: detection.has_docker_compose
      })
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const next = path.join(dir, entry.name)
      await walk(next, depth + 1)
    }
  }

  for (const root of roots) {
    await walk(root, 0)
  }

  return results
}
