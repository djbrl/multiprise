import path from 'node:path'
import { detectProject } from './scanner'
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
  for (const project of state.projects) {
    if (!project.root_path) {
      project.root_path = inferRootPath(project.path)
      changed = true
    }

    const inferredRole = inferRoleFromPath(project.path)
    if (!project.role || (project.role === 'service' && inferredRole !== 'service')) {
      project.role = inferredRole
      changed = true
    }

    if (project.kind === 'command') {
      const detection = await detectProject(project.path, project.root_path ?? project.path).catch(() => null)
      const detectedCommand = detection?.suggested_command
      if (detectedCommand && !/^docker(?:-|\s)/.test(detectedCommand) && project.command !== detectedCommand) {
        project.command = detectedCommand
        changed = true
      }
    }
  }
  if (changed) {
    await saveProjects(state.projects)
  }
}
