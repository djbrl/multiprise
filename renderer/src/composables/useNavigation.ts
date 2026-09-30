import { computed, ref, watch } from 'vue'
import { readStored, readStoredJson, STORAGE_KEYS, writeStored, writeStoredJson } from '../lib/storage'
import { type Group, type ProjectView } from '../types'
import { useProjects } from './useProjects'

// Which page is showing and which project is open.

export type Section = 'home' | 'projects' | 'settings'

const { folderGroups, onProjectsLoaded, groupForService } = useProjects()

const activeSection = ref<Section>('home')
const selectedGroupKey = ref<string | null>(null)
const projectPanelMode = ref<'logs' | 'browser'>('logs')
const projectsExpanded = ref(true)
const recentGroupKeys = ref<string[]>([])
const restoreProjectOnLoad = ref(false)

const selectedGroup = computed(() => folderGroups.value.find((group) => group.key === selectedGroupKey.value) ?? null)

// Home lists the most recently opened projects first.
const homeProjectGroups = computed(() => {
  const byKey = new Map(folderGroups.value.map((group) => [group.key, group]))
  const ordered = recentGroupKeys.value
    .map((key) => byKey.get(key))
    .filter((group): group is Group<ProjectView> => !!group)
  const recentKeys = new Set(ordered.map((group) => group.key))
  for (const group of folderGroups.value) {
    if (!recentKeys.has(group.key)) ordered.push(group)
  }
  return ordered.slice(0, 5)
})

watch(selectedGroupKey, (key) => writeStored(STORAGE_KEYS.selectedGroup, key))

function rememberGroup(key: string) {
  recentGroupKeys.value = [key, ...recentGroupKeys.value.filter((entry) => entry !== key)].slice(0, 8)
  writeStoredJson(STORAGE_KEYS.recentGroups, recentGroupKeys.value)
}

function openDetails(group: Group<ProjectView>) {
  rememberGroup(group.key)
  activeSection.value = 'projects'
  selectedGroupKey.value = group.key
}

function openServiceProject(service: ProjectView) {
  const group = groupForService(service.project.id)
  if (group) openDetails(group)
}

// From the sidebar's port list, which does not count as opening the project.
function openGroupForService(id: string) {
  const group = groupForService(id)
  if (!group) return
  activeSection.value = 'projects'
  projectsExpanded.value = true
  selectedGroupKey.value = group.key
}

function goHome() {
  activeSection.value = 'home'
  selectedGroupKey.value = null
}

// A reload (same session) reopens the project that was open; a fresh launch starts home.
function initializeNavigation() {
  activeSection.value = 'home'
  selectedGroupKey.value = null
  const recent = readStoredJson(STORAGE_KEYS.recentGroups)
  if (Array.isArray(recent)) {
    recentGroupKeys.value = recent.filter((key): key is string => typeof key === 'string').slice(0, 8)
  }
  restoreProjectOnLoad.value = readStored(STORAGE_KEYS.navigationSession, sessionStorage) === 'active'
  writeStored(STORAGE_KEYS.navigationSession, 'active', sessionStorage)
}

onProjectsLoaded((_ids, groups) => {
  // Restore once; later loads (every start refreshes them) must not pull the user away.
  if (restoreProjectOnLoad.value) {
    restoreProjectOnLoad.value = false
    const stored = readStored(STORAGE_KEYS.selectedGroup)
    if (!selectedGroupKey.value && stored && groups.some((group) => group.key === stored)) {
      selectedGroupKey.value = stored
      activeSection.value = 'projects'
      projectsExpanded.value = true
    }
  }
  if (selectedGroupKey.value && !groups.some((group) => group.key === selectedGroupKey.value)) {
    selectedGroupKey.value = null
  }
})

export function useNavigation() {
  return {
    activeSection,
    selectedGroupKey,
    selectedGroup,
    projectPanelMode,
    projectsExpanded,
    homeProjectGroups,
    openDetails,
    openServiceProject,
    openGroupForService,
    goHome,
    initializeNavigation
  }
}
