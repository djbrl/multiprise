import { loadProjects, loadSettings, saveProjects, saveSettings } from './store'
import { loadMultipriseConfig, selectService } from './multipriseconfig'
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
  const normalized = value.toLowerCase()
  if (normalized.includes('/frontend')) return 'frontend'
  if (normalized.includes('/backend')) return 'backend'
  return 'service'
}

export async function normalizeProjects(state: AppState) {
  let changed = false
  for (const project of state.projects) {
    if (!project.root_path) {
      try {
        const configInfo = await loadMultipriseConfig(project.path)
        if (configInfo) {
          project.root_path = configInfo.rootDir
          try {
            const selection = selectService({
              rootDir: configInfo.rootDir,
              config: configInfo.config,
              projectPath: project.path
            })
            const inferredRole = inferRoleFromPath(project.path)
            const configuredRole = selection.service.role
            const nextRole = configuredRole && configuredRole !== 'service'
              ? configuredRole
              : inferredRole
            if (project.role !== nextRole) {
              project.role = nextRole
              changed = true
            }
          } catch (err) {
            // ignore
          }
          changed = true
        }
      } catch (err) {
        // ignore
      }
      if (!project.root_path) {
        project.root_path = project.path
        changed = true
      }
    }
    const inferredRole = inferRoleFromPath(project.path)
    if (!project.role || (project.role === 'service' && inferredRole !== 'service')) {
      project.role = inferredRole
      changed = true
    }
  }
  if (changed) {
    await saveProjects(state.projects)
  }
}
