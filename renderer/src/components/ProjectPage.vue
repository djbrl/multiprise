<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useBrowserTabs } from '../composables/useBrowserTabs'
import { useEventStream } from '../composables/useEventStream'
import { useLogs } from '../composables/useLogs'
import { useNavigation } from '../composables/useNavigation'
import { useProjects } from '../composables/useProjects'
import { useServiceActions } from '../composables/useServiceActions'
import { groupHasNpmServices, groupHasRunning, groupInitials, groupReadyCount, groupServiceCount, isDockerService } from '../lib/services'
import { readStored, STORAGE_KEYS, writeStored } from '../lib/storage'
import { btnPanelPrimaryLg, btnPanelSecondary, btnUnplugLg, noScrollbar, panelProjectClass, spinnerClass, statusDot, statusDotLive } from '../ui'
import BrowserPanel from './BrowserPanel.vue'
import DockerServices from './DockerServices.vue'
import LogViewer from './LogViewer.vue'
import ServiceCard from './ServiceCard.vue'

// The open project: its services on the left, logs or the in-app browser on the right.

const { loading, error, groupFaviconUrl, handleFaviconError } = useProjects()
const { selectedGroup, selectedGroupKey, projectPanelMode, goHome } = useNavigation()
const { logViewer, projectLogEntries, projectLogServices, openLogFile } = useLogs()
const { eventStreamConnected } = useEventStream()
const { browserState, activeBrowserTab, syncBrowserBounds, openLogUrl } = useBrowserTabs()
const { vscodeErrors, groupActionLoading, groupLaunchCancelled, openProjectInEditorOrFinder, groupPrimaryAction } = useServiceActions()

const npmServices = computed(() => selectedGroup.value?.items.filter((item) => !isDockerService(item)) ?? [])
const dockerServices = computed(() => selectedGroup.value?.items.filter(isDockerService) ?? [])

// The services pane can be resized or collapsed; its share of the width is remembered.
const DEFAULT_SPLIT = 0.38
const DIVIDER_WIDTH = 1
const servicesPaneCollapsed = ref(false)
const serviceSplitRatio = ref(DEFAULT_SPLIT)
const splitContainerWidth = ref(0)
const projectSplitRef = ref<HTMLElement | null>(null)
let splitResizeObserver: ResizeObserver | undefined
let splitDragging = false

const storedSplit = Number(readStored(STORAGE_KEYS.serviceSplit))
if (Number.isFinite(storedSplit) && storedSplit >= 0.2 && storedSplit <= 0.7) serviceSplitRatio.value = storedSplit

// Both panes keep a usable minimum width.
function servicesWidth(totalWidth: number, requested: number) {
  const available = Math.max(0, totalWidth - DIVIDER_WIDTH)
  const minimumServices = Math.min(280, available * 0.42)
  const minimumFocus = Math.min(480, Math.max(0, available - minimumServices))
  const maximumServices = Math.max(minimumServices, available - minimumFocus)
  return Math.min(maximumServices, Math.max(minimumServices, requested))
}

const projectSplitStyle = computed(() => {
  if (servicesPaneCollapsed.value) return { gridTemplateColumns: '0px 0px minmax(0, 1fr)' }
  const width = splitContainerWidth.value || 1000
  const services = servicesWidth(width, Math.max(0, width - DIVIDER_WIDTH) * serviceSplitRatio.value)
  return { gridTemplateColumns: `${Math.round(services)}px ${DIVIDER_WIDTH}px minmax(0, 1fr)` }
})

function updateSplitWidth() {
  splitContainerWidth.value = projectSplitRef.value?.getBoundingClientRect().width ?? 0
}

function observeProjectSplit() {
  splitResizeObserver?.disconnect()
  if (!projectSplitRef.value) return
  updateSplitWidth()
  splitResizeObserver = new ResizeObserver(updateSplitWidth)
  splitResizeObserver.observe(projectSplitRef.value)
}

function handleServiceResize(event: PointerEvent) {
  if (!splitDragging || !projectSplitRef.value) return
  const rect = projectSplitRef.value.getBoundingClientRect()
  if (rect.width <= 0) return
  const available = Math.max(1, rect.width - DIVIDER_WIDTH)
  serviceSplitRatio.value = servicesWidth(rect.width, Math.max(0, event.clientX - rect.left)) / available
}

function stopServiceResize() {
  if (!splitDragging) return
  splitDragging = false
  document.body.classList.remove('resizing-project-panes')
  window.removeEventListener('pointermove', handleServiceResize)
  window.removeEventListener('pointerup', stopServiceResize)
  window.removeEventListener('pointercancel', stopServiceResize)
  writeStored(STORAGE_KEYS.serviceSplit, String(serviceSplitRatio.value))
  syncBrowserBounds()
}

function startServiceResize(event: PointerEvent) {
  if (servicesPaneCollapsed.value) return
  event.preventDefault()
  splitDragging = true
  document.body.classList.add('resizing-project-panes')
  window.addEventListener('pointermove', handleServiceResize)
  window.addEventListener('pointerup', stopServiceResize)
  window.addEventListener('pointercancel', stopServiceResize)
}

function resetServiceSplit() {
  serviceSplitRatio.value = DEFAULT_SPLIT
  writeStored(STORAGE_KEYS.serviceSplit, String(DEFAULT_SPLIT))
}

async function toggleServicesPane() {
  servicesPaneCollapsed.value = !servicesPaneCollapsed.value
  await nextTick()
  updateSplitWidth()
  syncBrowserBounds()
}

// Switching projects re-renders the split (the transition is keyed by project).
watch(selectedGroupKey, async () => {
  await nextTick()
  observeProjectSplit()
})

onMounted(observeProjectSplit)

onBeforeUnmount(() => {
  splitResizeObserver?.disconnect()
  stopServiceResize()
})
</script>

<template>
  <div class="flex h-full w-full min-h-0 flex-col overflow-hidden" :class="[panelProjectClass, noScrollbar]">
    <div v-if="loading" class="flex items-center p-4">
      <span :class="spinnerClass" aria-hidden="true"></span>
      <span class="sr-only">Loading projects</span>
    </div>
    <div
      v-if="error"
      class="flex items-start justify-between gap-3 border-b border-[var(--border)] bg-[var(--danger-bg)] px-4 py-2 text-[13px] text-[var(--danger-text)]"
      role="alert"
    >
      <span class="min-w-0 break-words">{{ error }}</span>
      <button class="shrink-0 rounded px-1 opacity-70 hover:opacity-100" aria-label="Dismiss error" @click="error = ''">×</button>
    </div>
    <div v-if="!selectedGroup" class="flex h-full flex-col items-center justify-center text-center">
      <p class="text-[13px] text-[var(--text-subtle)]">Choose a project from the sidebar.</p>
      <button class="mt-4" :class="btnPanelSecondary" @click="goHome">Go home</button>
    </div>
    <transition v-else name="project-switch" mode="out-in">
      <div :key="selectedGroup.key" class="flex h-full min-h-0 flex-col">
      <header class="page-header flex h-[52px] shrink-0 items-center justify-between gap-4 border-b border-[var(--border)] px-4">
        <div class="flex min-w-0 items-center gap-2.5">
          <span class="project-mark flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md border border-[var(--border)] bg-[var(--panel-muted)] text-[11px] font-semibold text-[var(--text-muted)]">
            <img
              v-if="groupFaviconUrl(selectedGroup)"
              :src="groupFaviconUrl(selectedGroup)"
              class="h-full w-full object-cover"
              alt=""
              @error="handleFaviconError(selectedGroup)"
            />
            <span v-else>{{ groupInitials(selectedGroup) }}</span>
          </span>
          <h1 class="shrink-0 text-sm font-semibold text-[var(--text-strong)]">{{ selectedGroup.name }}</h1>
          <button
            class="min-w-0 truncate font-mono text-xs text-[var(--text-subtle)] transition-colors hover:text-[var(--text-strong)]"
            title="View source code"
            @click="openProjectInEditorOrFinder(selectedGroup)"
          >{{ selectedGroup.path }}</button>
        </div>
        <div class="flex shrink-0 items-center justify-end gap-3">
          <span v-if="groupHasNpmServices(selectedGroup)" class="flex items-center gap-1.5 text-xs" :class="groupReadyCount(selectedGroup) ? 'text-[var(--live-text)]' : 'text-[var(--text-muted)]'">
            <span :class="[statusDot, groupReadyCount(selectedGroup) ? statusDotLive : '']"></span>
            {{ groupReadyCount(selectedGroup) }} of {{ groupServiceCount(selectedGroup) }} ready
          </span>
          <button
            :class="groupHasRunning(selectedGroup) || groupActionLoading[selectedGroup.key] === 'launch' ? btnUnplugLg : btnPanelPrimaryLg"
            :disabled="!groupHasNpmServices(selectedGroup) || (!!groupActionLoading[selectedGroup.key] && groupActionLoading[selectedGroup.key] !== 'launch') || !!groupLaunchCancelled[selectedGroup.key] && groupActionLoading[selectedGroup.key] === 'launch'"
            :title="groupActionLoading[selectedGroup.key] === 'launch' ? 'Stop this launch' : undefined"
            @click="groupPrimaryAction(selectedGroup, groupHasRunning(selectedGroup))"
          >
            <span v-if="groupActionLoading[selectedGroup.key]" :class="[spinnerClass, '!h-3 !w-3']" aria-hidden="true"></span>
            {{
              groupActionLoading[selectedGroup.key] === 'launch'
                ? groupLaunchCancelled[selectedGroup.key] ? 'Cancelling…' : 'Cancel launch'
                : groupActionLoading[selectedGroup.key] === 'stop'
                ? 'Stopping…'
                : groupHasRunning(selectedGroup)
                ? 'Stop all'
                : 'Launch'
            }}
          </button>
        </div>
      </header>
      <div
        v-if="selectedGroup.items.length && vscodeErrors[selectedGroup.items[0].project.id]"
        class="border-b border-[var(--warning-border)] bg-[var(--warning-bg)] px-4 py-2 text-xs text-[var(--warning-text)]"
      >
        {{ vscodeErrors[selectedGroup.items[0].project.id] }}
      </div>

      <div class="flex-1 min-h-0 overflow-hidden">
        <div
          ref="projectSplitRef"
          class="project-split grid h-full min-h-0 overflow-hidden transition-[grid-template-columns] duration-150 ease-out"
          :style="projectSplitStyle"
        >
          <!-- Explicit columns: v-show's display:none would otherwise shift the panes into the collapsed 0px tracks. -->
          <div
            v-show="!servicesPaneCollapsed"
            class="relative col-start-1 row-start-1 flex h-full min-h-0 min-w-0 flex-col overflow-y-auto"
            :class="noScrollbar"
          >
            <div class="flex h-[42px] shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] pl-4 pr-2">
              <h2 class="text-[13px] font-medium text-[var(--text-strong)]">
                Services <span class="font-normal text-[var(--text-subtle)]">{{ npmServices.length }}</span>
              </h2>
              <button
                type="button"
                class="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-subtle)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text-strong)]"
                title="Collapse services"
                aria-label="Collapse services"
                @click="toggleServicesPane"
              >
                <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.6">
                  <path d="M15 5l-7 7 7 7" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </div>
            <p v-if="npmServices.length === 0" class="border-b border-[var(--border)] px-4 py-3 text-[13px] text-[var(--text-subtle)]">No script services found.</p>
            <ServiceCard v-for="service in npmServices" :key="service.project.id" :service="service" />
            <DockerServices v-if="dockerServices.length" :services="dockerServices" />
          </div>

          <button
            v-show="!servicesPaneCollapsed"
            type="button"
            class="group relative z-10 col-start-2 row-start-1 h-full min-h-0 cursor-col-resize touch-none bg-[var(--border)] outline-none transition-colors hover:bg-[var(--text-subtle)] focus-visible:bg-[var(--text-subtle)]"
            title="Drag to resize · Double-click to reset"
            aria-label="Resize services and output panels"
            @pointerdown="startServiceResize"
            @dblclick="resetServiceSplit"
          >
            <span class="absolute inset-y-0 -left-1 -right-1"></span>
          </button>

          <div class="col-start-3 row-start-1 flex h-full min-h-0 min-w-0 flex-col">
            <div class="flex h-[42px] shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] px-4">
              <div class="flex h-full min-w-0 items-center gap-4">
                <button
                  v-if="servicesPaneCollapsed"
                  type="button"
                  class="inline-flex h-7 items-center gap-1 rounded-md pr-2 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-strong)]"
                  title="Show services"
                  @click="toggleServicesPane"
                >
                  <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.6">
                    <path d="M9 5l7 7-7 7" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                  Services
                </button>
                <div class="flex h-full items-stretch gap-4" role="tablist" aria-label="Project output">
                  <button
                    role="tab"
                    :aria-selected="projectPanelMode === 'logs'"
                    class="-mb-px border-b-2 text-[13px] transition-colors"
                    :class="projectPanelMode === 'logs' ? 'border-[var(--text-strong)] font-medium text-[var(--text-strong)]' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-strong)]'"
                    @click="projectPanelMode = 'logs'"
                  >
                    Logs
                  </button>
                  <button
                    role="tab"
                    :aria-selected="projectPanelMode === 'browser'"
                    class="-mb-px flex items-center gap-1.5 border-b-2 text-[13px] transition-colors"
                    :class="projectPanelMode === 'browser' ? 'border-[var(--text-strong)] font-medium text-[var(--text-strong)]' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-strong)]'"
                    @click="projectPanelMode = 'browser'"
                  >
                    Browser
                    <span v-if="browserState.tabs.length" class="text-xs font-normal text-[var(--text-subtle)]">{{ browserState.tabs.length }}</span>
                  </button>
                </div>
              </div>
              <span v-if="projectPanelMode === 'logs'" class="flex shrink-0 items-center gap-1.5 text-xs text-[var(--text-subtle)]">
                <span class="h-1.5 w-1.5 rounded-full bg-[var(--live)]" :class="eventStreamConnected ? '' : 'opacity-40'"></span>
                {{ eventStreamConnected ? 'Live' : 'Reconnecting' }} · {{ projectLogEntries.length }} lines
              </span>
              <span v-else-if="activeBrowserTab?.detached" class="shrink-0 text-xs text-[var(--text-subtle)]">Detached window</span>
            </div>

            <LogViewer
              v-if="projectPanelMode === 'logs'"
              ref="logViewer"
              :key="selectedGroupKey ?? ''"
              :entries="projectLogEntries"
              :services="projectLogServices"
              @open-url="openLogUrl"
              @open-file="openLogFile"
            />

            <BrowserPanel v-else />
          </div>
        </div>
      </div>
      </div>
    </transition>
  </div>
</template>
