import fs from 'node:fs/promises'
import path from 'node:path'
import { type DetectResponse, type DiscoveredService, type Framework, type ScanResult, type Settings } from './types'

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
  '.vercel',
  'coverage',
  '.cache',
  '.venv',
  '.ruff_cache'
])

const DOCKER_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']
const BUN_LOCK_FILES = ['bun.lockb', 'bun.lock']
const BACKEND_NAMES = new Set(['api', 'backend', 'server'])
const FRONTEND_NAMES = new Set(['app', 'client', 'frontend', 'ui', 'web'])
const SCRIPT_SCORES: Record<string, number> = {
  dev: 100,
  'start:dev': 98,
  develop: 88,
  watch: 84,
  serve: 80,
  start: 52,
  preview: 10
}
const PRODUCTION_SIGNALS = [
  /\bnode\s+(?:\.\/)?(?:dist|build|out)\//i,
  /\bnext\s+start\b/i,
  /\bNODE_ENV\s*=\s*production\b/i,
  /\b(?:vite|nuxt)\s+preview\b/i
]

export type PackageJsonMetadata = {
  name?: string
  packageManager?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

type PackageManagerInfo = {
  name: 'bun' | 'pnpm' | 'yarn' | 'npm'
  root: string
}

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

function directoriesToBoundary(dir: string, rootBoundary: string) {
  const directories: string[] = []
  let current = path.resolve(dir)
  const boundary = path.resolve(rootBoundary)
  while (true) {
    directories.push(current)
    if (current === boundary) break
    const parent = path.dirname(current)
    if (parent === current || !current.startsWith(`${boundary}${path.sep}`)) break
    current = parent
  }
  return directories
}

function packageManagerName(value?: string): PackageManagerInfo['name'] | null {
  const name = value?.split('@')[0]?.trim().toLowerCase()
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') return name
  return null
}

async function pickPackageManager(dir: string, rootBoundary: string): Promise<PackageManagerInfo> {
  const directories = directoriesToBoundary(dir, rootBoundary)

  for (const current of directories) {
    const packageJson = await readJson<PackageJsonMetadata>(path.join(current, 'package.json'))
    const declared = packageManagerName(packageJson?.packageManager)
    if (declared) return { name: declared, root: current }
  }

  for (const current of directories) {
    const files = await fs.readdir(current).catch(() => [] as string[])
    if (files.some((file) => BUN_LOCK_FILES.includes(file))) return { name: 'bun', root: current }
    if (files.includes('pnpm-lock.yaml')) return { name: 'pnpm', root: current }
    if (files.includes('yarn.lock')) return { name: 'yarn', root: current }
    if (files.includes('package-lock.json')) return { name: 'npm', root: current }
  }

  return { name: 'npm', root: path.resolve(rootBoundary) }
}

export function scoreScript(name: string, command: string) {
  let score = SCRIPT_SCORES[name] ?? -100
  for (const signal of PRODUCTION_SIGNALS) {
    if (signal.test(command)) score -= 60
  }
  if (/\b(--watch|watch mode|nodemon|tsx watch|nest start --watch)\b/i.test(command)) score += 8
  return score
}

export function pickScript(scripts: Record<string, string>): string | null {
  return Object.entries(scripts)
    .map(([name, command]) => ({ name, score: scoreScript(name, command) }))
    .filter((entry) => entry.score > -100)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))[0]?.name ?? null
}

export function commandForScript(pm: string, script: string) {
  if (pm === 'npm') return script === 'start' ? 'npm start' : `npm run ${script}`
  if (pm === 'bun') return `bun run ${script}`
  if (pm === 'pnpm') return `pnpm ${script}`
  return `yarn ${script}`
}

function inferFramework(packageJson: PackageJsonMetadata | null, scripts: Record<string, string>): Framework {
  const dependencies = {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {})
  }
  const commands = Object.values(scripts).join(' ').toLowerCase()
  if (dependencies.vite || /\bvite\b/.test(commands)) return 'vite'
  if (dependencies.next || /\bnext\s+(?:dev|start)\b/.test(commands)) return 'next'
  if (dependencies.nuxt || /\bnuxt\b/.test(commands)) return 'nuxt'
  if (dependencies['@nestjs/core'] || /\bnest\s+start\b/.test(commands)) return 'nest'
  if (packageJson) return 'node'
  return 'unknown'
}

function inferRole(dir: string, scripts: Record<string, string>, framework: Framework): 'backend' | 'frontend' | 'service' {
  const folderName = path.basename(dir).toLowerCase()
  if (FRONTEND_NAMES.has(folderName)) return 'frontend'
  if (BACKEND_NAMES.has(folderName)) return 'backend'
  if (framework === 'vite' || framework === 'next' || framework === 'nuxt') return 'frontend'
  if (framework === 'nest' || framework === 'node') {
    const commands = Object.values(scripts).join(' ').toLowerCase()
    if (/\b(nest|nodemon|tsx|ts-node|express|fastify)\b/.test(commands)) return 'backend'
  }
  return 'service'
}

export function adaptCommandForFramework(options: {
  command: string
  framework: Framework
  packageManager?: string | null
  port?: number
}) {
  const { command, framework, packageManager, port } = options
  if (!port || !['vite', 'nuxt'].includes(framework) || /(?:^|\s)--port(?:\s|=)/.test(command)) return command

  const args = `--port ${port} --host 127.0.0.1`
  if (packageManager === 'npm' || packageManager === 'bun') return `${command} -- ${args}`
  if (packageManager === 'pnpm' || packageManager === 'yarn') return `${command} ${args}`
  return `${command} ${args}`
}

export async function detectProject(dir: string, rootBoundary = dir): Promise<DetectResponse> {
  const files: string[] = await fs.readdir(dir).catch(() => [])
  const hasDocker = DOCKER_FILES.some((file) => files.includes(file))
  const packageJsonPath = path.join(dir, 'package.json')
  const cargoTomlPath = path.join(dir, 'Cargo.toml')

  const packageJson = await readJson<PackageJsonMetadata>(packageJsonPath)
  const scripts = packageJson?.scripts ?? {}
  let suggested_command: string | null = null
  let suggested_script: string | null = null
  let package_manager: string | null = null
  let package_root: string | null = null
  let framework = inferFramework(packageJson, scripts)

  if (Object.keys(scripts).length > 0) {
    const manager = await pickPackageManager(dir, rootBoundary)
    package_manager = manager.name
    package_root = manager.root
    suggested_script = pickScript(scripts)
    if (suggested_script) suggested_command = commandForScript(manager.name, suggested_script)
  }

  if (!suggested_command && (await pathExists(cargoTomlPath))) {
    suggested_command = 'cargo run'
    framework = 'cargo'
  }

  if (!suggested_command && hasDocker) {
    suggested_command = 'docker compose up -d --build'
    framework = 'docker'
  }

  return {
    scripts,
    suggested_command,
    suggested_script,
    package_manager,
    package_root,
    framework,
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
        suggested_script: detection.suggested_script ?? null,
        package_manager: detection.package_manager ?? null,
        package_root: detection.package_root ?? null,
        framework: detection.framework,
        has_docker_compose: detection.has_docker_compose
      })
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      await walk(path.join(dir, entry.name), depth + 1, rootBoundary)
    }
  }

  for (const root of roots) await walk(root, 0, root)
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
        script: result.suggested_script ?? null,
        command_source: 'auto',
        role: inferRole(servicePath, result.scripts, result.framework),
        kind: 'command',
        source: command === 'cargo run' ? 'Cargo.toml' : 'package.json',
        package_manager: result.package_manager ?? null,
        install_root: result.package_root ?? null,
        framework: result.framework,
        scripts: result.scripts
      })
    }

    if (result.has_docker_compose) {
      services.push({
        name: cwd === '.' ? 'docker' : `${path.basename(servicePath)} docker`,
        path: servicePath,
        cwd,
        command: 'docker compose up -d --build',
        script: null,
        command_source: 'auto',
        role: 'service',
        kind: 'docker_compose',
        source: 'compose',
        package_manager: null,
        install_root: null,
        framework: 'docker',
        scripts: {}
      })
    }
  }

  return services
}
