<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useBrowserTabs } from '../composables/useBrowserTabs'
import { useNavigation } from '../composables/useNavigation'
import { useProjectPicker } from '../composables/useProjectPicker'
import { useRunningServers } from '../composables/useRunningServers'
import { useServiceActions } from '../composables/useServiceActions'
import { openExternal } from '../lib/api'
import { serviceDisplayName, serviceFailed, serviceReady } from '../lib/services'
import { type ProjectView, type RunningServer } from '../types'
import { btnConfirm, btnGhostXs, panelClass, spinnerClass, statusDot, statusDotFailed, statusDotLive } from '../ui'

// Every dev server on this Mac in one table: what Multiprise runs and what terminals and coding
// agents started, with the ones nothing is attached to any more first. Stopping a leftover
// takes one click; a server something is still attached to takes two, since it may be in use.

const REFRESH_MS = 10000
const columns = 'grid-cols-[minmax(0,1.5fr)_88px_64px_minmax(0,1fr)_76px_60px]'

type Row = {
  key: string
  name: string
  status: 'Running' | 'Starting' | 'Failed' | 'Left behind'
  ports: number[]
  command: string
  reason: string | null
  startedBy: string
  startedAt: string | null
  service?: ProjectView
  server?: RunningServer
}

const { servers, outsideServers, leftovers, stopping, fetchRunningServers, stopRunningServer, stopLeftovers } = useRunningServers()
const { homeProjectGroups, openServiceProject } = useNavigation()
const { addFolders } = useProjectPicker()
const { openInAppBrowser } = useBrowserTabs()
const { actionFor, effectivePort, isActionLoading, isStarting, openProjectUrl, stopProject } = useServiceActions()

const confirming = ref<string | null>(null)
const confirmingLeftovers = ref(false)

const count = computed(() => leftovers.value.length)

// Services running or starting in Multiprise, most recently opened projects first.
const liveServices = computed(() => homeProjectGroups.value.flatMap((group) =>
  group.items.filter((item) => item.status.running || isStarting(item))
))

function serviceRow(service: ProjectView): Row {
  const port = effectivePort(service)
  return {
    key: service.project.id,
    name: serviceDisplayName(service),
    status: serviceFailed(service) ? 'Failed' : serviceReady(service) ? 'Running' : 'Starting',
    ports: port && serviceReady(service) ? [Number(port)] : [],
    command: actionFor(service).command,
    reason: null,
    startedBy: 'Multiprise',
    startedAt: servers.value.find((server) => server.managed && server.service_id === service.project.id)?.started_at ?? null,
    service
  }
}

function serverRow(server: RunningServer): Row {
  return {
    key: server.key,
    name: server.project ?? server.command,
    status: server.leftover ? 'Left behind' : 'Running',
    ports: server.ports,
    command: server.command,
    reason: server.leftover_reason,
    startedBy: server.kind === 'docker' ? 'Docker' : 'Outside',
    startedAt: server.started_at,
    server
  }
}

const running = computed(() => [
  ...liveServices.value.map(serviceRow),
  ...outsideServers.value.filter((server) => !server.leftover).map(serverRow)
])
const leftBehind = computed(() => leftovers.value.map(serverRow))

const bands = computed(() => [
  { title: 'Left behind', rows: leftBehind.value },
  { title: 'Running', rows: running.value }
].filter((band) => band.rows.length))

function formatAge(startedAt: string | null) {
  if (!startedAt) return ''
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 60000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h`
  const days = Math.floor(hours / 24)
  if (days < 21) return `${days} days`
  return `${Math.floor(days / 7)} weeks`
}

const statusDotClass = (row: Row) =>
  row.status === 'Running' ? statusDotLive
    : row.status === 'Failed' ? statusDotFailed
    : row.status === 'Left behind' ? '!border-[var(--attention)] !bg-[var(--attention)]'
    : ''

const statusTextClass = (row: Row) =>
  row.status === 'Running' ? 'text-[var(--live-text)]'
    : row.status === 'Failed' ? 'text-[var(--log-error)]'
    : row.status === 'Left behind' ? 'text-[var(--attention-text)]'
    : 'text-[var(--text-muted)]'

function openPort(row: Row) {
  if (row.service) openProjectUrl(row.service)
  else openExternal(`http://localhost:${row.ports[0]}`)
}

function stop(server: RunningServer) {
  if (server.leftover || confirming.value === server.key) {
    confirming.value = null
    return stopRunningServer(server)
  }
  confirming.value = server.key
}

async function stopAll() {
  confirmingLeftovers.value = false
  await stopLeftovers()
}

let timer: number | undefined

function refresh() {
  if (!document.hidden) fetchRunningServers()
}

// The Up column comes from this list, so a service that just started should not wait for the poll.
watch(() => liveServices.value.length, refresh)

onMounted(() => {
  fetchRunningServers()
  timer = window.setInterval(refresh, REFRESH_MS)
  document.addEventListener('visibilitychange', refresh)
})

onBeforeUnmount(() => {
  window.clearInterval(timer)
  document.removeEventListener('visibilitychange', refresh)
})
</script>

<template>
  <section v-if="bands.length" class="mt-5 overflow-hidden" :class="panelClass" aria-label="Servers on this Mac">
    <div class="overflow-x-auto">
      <div class="min-w-[620px]">
        <div class="grid h-8 items-center gap-3 border-b border-[var(--border)] px-4 text-xs text-[var(--text-subtle)]" :class="columns">
          <span>Server</span>
          <span>Status</span>
          <span>Port</span>
          <span>Command</span>
          <span>Started by</span>
          <span>Up</span>
        </div>
        <template v-for="band in bands" :key="band.title">
          <div class="list-band flex h-8 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--panel-muted)] px-4">
            <h2 class="text-xs font-medium text-[var(--text-strong)]">
              {{ band.title }} <span class="font-normal text-[var(--text-subtle)]">{{ band.rows.length }}</span>
            </h2>
            <span v-if="band.title === 'Left behind'" class="flex items-center gap-2">
              <template v-if="confirmingLeftovers">
                <button type="button" class="text-xs text-[var(--text-subtle)] hover:text-[var(--text)]" @click="confirmingLeftovers = false">Cancel</button>
                <button :class="btnConfirm" class="!h-6 !px-2 !text-xs" @click="stopAll">Yes, stop {{ count }}</button>
              </template>
              <button v-else :class="btnGhostXs" class="!h-6 !px-2" @click="confirmingLeftovers = true">
                Stop {{ count }} leftover{{ count === 1 ? '' : 's' }}
              </button>
            </span>
          </div>
          <div
            v-for="row in band.rows"
            :key="row.key"
            class="group relative grid min-h-[40px] items-center gap-3 border-b border-[var(--border)] px-4 py-1 transition-colors last:border-b-0 hover:bg-[var(--hover)]"
            :class="columns"
            :title="row.server?.path ?? undefined"
          >
            <span class="flex min-w-0 items-center gap-2">
              <button v-if="row.service" type="button" class="truncate text-left font-medium text-[var(--text-strong)] hover:underline" @click="openServiceProject(row.service)">{{ row.name }}</button>
              <span v-else class="truncate font-medium text-[var(--text-strong)]">{{ row.name }}</span>
              <span v-if="row.server?.worktree" class="shrink-0 rounded bg-[var(--panel-muted)] px-1.5 py-0.5 text-[11px] text-[var(--text-muted)]">{{ row.server.worktree }}</span>
              <span v-if="row.server?.scratch" class="shrink-0 rounded bg-[var(--panel-muted)] px-1.5 py-0.5 text-[11px] text-[var(--text-muted)]">temporary folder</span>
            </span>
            <span class="flex items-center gap-1.5 text-xs" :class="statusTextClass(row)">
              <span :class="[statusDot, statusDotClass(row)]"></span>
              <span class="truncate">{{ row.status }}</span>
            </span>
            <span class="flex min-w-0 items-center gap-1 font-mono text-xs">
              <button
                v-if="row.ports.length"
                type="button"
                class="text-[var(--text-strong)] underline-offset-2 hover:underline"
                :title="`Open http://localhost:${row.ports[0]} in the browser`"
                @click="openPort(row)"
              >:{{ row.ports[0] }}</button>
              <span v-else class="text-[var(--text-subtle)]">–</span>
              <span v-if="row.ports.length > 1" class="text-[var(--text-subtle)]" :title="row.ports.map((port) => `:${port}`).join(' ')">+{{ row.ports.length - 1 }}</span>
            </span>
            <span v-if="row.reason" class="truncate text-xs text-[var(--attention-text)]" :title="`${row.reason} ${row.command}`">{{ row.reason }}</span>
            <span v-else class="truncate font-mono text-xs text-[var(--text-muted)]" :title="row.command">{{ row.command }}</span>
            <span class="truncate text-xs text-[var(--text-muted)]">{{ row.startedBy }}</span>
            <span class="truncate text-xs text-[var(--text-muted)]">{{ formatAge(row.startedAt) }}</span>
            <span
              class="absolute inset-y-0 right-0 flex items-center justify-end gap-1.5 bg-[var(--hover)] pl-3 pr-4 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"
              :class="confirming === row.key || stopping[row.key] || isActionLoading('stop', row.key) ? 'opacity-100' : ''"
            >
              <template v-if="row.service">
                <button v-if="row.ports.length" :class="btnGhostXs" @click="openInAppBrowser(row.service)">Open</button>
                <button :class="btnGhostXs" :disabled="isActionLoading('stop', row.key)" @click="stopProject(row.service)">
                  {{ isStarting(row.service) ? 'Cancel' : 'Stop' }}
                </button>
              </template>
              <template v-else-if="row.server">
                <button v-if="row.server.kind === 'process' && row.ports.length" :class="btnGhostXs" @click="openPort(row)">Open</button>
                <button v-if="row.server.track_path" :class="btnGhostXs" title="Add this project to Multiprise" @click="addFolders([row.server.track_path])">Track</button>
                <button
                  :class="confirming === row.key ? btnConfirm : btnGhostXs"
                  class="!h-7 !px-2.5 !text-xs"
                  :disabled="stopping[row.key]"
                  @click="stop(row.server)"
                  @mouseleave="confirming === row.key && (confirming = null)"
                >
                  <span v-if="stopping[row.key]" :class="[spinnerClass, '!h-3 !w-3']" aria-hidden="true"></span>
                  {{ confirming === row.key ? 'Stop it?' : 'Stop' }}
                </button>
              </template>
            </span>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>
