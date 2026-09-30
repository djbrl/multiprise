import { computed, reactive, ref } from 'vue'
import { apiBase, apiFetch, apiToken } from '../lib/api'
import { groupByFolder, projectRootPath, serviceRole } from '../lib/services'
import { type Group, type ProjectView } from '../types'

// Every tracked service with its status, grouped by project folder, and the app-wide
// error line.

const projects = ref<ProjectView[]>([])
const loading = ref(false)
const hasLoadedOnce = ref(false)
const error = ref('')
const faviconFailed = reactive<Record<string, boolean>>({})

const folderGroups = computed(() => groupByFolder(projects.value, projectRootPath))

// Other state keyed by service or project drops what no longer exists after each load.
type LoadedHandler = (ids: Set<string>, groups: Group<ProjectView>[]) => void
const loadedHandlers: LoadedHandler[] = []

function onProjectsLoaded(handler: LoadedHandler) {
  loadedHandlers.push(handler)
}

export function pruneRecord(record: Record<string, unknown>, keep: (key: string) => boolean) {
  Object.keys(record).forEach((key) => {
    if (!keep(key)) delete record[key]
  })
}

onProjectsLoaded((ids) => pruneRecord(faviconFailed, (id) => ids.has(id)))

// Background polling must not wipe errors raised by user actions, so it only
// clears the error it set itself.
let projectsLoadError = ''

async function loadProjects(options: { showLoading?: boolean } = {}) {
  if (options.showLoading || !hasLoadedOnce.value) {
    loading.value = true
  }
  try {
    const response = await apiFetch('/api/projects')
    if (!response.ok) {
      throw new Error('Failed to load projects')
    }
    const data = (await response.json()) as { projects: ProjectView[] }
    projects.value = data.projects
    hasLoadedOnce.value = true
    const ids = new Set(data.projects.map((item) => item.project.id))
    const groups = groupByFolder(data.projects, projectRootPath)
    loadedHandlers.forEach((handler) => handler(ids, groups))
    if (projectsLoadError && error.value === projectsLoadError) error.value = ''
    projectsLoadError = ''
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    projectsLoadError = message === 'Failed to fetch' || message === 'Backend not available'
      ? 'Cannot reach the Multiprise service manager. Retrying…'
      : message
    error.value = projectsLoadError
  } finally {
    loading.value = false
  }
}

function projectById(id: string | null | undefined) {
  return id ? projects.value.find((item) => item.project.id === id) ?? null : null
}

function groupForService(id: string) {
  return folderGroups.value.find((group) => group.items.some((item) => item.project.id === id)) ?? null
}

// The icon shown for a project: its frontend's favicon when it has one, then any service's.
function groupFaviconId(group: Group<ProjectView>) {
  const frontends = group.items.filter((item) => serviceRole(item) === 'frontend')
  const others = group.items.filter((item) => serviceRole(item) !== 'frontend')
  return [...frontends, ...others].map((item) => item.project.id).find((id) => !faviconFailed[id]) ?? null
}

function groupFaviconUrl(group: Group<ProjectView>) {
  const id = groupFaviconId(group)
  return id && apiBase.value
    ? `${apiBase.value}/api/projects/${id}/favicon?token=${encodeURIComponent(apiToken.value)}`
    : ''
}

function handleFaviconError(group: Group<ProjectView>) {
  const id = groupFaviconId(group)
  if (id) faviconFailed[id] = true
}

export function useProjects() {
  return {
    projects,
    loading,
    error,
    folderGroups,
    loadProjects,
    onProjectsLoaded,
    projectById,
    groupForService,
    groupFaviconUrl,
    handleFaviconError
  }
}
