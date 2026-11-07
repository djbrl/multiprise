import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type {
  EnvironmentResponse,
  EnvVariable,
  ProcessInstance,
  ProjectInspectResult,
  ProjectView,
  RunningServer,
  Settings,
  UsedPort,
  UsageReport
} from '../types'
import type { MultipriseClient } from './client'
import { findRepository } from '../repository'
import {
  isPathLike,
  listProjects,
  projectHolding,
  qualifiedName,
  resolveCurrentProject,
  resolveTarget,
  UsageError,
  type Project,
  type Service,
  type Target
} from './services'

// Everything else the app can do, for the CLI and the MCP server: adding and removing
// projects, service configuration, processes and ports, and settings.

// Same rule as the backend's; importing environment.ts would pull in Electron.
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

const expandHome = (value: string) => value === '~' || value.startsWith('~/') ? path.join(os.homedir(), value.slice(1)) : value
export const absoluteFolder = (folder: string, cwd = process.cwd()) => path.resolve(cwd, expandHome(folder))

// What adding these folders would track, without saving anything.
export async function inspectFolders(client: MultipriseClient, folders: string[]) {
  const { projects } = await client.request<{ projects: ProjectInspectResult[] }>('POST', '/api/projects/inspect', {
    roots: folders.map((folder) => absoluteFolder(folder))
  })
  return projects
}

export type AddResult = { path: string; added: boolean; services: string[]; error?: string }

export async function addFolders(client: MultipriseClient, folders: string[]): Promise<AddResult[]> {
  const results: AddResult[] = []
  for (const folder of folders) {
    const absolute = absoluteFolder(folder)
    try {
      const { projects } = await client.request<{ projects: ProjectView[] }>('POST', '/api/projects', { path: absolute })
      results.push({ path: absolute, added: true, services: projects.map((view) => view.project.name) })
    } catch (err) {
      results.push({ path: absolute, added: false, services: [], error: err instanceof Error ? err.message : String(err) })
    }
  }
  return results
}

const PROJECT_FILES = ['package.json', 'Cargo.toml', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']

// Inside a repository the whole checkout is tracked. Elsewhere only a folder that is clearly a
// project is, so `up` in the wrong place cannot sweep up everything below it.
async function trackFolder(client: MultipriseClient, folder: string, onProgress?: (message: string) => void) {
  const repository = findRepository(folder)
  const root = repository?.root ?? folder
  const looksLikeProject = !!repository || PROJECT_FILES.some((file) => fs.existsSync(path.join(folder, file)))
  if (!looksLikeProject || root === os.homedir()) {
    throw new UsageError(`No Multiprise project contains ${folder}, and it does not look like a project. Use \`multiprise add <folder>\` to track it anyway.`)
  }
  const [result] = await addFolders(client, [root])
  if (!result.added) throw new UsageError(`Could not track ${root}: ${result.error ?? 'not added'}`)
  onProgress?.(`Now tracking ${root} (${result.services.join(', ')})`)
}

// What `up` and `start_service` act on: folders are tracked first if nothing holds them yet.
export async function targetsToStart(client: MultipriseClient, names: string[], onProgress?: (message: string) => void, cwd = process.cwd()) {
  let projects = await listProjects(client)
  const targets: Target[] = []
  for (const name of names.length ? names : ['.']) {
    if (!isPathLike(name)) {
      targets.push(resolveTarget(projects, name, cwd))
      continue
    }
    const folder = absoluteFolder(name, cwd)
    if (!projectHolding(projects, folder)) {
      await trackFolder(client, folder, onProgress)
      projects = await listProjects(client)
    }
    targets.push(names.length ? resolveTarget(projects, folder, cwd) : resolveCurrentProject(projects, cwd))
  }
  return targets
}

// Untracking stops the services and forgets their settings, secrets and logs; the folder is untouched.
export async function removeTargets(client: MultipriseClient, targets: Target[]) {
  const removed: string[] = []
  for (const target of targets) {
    for (const service of target.services) {
      if (removed.includes(qualifiedName(service))) continue
      await client.request('DELETE', `/api/projects/${service.id}`)
      removed.push(qualifiedName(service))
    }
  }
  return removed
}

async function updateService(client: MultipriseClient, service: Service, patch: Record<string, unknown>) {
  return client.request<ProjectView>('PATCH', `/api/projects/${service.id}`, patch)
}

export const renameService = (client: MultipriseClient, service: Service, name: string) => {
  if (!name.trim()) throw new UsageError('The new name cannot be empty.')
  return updateService(client, service, { name: name.trim() })
}

// A command set here is kept across rescans until reset to the detected one.
export async function setCommand(client: MultipriseClient, service: Service, command: string | null) {
  const view = command === null
    ? await updateService(client, service, { command: null, command_source: 'auto' })
    : await updateService(client, service, { command, command_source: 'user' })
  return { command: view.project.command ?? null, source: view.project.command_source ?? 'auto' }
}

// The port the service asks for next time (Multiprise may still move it when the port is taken).
export async function setPort(client: MultipriseClient, service: Service, port: number | null) {
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new UsageError('A port is a whole number between 1 and 65535.')
  const view = await updateService(client, service, { port })
  return view.project.port ?? null
}

export const getEnvironment = (client: MultipriseClient, service: Service) =>
  client.request<EnvironmentResponse>('GET', `/api/projects/${service.id}/environment`)

// KEY=VALUE pairs; the value may be empty and may contain "=".
export function parseAssignments(pairs: string[]) {
  return pairs.map((pair) => {
    const equals = pair.indexOf('=')
    if (equals <= 0) throw new UsageError(`"${pair}" is not KEY=VALUE.`)
    const key = pair.slice(0, equals).trim()
    if (!ENV_KEY_PATTERN.test(key)) throw new UsageError(`"${key}" is not a valid variable name.`)
    return { key, value: pair.slice(equals + 1) }
  })
}

// Secret values are never sent back, so kept secrets are passed through without a value.
async function saveVariables(client: MultipriseClient, service: Service, variables: EnvVariable[]) {
  return client.request<EnvironmentResponse>('PUT', `/api/projects/${service.id}/environment`, { variables })
}

export async function setVariables(client: MultipriseClient, service: Service, assignments: Array<{ key: string; value: string }>, secret: boolean) {
  const current = await getEnvironment(client, service)
  const keys = new Set(assignments.map((entry) => entry.key))
  const kept = current.variables.filter((variable) => !keys.has(variable.key))
  return saveVariables(client, service, [...kept, ...assignments.map(({ key, value }) => ({ key, value, secret }))])
}

export async function unsetVariables(client: MultipriseClient, service: Service, keys: string[]) {
  const current = await getEnvironment(client, service)
  const missing = keys.filter((key) => !current.variables.some((variable) => variable.key === key))
  if (missing.length) throw new UsageError(`${qualifiedName(service)} has no variable ${missing.join(', ')}.`)
  return saveVariables(client, service, current.variables.filter((variable) => !keys.includes(variable.key)))
}

// Services this one needs: they start first and can be referenced as {{services.<name>.url}}.
export async function setDependencies(client: MultipriseClient, service: Service, ids: string[]) {
  const view = await updateService(client, service, { links: ids })
  return view.project.links ?? []
}

export async function dependencyNames(client: MultipriseClient, ids: string[], projects?: Project[]) {
  const all = (projects ?? await listProjects(client)).flatMap((project) => project.services)
  return ids.map((id) => {
    const found = all.find((entry) => entry.id === id)
    return found ? qualifiedName(found) : id
  })
}

export async function serviceDetails(client: MultipriseClient, service: Service) {
  const [{ projects: views }, environment, projects] = await Promise.all([
    client.request<{ projects: ProjectView[] }>('GET', '/api/projects'),
    getEnvironment(client, service),
    listProjects(client)
  ])
  const view = views.find((entry) => entry.project.id === service.id)
  return {
    ...service,
    name: qualifiedName(service),
    command_source: view?.project.command_source ?? 'auto',
    framework: view?.project.framework ?? null,
    package_manager: view?.project.package_manager ?? null,
    failure_code: view?.status.failure_code ?? null,
    started_at: view?.status.started_at ?? null,
    depends_on: await dependencyNames(client, environment.links, projects),
    variables: environment.variables,
    env_file: environment.env_file
  }
}

export async function processesOf(client: MultipriseClient, service: Service) {
  const { instances } = await client.request<{ instances: ProcessInstance[] }>('GET', `/api/projects/${service.id}/process/instances`)
  return instances
}

// Only a process holding the service's port (or blocking its start) can be stopped this way;
// Multiprise's own processes are stopped with `down`.
export async function killProcess(client: MultipriseClient, service: Service, target: { pid?: number; port?: number }) {
  return client.request<{ ok: boolean; pid: number }>('POST', `/api/projects/${service.id}/process/kill`, target)
}

export async function usedPorts(client: MultipriseClient) {
  const { ports } = await client.request<{ ports: UsedPort[] }>('GET', '/api/ports/used')
  return ports
}

export async function runningServers(client: MultipriseClient) {
  const { servers } = await client.request<{ servers: RunningServer[] }>('GET', '/api/running')
  return servers
}

export const usageReport = (client: MultipriseClient) =>
  client.request<UsageReport>('GET', '/api/usage')

export const stopRunningServer = (client: MultipriseClient, server: RunningServer) =>
  client.request('POST', '/api/running/stop', { key: server.key })

export const runningServerName = (server: RunningServer) =>
  `${server.project ?? server.command}${server.worktree ? ` (${server.worktree})` : ''}`

// By port, or every leftover; asking for nothing is a mistake rather than "all of them".
export function chooseRunningServers(servers: RunningServer[], ports: number[], leftovers: boolean) {
  const chosen = leftovers ? servers.filter((server) => server.leftover) : []
  for (const port of ports) {
    const found = servers.find((server) => server.ports.includes(port))
    if (!found) throw new UsageError(`Nothing listed is on port ${port}. See \`multiprise running\`; desktop apps and system services are not listed.`)
    if (!chosen.includes(found)) chosen.push(found)
  }
  return chosen
}

export async function prepareService(client: MultipriseClient, service: Service, step: 'install' | 'build') {
  await client.request('POST', `/api/projects/${service.id}/prepare`, { step })
}

export async function openFolder(client: MultipriseClient, service: Service, target: 'vscode' | 'finder') {
  await client.request('POST', `/api/projects/${service.id}/open`, { target })
}

export const getSettings = (client: MultipriseClient) => client.request<Settings>('GET', '/api/settings')

// Values arrive as text from the command line; each is converted to the setting's type.
export function parseSettings(current: Settings, assignments: Array<{ key: string; value: string }>) {
  const patch: Partial<Record<keyof Settings, unknown>> = {}
  for (const { key, value } of assignments) {
    if (!(key in current) || key === 'onboarded') {
      throw new UsageError(`Unknown setting "${key}". Settings: ${Object.keys(current).filter((name) => name !== 'onboarded').join(', ')}.`)
    }
    const existing = current[key as keyof Settings]
    if (typeof existing === 'boolean') {
      if (!/^(true|false|on|off|yes|no)$/i.test(value)) throw new UsageError(`${key} is on or off.`)
      patch[key as keyof Settings] = /^(true|on|yes)$/i.test(value)
    } else if (typeof existing === 'number') {
      const number = Number(value)
      if (!Number.isFinite(number)) throw new UsageError(`${key} is a number.`)
      patch[key as keyof Settings] = number
    } else if (Array.isArray(existing)) {
      patch[key as keyof Settings] = value.split(',').map((item) => item.trim()).filter(Boolean)
    } else {
      patch[key as keyof Settings] = value
    }
  }
  return patch
}

export async function updateSettings(client: MultipriseClient, patch: Partial<Record<keyof Settings, unknown>>) {
  return client.request<Settings>('PATCH', '/api/settings', patch)
}
