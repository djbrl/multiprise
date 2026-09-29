import path from 'node:path'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { publish } from './events'
import { detectProject, discoverProjectServices } from './scanner'
import { loadProjects, loadSettings, saveProjects, saveSettings } from './store'
import { type Project, type Settings, type ScanState } from './types'

export type AppState = {
  projects: Project[]
  settings: Settings
  scans: Map<string, ScanState>
}

export async function createState(): Promise<AppState> {
  const projects = await loadProjects()
  const settings = await loadSettings()
  return {
    projects,
    settings,
    scans: new Map()
  }
}

export async function persistProjects(state: AppState) {
  await saveProjects(state.projects)
  publish({ type: 'projects' })
}

export async function persistSettings(state: AppState) {
  await saveSettings(state.settings)
}

function inferRoleFromPath(value: string): 'backend' | 'frontend' | 'service' {
  const segments = value.toLowerCase().split(/[\\/]/)
  if (segments.some((segment) => ['frontend', 'client', 'web', 'ui'].includes(segment))) return 'frontend'
  if (segments.some((segment) => ['backend', 'server', 'api'].includes(segment))) return 'backend'
  return 'service'
}

function inferRootPath(projectPath: string) {
  const serviceFolder = path.basename(projectPath).toLowerCase()
  if (['backend', 'frontend', 'server', 'client', 'api', 'web', 'ui'].includes(serviceFolder)) {
    return path.dirname(projectPath)
  }
  return projectPath
}

export async function normalizeProjects(state: AppState) {
  let changed = false
  const roots = new Map<string, Project[]>()
  for (const project of state.projects) {
    const root = path.resolve(project.root_path ?? inferRootPath(project.path))
    const entries = roots.get(root) ?? []
    entries.push(project)
    roots.set(root, entries)
  }

  for (const [root, existing] of roots) {
    const rootStats = await fs.stat(root).catch(() => null)
    if (!rootStats?.isDirectory()) continue

    const discovered = await discoverProjectServices(root, state.settings).catch(() => [])
    if (!discovered.length) continue

    const claimed = new Set<string>()
    const reconciled: Project[] = []
    for (const service of discovered) {
      const exact = existing.find((project) =>
        !claimed.has(project.id) && path.resolve(project.path) === path.resolve(service.path) && project.kind === service.kind
      )
      const roleMatch = exact ?? existing.find((project) =>
        !claimed.has(project.id) && project.role === service.role && project.kind === service.kind
      )
      const previous = roleMatch
      if (previous) claimed.add(previous.id)
      const samePath = !!previous && path.resolve(previous.path) === path.resolve(service.path)

      reconciled.push({
        id: previous?.id ?? randomUUID(),
        name: service.name,
        path: service.path,
        root_path: root,
        tags: previous?.tags ?? [],
        command: samePath && previous?.command_source === 'user' ? previous.command : service.command,
        command_source: samePath && previous?.command_source === 'user' ? 'user' : 'auto',
        package_manager: service.package_manager ?? null,
        install_root: service.install_root ?? null,
        framework: service.framework,
        stop_command: service.kind === 'docker_compose' ? (previous?.stop_command || 'docker compose down') : previous?.stop_command ?? null,
        port: previous?.port ?? null,
        icon_path: previous?.icon_path ?? existing.find((project) => project.icon_path)?.icon_path ?? null,
        kind: service.kind,
        role: service.role,
        docker_running: false,
        docker_started_at: null,
        last_exit_code: previous?.last_exit_code ?? null,
        last_exit_at: previous?.last_exit_at ?? null,
        last_error: null,
        created_at: previous?.created_at ?? new Date().toISOString(),
        ...(previous?.env ? { env: previous.env } : {}),
        ...(previous?.secret_env ? { secret_env: previous.secret_env } : {}),
        ...(previous?.links ? { links: previous.links } : {})
      })
    }

    const retained: Project[] = []
    for (const project of existing) {
      if (claimed.has(project.id) || project.command_source !== 'user') continue
      const stats = await fs.stat(project.path).catch(() => null)
      if (stats?.isDirectory()) retained.push(project)
    }
    const fingerprint = (project: Project) => JSON.stringify({
      id: project.id,
      name: project.name,
      path: project.path,
      command: project.command,
      command_source: project.command_source,
      package_manager: project.package_manager,
      install_root: project.install_root,
      framework: project.framework,
      kind: project.kind,
      role: project.role,
      links: project.links
    })
    const before = existing.map(fingerprint).sort().join('|')
    const after = [...reconciled, ...retained].map(fingerprint).sort().join('|')
    if (before !== after) {
      state.projects = state.projects.filter((project) => !existing.includes(project))
      state.projects.push(...reconciled, ...retained)
      changed = true
    }
  }

  // A rescan can drop services; links to them go too.
  const ids = new Set(state.projects.map((project) => project.id))
  for (const project of state.projects) {
    if (project.links?.some((id) => !ids.has(id))) {
      project.links = project.links.filter((id) => ids.has(id))
      changed = true
    }
  }

  for (const project of state.projects) {
    if (!project.root_path) {
      project.root_path = inferRootPath(project.path)
      changed = true
    }

    // Only folders inside the project count; parent directories say nothing about the service.
    const inferredRole = inferRoleFromPath(path.relative(project.root_path ?? project.path, project.path))
    if (!project.role || (project.role === 'service' && inferredRole !== 'service')) {
      project.role = inferredRole
      changed = true
    }

    if (!project.command_source) {
      project.command_source = 'auto'
      changed = true
    }

    if (project.kind === 'command') {
      const detection = await detectProject(project.path, project.root_path ?? project.path).catch(() => null)
      const detectedCommand = detection?.suggested_command
      if (project.command_source !== 'user' && detectedCommand && !/^docker(?:-|\s)/.test(detectedCommand) && project.command !== detectedCommand) {
        project.command = detectedCommand
        changed = true
      }
      if (detection && project.package_manager !== detection.package_manager) {
        project.package_manager = detection.package_manager
        changed = true
      }
      if (detection && project.install_root !== detection.package_root) {
        project.install_root = detection.package_root
        changed = true
      }
      if (detection && project.framework !== detection.framework) {
        project.framework = detection.framework
        changed = true
      }
    }
  }
  if (changed) {
    await saveProjects(state.projects)
  }
}
