<script setup lang="ts">
import multipriseIconUrl from '../assets/multiprise-icon.svg'
import UsageMeters from './UsageMeters.vue'
import { useNavigation } from '../composables/useNavigation'
import { useOverlays } from '../composables/useOverlays'
import { usePorts } from '../composables/usePorts'
import { useProjectPicker } from '../composables/useProjectPicker'
import { useProjects } from '../composables/useProjects'
import { groupIsLive } from '../lib/services'
import { sidebarThemeStyle } from '../theme'
import { type ResolvedTheme } from '../types'
import { noScrollbar, spinnerClass, statusDot, statusDotLive } from '../ui'

// Projects, the ports in use on this Mac, how busy it is, and Settings.

defineProps<{ theme: ResolvedTheme }>()
const collapsed = defineModel<boolean>('collapsed', { required: true })

const { folderGroups } = useProjects()
const { activeSection, selectedGroupKey, projectsExpanded, openDetails, openGroupForService, goHome } = useNavigation()
const { usedPorts, portsLoading, portsError, activePortsExpanded, toggleActivePorts, usedPortProjectName, usedPortTitle } = usePorts()
const { openGroupMenu, paletteOpen } = useOverlays()
const { openPicker } = useProjectPicker()

function toggleProjectsSection() {
  if (activeSection.value !== 'projects') {
    activeSection.value = 'projects'
    projectsExpanded.value = true
  } else {
    projectsExpanded.value = !projectsExpanded.value
  }
}
</script>

<template>
  <aside
    class="relative flex h-full min-h-0 flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--sidebar-bg)] text-[var(--text)]"
    :style="sidebarThemeStyle(theme)"
  >
    <div class="app-drag-region h-9 shrink-0"></div>
    <div class="flex shrink-0 items-center px-2.5" :class="collapsed ? 'flex-col gap-2' : 'h-9 justify-between'">
      <button class="flex min-w-0 items-center gap-1.5 text-left" title="Home" @click="goHome">
        <img :src="multipriseIconUrl" alt="" class="sidebar-logo h-7 w-7 shrink-0" />
        <span v-if="!collapsed" class="truncate text-sm font-semibold tracking-[-0.01em] text-[var(--text-strong)]">Multiprise</span>
      </button>
      <button
        class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text-strong)]"
        :title="collapsed ? 'Expand sidebar' : 'Collapse sidebar'"
        @click="collapsed = !collapsed"
      >
        <svg viewBox="0 0 24 24" class="h-4 w-4 transition-transform" :class="collapsed ? 'rotate-180' : ''" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M15 5l-7 7 7 7" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>

    <nav class="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2.5 pb-3 pt-2" :class="noScrollbar">
      <button
        v-if="!collapsed"
        type="button"
        class="sidebar-search mb-2.5 flex h-8 w-full shrink-0 items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--panel-bg)] px-2.5 text-[var(--text-subtle)] transition-colors hover:border-[var(--text-subtle)]"
        @click="paletteOpen = true"
      >
        <span class="truncate">Search or run a command</span>
        <kbd class="shrink-0 font-sans text-[11px]">⌘K</kbd>
      </button>

      <button
        v-if="!collapsed"
        type="button"
        class="flex h-[30px] w-full shrink-0 items-center rounded-md px-2 text-left transition-colors hover:bg-[var(--hover)]"
        :class="activeSection === 'home' ? 'nav-selected bg-[var(--selection)] font-medium text-[var(--text-strong)]' : 'text-[var(--text-muted)]'"
        @click="goHome"
      >Home</button>

      <button
        v-if="!collapsed && (usedPorts.length || portsLoading || portsError)"
        type="button"
        class="flex h-[30px] w-full shrink-0 items-center justify-between rounded-md px-2 text-left text-[var(--text-muted)] transition-colors hover:bg-[var(--hover)]"
        @click="toggleActivePorts"
      >
        <span>Plugged in</span>
        <span class="flex items-center gap-1.5 text-xs text-[var(--text-subtle)]">
          {{ usedPorts.length || '' }}
          <svg viewBox="0 0 24 24" class="h-3 w-3 transition" :class="activePortsExpanded ? 'rotate-90' : ''" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M9 5l7 7-7 7" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
      </button>
      <transition name="unfurl">
        <div v-if="!collapsed && activePortsExpanded && (usedPorts.length || portsLoading || portsError)" class="pb-1">
          <div v-if="portsError" class="px-2 py-1 text-xs text-[var(--text-subtle)]">{{ portsError }}</div>
          <div v-else-if="portsLoading" class="flex items-center px-2 py-1">
            <span :class="spinnerClass" aria-hidden="true"></span>
            <span class="sr-only">Loading ports</span>
          </div>
          <div v-else class="max-h-40 overflow-y-auto" :class="noScrollbar">
            <button
              v-for="item in usedPorts"
              :key="item.port"
              type="button"
              class="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors"
              :class="item.project_id ? 'hover:bg-[var(--hover)]' : 'cursor-default'"
              :disabled="!item.project_id"
              :title="usedPortTitle(item)"
              @click="item.project_id && openGroupForService(item.project_id)"
            >
              <span class="w-12 shrink-0 font-mono text-[var(--text-strong)]">:{{ item.port }}</span>
              <span class="truncate text-[var(--text-muted)]">{{ usedPortProjectName(item) }}</span>
            </button>
          </div>
        </div>
      </transition>

      <div class="mt-4 flex shrink-0 items-center justify-between px-2 pb-1" :class="collapsed ? 'hidden' : ''">
        <button type="button" class="flex items-center gap-1 text-xs font-medium text-[var(--text-subtle)]" @click="toggleProjectsSection">
          Projects
          <svg viewBox="0 0 24 24" class="h-3 w-3 transition" :class="projectsExpanded ? 'rotate-90' : ''" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M9 5l7 7-7 7" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          class="inline-flex h-[22px] w-[22px] items-center justify-center rounded text-[var(--text-subtle)] transition-colors hover:bg-[var(--hover)]"
          title="Add project"
          @click.stop="openPicker"
        >
          <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 5v14M5 12h14" stroke-linecap="round" />
          </svg>
        </button>
      </div>
      <transition name="unfurl">
        <div v-if="projectsExpanded" class="space-y-px">
          <div v-if="folderGroups.length === 0 && !collapsed" class="px-2 py-1 text-xs text-[var(--text-subtle)]">No projects yet.</div>
          <button
            v-for="group in folderGroups"
            :key="group.key"
            class="flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-[var(--hover)]"
            :title="collapsed ? group.name : undefined"
            :class="[collapsed ? 'justify-center' : '', activeSection === 'projects' && selectedGroupKey === group.key ? 'nav-selected bg-[var(--selection)] font-medium' : '']"
            @click="openDetails(group)"
            @contextmenu.prevent="openGroupMenu($event, group)"
          >
            <span :class="[statusDot, groupIsLive(group) ? statusDotLive : '']" :aria-label="groupIsLive(group) ? 'Live' : 'Idle'"></span>
            <span v-if="!collapsed" class="truncate" :class="groupIsLive(group) ? 'text-[var(--text-strong)]' : 'text-[var(--text-muted)]'">{{ group.name }}</span>
          </button>
        </div>
      </transition>

      <UsageMeters class="mt-auto" :compact="collapsed" />

      <button
        class="flex h-[30px] w-full shrink-0 items-center rounded-md px-2 text-left transition-colors hover:bg-[var(--hover)]"
        :class="[collapsed ? 'justify-center' : '', activeSection === 'settings' ? 'nav-selected bg-[var(--selection)] font-medium text-[var(--text-strong)]' : 'text-[var(--text-muted)]']"
        title="Settings"
        @click="activeSection = 'settings'"
      >
        <svg v-if="collapsed" viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
        </svg>
        <span v-else>Settings</span>
      </button>
    </nav>
  </aside>
</template>
