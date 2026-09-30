<script setup lang="ts">
import { computed } from 'vue'
import { useBrowserTabs } from '../composables/useBrowserTabs'
import { useNavigation } from '../composables/useNavigation'
import { useOverlays } from '../composables/useOverlays'
import { useProjectPicker } from '../composables/useProjectPicker'
import { useProjects } from '../composables/useProjects'
import { useServiceActions } from '../composables/useServiceActions'
import {
  groupHasNpmServices,
  groupHasRunning,
  groupInitials,
  groupReadyCount,
  groupServiceCount,
  serviceDisplayName,
  serviceFailed,
  serviceReady,
  serviceStatusLabel
} from '../lib/services'
import { btnPanelPrimary, btnPanelSecondary, btnUnplug, noScrollbar, panelProjectClass, spinnerClass, statusDot, statusDotFailed, statusDotLive } from '../ui'

// Home: what is running now, every project with a one-click launch, and folders to add back.

const { loading, error, groupFaviconUrl, handleFaviconError } = useProjects()
const { homeProjectGroups, openDetails, openServiceProject } = useNavigation()
const { paletteOpen } = useOverlays()
const { recentImportable, importLoading, openPicker, importRecentProject } = useProjectPicker()
const { openInAppBrowser } = useBrowserTabs()
const {
  groupActionLoading, groupLaunchCancelled, isActionLoading, isStarting, projectUrl, openProjectUrl, stopProject, groupPrimaryAction
} = useServiceActions()

// Services running or starting anywhere, most recently opened projects first.
const liveServices = computed(() => homeProjectGroups.value.flatMap((group) =>
  group.items.filter((item) => item.status.running || isStarting(item))
))
</script>

<template>
  <div class="h-full min-h-0 overflow-y-auto rounded-2xl" :class="[panelProjectClass, noScrollbar]">
    <div class="mx-auto w-full max-w-[1100px] px-8 py-8 sm:px-10">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <h1 class="text-2xl font-semibold tracking-[-0.03em] text-[var(--text-strong)]">Projects</h1>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="hidden h-9 items-center gap-2 rounded-lg border border-[var(--border)] px-3 text-xs text-[var(--text-subtle)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)] sm:inline-flex"
            @click="paletteOpen = true"
          >
            Search or run a command
            <kbd class="rounded border border-[var(--border)] px-1.5 py-0.5 font-sans text-[10px]">⌘K</kbd>
          </button>
          <button :class="btnPanelPrimary" class="h-9" @click="openPicker">
            <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke-linecap="round" />
            </svg>
            Add projects
          </button>
        </div>
      </div>

      <p v-if="error" class="mt-4 text-sm text-[var(--warning-text)]" role="alert">{{ error }}</p>

      <div v-if="loading" class="flex min-h-44 items-center justify-center" role="status" aria-label="Loading projects">
        <span :class="spinnerClass" aria-hidden="true"></span>
      </div>

      <template v-else>
        <section v-if="liveServices.length" class="mt-7">
          <h2 class="text-xs font-semibold uppercase tracking-wide text-[var(--text-subtle)]">Running now · {{ liveServices.length }}</h2>
          <div class="mt-2 divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--panel-bg)]">
            <div v-for="service in liveServices" :key="service.project.id" class="flex items-center gap-3 px-4 py-2.5">
              <span :class="[statusDot, serviceReady(service) ? statusDotLive : serviceFailed(service) ? statusDotFailed : '']"></span>
              <button type="button" class="min-w-0 flex-1 text-left" @click="openServiceProject(service)">
                <span class="block truncate text-sm font-medium text-[var(--text-strong)]">{{ serviceDisplayName(service) }}</span>
                <span class="block truncate text-[11px] text-[var(--text-subtle)]">{{ serviceStatusLabel(service) }}</span>
              </button>
              <button
                v-if="projectUrl(service) && serviceReady(service)"
                type="button"
                class="hidden truncate font-mono text-xs text-[var(--text-muted)] hover:text-[var(--text-strong)] md:block"
                title="Open in the browser"
                @click="openProjectUrl(service)"
              >{{ projectUrl(service) }}</button>
              <button
                v-if="projectUrl(service) && serviceReady(service)"
                :class="btnPanelSecondary"
                class="!h-7 !px-2.5 !text-xs"
                @click="openInAppBrowser(service)"
              >Open</button>
              <button
                :class="btnPanelSecondary"
                class="!h-7 !px-2.5 !text-xs"
                :disabled="isActionLoading('stop', service.project.id)"
                @click="stopProject(service)"
              >{{ isStarting(service) ? 'Cancel' : 'Stop' }}</button>
            </div>
          </div>
        </section>

        <section v-if="homeProjectGroups.length" class="mt-7">
          <h2 class="text-xs font-semibold uppercase tracking-wide text-[var(--text-subtle)]">All projects · {{ homeProjectGroups.length }}</h2>
          <div class="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <div
              v-for="group in homeProjectGroups"
              :key="group.key"
              class="group flex flex-col rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] p-4 transition-colors hover:border-[var(--text-subtle)]"
            >
              <button type="button" class="flex min-w-0 items-center gap-3 text-left" @click="openDetails(group)">
                <span
                  class="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--panel-muted)] text-xs font-semibold text-[var(--text-muted)]"
                >
                  <img
                    v-if="groupFaviconUrl(group)"
                    :src="groupFaviconUrl(group)"
                    class="h-full w-full object-cover"
                    alt=""
                    @error="handleFaviconError(group)"
                  />
                  <span v-else>{{ groupInitials(group) }}</span>
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[15px] font-semibold text-[var(--text-strong)]">{{ group.name }}</span>
                  <span class="block truncate text-[11px] text-[var(--text-subtle)]">{{ group.path }}</span>
                </span>
              </button>
              <div class="mt-4 flex items-center justify-between gap-3">
                <span class="text-xs" :class="groupReadyCount(group) ? 'font-medium text-[var(--electric)]' : 'text-[var(--text-muted)]'">
                  {{ groupReadyCount(group) ? `${groupReadyCount(group)} of ${groupServiceCount(group)} running` : `${groupServiceCount(group)} service${groupServiceCount(group) === 1 ? '' : 's'}` }}
                </span>
                <button
                  v-if="groupHasNpmServices(group)"
                  :class="groupHasRunning(group) || groupActionLoading[group.key] === 'launch' ? btnUnplug : btnPanelPrimary"
                  class="!h-7 !px-3 !text-xs"
                  :disabled="groupActionLoading[group.key] === 'stop' || groupActionLoading[group.key] === 'delete' || (groupActionLoading[group.key] === 'launch' && !!groupLaunchCancelled[group.key])"
                  @click="groupPrimaryAction(group, groupHasRunning(group))"
                >
                  <span v-if="groupActionLoading[group.key]" :class="[spinnerClass, '!h-3 !w-3']" aria-hidden="true"></span>
                  {{ groupActionLoading[group.key] === 'launch' ? 'Cancel' : groupActionLoading[group.key] === 'stop' ? 'Stopping…' : groupHasRunning(group) ? 'Stop' : 'Launch' }}
                </button>
              </div>
            </div>
          </div>
        </section>

        <section v-else class="mt-16 flex flex-col items-center text-center">
          <p class="text-lg font-medium text-[var(--text-strong)]">No projects yet</p>
          <p class="mt-1 text-sm text-[var(--text-muted)]">Add a folder, or drop one anywhere on this window.</p>
          <button :class="btnPanelPrimary" class="mt-5 h-9" @click="openPicker">Add projects</button>
        </section>

        <section v-if="recentImportable.length" class="mt-9">
          <h2 class="text-xs font-semibold uppercase tracking-wide text-[var(--text-subtle)]">Found on this Mac</h2>
          <div class="mt-2 flex flex-wrap gap-2">
            <button
              v-for="project in recentImportable"
              :key="project.path"
              type="button"
              class="inline-flex max-w-[260px] items-center gap-2 rounded-lg border border-dashed border-[var(--border)] px-3 py-2 text-left text-xs transition-colors hover:border-[var(--text-subtle)] hover:bg-[var(--hover)] disabled:cursor-wait disabled:opacity-60"
              :title="project.path"
              :disabled="importLoading[project.path]"
              @click="importRecentProject(project)"
            >
              <span v-if="importLoading[project.path]" :class="[spinnerClass, '!h-3 !w-3']" aria-hidden="true"></span>
              <span v-else class="text-[var(--text-subtle)]">+</span>
              <span class="truncate font-medium text-[var(--text)]">{{ project.name }}</span>
            </button>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>
