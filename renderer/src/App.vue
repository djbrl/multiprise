<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ActivityView from './components/ActivityView.vue'
import AddProjectsDialog from './components/AddProjectsDialog.vue'
import AppSidebar from './components/AppSidebar.vue'
import CommandPalette from './components/CommandPalette.vue'
import GroupContextMenu from './components/GroupContextMenu.vue'
import HomeView from './components/HomeView.vue'
import ManualPortsDialog from './components/ManualPortsDialog.vue'
import Onboarding from './components/Onboarding.vue'
import ProjectPage from './components/ProjectPage.vue'
import ServiceConfigDialog from './components/ServiceConfigDialog.vue'
import SettingsView from './components/SettingsView.vue'
import { useBrowserTabs } from './composables/useBrowserTabs'
import { useCommands } from './composables/useCommands'
import { useEventStream } from './composables/useEventStream'
import { useLogs } from './composables/useLogs'
import { useNavigation } from './composables/useNavigation'
import { useOverlays } from './composables/useOverlays'
import { usePorts } from './composables/usePorts'
import { useProjectPicker } from './composables/useProjectPicker'
import { useProjects } from './composables/useProjects'
import { useServiceActions } from './composables/useServiceActions'
import { useSettings } from './composables/useSettings'
import { useUsage } from './composables/useUsage'
import { ensureApiBase } from './lib/api'
import { projectRootPath, projectTitle } from './lib/services'
import { resolveTheme, themeStyle } from './theme'
import { type ServiceOption } from './types'

// The shell: sidebar, the current page, and the dialogs over it. State and actions live in
// the composables; this wires them to the window and keeps the background refreshes going.

const { projects, loadProjects, projectById } = useProjects()
const { activeSection, selectedGroupKey, selectedGroup, projectPanelMode, initializeNavigation } = useNavigation()
const { settings, settingsDraft, settingsLoaded, loadSettingsFromStorage, fetchSettings, patchSetting } = useSettings()
const { paletteOpen, onboardingOpen, onboarding, configServiceId, overlayOpen, closeGroupMenu, closeExternalMenus } = useOverlays()
const { activePortsExpanded, fetchUsedPorts, refreshPortsIfStale, stopPortsPolling } = usePorts()
const { refreshSelectedLogs } = useLogs()
const { connectEventStream, disconnectEventStream } = useEventStream()
const { activeBrowserTab, syncBrowserBounds, updateBrowserVisibility, connectBrowser, disconnectBrowser } = useBrowserTabs()
const { loadRecentProjects, addFolders } = useProjectPicker()
const { refreshSelectedInstances, stopActionTimers } = useServiceActions()
const { paletteCommands, showLogs, handleKeydown } = useCommands()
const { startUsage, stopUsage } = useUsage()

const sidebarCollapsed = ref(false)

// The Settings page previews the theme being chosen before it is saved.
const activeTheme = computed(() => resolveTheme(activeSection.value === 'settings' ? settingsDraft.theme : settings.theme))
const shellStyle = computed(() => themeStyle(activeTheme.value))

const serviceOptions = computed<ServiceOption[]>(() => projects.value.map((item) => ({
  id: item.project.id,
  name: projectTitle(item),
  project: projectRootPath(item).split('/').filter(Boolean).pop() ?? projectRootPath(item)
})))
const configService = computed(() => serviceOptions.value.find((option) => option.id === configServiceId.value && projectById(option.id)) ?? null)

async function finishOnboarding() {
  onboardingOpen.value = false
  activeSection.value = 'home'
  await patchSetting({ onboarded: true })
  await loadProjects()
}

// Folders dropped anywhere on the window go to onboarding when it is open, otherwise to
// Add Projects, with their services previewed before anything is saved.
const dragDepth = ref(0)
const carriesFiles = (event: DragEvent) => !!event.dataTransfer?.types.includes('Files')

function handleDragEnter(event: DragEvent) {
  if (!carriesFiles(event)) return
  event.preventDefault()
  dragDepth.value += 1
}

function handleDragOver(event: DragEvent) {
  if (!carriesFiles(event)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

function handleDragLeave(event: DragEvent) {
  if (!carriesFiles(event)) return
  dragDepth.value = Math.max(0, dragDepth.value - 1)
}

async function handleDrop(event: DragEvent) {
  if (!carriesFiles(event)) return
  event.preventDefault()
  dragDepth.value = 0
  const paths = [...(event.dataTransfer?.files ?? [])]
    .map((file) => window.vibe?.pathForFile?.(file) ?? '')
    .filter(Boolean)
  if (!paths.length) return
  if (onboardingOpen.value) await onboarding.value?.addFolders(paths)
  else await addFolders(paths)
}

watch(
  [activeSection, projectPanelMode, selectedGroupKey, () => activeBrowserTab.value?.detached, overlayOpen],
  updateBrowserVisibility
)

watch(selectedGroupKey, async (key, previousKey) => {
  if (key !== previousKey) projectPanelMode.value = 'logs'
  if (!key) return
  await refreshSelectedLogs()
  await refreshSelectedInstances()
})

// A crash or exit changes which processes own the ports; refresh them so stale
// "external instance" rows don't hide the Start action.
watch(
  () => selectedGroup.value?.items.map((item) => `${item.project.id}:${item.status.phase}:${item.status.pid ?? ''}`).join('|') ?? '',
  (current, previous) => {
    if (previous && current !== previous) refreshSelectedInstances()
  }
)

function handleWindowClick() {
  closeGroupMenu()
  closeExternalMenus()
}

function handleResize() {
  closeGroupMenu()
  syncBrowserBounds()
}

async function handleVisibilityChange() {
  if (document.hidden) return
  await Promise.all([loadProjects(), refreshSelectedLogs(), fetchUsedPorts({ silent: true })])
  syncBrowserBounds()
}

// Changes arrive over the event stream; these slow refreshes only catch what it cannot
// see (Docker, processes started outside Multiprise) or a dropped connection.
let projectsTimer: number | undefined
let portsTimer: number | undefined

onMounted(async () => {
  initializeNavigation()
  await ensureApiBase()
  loadSettingsFromStorage()
  await fetchSettings()
  await loadProjects({ showLoading: true })
  // A new user (nothing saved yet) starts with the welcome.
  if (settingsLoaded.value && !settings.onboarded && !projects.value.length) onboardingOpen.value = true
  loadRecentProjects()
  if (activePortsExpanded.value) await fetchUsedPorts()
  projectsTimer = window.setInterval(() => {
    if (!document.hidden) loadProjects()
  }, 15000)
  portsTimer = window.setInterval(refreshPortsIfStale, 5000)
  connectEventStream()
  startUsage()
  await connectBrowser()
  window.addEventListener('click', handleWindowClick)
  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('dragenter', handleDragEnter)
  window.addEventListener('dragover', handleDragOver)
  window.addEventListener('dragleave', handleDragLeave)
  window.addEventListener('drop', handleDrop)
  window.addEventListener('resize', handleResize)
  document.addEventListener('visibilitychange', handleVisibilityChange)
})

onBeforeUnmount(() => {
  window.clearInterval(projectsTimer)
  window.clearInterval(portsTimer)
  disconnectEventStream()
  stopUsage()
  stopPortsPolling()
  stopActionTimers()
  disconnectBrowser()
  window.removeEventListener('click', handleWindowClick)
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('dragenter', handleDragEnter)
  window.removeEventListener('dragover', handleDragOver)
  window.removeEventListener('dragleave', handleDragLeave)
  window.removeEventListener('drop', handleDrop)
  window.removeEventListener('resize', handleResize)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
})
</script>

<template>
  <div class="multiprise-shell relative h-screen overflow-hidden font-sans text-[var(--text)]" :data-theme="activeTheme" :style="shellStyle">
    <main
      class="grid h-full min-h-0 overflow-hidden transition-[grid-template-columns] duration-200 ease-out"
      :class="sidebarCollapsed ? 'grid-cols-[72px_1fr]' : 'grid-cols-[232px_1fr]'"
    >
      <AppSidebar v-model:collapsed="sidebarCollapsed" :theme="activeTheme" />

      <section class="flex h-full min-h-0 flex-col overflow-hidden">
        <div class="content-plate min-h-0 flex-1 overflow-hidden">
          <HomeView v-if="activeSection === 'home'" />
          <ProjectPage v-else-if="activeSection === 'projects'" />
          <ActivityView v-else-if="activeSection === 'activity'" />
          <SettingsView v-else />
        </div>
      </section>
    </main>

    <GroupContextMenu />

    <Onboarding
      v-if="onboardingOpen"
      ref="onboarding"
      @projects-added="loadProjects()"
      @done="finishOnboarding"
    />

    <div
      v-if="dragDepth > 0"
      class="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-8"
    >
      <div class="flex h-full w-full flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-[var(--electric)] bg-[color-mix(in_srgb,var(--panel-bg)_85%,transparent)]">
        <svg viewBox="0 0 24 24" class="h-10 w-10 text-[var(--electric)]" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke-linejoin="round" />
          <path d="M12 10v6M9 13h6" stroke-linecap="round" />
        </svg>
        <p class="text-lg font-semibold text-[var(--text-strong)]">Drop project folders to add them</p>
        <p class="text-sm text-[var(--text-subtle)]">You will see the services Multiprise finds, and their commands, before anything is saved.</p>
      </div>
    </div>

    <CommandPalette
      v-if="paletteOpen"
      :commands="paletteCommands"
      @close="paletteOpen = false"
      @search-logs="showLogs($event)"
    />

    <ServiceConfigDialog
      v-if="configService"
      :key="configService.id"
      :service="configService"
      :services="serviceOptions"
      @close="configServiceId = null"
      @saved="loadProjects()"
    />

    <ManualPortsDialog />
    <AddProjectsDialog />
  </div>
</template>
