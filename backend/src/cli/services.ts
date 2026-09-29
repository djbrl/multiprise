import os from 'node:os'
import path from 'node:path'
import { projectRoleFallback } from '../roles'
import type { LogLine, ProcessPhase, ProjectView, ServiceRole, Settings } from '../types'
import type { MultipriseClient } from './client'

// Operations shared by the CLI and the MCP server. They mirror what the app's own
// buttons do, so a service started here gets the same port and linked environment.

export type Service = {
  id: string
  name: string
  project: string
  path: string
  role: ServiceRole
  kind: 'command' | 'docker_compose'
  phase: ProcessPhase
  running: boolean
  port: number | null
  url: string | null
  pid: number | null
  command: string | null
  error: string | null
}

export type Project = {
  name: string
  path: string
  services: Service[]
}

export type Target = { project: Project; services: Service[]; whole: boolean }

export type StartResult = {
  service: Service
  outcome: 'started' | 'already-running' | 'failed' | 'skipped'
  error?: string
}

export type StopResult = {
  service: Service
  outcome: 'stopped' | 'not-running' | 'failed'
  error?: string
}

export class UsageError extends Error {}

export const serviceUrl = (port: number) => `http://localhost:${port}`

const rootOf = (view: ProjectView) => view.project.root_path || view.project.path

function toService(view: ProjectView, projectName: string): Service {
  const { project, status } = view
  // Compose files declare their own ports; for other services this is the current or last port.
  const port = project.kind === 'docker_compose' ? null : project.port ?? null
  return {
    id: project.id,
    name: project.name,
    project: projectName,
    path: project.path,
    role: projectRoleFallback(project),
    kind: project.kind,
    phase: project.kind === 'docker_compose' ? (project.docker_running ? 'ready' : 'stopped') : status.phase,
    running: project.kind === 'docker_compose' ? Boolean(project.docker_running) : status.running,
    port,
    url: port && status.running && status.phase === 'ready' ? serviceUrl(port) : null,
    pid: status.pid ?? null,
    command: project.command ?? null,
    error: status.error ?? project.last_error ?? null
  }
}

export async function listProjects(client: MultipriseClient): Promise<Project[]> {
  const { projects: views } = await client.request<{ projects: ProjectView[] }>('GET', '/api/projects')
  const byRoot = new Map<string, ProjectView[]>()
  for (const view of views) {
    const root = rootOf(view)
    if (!byRoot.has(root)) byRoot.set(root, [])
    byRoot.get(root)!.push(view)
  }
  return [...byRoot.entries()]
    .map(([root, items]) => {
      const name = path.basename(root)
      return { name, path: root, services: items.map((view) => toService(view, name)) }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

const sameName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0

const isPathLike = (query: string) => /^(\.{1,2}($|\/)|\/|~($|\/))/.test(query)

const expandHome = (value: string) => value === '~' || value.startsWith('~/') ? path.join(os.homedir(), value.slice(1)) : value

const contains = (parent: string, child: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)

export const qualifiedName = (service: Service) =>
  sameName(service.name, service.project) ? service.name : `${service.project}/${service.name}`

function describeMatches(matches: Array<Project | Service>) {
  return matches.map((match) => 'services' in match ? `${match.name} (project)` : qualifiedName(match)).join(', ')
}

function projectOf(projects: Project[], service: Service) {
  return projects.find((project) => project.services.some((item) => item.id === service.id))!
}

function byPath(projects: Project[], absolute: string): Target | null {
  const exactProject = projects.find((project) => project.path === absolute)
  if (exactProject) return { project: exactProject, services: exactProject.services, whole: true }
  const services = projects.flatMap((project) => project.services)
  const exactService = services.find((service) => service.path === absolute)
  if (exactService) return { project: projectOf(projects, exactService), services: [exactService], whole: false }
  // The deepest project containing the folder, e.g. a subfolder of a service.
  const containing = projects
    .filter((project) => contains(project.path, absolute))
    .sort((a, b) => b.path.length - a.path.length)[0]
  return containing ? { project: containing, services: containing.services, whole: true } : null
}

// A query is a service id, `project/service`, a project or service name, or a folder.
export function resolveTarget(projects: Project[], query: string, cwd = process.cwd()): Target {
  const services = projects.flatMap((project) => project.services)
  const byId = services.find((service) => service.id === query)
  if (byId) return { project: projectOf(projects, byId), services: [byId], whole: false }

  if (isPathLike(query)) {
    const absolute = path.resolve(cwd, expandHome(query))
    const found = byPath(projects, absolute)
    if (!found) throw new UsageError(`No Multiprise project contains ${absolute}.`)
    return found
  }

  const slash = query.indexOf('/')
  if (slash > 0) {
    const projectName = query.slice(0, slash)
    const serviceName = query.slice(slash + 1)
    const matches = projects
      .filter((project) => sameName(project.name, projectName))
      .flatMap((project) => project.services.filter((service) => sameName(service.name, serviceName)))
    if (matches.length === 1) return { project: projectOf(projects, matches[0]), services: matches, whole: false }
    if (matches.length > 1) throw new UsageError(`"${query}" matches several services. Use one of these ids: ${matches.map((service) => service.id).join(', ')}`)
  }

  const projectMatches = projects.filter((project) => sameName(project.name, query))
  if (projectMatches.length === 1) {
    return { project: projectMatches[0], services: projectMatches[0].services, whole: true }
  }
  const serviceMatches = services.filter((service) => sameName(service.name, query))
  if (projectMatches.length === 0 && serviceMatches.length === 1) {
    return { project: projectOf(projects, serviceMatches[0]), services: serviceMatches, whole: false }
  }
  if (projectMatches.length + serviceMatches.length > 1) {
    throw new UsageError(`"${query}" is ambiguous: ${describeMatches([...projectMatches, ...serviceMatches])}. Use project/service or a service id.`)
  }
  throw new UsageError(`No project or service named "${query}". Run \`multiprise ls\` to see them.`)
}

// Without a name, commands act on the project containing the current folder.
export function resolveCurrentProject(projects: Project[], cwd = process.cwd()): Target {
  const absolute = path.resolve(cwd)
  const project = projects
    .filter((entry) => contains(entry.path, absolute))
    .sort((a, b) => b.path.length - a.path.length)[0]
  if (!project) {
    throw new UsageError(`No Multiprise project contains ${cwd}. Name a project or service, or add this folder in the app.`)
  }
  return { project, services: project.services, whole: true }
}

// Commands such as logs and url need exactly one service.
export function resolveService(projects: Project[], query: string | undefined, cwd = process.cwd()): Service {
  let target: Target
  if (query) {
    target = resolveTarget(projects, query, cwd)
  } else {
    const absolute = path.resolve(cwd)
    // Inside a service folder, that service is meant even when the project has others. A
    // service at the project root contains its siblings too, so it only counts when alone.
    const service = projects
      .flatMap((project) => project.services)
      .filter((entry) => contains(entry.path, absolute))
      .sort((a, b) => b.path.length - a.path.length)[0]
    const project = service && projectOf(projects, service)
    target = service && (service.path !== project.path || project.services.length === 1)
      ? { project, services: [service], whole: false }
      : resolveCurrentProject(projects, cwd)
  }
  if (target.services.length === 1) return target.services[0]
  throw new UsageError(`${target.project.name} has several services; name one: ${target.services.map(qualifiedName).join(', ')}`)
}

const errorMessage = (err: unknown) => err instanceof Error ? err.message : String(err)

async function startProjectServices(client: MultipriseClient, settings: Settings, target: Target, onProgress?: (message: string) => void) {
  const { project } = target
  const selected = new Set(target.services.map((service) => service.id))
  // Like the app's "Launch all", a whole project leaves Docker Compose services alone.
  const chosen = target.services.filter((service) => !target.whole || service.kind !== 'docker_compose')
  const regular = project.services.filter((service) => service.kind !== 'docker_compose')
  const primaryBackend = regular.find((service) => service.role === 'backend')
  const primaryFrontend = regular.find((service) => service.role === 'frontend')

  // Stopped primary services get their previous port back when it is still free, so
  // the ports handed to their siblings are the ones they will actually use.
  let allocated: Record<string, number> = {}
  const toAllocate = [primaryBackend, primaryFrontend]
    .filter((service): service is Service => !!service && selected.has(service.id) && !service.running)
  if (settings.auto_port && toAllocate.length) {
    allocated = (await client.request<{ ports: Record<string, number> }>('POST', '/api/ports/allocate', {
      services: toAllocate.map((service) => service.id)
    })).ports ?? {}
  }
  const linkedPort = (service?: Service) => service ? allocated[service.id] ?? service.port ?? undefined : undefined
  const env: Record<string, string> = {}
  const backendPort = linkedPort(primaryBackend)
  const frontendPort = linkedPort(primaryFrontend)
  if (backendPort) env.BACKEND_PORT = String(backendPort)
  if (frontendPort) env.FRONTEND_PORT = String(frontendPort)

  const results: StartResult[] = []
  const launchStage = async (services: Service[]) => {
    let allStarted = true
    for (const service of services) {
      if (service.running) {
        results.push({ service, outcome: 'already-running' })
        continue
      }
      onProgress?.(`Starting ${qualifiedName(service)}…`)
      try {
        const view = await client.request<ProjectView>('POST', `/api/projects/${service.id}/start`, {
          port: allocated[service.id],
          env: Object.keys(env).length ? env : undefined,
          role: service.role
        })
        results.push({ service: toService(view, project.name), outcome: 'started' })
      } catch (err) {
        allStarted = false
        results.push({ service, outcome: 'failed', error: errorMessage(err) })
      }
    }
    return allStarted
  }

  // Supporting services first, then backends; frontends only once their backend is up.
  await launchStage(chosen.filter((service) => service.role === 'service'))
  const backendsStarted = await launchStage(chosen.filter((service) => service.role === 'backend'))
  const frontends = chosen.filter((service) => service.role === 'frontend')
  if (backendsStarted) {
    await launchStage(frontends)
  } else {
    for (const service of frontends) {
      results.push({ service, outcome: 'skipped', error: 'Its backend did not start.' })
    }
  }
  return results
}

export async function startTargets(client: MultipriseClient, targets: Target[], onProgress?: (message: string) => void) {
  const settings = await client.request<Settings>('GET', '/api/settings')
  const results: StartResult[] = []
  for (const target of mergeTargets(targets)) {
    results.push(...await startProjectServices(client, settings, target, onProgress))
  }
  return results
}

export async function stopTargets(client: MultipriseClient, targets: Target[], onProgress?: (message: string) => void) {
  const results: StopResult[] = []
  for (const target of mergeTargets(targets)) {
    // Frontends first, so nothing is left talking to a backend that is gone.
    const order: ServiceRole[] = ['frontend', 'backend', 'service']
    const services = target.services
      .filter((service) => !target.whole || service.kind !== 'docker_compose')
      .sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role))
    for (const service of services) {
      if (!service.running && service.phase !== 'starting') {
        results.push({ service, outcome: 'not-running' })
        continue
      }
      onProgress?.(`Stopping ${qualifiedName(service)}…`)
      try {
        const view = await client.request<ProjectView>('POST', `/api/projects/${service.id}/stop`, {})
        results.push({ service: toService(view, target.project.name), outcome: 'stopped' })
      } catch (err) {
        results.push({ service, outcome: 'failed', error: errorMessage(err) })
      }
    }
  }
  return results
}

export async function restartTargets(client: MultipriseClient, targets: Target[], onProgress?: (message: string) => void) {
  const stopped = await stopTargets(client, targets, onProgress)
  const failed = stopped.filter((result) => result.outcome === 'failed')
  if (failed.length) return { stopped, started: [] as StartResult[] }
  // Start from fresh state: the services are stopped now and may have new ports.
  const current = new Map((await listProjects(client)).map((project) => [project.path, project]))
  const refreshed = targets.flatMap((target) => {
    const project = current.get(target.project.path)
    if (!project) return []
    const ids = new Set(target.services.map((service) => service.id))
    return [{ project, whole: target.whole, services: project.services.filter((service) => ids.has(service.id)) }]
  })
  return { stopped, started: await startTargets(client, refreshed, onProgress) }
}

// Several names in one project become a single launch so start order still applies.
function mergeTargets(targets: Target[]) {
  const merged = new Map<string, Target>()
  for (const target of targets) {
    const existing = merged.get(target.project.path)
    if (!existing) {
      merged.set(target.project.path, { ...target, services: [...target.services] })
      continue
    }
    existing.whole = existing.whole || target.whole
    for (const service of target.services) {
      if (!existing.services.some((item) => item.id === service.id)) existing.services.push(service)
    }
  }
  return [...merged.values()]
}

export async function getLogs(client: MultipriseClient, service: Service, lines = 100) {
  const { logs } = await client.request<{ logs: LogLine[] }>('GET', `/api/projects/${service.id}/logs?tail=${Math.max(1, Math.floor(lines))}`)
  return logs
}

export const formatLogLine = (entry: LogLine) =>
  entry.repeat && entry.repeat > 1 ? `${entry.line}  (×${entry.repeat})` : entry.line
