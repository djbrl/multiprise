import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

type RuntimeSource = '.node-version' | '.nvmrc' | 'package.json#volta.node' | 'package.json#engines.node' | 'automatic LTS fallback'

export type NodeRuntimeDeclaration = {
  spec: string
  source: RuntimeSource
  directory: string
  // The original semver range for engines declarations; any satisfying Node is acceptable.
  range?: string
}

export type RuntimeResolution = {
  path?: string
  version?: string
  executable?: string
  source?: RuntimeSource
}

type PackageRuntimeMetadata = {
  engines?: { node?: string }
  volta?: { node?: string }
}

function commandName(command: string) {
  const trimmed = command.trim()
  const match = trimmed.match(/^([^\s;&|]+)/)
  return match?.[1] ?? null
}

function isNodeCommand(command: string) {
  const executable = path.basename(commandName(command) ?? '').toLowerCase()
  return ['node', 'npm', 'npx', 'pnpm', 'yarn', 'corepack'].includes(executable)
}

function directoriesToBoundary(dir: string, rootBoundary: string) {
  const directories: string[] = []
  let current = path.resolve(dir)
  const boundary = path.resolve(rootBoundary)
  while (true) {
    directories.push(current)
    if (current === boundary) break
    const parent = path.dirname(current)
    if (parent === current || !current.startsWith(boundary + path.sep)) break
    current = parent
  }
  return directories
}

function normalizeVersionFile(value: string) {
  return value.trim().split(/\s+/)[0]?.replace(/^v/i, '') ?? ''
}

function engineVersionSpec(value: string) {
  const majors = Array.from(value.matchAll(/(?:^|[^\d])v?(\d+)(?:\.\d+)?(?:\.\d+)?/g))
    .map((match) => Number(match[1]))
    .filter((major) => Number.isInteger(major) && major >= 8 && major <= 99)
  if (!majors.length) return ''
  const evenMajors = majors.filter((major) => major % 2 === 0)
  return String(Math.max(...(evenMajors.length ? evenMajors : majors)))
}

type Version = [number, number, number]

function parseVersion(value: string): Version | null {
  const match = value.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (!match) return null
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}

function compareVersions(left: Version, right: Version) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

function satisfiesComparator(version: Version, comparator: string): boolean {
  const match = comparator.match(/^(>=|<=|>|<|=|\^|~)?\s*v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?/)
  if (!match) return false
  const operator = match[1] ?? ''
  const parts = [match[2], match[3], match[4]]
  const wildcardIndex = parts.findIndex((part) => part === undefined || /^[xX*]$/.test(part))
  const precision = wildcardIndex === -1 ? 3 : wildcardIndex
  const base = parts.map((part, index) => index < precision ? Number(part) : 0) as Version
  if (precision === 0) return true

  const upperFor = (index: number): Version => {
    const upper = [...base] as Version
    upper[index] += 1
    for (let rest = index + 1; rest < 3; rest += 1) upper[rest] = 0
    return upper
  }
  const within = (upper: Version) => compareVersions(version, base) >= 0 && compareVersions(version, upper) < 0

  switch (operator) {
    case '>=': return compareVersions(version, base) >= 0
    case '>': return precision < 3 ? compareVersions(version, upperFor(precision - 1)) >= 0 : compareVersions(version, base) > 0
    case '<=': return precision < 3 ? compareVersions(version, upperFor(precision - 1)) < 0 : compareVersions(version, base) <= 0
    case '<': return compareVersions(version, base) < 0
    case '^': {
      const index = base[0] !== 0 || precision === 1 ? 0 : base[1] !== 0 || precision === 2 ? 1 : 2
      return within(upperFor(index))
    }
    case '~': return within(upperFor(precision === 1 ? 0 : 1))
    default: return precision === 3 ? compareVersions(version, base) === 0 : within(upperFor(precision - 1))
  }
}

// Minimal semver range support covering the forms used in engines.node:
// "||" alternatives, space-separated comparators, "a - b" hyphen ranges, ^, ~ and x-ranges.
export function versionSatisfies(version: string, range: string): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return false
  return range.split('||').some((alternative) => {
    const trimmed = alternative.trim()
    if (!trimmed) return true
    const hyphen = trimmed.match(/^(\S+)\s+-\s+(\S+)$/)
    const comparators = hyphen
      ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`]
      : trimmed.replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/)
    return comparators.every((comparator) => satisfiesComparator(parsed, comparator))
  })
}

async function readPackageRuntime(directory: string): Promise<PackageRuntimeMetadata | null> {
  try {
    return JSON.parse(await fsp.readFile(path.join(directory, 'package.json'), 'utf8')) as PackageRuntimeMetadata
  } catch (err) {
    return null
  }
}

export async function findNodeRuntimeDeclaration(cwd: string, rootBoundary = cwd): Promise<NodeRuntimeDeclaration | null> {
  const directories = directoriesToBoundary(cwd, rootBoundary)

  for (const directory of directories) {
    for (const file of ['.node-version', '.nvmrc'] as const) {
      try {
        const spec = normalizeVersionFile(await fsp.readFile(path.join(directory, file), 'utf8'))
        if (spec) return { spec, source: file, directory }
      } catch (err) {
        // Continue toward the workspace root.
      }
    }
  }

  for (const directory of directories) {
    const packageJson = await readPackageRuntime(directory)
    const voltaSpec = normalizeVersionFile(packageJson?.volta?.node ?? '')
    if (voltaSpec) {
      return { spec: voltaSpec, source: 'package.json#volta.node', directory }
    }
    const engineRange = packageJson?.engines?.node?.trim() ?? ''
    const engineSpec = engineVersionSpec(engineRange)
    if (engineSpec) {
      return { spec: engineSpec, source: 'package.json#engines.node', directory, range: engineRange }
    }
  }

  return null
}

export function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env) {
  const executable = commandName(command)
  if (!executable) return null

  if (executable.includes('/') || executable.includes('\\')) {
    try {
      fs.accessSync(executable, fs.constants.X_OK)
      return executable
    } catch (err) {
      return null
    }
  }

  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : ['']
  for (const directory of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, executable + extension)
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
      } catch (err) {
        // Keep searching the effective PATH.
      }
    }
  }
  return null
}

export function assertCommandAvailable(command: string, env: NodeJS.ProcessEnv = process.env) {
  const executable = commandName(command)
  if (!executable || findExecutable(command, env)) return
  throw new Error('Required runtime "' + executable + '" was not found. Make sure it is installed and available in your login shell PATH, then restart Multiprise.')
}

function execute(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) {
  return new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => {
    execFile(executable, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? error?.message ?? '')
      })
    })
  })
}

function nodeMajor(version?: string | null) {
  const value = Number(version?.match(/v?(\d+)/)?.[1])
  return Number.isInteger(value) ? value : null
}

function mergePath(prepend: string, existing?: string) {
  return Array.from(new Set([prepend, ...(existing ?? '').split(path.delimiter).filter(Boolean)]))
    .join(path.delimiter)
}

async function currentNode(env: NodeJS.ProcessEnv, cwd: string) {
  const executable = findExecutable('node', env)
  if (!executable) return { executable: null, version: null }
  const result = await execute(executable, ['--version'], { cwd, env })
  return {
    executable,
    version: result.ok ? result.stdout.trim().split(/\s+/)[0] ?? null : null
  }
}

async function resolveWithFnm(options: {
  fnm: string
  spec: string
  cwd: string
  env: NodeJS.ProcessEnv
  autoInstall: boolean
  source: RuntimeSource
  onLog?: (line: string) => void
}) {
  const execArgs = ['exec', '--using', options.spec, 'node', '-p', 'process.execPath + "\\n" + process.version']
  let result = await execute(options.fnm, execArgs, { cwd: options.cwd, env: options.env })

  if (!result.ok && options.autoInstall) {
    options.onLog?.('[runtime] Installing Node ' + options.spec + ' with fnm…')
    const installed = await execute(
      options.fnm,
      ['install', '--progress', 'never', options.spec],
      { cwd: options.cwd, env: options.env }
    )
    if (!installed.ok) {
      throw new Error('Node ' + options.spec + ' is required by ' + options.source + ', but fnm could not install it. ' + installed.stderr.trim())
    }
    result = await execute(options.fnm, execArgs, { cwd: options.cwd, env: options.env })
  }

  if (!result.ok) {
    const guidance = options.autoInstall
      ? 'fnm could not activate it.'
      : 'Enable automatic setup so Multiprise can install it, or install it with your runtime manager.'
    throw new Error('Node ' + options.spec + ' is required by ' + options.source + ', but it is not available. ' + guidance)
  }

  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const executable = lines.find((line) => path.isAbsolute(line) && path.basename(line) === 'node')
  const version = lines.find((line) => /^v\d+\.\d+\.\d+/.test(line))
  if (!executable || !version) {
    throw new Error('fnm activated Node ' + options.spec + ', but Multiprise could not resolve its executable.')
  }

  return {
    path: mergePath(path.dirname(executable), options.env.PATH),
    version,
    executable,
    source: options.source
  } satisfies RuntimeResolution
}

export async function resolveProjectNodeRuntime(options: {
  command: string
  cwd: string
  rootBoundary?: string
  framework?: string
  env?: NodeJS.ProcessEnv
  autoInstall?: boolean
  onLog?: (line: string) => void
}): Promise<RuntimeResolution> {
  if (!isNodeCommand(options.command)) return {}

  const env = { ...process.env, ...(options.env ?? {}) }
  const current = await currentNode(env, options.cwd)
  const declaration = await findNodeRuntimeDeclaration(options.cwd, options.rootBoundary ?? options.cwd)
  const currentMajor = nodeMajor(current.version)

  let requested = declaration
  if (!requested && ['vite', 'next', 'nuxt'].includes(options.framework ?? '') && currentMajor && currentMajor % 2 === 1) {
    requested = {
      spec: 'lts-latest',
      source: 'automatic LTS fallback',
      directory: options.cwd
    }
  }

  if (!requested) {
    if (current.executable && current.version) {
      options.onLog?.('[runtime] Node ' + current.version + ' · ' + current.executable)
      return {
        path: env.PATH,
        version: current.version,
        executable: current.executable
      }
    }
    return {}
  }

  const requestedMajor = nodeMajor(requested.spec)
  const currentSatisfies = requested.range
    ? !!current.version && versionSatisfies(current.version, requested.range)
    : !!requestedMajor && requestedMajor === currentMajor
  if (
    requested.source !== 'automatic LTS fallback' &&
    current.executable &&
    current.version &&
    currentSatisfies
  ) {
    options.onLog?.('[runtime] Node ' + current.version + ' from ' + requested.source + ' · ' + current.executable)
    return {
      path: env.PATH,
      version: current.version,
      executable: current.executable,
      source: requested.source
    }
  }

  const fnm = findExecutable('fnm', env)
  if (!fnm) {
    throw new Error(
      'Node ' + requested.spec + ' is required by ' + requested.source +
      ', but Multiprise could not find fnm and the active Node is ' + (current.version ?? 'unavailable') + '.'
    )
  }

  const resolved = await resolveWithFnm({
    fnm,
    spec: requested.spec,
    cwd: requested.directory,
    env,
    autoInstall: options.autoInstall ?? false,
    source: requested.source,
    onLog: options.onLog
  })
  options.onLog?.('[runtime] Node ' + resolved.version + ' from ' + requested.source + ' · ' + resolved.executable)
  return resolved
}
