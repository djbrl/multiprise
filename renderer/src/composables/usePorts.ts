import { ref } from 'vue'
import { apiFetch } from '../lib/api'
import { deriveProjectNameFromPath, normalizePath, projectRootPath, projectTitle } from '../lib/services'
import { type UsedPort } from '../types'
import { useProjects } from './useProjects'

// Listening ports on this Mac, for the sidebar's "Plugged in" list. External processes can
// take or release a port without Multiprise hearing about it, so this one is polled.

const { projects, folderGroups } = useProjects()

const usedPorts = ref<UsedPort[]>([])
const portsLoading = ref(false)
const portsRefreshing = ref(false)
const portsError = ref('')
const activePortsExpanded = ref(true)
const PORTS_REFRESH_MS = 10000
let lastPortsRefreshAt = 0
let portsReloadTimer: number | undefined

function usedPortsMatch(current: UsedPort[], incoming: UsedPort[]) {
  if (current.length !== incoming.length) return false
  return current.every((entry, index) => {
    const candidate = incoming[index]
    return candidate && entry.port === candidate.port && entry.pid === candidate.pid && entry.project_id === candidate.project_id && entry.source === candidate.source
  })
}

async function fetchUsedPorts(options: { silent?: boolean } = {}) {
  if (portsRefreshing.value) return
  portsRefreshing.value = true
  portsError.value = ''
  if (!options.silent) portsLoading.value = true
  try {
    const response = await apiFetch('/api/ports/used')
    if (!response.ok) throw new Error('Failed to load ports')
    const data = (await response.json()) as { ports: UsedPort[] }
    // Keep the same array when nothing changed, so the list does not re-render.
    if (!usedPortsMatch(usedPorts.value, data.ports)) usedPorts.value = data.ports
    lastPortsRefreshAt = Date.now()
  } catch (err) {
    portsError.value = err instanceof Error ? err.message : 'Unknown error'
  } finally {
    portsRefreshing.value = false
    if (!options.silent) portsLoading.value = false
  }
}

// After a status change: give a service that just became ready a moment to show up in lsof.
function schedulePortsReload() {
  if (!activePortsExpanded.value || portsReloadTimer) return
  portsReloadTimer = window.setTimeout(async () => {
    portsReloadTimer = undefined
    await fetchUsedPorts({ silent: true })
  }, 600)
}

async function refreshPortsIfStale() {
  if (document.hidden || projects.value.length === 0 || !activePortsExpanded.value) return
  if (Date.now() - lastPortsRefreshAt >= PORTS_REFRESH_MS) {
    await fetchUsedPorts({ silent: true })
  }
}

function stopPortsPolling() {
  if (portsReloadTimer) window.clearTimeout(portsReloadTimer)
  portsReloadTimer = undefined
}

function toggleActivePorts() {
  activePortsExpanded.value = !activePortsExpanded.value
  if (activePortsExpanded.value) fetchUsedPorts()
}

function usedPortProjectName(item: UsedPort) {
  const matchedProject = item.project_id ? projects.value.find((project) => project.project.id === item.project_id) : undefined
  const pathForName = matchedProject ? projectRootPath(matchedProject) : item.project_path
  if (pathForName) {
    const derived = deriveProjectNameFromPath(pathForName)
    if (derived) return derived
  }
  if (item.project_id) {
    if (matchedProject) {
      const name = projectTitle(matchedProject).trim()
      if (name) return name
    }
    const group = folderGroups.value.find((entry) => entry.items.some((project) => project.project.id === item.project_id))
    if (group) return group.name
  }
  if (item.project_name?.trim()) return item.project_name
  if (item.project_path) {
    const normalized = normalizePath(item.project_path)
    const direct = projects.value.find((project) => normalizePath(projectRootPath(project)) === normalized)
    if (direct) return projectTitle(direct)
    const group = folderGroups.value.find((entry) => normalized.startsWith(normalizePath(entry.path)))
    if (group) return group.name
    const parts = item.project_path.split('/').filter(Boolean)
    return parts[parts.length - 1] ?? item.project_path
  }
  return 'External'
}

function usedPortTitle(item: UsedPort) {
  const match = item.project_id ? projects.value.find((project) => project.project.id === item.project_id) : undefined
  const detail = match ? projectRootPath(match) : item.project_path ?? ''
  const name = usedPortProjectName(item)
  return detail ? `${name} — ${detail}` : name
}

export function usePorts() {
  return {
    usedPorts,
    portsLoading,
    portsError,
    activePortsExpanded,
    fetchUsedPorts,
    schedulePortsReload,
    refreshPortsIfStale,
    stopPortsPolling,
    toggleActivePorts,
    usedPortProjectName,
    usedPortTitle
  }
}
