import { computed, reactive, ref } from 'vue'
import { apiFetch, errorMessage, jsonBody, throwResponseError } from '../lib/api'
import { folderLabel, normalizePath, projectRootPath } from '../lib/services'
import { readStoredJson, STORAGE_KEYS, writeStoredJson } from '../lib/storage'
import { type ProjectInspectResult, type RecentProject } from '../types'
import { useOverlays } from './useOverlays'
import { useProjects } from './useProjects'

// The Add Projects dialog: chosen folders with the services found in each, and folders
// added before, offered again once they are untracked.

const { pickerOpen } = useOverlays()
const { projects, error, loadProjects } = useProjects()

const selectedFolders = ref<string[]>([])
const projectPreviewMap = reactive<Record<string, ProjectInspectResult>>({})
const addingProjects = ref(false)
const recentProjects = ref<RecentProject[]>([])
const importLoading = reactive<Record<string, boolean>>({})

const validSelectedFolders = computed(() => selectedFolders.value.filter((path) => projectPreviewMap[path]?.has_services))

const recentImportable = computed(() =>
  recentProjects.value
    .filter((recent) => !projects.value.some((project) => normalizePath(projectRootPath(project)) === normalizePath(recent.path)))
    .slice(0, 3)
)

function loadRecentProjects() {
  const stored = readStoredJson(STORAGE_KEYS.recentScan)
  if (!Array.isArray(stored)) return
  recentProjects.value = stored.filter((entry): entry is RecentProject => !!entry && typeof entry.path === 'string')
}

function rememberRecentProjects(added: RecentProject[]) {
  if (!added.length) return
  const now = new Date().toISOString()
  const byPath = new Map<string, RecentProject>()
  added.forEach((project) => byPath.set(normalizePath(project.path), { ...project, last_seen: now }))
  recentProjects.value.forEach((project) => {
    const key = normalizePath(project.path)
    if (!byPath.has(key)) byPath.set(key, project)
  })
  recentProjects.value = Array.from(byPath.values()).slice(0, 12)
  writeStoredJson(STORAGE_KEYS.recentScan, recentProjects.value)
}

async function refreshProjectPreviews() {
  if (selectedFolders.value.length === 0) return
  try {
    const response = await apiFetch('/api/projects/inspect', jsonBody('POST', { roots: selectedFolders.value }))
    if (!response.ok) throw new Error('Inspect failed')
    const data = (await response.json()) as { projects: ProjectInspectResult[] }
    data.projects.forEach((project) => {
      projectPreviewMap[project.path] = project
    })
  } catch (err) {
    // The folders stay listed as "Discovering services…"; choosing again retries.
  }
}

async function openPicker() {
  pickerOpen.value = true
  if (selectedFolders.value.length) await refreshProjectPreviews()
}

function closePicker() {
  pickerOpen.value = false
}

async function pickFolders() {
  error.value = ''
  try {
    const response = await apiFetch('/api/fs/pick', { method: 'POST' })
    if (!response.ok) throw new Error('Folder picker failed')
    const data = (await response.json()) as { paths: string[] }
    if (data.paths.length) await addFolders(data.paths)
  } catch (err) {
    error.value = errorMessage(err)
  }
}

// Chosen or dropped folders: listed with their services before anything is saved.
async function addFolders(paths: string[]) {
  selectedFolders.value = Array.from(new Set([...selectedFolders.value, ...paths]))
  if (pickerOpen.value) await refreshProjectPreviews()
  else await openPicker()
}

function removeSelectedFolder(path: string) {
  selectedFolders.value = selectedFolders.value.filter((entry) => entry !== path)
  delete projectPreviewMap[path]
}

async function addProject(path: string, name?: string) {
  const response = await apiFetch('/api/projects', jsonBody('POST', { path, name }))
  if (!response.ok) await throwResponseError(response, 'Failed to add project')
}

async function addSelectedProjects() {
  const selected = validSelectedFolders.value
  if (!selected.length || addingProjects.value) return
  error.value = ''
  addingProjects.value = true
  try {
    rememberRecentProjects(selected.map((path) => ({ path, name: folderLabel(path) })))
    // Add every folder even if one fails, and keep only the failures selected for a retry.
    const failures: string[] = []
    for (const path of selected) {
      try {
        await addProject(path)
        removeSelectedFolder(path)
      } catch (err) {
        const message = errorMessage(err, 'Failed to add project')
        if (message === 'Project already exists') {
          removeSelectedFolder(path)
          continue
        }
        failures.push(`${folderLabel(path)}: ${message}`)
      }
    }
    await loadProjects()
    if (failures.length) {
      error.value = `Could not add ${failures.length === 1 ? 'a folder' : `${failures.length} folders`} — ${failures.join('; ')}`
      return
    }
    pickerOpen.value = false
    selectedFolders.value = []
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    addingProjects.value = false
  }
}

async function importRecentProject(project: RecentProject) {
  if (importLoading[project.path]) return
  error.value = ''
  importLoading[project.path] = true
  try {
    rememberRecentProjects([project])
    await addProject(project.path, project.name)
    await loadProjects()
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    importLoading[project.path] = false
  }
}

export function useProjectPicker() {
  return {
    selectedFolders,
    projectPreviewMap,
    validSelectedFolders,
    addingProjects,
    recentImportable,
    importLoading,
    loadRecentProjects,
    openPicker,
    closePicker,
    pickFolders,
    addFolders,
    removeSelectedFolder,
    addSelectedProjects,
    importRecentProject
  }
}
