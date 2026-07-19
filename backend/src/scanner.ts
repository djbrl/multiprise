import fs from 'node:fs/promises'
import path from 'node:path'
import { type DetectResponse, type DiscoveredService, type ScanResult, type Settings } from './types'

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
const BACKEND_NAMES = new Set(['api', 'backend', 'server'])
const FRONTEND_NAMES = new Set(['app', 'client', 'frontend', 'ui', 'web'])

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

async function pickPackageManager(dir: string, rootBoundary: string): Promise<'bun' | 'pnpm' | 'yarn' | 'npm'> {
  let current = path.resolve(dir)
  const boundary = path.resolve(rootBoundary)

  while (true) {
    const files = await fs.readdir(current).catch(() => [] as string[])
    if (files.some((file) => BUN_LOCK_FILES.includes(file))) return 'bun'
    if (files.includes('pnpm-lock.yaml')) return 'pnpm'
    if (files.includes('yarn.lock')) return 'yarn'
    if (files.includes('package-lock.json') || current === boundary) return 'npm'

    const parent = path.dirname(current)
    if (parent === current || !current.startsWith(`${boundary}${path.sep}`)) return 'npm'
    current = parent
  }
}

function pickScript(scripts: Record<string, string>): string | null {
  const preferred = ['dev', 'start', 'start:dev', 'serve', 'develop', 'watch', 'preview']
  for (const key of preferred) {
    if (scripts[key]) return key
  }
  return null
}

function commandForScript(pm: string, script: string) {
  if (pm === 'npm') return script === 'start' ? 'npm start' : `npm run ${script}`
  if (pm === 'bun') return `bun run ${script}`
  if (pm === 'pnpm') return `pnpm ${script}`
  return `yarn ${script}`
}

function inferRole(dir: string, scripts: Record<string, string>): 'backend' | 'frontend' | 'service' {
  const folderName = path.basename(dir).toLowerCase()
  if (FRONTEND_NAMES.has(folderName)) return 'frontend'
  if (BACKEND_NAMES.has(folderName)) return 'backend'

  const commands = Object.values(scripts).join(' ').toLowerCase()
  if (/\b(vite|next|nuxt|react-scripts|vue-cli-service|astro)\b/.test(commands)) return 'frontend'
  if (/\b(nest|nodemon|tsx|ts-node|express|fastify)\b/.test(commands)) return 'backend'
  return 'service'
}

export async function detectProject(dir: string, rootBoundary = dir): Promise<DetectResponse> {
  const files: string[] = await fs.readdir(dir).catch(() => [])
  const hasDocker = DOCKER_FILES.some((file) => files.includes(file))
  const packageJsonPath = path.join(dir, 'package.json')
  const cargoTomlPath = path.join(dir, 'Cargo.toml')

  const packageJson = (await readJson<{ scripts?: Record<string, string> }>(packageJsonPath)) ?? null
  const scripts = packageJson?.scripts ?? {}

  let suggested_command: string | null = null
  let package_manager: string | null = null

  if (Object.keys(scripts).length > 0) {
    const pm = await pickPackageManager(dir, rootBoundary)
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

  async function walk(dir: string, depth: number, rootBoundary: string) {
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
      const detection = await detectProject(dir, rootBoundary)
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
      await walk(path.join(dir, entry.name), depth + 1, rootBoundary)
    }
  }

  for (const root of roots) {
    await walk(root, 0, root)
  }

  return results
}

export async function discoverProjectServices(rootDir: string, settings: Settings): Promise<DiscoveredService[]> {
  const normalizedRoot = path.resolve(rootDir)
  const results = await scanProjects([normalizedRoot], settings)
  const nestedRunnable = results.some((result) =>
    path.resolve(result.path) !== normalizedRoot &&
    !!result.suggested_command &&
    !/^docker(?:-|\s)/.test(result.suggested_command)
  )
  const services: DiscoveredService[] = []

  for (const result of results) {
    const servicePath = path.resolve(result.path)
    const cwd = path.relative(normalizedRoot, servicePath) || '.'
    const command = result.suggested_command ?? null
    const dockerOnly = !!command && /^docker(?:-|\s)/.test(command)

    if (command && !dockerOnly && !(servicePath === normalizedRoot && nestedRunnable)) {
      services.push({
        name: cwd === '.' ? path.basename(normalizedRoot) : path.basename(servicePath),
        path: servicePath,
        cwd,
        command,
        role: inferRole(servicePath, result.scripts),
        kind: 'command',
        source: command === 'cargo run' ? 'Cargo.toml' : 'package.json',
        package_manager: result.package_manager ?? null,
        scripts: result.scripts
      })
    }

    if (result.has_docker_compose) {
      services.push({
        name: cwd === '.' ? 'docker' : `${path.basename(servicePath)} docker`,
        path: servicePath,
        cwd,
        command: 'docker compose up -d --build',
        role: 'service',
        kind: 'docker_compose',
        source: 'compose',
        package_manager: null,
        scripts: {}
      })
    }
  }

  return services
}
