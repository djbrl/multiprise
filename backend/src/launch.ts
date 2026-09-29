import { type AppState, persistProjects } from './state'
import {
  type Project,
  type ProjectView,
  type StartProjectPayload
} from './types'
import { adaptCommandForFramework, detectProject } from './scanner'
import { isPortAvailable, listListeningPorts, pickAvailablePort } from './ports'
import {
  LaunchCancelledError,
  appendProcessLog,
  clearLogs,
  getProcessPid,
  getProcessStatus,
  markProcessFailed,
  markProcessStarting,
  markProcessStopped,
  startProcess,
  stopProcess
} from './processes'
import { prepareService } from './preparation'
import { projectRoleFallback } from './roles'
import { resolveProjectNodeRuntime } from './runtime'
import { spawnCommand } from './commands'
import { dockerStatus, followDockerLogsFrom, refreshDockerProject } from './docker'
import { envFileStatus, serviceEnvironment } from './environment'
import { launchFailureCode } from './failures'
import { HttpError, isValidPort } from './http'

export const DEFAULT_DOCKER_STOP = 'docker compose down'

export const SERVICE_ROLES = new Set(['backend', 'frontend', 'service'])

// Launches in progress, keyed by project id; Stop and Delete flag them as cancelled.
export type Launches = Map<string, { cancelled: boolean }>

// The request each service was last launched with, so an automatic restart can repeat it.
const lastLaunches = new Map<string, StartProjectPayload>()

export function lastLaunchPayload(id: string): StartProjectPayload | undefined {
  return lastLaunches.get(id)
}

export function cancelLaunch(launches: Launches, id: string) {
  const launch = launches.get(id)
  if (launch) launch.cancelled = true
}

export const buildProjectView = (project: Project): ProjectView => ({
  project,
  status: project.kind === 'docker_compose' ? dockerStatus(project) : getProcessStatus(project.id)
})

// A service keeps the port it had last time whenever that port is still free,
// so its URL, bookmarks and OAuth callbacks survive a relaunch.
export async function previousPortIfFree(project: Project, state: AppState, listening: Array<{ port: number }>) {
  const port = project.port
  if (!port || project.kind === 'docker_compose') return undefined
  if (listening.some((entry) => entry.port === port)) return undefined
  if (state.projects.some((entry) => entry.id !== project.id && entry.port === port)) return undefined
  return await isPortAvailable(port) ? port : undefined
}

export async function resolveStartCommand(project: Project, payload: StartProjectPayload) {
  const detection = await detectProject(project.path, project.root_path ?? project.path)
  const projectCommand = project.command?.trim() ?? ''
  const payloadCommand = payload.command?.trim() ?? ''
  const payloadIsUserOverride = !!payloadCommand && payloadCommand !== projectCommand

  if (project.kind === 'docker_compose') {
    return {
      command: payloadCommand || projectCommand || 'docker compose up -d --build',
      commandSource: payloadIsUserOverride || project.command_source === 'user' ? 'user' as const : 'auto' as const,
      cwd: project.path,
      detection
    }
  }

  const commandSource = payloadIsUserOverride || project.command_source === 'user' ? 'user' as const : 'auto' as const
  const command = commandSource === 'user'
    ? payloadCommand || projectCommand
    : detection.suggested_command?.trim() || payloadCommand || projectCommand

  if (!command || /^docker(?:-|\s)/.test(command)) {
    throw new Error(`No runnable development script found in ${project.path}`)
  }

  return { command, commandSource, cwd: project.path, detection }
}

async function buildStartEnv(options: {
  payloadEnv?: Record<string, string>
  role: 'backend' | 'frontend' | 'service'
  framework?: Project['framework']
  port?: number
}) {
  const { payloadEnv, role, framework, port } = options
  const merged: Record<string, string> = { ...(payloadEnv ?? {}) }
  const backendPort = merged.BACKEND_PORT ? Number(merged.BACKEND_PORT) : role === 'backend' ? port : undefined
  const frontendPort = merged.FRONTEND_PORT ? Number(merged.FRONTEND_PORT) : role === 'frontend' ? port : undefined

  if (backendPort) {
    merged.BACKEND_PORT ||= String(backendPort)
    merged.API_PORT ||= String(backendPort)
    if (role === 'frontend') {
      merged.VITE_API_PORT ||= String(backendPort)
      merged.VITE_API_URL ||= `http://localhost:${backendPort}`
    }
  }
  if (frontendPort) {
    merged.FRONTEND_PORT ||= String(frontendPort)
    merged.VITE_PORT ||= String(frontendPort)
  }
  if (port) {
    merged.PORT ||= String(port)
    merged.SERVICE_PORT ||= String(port)
    if (framework === 'nuxt') {
      merged.NUXT_PORT ||= String(port)
      merged.NITRO_PORT ||= String(port)
    }
    if (framework === 'cargo') {
      merged.ROCKET_PORT ||= String(port)
      merged.LEPTOS_SITE_ADDR ||= `127.0.0.1:${port}`
    }
  }

  return merged
}

// Starts a service and resolves once it is ready. Failures are thrown as HttpErrors
// carrying the status and message the API responds with.
export async function launchService(
  state: AppState,
  launches: Launches,
  project: Project,
  payload: StartProjectPayload,
  // A restart keeps the crashed run's output on screen instead of starting a fresh log.
  options: { keepLogs?: boolean } = {}
): Promise<ProjectView> {
  // Already up (a dependency start may have got there first): nothing to do.
  if (project.kind !== 'docker_compose' && getProcessPid(project.id)) {
    return buildProjectView(project)
  }

  if (payload.role !== undefined && !SERVICE_ROLES.has(payload.role)) {
    throw new HttpError(400, 'Role must be backend, frontend, or service')
  }
  if (payload.command !== undefined && payload.command !== null && typeof payload.command !== 'string') {
    throw new HttpError(400, 'Command must be a string')
  }
  if (payload.env !== undefined && (typeof payload.env !== 'object' || payload.env === null ||
    Object.values(payload.env).some((value) => typeof value !== 'string'))) {
    throw new HttpError(400, 'Environment values must be strings')
  }
  const role = payload.role ?? projectRoleFallback(project)
  if (launches.has(project.id)) {
    throw new HttpError(409, 'This service is already starting')
  }
  // Claimed synchronously so overlapping requests cannot both pass the running check.
  const launch = { cancelled: false }
  launches.set(project.id, launch)
  lastLaunches.set(project.id, { ...payload, role })
  try {
    const usedPorts = new Set<number>()
    const listening = await listListeningPorts()
    listening.forEach((entry) => usedPorts.add(entry.port))
    state.projects.forEach((entry) => {
      if (entry.port) usedPorts.add(entry.port)
    })

    let port = payload.port ?? undefined
    if (port !== undefined && !isValidPort(port)) {
      throw new HttpError(400, 'Port must be an integer between 1 and 65535')
    }
    const autoPort = payload.force_auto_port || state.settings.auto_port
    if (port === undefined && !autoPort && project.port) {
      port = project.port
    }
    if (port && listening.some((entry) => entry.port === port)) {
      throw new HttpError(400, `Port ${port} is already in use`)
    }
    // "Start another instance" forces a fresh port; every other launch reuses the previous one.
    if (!port && autoPort && !payload.force_auto_port) {
      port = await previousPortIfFree(project, state, listening)
    }
    // Compose files declare their own ports, so none is reserved for them.
    if (!port && autoPort && project.kind !== 'docker_compose') {
      const pickedPort = await pickAvailablePort({ role, used: usedPorts, preferredBase: state.settings.port_base })
      if (!pickedPort) {
        throw new HttpError(400, 'No ports available in range')
      }
      port = pickedPort
    }
    if (!port && project.kind !== 'docker_compose') {
      throw new HttpError(400, 'Choose a port before launching this service')
    }

    if (!options.keepLogs) clearLogs(project.id)
    if (project.kind !== 'docker_compose') markProcessStarting(project.id)
    const ensureNotCancelled = () => {
      if (launch.cancelled) throw new LaunchCancelledError()
    }
    try {
      const { command, commandSource, cwd, detection } = await resolveStartCommand(project, payload)
      const framework = detection.framework ?? project.framework ?? 'unknown'
      const defaults = await buildStartEnv({
        payloadEnv: payload.env,
        role,
        framework,
        port
      })
      // The service's own variables win over the defaults, except the port it was given.
      const startEnv = { ...defaults, ...await serviceEnvironment(state, project) }
      if (defaults.PORT) startEnv.PORT = defaults.PORT
      await warnAboutEnvFiles(project)
      const runtime = await resolveProjectNodeRuntime({
        command,
        cwd,
        rootBoundary: project.root_path ?? project.path,
        framework,
        env: startEnv,
        autoInstall: state.settings.auto_install,
        onLog: (line) => appendProcessLog(project.id, 'stdout', line)
      })
      const env = {
        ...startEnv,
        ...(runtime.path ? { PATH: runtime.path } : {})
      }
      ensureNotCancelled()

      project.command = command
      project.command_source = commandSource
      project.package_manager = detection.package_manager ?? project.package_manager ?? null
      project.install_root = detection.package_root ?? project.install_root ?? null
      project.framework = framework
      project.port = port ?? project.port ?? null
      project.last_error = null

      if (project.kind === 'docker_compose') {
        followDockerLogsFrom(project, new Date().toISOString())
        await spawnCommand(command, cwd, env, (stream, line) => appendProcessLog(project.id, stream, line))
        await refreshDockerProject(state, project, true)
        await persistProjects(state)
        return buildProjectView(project)
      }

      await prepareService({
        id: project.id,
        project,
        detection,
        command,
        autoInstall: state.settings.auto_install,
        env
      })
      ensureNotCancelled()
      const launchCommand = adaptCommandForFramework({
        command,
        framework,
        packageManager: project.package_manager,
        port
      })

      await startProcess({
        id: project.id,
        command: launchCommand,
        cwd,
        env,
        port,
        readiness: ['vite', 'next', 'nuxt'].includes(framework) || role === 'frontend' ? 'http' : 'tcp',
        // A first `cargo run` compiles the whole crate before it can listen.
        timeoutMs: framework === 'cargo' ? Math.max(state.settings.startup_timeout_ms, 180000) : state.settings.startup_timeout_ms,
        onExit: (code, error) => {
          project.last_exit_code = code ?? null
          project.last_exit_at = new Date().toISOString()
          project.last_error = error ?? null
          persistProjects(state).catch((err) => console.error('[multiprise] failed to save projects:', err))
        }
      })

      await persistProjects(state)
      return buildProjectView(project)
    } catch (err) {
      if (err instanceof LaunchCancelledError || launch.cancelled) {
        if (project.kind !== 'docker_compose') markProcessStopped(project.id)
        throw new HttpError(409, 'Launch cancelled')
      }
      const message = err instanceof Error ? err.message : 'Failed to start'
      if (project.kind !== 'docker_compose' && getProcessStatus(project.id).phase !== 'failed') {
        markProcessFailed(project.id, message, null, launchFailureCode(message))
      }
      project.last_error = message
      project.last_exit_at = new Date().toISOString()
      await persistProjects(state)
      throw new HttpError(400, message)
    }
  } finally {
    if (launches.get(project.id) === launch) launches.delete(project.id)
  }
}

async function warnAboutEnvFiles(project: Project) {
  const status = await envFileStatus(project)
  if (!status.example || !status.missing.length) return
  const names = status.missing.slice(0, 8).join(', ') + (status.missing.length > 8 ? ', …' : '')
  appendProcessLog(project.id, 'stderr', status.has_env
    ? `[multiprise] ${status.example} lists variables that are not set: ${names}.`
    : `[multiprise] ${status.example} exists but there is no .env, so these are not set: ${names}. Add them to the service's environment in Multiprise, or create .env.`)
}

// Rejects links to unknown services, to the service itself, or that would form a cycle.
export function validateLinks(state: AppState, project: Project, links: unknown): string[] {
  if (!Array.isArray(links) || links.some((id) => typeof id !== 'string')) throw new HttpError(400, 'links must be a list of service ids')
  const unique = [...new Set(links as string[])]
  for (const id of unique) {
    if (id === project.id) throw new HttpError(400, 'A service cannot depend on itself')
    if (!state.projects.some((entry) => entry.id === id)) throw new HttpError(400, `No service with id ${id}`)
  }
  const linksOf = (entry: Project) => entry.id === project.id ? unique : entry.links ?? []
  const visiting = new Set<string>()
  const visit = (id: string, trail: string[]): void => {
    if (id === project.id && trail.length) {
      const names = [...trail, id].map((entry) => state.projects.find((item) => item.id === entry)?.name ?? entry)
      throw new HttpError(400, `That would make a loop: ${names.join(' → ')}`)
    }
    if (visiting.has(id)) return
    visiting.add(id)
    const entry = state.projects.find((item) => item.id === id)
    for (const next of entry ? linksOf(entry) : []) visit(next, [...trail, id])
  }
  for (const id of unique) visit(id, [project.id])
  return unique
}

// Every service the given one depends on, directly or not, dependencies first.
export function dependencyOrder(state: AppState, project: Project): Project[] {
  const ordered: Project[] = []
  const seen = new Set<string>([project.id])
  const visit = (entry: Project) => {
    for (const id of entry.links ?? []) {
      const dependency = state.projects.find((item) => item.id === id)
      if (!dependency || seen.has(id)) continue
      seen.add(id)
      visit(dependency)
      ordered.push(dependency)
    }
  }
  visit(project)
  return ordered
}

const isUp = (project: Project) =>
  project.kind === 'docker_compose' ? !!project.docker_running : getProcessStatus(project.id).running

// BACKEND_PORT/FRONTEND_PORT as the app's Launch button passes them, from the project's
// primary backend and frontend, for starts that do not come from that button.
export function siblingPortEnv(state: AppState, project: Project): Record<string, string> {
  const root = project.root_path ?? project.path
  const siblings = state.projects.filter((entry) => (entry.root_path ?? entry.path) === root && entry.kind !== 'docker_compose')
  const portOf = (role: string) => siblings.find((entry) => projectRoleFallback(entry) === role)?.port
  const env: Record<string, string> = {}
  const backendPort = portOf('backend')
  const frontendPort = portOf('frontend')
  if (backendPort) env.BACKEND_PORT = String(backendPort)
  if (frontendPort) env.FRONTEND_PORT = String(frontendPort)
  return env
}

// Starts stopped dependencies first (each with the settings it last started with), then the service.
export async function launchWithDependencies(state: AppState, launches: Launches, project: Project, payload: StartProjectPayload) {
  const dependencies = dependencyOrder(state, project)
  // Reserve the service's port first, so dependencies starting now are told the right one.
  if (dependencies.some((dependency) => !isUp(dependency)) && payload.port === undefined &&
    project.kind !== 'docker_compose' && state.settings.auto_port && !isUp(project)) {
    const listening = await listListeningPorts()
    const used = new Set<number>(listening.map((entry) => entry.port))
    state.projects.forEach((entry) => { if (entry.port && entry.id !== project.id) used.add(entry.port) })
    const port = await previousPortIfFree(project, state, listening) ??
      await pickAvailablePort({ role: payload.role ?? projectRoleFallback(project), used, preferredBase: state.settings.port_base })
    if (port) {
      payload = { ...payload, port }
      project.port = port
    }
  }
  for (const dependency of dependencies) {
    // Someone else is starting it: wait for that launch instead of racing it.
    const deadline = Date.now() + Math.max(state.settings.startup_timeout_ms, 30000)
    while (launches.has(dependency.id) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 150))
    if (isUp(dependency)) continue
    try {
      await launchService(state, launches, dependency, lastLaunchPayload(dependency.id) ?? { env: siblingPortEnv(state, dependency) })
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400
      throw new HttpError(status, `${dependency.name}, which ${project.name} depends on, could not start: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return launchService(state, launches, project, payload)
}

export async function stopService(state: AppState, launches: Launches, project: Project): Promise<ProjectView> {
  if (project.kind === 'docker_compose') {
    const stopCommand = project.stop_command || DEFAULT_DOCKER_STOP
    try {
      await spawnCommand(stopCommand, project.path, undefined, (stream, line) => appendProcessLog(project.id, stream, line))
    } catch (err) {
      throw new HttpError(400, `Failed to stop docker project. ${err instanceof Error ? err.message : ''}`.trim())
    }
    await refreshDockerProject(state, project, true)
    return buildProjectView(project)
  }

  cancelLaunch(launches, project.id)
  await stopProcess(project.id)
  await persistProjects(state)
  return buildProjectView(project)
}
