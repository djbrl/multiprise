import { type Group, type ProjectView, type ServiceRole } from '../types'

// Pure helpers about services and project groups; no state lives here.

export function normalizePath(path: string) {
  if (path.length > 1 && path.endsWith('/')) {
    return path.replace(/\/+$/, '')
  }
  return path
}

export function folderLabel(path: string) {
  const parts = normalizePath(path).split('/').filter(Boolean)
  return parts[parts.length - 1] || path
}

export function parsePort(value: string) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function projectTitle(item: ProjectView) {
  return item.project.name || item.project.path.split('/').pop() || 'Untitled'
}

export function projectRootPath(item: ProjectView) {
  return item.project.root_path ?? item.project.path
}

// "project / service", or just the name when the project has a single service named after it.
export function serviceDisplayName(service: ProjectView) {
  const project = folderLabel(projectRootPath(service))
  const name = projectTitle(service)
  return project === name ? name : `${project} / ${name}`
}

export function serviceReady(service: ProjectView) {
  return service.status.phase === 'ready' || (service.status.ready && service.status.running)
}

export function serviceStarting(service: ProjectView) {
  return service.status.phase === 'starting'
}

export function serviceFailed(service: ProjectView) {
  return service.status.phase === 'failed'
}

export function serviceStatusLabel(service: ProjectView) {
  if (serviceStarting(service)) return 'Starting'
  if (serviceReady(service)) return 'Ready'
  if (serviceFailed(service)) return 'Failed'
  return 'Stopped'
}

export function isDockerService(item: ProjectView) {
  return item.project.kind === 'docker_compose'
}

const backendKeywords = new Set(['backend', 'server', 'api'])
const frontendKeywords = new Set(['frontend', 'client', 'web', 'app', 'ui'])

// Words from the service's own folders (relative to its project root) and name.
// Matching whole words avoids misreading parents like "~/capital" or "/Applications".
function serviceRoleWords(item: ProjectView) {
  const servicePath = normalizePath(item.project.path)
  const rootPath = normalizePath(item.project.root_path ?? item.project.path)
  const relative = servicePath.startsWith(`${rootPath}/`) ? servicePath.slice(rootPath.length + 1) : ''
  return `${relative}/${projectTitle(item)}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

export function serviceRole(item: ProjectView): ServiceRole {
  // Discovery already classified the service from its folder, framework and scripts.
  if (item.project.role === 'backend' || item.project.role === 'frontend') return item.project.role
  const words = serviceRoleWords(item)
  if (words.some((word) => backendKeywords.has(word))) return 'backend'
  if (words.some((word) => frontendKeywords.has(word))) return 'frontend'
  return 'service'
}

export function serviceMetaLabels(item: ProjectView) {
  const labels: string[] = []
  const role = serviceRole(item)
  if (role !== 'service') {
    labels.push(role.charAt(0).toUpperCase() + role.slice(1))
  }
  if (isDockerService(item)) {
    labels.push('Docker')
  }
  return labels
}

export function groupByFolder<T>(items: T[], getPath: (item: T) => string): Group<T>[] {
  const groups = new Map<string, Group<T>>()
  items.forEach((item) => {
    const groupKey = normalizePath(getPath(item))
    const group = groups.get(groupKey)
    if (group) {
      group.items.push(item)
    } else {
      groups.set(groupKey, {
        key: groupKey,
        name: groupKey.split('/').filter(Boolean).pop() || groupKey,
        path: groupKey,
        items: [item]
      })
    }
  })

  const grouped = Array.from(groups.values())
  grouped.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
  grouped.forEach((group) => {
    group.items.sort((a, b) => normalizePath(getPath(a)).localeCompare(normalizePath(getPath(b)), undefined, { numeric: true }))
  })
  return grouped
}

export function groupInitials(group: Group<ProjectView>) {
  const name = group.name.trim()
  if (!name) return '?'
  const parts = name.split(/[\s_-]+/).filter(Boolean)
  const letters = parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '')
  return letters.join('') || name.slice(0, 1).toUpperCase()
}

// Launch and Stop act on script services; Docker services are started one by one.
const scriptServices = (group: Group<ProjectView>) => group.items.filter((item) => !isDockerService(item))

export function groupServiceCount(group: Group<ProjectView>) {
  return scriptServices(group).length
}

export function groupReadyCount(group: Group<ProjectView>) {
  return scriptServices(group).filter(serviceReady).length
}

export function groupHasNpmServices(group: Group<ProjectView>) {
  return groupServiceCount(group) > 0
}

export function groupHasRunning(group: Group<ProjectView>) {
  return scriptServices(group).some((item) => item.status.running)
}

export function groupIsLive(group: Group<ProjectView>) {
  return group.items.some(serviceReady)
}

// A path's project name, skipping a trailing backend/ or frontend/ folder.
export function deriveProjectNameFromPath(path: string) {
  const parts = normalizePath(path).split('/').filter(Boolean)
  if (parts.length === 0) return ''
  const last = parts[parts.length - 1]
  if (last === 'backend' || last === 'frontend') {
    return parts[parts.length - 2] ?? last
  }
  return last
}
