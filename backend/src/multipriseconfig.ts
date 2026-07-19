import fs from 'node:fs/promises'
import path from 'node:path'
import { type MultipriseConfig, type MultipriseService } from './types'

type EnvContext = {
  servicePort?: number
  backendPort?: number
  frontendPort?: number
}

const CONFIG_FILE = 'multiprise.json'
const LEGACY_CONFIG_FILE = ['vibe', 'manager.json'].join('')
const CONFIG_FILES = [CONFIG_FILE, LEGACY_CONFIG_FILE]

async function fileExists(target: string) {
  try {
    await fs.access(target)
    return true
  } catch (err) {
    return false
  }
}

async function findConfigFile(directory: string) {
  for (const fileName of CONFIG_FILES) {
    const candidate = path.join(directory, fileName)
    if (await fileExists(candidate)) return candidate
  }
  return null
}

function npmScriptFromCommand(command: string) {
  const runMatch = command.match(/^\s*npm\s+(?:run|run-script)\s+([^\s;&|]+)/)
  if (runMatch) return runMatch[1]

  const lifecycleMatch = command.match(/^\s*npm\s+(start|stop|restart|test)(?:\s|$)/)
  return lifecycleMatch?.[1] ?? null
}

async function validateServiceCommand(rootDir: string, service: MultipriseService) {
  if (!service.start) return

  const script = npmScriptFromCommand(service.start)
  if (!script) return

  const cwd = normalizeCwd(service.cwd)
  const serviceDir = path.resolve(rootDir, cwd)
  const packagePath = path.join(serviceDir, 'package.json')
  const raw = await fs.readFile(packagePath, 'utf-8').catch(() => null)
  if (!raw) {
    throw new Error(`Configured command "${service.start}" requires ${path.relative(rootDir, packagePath) || 'package.json'}, but that file was not found`)
  }

  let scripts: Record<string, string>
  try {
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> }
    scripts = parsed.scripts ?? {}
  } catch (err) {
    throw new Error(`Could not parse ${path.relative(rootDir, packagePath) || 'package.json'}`)
  }

  if (scripts[script]) return
  if (script === 'start' && await fileExists(path.join(serviceDir, 'server.js'))) return

  const available = Object.keys(scripts)
  const suffix = available.length > 0 ? ` Available scripts: ${available.join(', ')}.` : ' No npm scripts are defined.'
  throw new Error(`Configured command "${service.start}" is invalid for ${cwd === '.' ? 'package.json' : `${cwd}/package.json`}: script "${script}" does not exist.${suffix}`)
}

async function validateConfig(rootDir: string, config: MultipriseConfig) {
  await Promise.all(config.services.map((service) => validateServiceCommand(rootDir, service)))
}

export async function loadMultipriseConfig(startPath: string): Promise<{ rootDir: string; config: MultipriseConfig } | null> {
  let current = startPath
  try {
    const stat = await fs.stat(current)
    if (!stat.isDirectory()) {
      current = path.dirname(current)
    }
  } catch (err) {
    current = path.dirname(startPath)
  }

  while (true) {
    const candidate = await findConfigFile(current)
    if (candidate) {
      const raw = await fs.readFile(candidate, 'utf-8')
      const config = JSON.parse(raw) as MultipriseConfig
      if (!config?.services || !Array.isArray(config.services) || config.services.length === 0) {
        throw new Error('multiprise.json has no services')
      }
      await validateConfig(current, config)
      return { rootDir: current, config }
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  return null
}

function normalizeCwd(value?: string) {
  if (!value) return '.'
  return value.replace(/^\./, '').replace(/^\//, '') || '.'
}

export async function loadMultipriseConfigAtRoot(rootDir: string): Promise<MultipriseConfig | null> {
  const candidate = await findConfigFile(rootDir)
  if (!candidate) return null
  const raw = await fs.readFile(candidate, 'utf-8')
  const config = JSON.parse(raw) as MultipriseConfig
  if (!config?.services || !Array.isArray(config.services) || config.services.length === 0) {
    throw new Error('multiprise.json has no services')
  }
  await validateConfig(rootDir, config)
  return config
}

export function normalizeServiceCwd(value?: string) {
  return normalizeCwd(value)
}

export function selectService(options: {
  rootDir: string
  config: MultipriseConfig
  projectPath: string
}): { service: MultipriseService; serviceDir: string } {
  const { rootDir, config, projectPath } = options
  const relative = path.relative(rootDir, projectPath)
  const candidates = config.services
    .map((service) => {
      const cwd = normalizeCwd(service.cwd)
      const match = cwd === '.' ? true : relative.startsWith(cwd)
      return { service, cwd, match }
    })
    .filter((entry) => entry.match)

  let selected: { service: MultipriseService; cwd: string } | null = null
  for (const entry of candidates) {
    if (!selected || entry.cwd.length > selected.cwd.length) {
      selected = { service: entry.service, cwd: entry.cwd }
    }
  }

  if (!selected && config.services.length === 1) {
    selected = { service: config.services[0], cwd: normalizeCwd(config.services[0].cwd) }
  }

  if (!selected) {
    throw new Error('No matching service in multiprise.json')
  }

  const serviceDir = path.resolve(rootDir, selected.cwd)
  return { service: selected.service, serviceDir }
}

export function resolveEnvValue(value: string, context: EnvContext) {
  return value.replace(/\{\{(PORT|SERVICE_PORT|BACKEND_PORT|FRONTEND_PORT)\}\}/g, (_match, token) => {
    switch (token) {
      case 'PORT':
      case 'SERVICE_PORT':
        return context.servicePort ? String(context.servicePort) : ''
      case 'BACKEND_PORT':
        return context.backendPort ? String(context.backendPort) : ''
      case 'FRONTEND_PORT':
        return context.frontendPort ? String(context.frontendPort) : ''
      default:
        return ''
    }
  })
}

export function resolveServiceEnv(env: Record<string, string> | undefined, context: EnvContext) {
  const resolved: Record<string, string> = {}
  if (!env) return resolved
  Object.entries(env).forEach(([key, value]) => {
    resolved[key] = resolveEnvValue(String(value), context)
  })
  return resolved
}
