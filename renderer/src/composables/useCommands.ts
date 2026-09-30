import { computed, nextTick } from 'vue'
import { type PaletteCommand } from '../components/CommandPalette.vue'
import { groupHasRunning, projectTitle, serviceReady, serviceStatusLabel } from '../lib/services'
import { useBrowserTabs } from './useBrowserTabs'
import { useLogs } from './useLogs'
import { useNavigation } from './useNavigation'
import { useOverlays } from './useOverlays'
import { useProjectPicker } from './useProjectPicker'
import { useProjects } from './useProjects'
import { useServiceActions } from './useServiceActions'
import { useSettings } from './useSettings'

// The command palette's commands and the app-wide keyboard shortcuts.

const { folderGroups } = useProjects()
const { activeSection, selectedGroup, projectPanelMode, openDetails, goHome } = useNavigation()
const { paletteOpen, onboardingOpen, configServiceId, closeGroupMenu, closeExternalMenus } = useOverlays()
const { settings, patchSetting } = useSettings()
const { logViewer } = useLogs()
const { openPicker } = useProjectPicker()
const { openInAppBrowser } = useBrowserTabs()
const {
  groupActionLoading, projectUrl, toggleService, runFailureAction, openProjectUrl, copyProjectUrl,
  launchGroup, stopGroup, groupPrimaryAction, closeManualPortPrompt
} = useServiceActions()

async function showLogs(search?: string) {
  const group = selectedGroup.value ?? folderGroups.value[0]
  if (!group) return
  openDetails(group)
  projectPanelMode.value = 'logs'
  await nextTick()
  if (search !== undefined) logViewer.value?.search(search)
  else logViewer.value?.focusSearch()
}

const paletteCommands = computed<PaletteCommand[]>(() => {
  const commands: PaletteCommand[] = []
  folderGroups.value.forEach((group, index) => {
    commands.push({
      id: `open:${group.key}`,
      group: 'Projects',
      title: group.name,
      subtitle: group.path,
      shortcut: index < 9 ? `⌘${index + 1}` : undefined,
      keywords: group.items.map(projectTitle).join(' '),
      run: () => openDetails(group)
    })
  })
  for (const group of folderGroups.value) {
    const running = groupHasRunning(group)
    const launching = groupActionLoading[group.key] === 'launch'
    commands.push({
      id: `group:${group.key}`,
      group: 'Projects',
      title: launching ? `Cancel launching ${group.name}` : running ? `Stop ${group.name}` : `Launch ${group.name}`,
      subtitle: launching ? 'Stop the services this launch started' : running ? 'Stop every service of the project' : 'Start every service, backends first',
      run: () => groupPrimaryAction(group, running)
    })
  }
  for (const group of folderGroups.value) {
    for (const service of group.items) {
      const name = projectTitle(service) === group.name ? group.name : `${group.name}/${projectTitle(service)}`
      const id = service.project.id
      commands.push({
        id: `toggle:${id}`,
        group: 'Services',
        title: service.status.running ? `Stop ${name}` : `Start ${name}`,
        subtitle: serviceStatusLabel(service),
        run: () => toggleService(service)
      })
      if (service.status.running) {
        commands.push({ id: `restart:${id}`, group: 'Services', title: `Restart ${name}`, run: () => runFailureAction(service, 'restart') })
      }
      const url = projectUrl(service)
      if (url && serviceReady(service)) {
        commands.push({ id: `browser:${id}`, group: 'Services', title: `Open ${name} in the app browser`, subtitle: url, run: () => openInAppBrowser(service) })
        commands.push({ id: `external:${id}`, group: 'Services', title: `Open ${name} in the default browser`, subtitle: url, run: () => openProjectUrl(service) })
        commands.push({ id: `copy:${id}`, group: 'Services', title: `Copy ${name} URL`, subtitle: url, run: () => copyProjectUrl(service) })
      }
      commands.push({ id: `env:${id}`, group: 'Services', title: `${name}: environment and links…`, keywords: 'env variables secrets depends', run: () => { configServiceId.value = id } })
    }
  }
  commands.push(
    { id: 'logs', group: 'App', title: 'Search logs', shortcut: '⌘F', run: () => showLogs() },
    { id: 'add', group: 'App', title: 'Add projects…', shortcut: '⌘O', run: () => openPicker() },
    { id: 'home', group: 'App', title: 'Go home', run: () => goHome() },
    { id: 'welcome', group: 'App', title: 'Show the welcome tour', keywords: 'onboarding intro help', run: () => { onboardingOpen.value = true } },
    { id: 'settings', group: 'App', title: 'Open settings', shortcut: '⌘,', run: () => { activeSection.value = 'settings' } },
    {
      id: 'theme',
      group: 'App',
      title: settings.theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme',
      keywords: 'appearance dark light mode',
      run: () => patchSetting({ theme: settings.theme === 'dark' ? 'light' : 'dark' })
    }
  )
  return commands
})

// Shortcuts that act on "the project" use the open one.
function handleShortcut(event: KeyboardEvent) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || onboardingOpen.value) return false
  const key = event.key.toLowerCase()
  if (key === 'k') {
    paletteOpen.value = !paletteOpen.value
    return true
  }
  if (paletteOpen.value || configServiceId.value) return false
  if (key === ',') {
    activeSection.value = 'settings'
    return true
  }
  if (key === 'o' && !event.shiftKey) {
    openPicker()
    return true
  }
  if (key === 'f' && activeSection.value === 'projects' && selectedGroup.value) {
    showLogs()
    return true
  }
  if (/^[1-9]$/.test(key)) {
    const group = folderGroups.value[Number(key) - 1]
    if (group) openDetails(group)
    return !!group
  }
  const group = activeSection.value === 'projects' ? selectedGroup.value : null
  if (key === 'enter' && group) {
    launchGroup(group)
    return true
  }
  if (key === '.' && group) {
    stopGroup(group)
    return true
  }
  return false
}

function handleKeydown(event: KeyboardEvent) {
  if (handleShortcut(event)) {
    event.preventDefault()
    return
  }
  if (event.key === 'Escape') {
    paletteOpen.value = false
    configServiceId.value = null
    closeGroupMenu()
    closeExternalMenus()
    closeManualPortPrompt()
  }
}

export function useCommands() {
  return { paletteCommands, showLogs, handleKeydown }
}
