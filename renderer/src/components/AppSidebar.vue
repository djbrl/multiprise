<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import multipriseIconUrl from '../assets/multiprise-icon.svg'
import { useNavigation } from '../composables/useNavigation'
import { useOverlays } from '../composables/useOverlays'
import { usePorts } from '../composables/usePorts'
import { useProjectPicker } from '../composables/useProjectPicker'
import { useProjects } from '../composables/useProjects'
import { groupIsLive } from '../lib/services'
import { sidebarThemeStyle } from '../theme'
import { type ThemeName } from '../types'
import { noScrollbar, spinnerClass, statusDot, statusDotLive } from '../ui'

// Projects, the ports in use on this Mac, and Settings.

defineProps<{ theme: ThemeName }>()
const collapsed = defineModel<boolean>('collapsed', { required: true })

const { folderGroups } = useProjects()
const { activeSection, selectedGroupKey, projectsExpanded, openDetails, openGroupForService, goHome } = useNavigation()
const { usedPorts, portsLoading, portsError, activePortsExpanded, toggleActivePorts, usedPortProjectName, usedPortTitle } = usePorts()
const { openGroupMenu } = useOverlays()
const { openPicker } = useProjectPicker()

const projectSearch = ref('')
watch(collapsed, (value) => {
  if (value) projectSearch.value = ''
})

const filteredFolderGroups = computed(() => {
  const query = projectSearch.value.trim().toLowerCase()
  if (!query) return folderGroups.value
  return folderGroups.value.filter((group) => `${group.name} ${group.path}`.toLowerCase().includes(query))
})

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
    class="relative flex min-h-0 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--sidebar-bg)] text-[var(--text)] shadow-sm transition-[background-color,border-color,color,box-shadow] duration-200"
    :class="collapsed ? 'm-2 h-[calc(100%-16px)]' : 'm-3 mr-0 h-[calc(100%-24px)]'"
    :style="sidebarThemeStyle(theme)"
  >
    <div
      class="flex h-14 shrink-0 items-center border-b border-[var(--border)] px-3"
      :class="collapsed ? 'justify-center' : 'justify-between'"
    >
      <button
        v-if="!collapsed"
        class="group flex min-w-0 items-center gap-2.5 text-left"
        @click="goHome"
        title="Home"
      >
        <img :src="multipriseIconUrl" alt="" class="h-8 w-8 shrink-0" />
        <span>
          <span class="block truncate text-[16px] font-semibold tracking-[-0.025em] text-[var(--text-strong)]">multiprise</span>
        </span>
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

    <nav class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pb-3 pt-2" :class="collapsed ? ['px-1', noScrollbar] : 'px-2'">
      <div v-if="!collapsed" class="relative my-1">
        <svg viewBox="0 0 24 24" class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-subtle)]" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="11" cy="11" r="6" />
          <path d="M16 16l4 4" stroke-linecap="round" />
        </svg>
        <input
          v-model="projectSearch"
          class="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--input-bg)] pl-8 pr-3 text-xs text-[var(--input-text)] placeholder:text-[var(--input-placeholder)] focus:border-[var(--text-subtle)] focus:outline-none"
          placeholder="Search projects"
        />
      </div>

      <button
        v-if="!collapsed && (usedPorts.length || portsLoading || portsError)"
        class="flex items-center justify-between px-2 py-1.5 text-left text-[13px] font-medium text-[var(--text-muted)]"
        :class="activePortsExpanded ? 'text-[var(--text-strong)]' : 'text-[var(--text-muted)]'"
        @click="toggleActivePorts"
      >
        <span class="flex items-center gap-2">
          <svg viewBox="0 0 24 24" class="h-3.5 w-3.5 text-[var(--electric)]" fill="none" stroke="currentColor" stroke-width="1.7">
            <path d="M8 3v5M16 3v5M6 8h12v3a6 6 0 01-6 6v4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span>
            <span class="block leading-4">Plugged in</span>
            <span class="block text-[9px] font-normal text-[var(--text-subtle)]">Active local ports</span>
          </span>
        </span>
        <svg
          viewBox="0 0 24 24"
          class="h-3.5 w-3.5 text-[var(--text-subtle)] transition"
          :class="activePortsExpanded ? 'rotate-90' : ''"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
        >
          <path d="M9 5l7 7-7 7" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <transition name="unfurl">
        <div v-if="!collapsed && activePortsExpanded && (usedPorts.length || portsLoading || portsError)" class="space-y-0.5 px-1 pb-2">
          <div v-if="portsError" class="px-2 py-1 text-sm text-[var(--text-subtle)]">{{ portsError }}</div>
          <div v-else-if="portsLoading" class="flex items-center px-2 py-1 text-sm text-[var(--text-subtle)]">
            <span :class="spinnerClass" aria-hidden="true"></span>
            <span class="sr-only">Loading ports</span>
          </div>
          <div v-else class="max-h-40 space-y-0.5 overflow-y-auto pr-1" :class="noScrollbar">
            <button
              v-for="item in usedPorts"
              :key="item.port"
              type="button"
              class="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] text-[var(--text-muted)] transition-colors"
              :class="item.project_id ? 'hover:bg-[var(--hover)]' : 'cursor-default opacity-70'"
              :disabled="!item.project_id"
              :title="usedPortTitle(item)"
              @click="item.project_id && openGroupForService(item.project_id)"
            >
              <span class="h-2 w-2 shrink-0 rounded-full bg-[var(--live)]"></span>
              <span class="flex min-w-0 flex-1 items-baseline gap-2">
                <span class="shrink-0 font-mono text-[12px] font-semibold text-[var(--electric)]">:{{ item.port }}</span>
                <span class="truncate text-[10px] text-[var(--text-muted)]">{{ usedPortProjectName(item) }}</span>
              </span>
            </button>
          </div>
        </div>
      </transition>
      <div
        class="flex items-center justify-between px-2 py-1.5 text-left text-[13px] font-medium text-[var(--text-muted)]"
        :class="activeSection === 'projects' ? 'text-[var(--text-strong)]' : 'text-[var(--text-muted)]'"
      >
        <button class="flex flex-1 items-center justify-between text-left" @click="toggleProjectsSection">
          <span>
            <span class="block leading-4">{{ collapsed ? 'Projects' : 'Tracked projects' }}</span>
            <span v-if="!collapsed" class="block text-[9px] font-normal text-[var(--text-subtle)]">Saved project folders</span>
          </span>
          <svg
            v-if="!collapsed"
            viewBox="0 0 24 24"
            class="h-3.5 w-3.5 text-[var(--text-subtle)] transition"
            :class="projectsExpanded ? 'rotate-90' : ''"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          >
            <path d="M9 5l7 7-7 7" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          class="ml-2 inline-flex h-7 w-7 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--panel-bg)] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover)]"
          :class="collapsed ? 'hidden' : ''"
          @click.stop="openPicker"
          title="Add project"
        >
          <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M12 5v14M5 12h14" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
      <transition name="unfurl">
        <div v-if="projectsExpanded" class="space-y-0.5 px-1">
          <div v-if="folderGroups.length === 0" class="px-2 py-1 text-sm text-[var(--text-subtle)]">
            {{ collapsed ? 'None' : 'No tracked projects.' }}
          </div>
          <div v-else-if="!filteredFolderGroups.length && !collapsed" class="px-2 py-2 text-xs text-[var(--text-subtle)]">
            No projects match “{{ projectSearch }}”.
          </div>
          <button
            v-for="group in filteredFolderGroups"
            :key="group.key"
            class="group flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--hover)]"
            :title="collapsed ? group.name : undefined"
            :class="activeSection === 'projects' && selectedGroupKey === group.key ? 'bg-[var(--selection)] text-[var(--text-strong)]' : ''"
            @click="openDetails(group)"
            @contextmenu.prevent="openGroupMenu($event, group)"
          >
            <span class="flex min-w-0 flex-1 items-center gap-2" :class="collapsed ? 'justify-center' : ''">
              <span
                :class="[statusDot, groupIsLive(group) ? statusDotLive : '']"
                :aria-label="groupIsLive(group) ? 'Live' : 'Idle'"
              ></span>
              <span
                v-if="!collapsed"
                class="block truncate text-[13px]"
                :class="groupIsLive(group) ? 'font-semibold text-[var(--text-strong)]' : 'text-[var(--text-muted)]'"
              >
                {{ group.name }}
              </span>
            </span>
          </button>
        </div>
      </transition>
      <div class="mt-auto space-y-1 pt-2">
        <button
          class="flex h-10 w-full items-center rounded-lg px-3 text-left text-[13px] font-medium transition-colors hover:bg-[var(--hover)]"
          :class="activeSection === 'settings' ? 'bg-[var(--selection)] text-[var(--text-strong)]' : 'text-[var(--text-muted)]'"
          @click="activeSection = 'settings'"
          title="Settings"
        >
          <svg v-if="collapsed" viewBox="0 0 24 24" class="mx-auto h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
          </svg>
          <span v-else>Settings</span>
        </button>
      </div>
    </nav>
  </aside>
</template>
