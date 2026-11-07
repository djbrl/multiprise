<script setup lang="ts">
import { onMounted } from 'vue'
import multipriseIconUrl from '../assets/multiprise-icon.svg'
import RunningServers from './RunningServers.vue'
import { useAgents } from '../composables/useAgents'
import { useNavigation } from '../composables/useNavigation'
import { useProjectPicker } from '../composables/useProjectPicker'
import { useProjects } from '../composables/useProjects'
import { useServiceActions } from '../composables/useServiceActions'
import { groupHasNpmServices, groupHasRunning, groupInitials, groupReadyCount, groupServiceCount } from '../lib/services'
import { btnGhostXs, btnPanelPrimary, btnPanelSecondary, noScrollbar, panelClass, panelProjectClass, spinnerClass, statusDot, statusDotLive } from '../ui'

// Home: every server on this Mac, every project with a one-click launch, and folders to add back.

const { loading, error, groupFaviconUrl, handleFaviconError } = useProjects()
const { homeProjectGroups, openDetails } = useNavigation()
const { recentImportable, importLoading, openPicker, importRecentProject } = useProjectPicker()
const { groupActionLoading, groupLaunchCancelled, groupPrimaryAction } = useServiceActions()

const { agentStatus, agentsBusy, agentsFailure, showAgentsOffer, loadAgentStatus, connectAgents, dismissAgentsOffer } = useAgents()

onMounted(loadAgentStatus)
</script>

<template>
  <div class="flex h-full min-h-0 flex-col" :class="panelProjectClass">
    <header class="page-header flex h-[52px] shrink-0 items-center justify-between gap-4 border-b border-[var(--border)] px-6">
      <h1 class="text-sm font-medium text-[var(--text-strong)]">Home</h1>
      <button :class="btnPanelPrimary" @click="openPicker">Add project</button>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto" :class="noScrollbar">
      <div class="flex min-h-full w-full flex-col px-6 pb-8 pt-1">
        <p v-if="error" class="mt-4 text-[13px] text-[var(--warning-text)]" role="alert">{{ error }}</p>

        <div v-if="showAgentsOffer" class="mt-5 flex flex-wrap items-center justify-between gap-4 border-b border-[var(--border)] pb-4">
          <div class="min-w-0 flex-1 basis-80">
            <p class="font-medium text-[var(--text-strong)]">Let Claude Code run its dev servers here</p>
            <p class="mt-0.5 text-xs leading-5 text-[var(--text-muted)]">
              Registers the Multiprise MCP server for every project and adds a short note to <span class="font-mono">{{ agentStatus?.instructions_path }}</span>. You can undo both in Settings.
            </p>
            <p v-if="agentsFailure" class="mt-1 text-xs text-[var(--warning-text)]" role="alert">{{ agentsFailure }}</p>
          </div>
          <div class="flex shrink-0 items-center gap-3">
            <button type="button" class="text-xs text-[var(--text-muted)] hover:text-[var(--text-strong)]" @click="dismissAgentsOffer">Not now</button>
            <button :class="btnPanelSecondary" :disabled="agentsBusy" @click="connectAgents">
              {{ agentsBusy ? 'Connecting…' : 'Connect Claude Code' }}
            </button>
          </div>
        </div>

        <div v-if="loading" class="flex min-h-44 items-center justify-center" role="status" aria-label="Loading projects">
          <span :class="spinnerClass" aria-hidden="true"></span>
        </div>

        <template v-else>
          <RunningServers />

          <section v-if="homeProjectGroups.length" class="mt-7">
            <h2 class="text-[13px] font-medium text-[var(--text-strong)]">
              Projects <span class="font-normal text-[var(--text-subtle)]">{{ homeProjectGroups.length }}</span>
            </h2>
            <div class="mt-2.5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <div
                v-for="group in homeProjectGroups"
                :key="group.key"
                class="flex flex-col p-3.5 transition-colors"
                :class="panelClass"
              >
                <button type="button" class="flex min-w-0 items-center gap-2.5 text-left" @click="openDetails(group)">
                  <span class="project-mark flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md border border-[var(--border)] bg-[var(--panel-muted)] text-[11px] font-semibold text-[var(--text-muted)]">
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
                    <span class="block truncate font-medium text-[var(--text-strong)]">{{ group.name }}</span>
                    <span class="block truncate text-xs text-[var(--text-subtle)]">{{ group.path }}</span>
                  </span>
                </button>
                <div class="mt-3 flex items-center justify-between gap-3">
                  <span class="flex items-center gap-1.5 text-xs" :class="groupReadyCount(group) ? 'text-[var(--live-text)]' : 'text-[var(--text-muted)]'">
                    <span :class="[statusDot, groupReadyCount(group) ? statusDotLive : '']"></span>
                    {{ groupReadyCount(group) ? `${groupReadyCount(group)} of ${groupServiceCount(group)} running` : `${groupServiceCount(group)} service${groupServiceCount(group) === 1 ? '' : 's'}` }}
                  </span>
                  <button
                    v-if="groupHasNpmServices(group)"
                    :class="btnGhostXs"
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

          <section v-else class="flex flex-1 flex-col items-center justify-center gap-7 py-10 text-center">
            <div class="flex w-full max-w-[560px] items-center" aria-hidden="true">
              <span class="h-[3px] flex-1 bg-[var(--ghost-border)]"></span>
              <div class="surface-raised flex items-center gap-3 rounded-[20px] border border-[var(--border)] bg-[var(--panel-muted)] px-4 py-3">
                <img :src="multipriseIconUrl" alt="" class="sidebar-logo h-[76px] w-[76px]" />
                <span
                  v-for="socket in 3"
                  :key="socket"
                  class="relative flex h-[62px] w-[62px] items-center justify-center rounded-full border border-[var(--ghost-border)] bg-[var(--panel-bg)]"
                >
                  <span class="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--selection)] font-mono text-[13px] text-[var(--text-subtle)]">&gt;_</span>
                </span>
              </div>
            </div>
            <div class="max-w-[420px]">
              <h2 class="text-xl font-semibold tracking-[-0.015em] text-[var(--text-strong)]">Nothing plugged in yet</h2>
              <p class="mt-1.5 text-sm text-[var(--text-muted)]">Drop a project folder anywhere on this window, or run <span class="font-mono text-[13px]">multiprise up</span> in one.</p>
            </div>
            <button :class="btnPanelPrimary" @click="openPicker">Add project</button>
          </section>

          <section v-if="recentImportable.length" :class="homeProjectGroups.length ? 'mt-7' : 'text-center'">
            <h2 class="text-[13px] font-medium text-[var(--text-strong)]">Found on this Mac</h2>
            <div class="mt-2.5 flex flex-wrap gap-1.5" :class="homeProjectGroups.length ? '' : 'justify-center'">
              <button
                v-for="project in recentImportable"
                :key="project.path"
                type="button"
                :class="btnGhostXs"
                class="max-w-[260px] disabled:cursor-wait"
                :title="project.path"
                :disabled="importLoading[project.path]"
                @click="importRecentProject(project)"
              >
                <span v-if="importLoading[project.path]" :class="[spinnerClass, '!h-3 !w-3']" aria-hidden="true"></span>
                <span v-else class="text-[var(--text-subtle)]">+</span>
                <span class="truncate">{{ project.name }}</span>
              </button>
            </div>
          </section>
        </template>
      </div>
    </div>
  </div>
</template>
