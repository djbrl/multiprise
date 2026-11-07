<script setup lang="ts">
import { computed, ref } from 'vue'
import UsageChart, { type ChartPoint } from './UsageChart.vue'
import { useNavigation } from '../composables/useNavigation'
import { useProjects } from '../composables/useProjects'
import { useRunningServers } from '../composables/useRunningServers'
import { useServiceActions } from '../composables/useServiceActions'
import { formatBytes, serversTotal, useUsage } from '../composables/useUsage'
import { type AppUsage, type Group, type ProjectView, type RunningServer } from '../types'
import { btnConfirm, btnGhostXs, noScrollbar, panelClass, panelProjectClass, spinnerClass } from '../ui'

// How busy this Mac is, and how much of that is the dev servers on it.

type Row = {
  key: string
  name: string
  detail: string | null
  tag: string
  cpu: number
  memory: number
  services: { key: string; name: string; cpu: number; memory: number }[]
  group?: Group<ProjectView>
  server?: RunningServer
}

const { machine, report, history, cpuLevel, memoryLevel, historyMs, sample } = useUsage()
const { groupForService } = useProjects()
const { openDetails } = useNavigation()
const { groupActionLoading, stopGroup } = useServiceActions()
const { stopping, stopRunningServer } = useRunningServers()

const columns = 'grid-cols-[minmax(0,1fr)_84px_minmax(72px,120px)_minmax(96px,150px)_64px]'

const PRESSURE_TEXT = {
  normal: 'macOS has room to spare, however full the figure looks.',
  warning: 'macOS is compressing memory and swapping to disk to keep up. Stopping something will help.',
  critical: 'macOS is out of room and things will slow down. Stop what you can.'
}

const total = computed(() => report.value ? serversTotal(report.value) : null)
const now = computed(() => history.value[history.value.length - 1]?.at ?? 0)

const cpuPoints = computed<ChartPoint[]>(() => history.value.map((point) => ({ at: point.at, total: point.cpu, servers: point.serversCpu })))
const memoryPoints = computed<ChartPoint[]>(() => history.value.map((point) => ({ at: point.at, total: point.memory, servers: point.serversMemory })))

const formatCpu = (point: ChartPoint) => ({
  total: point.total === null ? '–' : `${Math.round(point.total)}%`,
  servers: point.servers === null ? null : `${point.servers.toFixed(1)}%`
})
const formatMemory = (point: ChartPoint) => {
  const bytes = (percent: number) => formatBytes(percent / 100 * (machine.value?.memory_total ?? 0))
  return {
    total: point.total === null ? '–' : bytes(point.total),
    servers: point.servers === null ? null : bytes(point.servers)
  }
}

const rows = computed<Row[]>(() => {
  const usage = report.value
  if (!usage) return []
  const projects = new Map<string, Row>()
  for (const service of usage.services) {
    const group = groupForService(service.service_id) ?? undefined
    const key = group?.key ?? service.project_path
    const row = projects.get(key) ?? { key, name: group?.name ?? service.project, detail: null, tag: 'Multiprise', cpu: 0, memory: 0, services: [], group }
    row.cpu += service.cpu
    row.memory += service.memory
    row.services.push({ key: service.service_id, name: service.name, cpu: service.cpu, memory: service.memory })
    projects.set(key, row)
  }
  const list: Row[] = [
    ...projects.values(),
    ...usage.servers.map(({ server, cpu, memory }) => ({
      key: server.key,
      name: server.project ?? server.command,
      detail: server.worktree ?? (server.scratch ? 'temporary folder' : null),
      tag: server.leftover ? 'Left behind' : 'Outside',
      cpu,
      memory,
      services: [],
      server
    })),
    ...usage.containers.map(({ key, name, cpu, memory, containers }) => ({
      key,
      name,
      detail: `${containers} container${containers === 1 ? '' : 's'}`,
      tag: 'Docker',
      cpu,
      memory,
      services: []
    })),
    { key: 'multiprise', name: 'Multiprise', detail: 'this app', tag: '', cpu: usage.multiprise.cpu, memory: usage.multiprise.memory, services: [] }
  ]
  return list.sort((a, b) => b.memory - a.memory)
})

const largestCpu = computed(() => Math.max(1, ...rows.value.map((row) => row.cpu)))
const largestMemory = computed(() => Math.max(1, ...rows.value.map((row) => row.memory)))

const showServices = (row: Row) => row.services.length > 1

const confirming = ref<string | null>(null)

async function stopServer(server: RunningServer) {
  if (!server.leftover && confirming.value !== server.key) {
    confirming.value = server.key
    return
  }
  confirming.value = null
  await stopRunningServer(server)
  await sample()
}

async function stopProject(group: Group<ProjectView>) {
  await stopGroup(group)
  await sample()
}

// Everything else on this Mac, so a busy browser or a forgotten script shows up too.
const APPS_SHOWN = 8
const KIND_LABEL: Record<AppUsage['kind'], string> = { app: 'App', script: 'Script', program: 'Program', system: 'macOS' }

const appsSort = ref<'memory' | 'cpu'>('memory')
const showAllApps = ref(false)

const sortedApps = computed(() => {
  const apps = [...(report.value?.apps ?? [])]
  return appsSort.value === 'cpu' ? apps.sort((a, b) => b.cpu - a.cpu || b.memory - a.memory) : apps.sort((a, b) => b.memory - a.memory)
})
const visibleApps = computed(() => showAllApps.value ? sortedApps.value : sortedApps.value.slice(0, APPS_SHOWN))
const largestAppCpu = computed(() => Math.max(1, ...sortedApps.value.map((app) => app.cpu)))
const largestAppMemory = computed(() => Math.max(1, ...sortedApps.value.map((app) => app.memory)))

const appTitle = (app: AppUsage) => [app.path, app.detail, `${app.processes} process${app.processes === 1 ? '' : 'es'}`].filter(Boolean).join('\n')
</script>

<template>
  <div class="flex h-full min-h-0 flex-col" :class="panelProjectClass">
    <header class="page-header flex h-[52px] shrink-0 items-center border-b border-[var(--border)] px-6">
      <h1 class="text-sm font-medium text-[var(--text-strong)]">Activity</h1>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto" :class="noScrollbar">
      <div v-if="!machine" class="flex min-h-44 items-center justify-center" role="status" aria-label="Measuring">
        <span :class="spinnerClass" aria-hidden="true"></span>
      </div>

      <div v-else class="w-full px-6 pb-8 pt-5">
        <div class="grid gap-3 lg:grid-cols-2">
          <section class="p-4" :class="panelClass" aria-label="CPU">
            <h2 class="text-xs text-[var(--text-muted)]">CPU</h2>
            <p class="mt-1 text-[28px] font-semibold leading-8 tracking-[-0.02em] text-[var(--text-strong)]">
              {{ machine.cpu === null ? '–' : `${Math.round(machine.cpu)}%` }}
            </p>
            <p class="mt-1 min-h-[40px] text-xs leading-5 text-[var(--text-muted)]">
              Dev servers {{ total ? `${total.cpu.toFixed(1)}%` : '–' }}. 100% is all {{ machine.cores }} cores busy.
              <span v-if="cpuLevel !== 'normal'" class="font-medium text-[var(--attention-text)]">Nearly every core is busy.</span>
            </p>
            <UsageChart class="mt-3" label="CPU" :points="cpuPoints" :window-ms="historyMs" :now="now" :format="formatCpu" />
          </section>

          <section class="p-4" :class="panelClass" aria-label="Memory">
            <div class="flex items-center justify-between gap-3">
              <h2 class="text-xs text-[var(--text-muted)]">Memory</h2>
              <span
                v-if="machine.memory_pressure"
                class="flex items-center gap-1.5 text-xs"
                :class="memoryLevel === 'normal' ? 'text-[var(--live-text)]' : memoryLevel === 'warning' ? 'font-medium text-[var(--attention-text)]' : 'font-medium text-[var(--log-error)]'"
              >
                <span class="inline-flex h-2 w-2 rounded-full" :class="memoryLevel === 'normal' ? 'bg-[var(--live)]' : memoryLevel === 'warning' ? 'bg-[var(--attention)]' : 'bg-[var(--log-error)]'"></span>
                Pressure {{ memoryLevel }}
              </span>
            </div>
            <p class="mt-1 text-[28px] font-semibold leading-8 tracking-[-0.02em] text-[var(--text-strong)]">
              {{ formatBytes(machine.memory_used) }}
              <span class="text-sm font-normal tracking-normal text-[var(--text-muted)]">of {{ formatBytes(machine.memory_total) }}</span>
            </p>
            <p class="mt-1 min-h-[40px] text-xs leading-5 text-[var(--text-muted)]">
              Dev servers {{ total ? formatBytes(total.memory) : '–' }}<template v-if="machine.swap_used">, {{ formatBytes(machine.swap_used) }} swapped to disk</template>.
              <template v-if="machine.memory_pressure">{{ PRESSURE_TEXT[memoryLevel] }}</template>
            </p>
            <UsageChart class="mt-3" label="Memory" :points="memoryPoints" :window-ms="historyMs" :now="now" :format="formatMemory" />
          </section>
        </div>

        <section class="mt-5 overflow-hidden" :class="panelClass" aria-label="What is using it">
          <div class="overflow-x-auto">
            <div class="min-w-[560px]">
              <div class="grid h-8 items-center gap-3 border-b border-[var(--border)] px-4 text-xs text-[var(--text-subtle)]" :class="columns">
                <span>Dev server</span>
                <span>Started by</span>
                <span>CPU</span>
                <span>Memory</span>
                <span></span>
              </div>
              <div v-if="!report" class="flex h-20 items-center justify-center" role="status" aria-label="Measuring">
                <span :class="spinnerClass" aria-hidden="true"></span>
              </div>
              <template v-for="row in rows" :key="row.key">
                <div class="group grid min-h-[40px] items-center gap-3 border-b border-[var(--border)] px-4 py-1 transition-colors last:border-b-0 hover:bg-[var(--hover)]" :class="columns">
                  <span class="flex min-w-0 items-center gap-2">
                    <button v-if="row.group" type="button" class="truncate text-left font-medium text-[var(--text-strong)] hover:underline" @click="openDetails(row.group)">{{ row.name }}</button>
                    <span v-else class="truncate font-medium text-[var(--text-strong)]">{{ row.name }}</span>
                    <span v-if="row.detail" class="shrink-0 rounded bg-[var(--panel-muted)] px-1.5 py-0.5 text-[11px] text-[var(--text-muted)]">{{ row.detail }}</span>
                  </span>
                  <span class="truncate text-xs" :class="row.tag === 'Left behind' ? 'text-[var(--attention-text)]' : 'text-[var(--text-muted)]'">{{ row.tag }}</span>
                  <span class="flex min-w-0 flex-col gap-1">
                    <span class="text-xs tabular-nums text-[var(--text-strong)]">{{ row.cpu.toFixed(1) }}%</span>
                    <span v-if="row.cpu >= 0.1" class="block h-[3px] rounded-full bg-[var(--electric)] transition-[width] duration-500" :style="{ width: `${100 * row.cpu / largestCpu}%` }"></span>
                  </span>
                  <span class="flex min-w-0 flex-col gap-1">
                    <span class="text-xs tabular-nums text-[var(--text-strong)]">{{ formatBytes(row.memory) }}</span>
                    <span class="block h-[3px] rounded-full bg-[var(--electric)] transition-[width] duration-500" :style="{ width: `${Math.max(1, 100 * row.memory / largestMemory)}%` }"></span>
                  </span>
                  <span class="flex justify-end opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100" :class="confirming === row.key || (row.server && stopping[row.key]) ? 'opacity-100' : ''">
                    <button v-if="row.group" :class="btnGhostXs" :disabled="!!groupActionLoading[row.group.key]" @click="stopProject(row.group)">Stop</button>
                    <button
                      v-else-if="row.server"
                      :class="confirming === row.key ? btnConfirm : btnGhostXs"
                      class="!h-7 !px-2.5 !text-xs"
                      :disabled="stopping[row.key]"
                      @click="stopServer(row.server)"
                      @mouseleave="confirming === row.key && (confirming = null)"
                    >{{ confirming === row.key ? 'Stop it?' : 'Stop' }}</button>
                  </span>
                </div>
                <template v-if="showServices(row)">
                  <div
                    v-for="service in row.services"
                    :key="service.key"
                    class="grid h-8 items-center gap-3 border-b border-[var(--border)] px-4 text-xs text-[var(--text-muted)]"
                    :class="columns"
                  >
                    <span class="truncate pl-3">{{ service.name }}</span>
                    <span></span>
                    <span class="tabular-nums">{{ service.cpu.toFixed(1) }}%</span>
                    <span class="tabular-nums">{{ formatBytes(service.memory) }}</span>
                    <span></span>
                  </div>
                </template>
              </template>
            </div>
          </div>
        </section>
        <section v-if="sortedApps.length" class="mt-5 overflow-hidden" :class="panelClass" aria-label="Everything else">
          <div class="flex h-11 items-center justify-between gap-3 border-b border-[var(--border)] px-4">
            <h2 class="text-sm font-medium text-[var(--text-strong)]">Everything else</h2>
            <div class="flex items-center gap-0.5 rounded-md bg-[var(--panel-muted)] p-0.5 text-xs" role="group" aria-label="Sort by">
              <button
                v-for="option in (['memory', 'cpu'] as const)"
                :key="option"
                type="button"
                class="h-6 rounded px-2 transition-colors"
                :class="appsSort === option ? 'bg-[var(--panel-bg)] font-medium text-[var(--text-strong)] shadow-sm' : 'text-[var(--text-muted)] hover:text-[var(--text-strong)]'"
                :aria-pressed="appsSort === option"
                @click="appsSort = option"
              >{{ option === 'cpu' ? 'CPU' : 'Memory' }}</button>
            </div>
          </div>
          <div class="overflow-x-auto">
            <div class="min-w-[560px]">
              <div class="grid h-8 items-center gap-3 border-b border-[var(--border)] px-4 text-xs text-[var(--text-subtle)]" :class="columns">
                <span>App or process</span>
                <span>Kind</span>
                <span>CPU</span>
                <span>Memory</span>
                <span></span>
              </div>
              <div
                v-for="app in visibleApps"
                :key="app.key"
                class="grid min-h-[40px] items-center gap-3 border-b border-[var(--border)] px-4 py-1 transition-colors last:border-b-0 hover:bg-[var(--hover)]"
                :class="columns"
                :title="appTitle(app)"
              >
                <span class="flex min-w-0 items-baseline gap-2">
                  <span class="shrink-0 truncate font-medium text-[var(--text-strong)]" :class="app.detail ? 'max-w-[45%]' : ''">{{ app.name }}</span>
                  <span v-if="app.detail" class="truncate font-mono text-[11px] text-[var(--text-muted)]">{{ app.detail }}</span>
                </span>
                <span class="truncate text-xs text-[var(--text-muted)]">{{ KIND_LABEL[app.kind] }}</span>
                <span class="flex min-w-0 flex-col gap-1">
                  <span class="text-xs tabular-nums text-[var(--text-strong)]">{{ app.cpu.toFixed(1) }}%</span>
                  <span v-if="app.cpu >= 0.1" class="block h-[3px] rounded-full bg-[var(--text-subtle)] transition-[width] duration-500" :style="{ width: `${100 * app.cpu / largestAppCpu}%` }"></span>
                </span>
                <span class="flex min-w-0 flex-col gap-1">
                  <span class="text-xs tabular-nums text-[var(--text-strong)]">{{ formatBytes(app.memory) }}</span>
                  <span class="block h-[3px] rounded-full bg-[var(--text-subtle)] transition-[width] duration-500" :style="{ width: `${Math.max(1, 100 * app.memory / largestAppMemory)}%` }"></span>
                </span>
                <span></span>
              </div>
            </div>
          </div>
          <button
            v-if="sortedApps.length > APPS_SHOWN"
            type="button"
            class="flex h-9 w-full items-center justify-center border-t border-[var(--border)] text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text-strong)]"
            @click="showAllApps = !showAllApps"
          >{{ showAllApps ? 'Show fewer' : `Show ${sortedApps.length - APPS_SHOWN} more` }}</button>
        </section>
        <p class="mt-2.5 text-xs leading-5 text-[var(--text-subtle)]">
          CPU is a share of the whole Mac. Memory is footprint, as in Activity Monitor, including what has been compressed or swapped out. Each server counts along with the processes it started, not the terminal or agent that started it. Apps include their helper processes; a script includes what it started. Docker's virtual machine holds its containers, so they count there too. Everything else is measured every 20 seconds.
        </p>
      </div>
    </div>
  </div>
</template>
