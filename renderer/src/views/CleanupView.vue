<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useCleanup } from '../composables/useCleanup'
import { useNavigation } from '../composables/useNavigation'
import { useProjects } from '../composables/useProjects'
import { useRunningServers } from '../composables/useRunningServers'
import { useServiceActions } from '../composables/useServiceActions'
import { formatBytes } from '../composables/useUsage'
import { type MemoryTrend, type ProjectDiskUse, type RunningServer } from '../types'
import { btnConfirm, btnGhostXs, noScrollbar, panelClass, panelProjectClass, spinnerClass } from '../ui'

// Keeping many projects tidy: memory that keeps climbing, servers nobody uses, worktrees whose
// work has landed, and what can be rebuilt or thrown away to get disk back.

const { report, disk, error, busy, fetchReport, fetchDisk, trashFolders, removeDocker, untrack, run } = useCleanup()
const { projectById, groupForService } = useProjects()
const { openDetails } = useNavigation()
const { runFailureAction, stopProject } = useServiceActions()
const { stopRunningServer } = useRunningServers()

onMounted(() => {
  fetchReport(true)
  fetchDisk()
})

// Actions that cannot be undone, or stop something, take a second press.
const confirming = ref<string | null>(null)
function confirmFirst(key: string, action: () => unknown) {
  if (confirming.value !== key) {
    confirming.value = key
    return
  }
  confirming.value = null
  action()
}

const label = (project: string, name: string) => name === project ? name : `${project} / ${name}`

function since(iso: string | null) {
  if (!iso) return 'never'
  const minutes = Math.max(0, (Date.now() - Date.parse(iso)) / 60000)
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`
  const days = Math.round(minutes / (24 * 60))
  return days < 60 ? `${days} days` : `${Math.round(days / 30)} months`
}

// ---- Memory tracking

const growing = computed(() => report.value?.memory.filter((trend) => trend.status === 'growing') ?? [])
const judged = computed(() => report.value?.memory.filter((trend) => trend.status !== 'warming-up').length ?? 0)
const memorySummary = computed(() => {
  const count = growing.value.length
  if (count) return `${count === 1 ? 'One service' : `${count} services`} growing`
  if (!report.value?.memory.length) return 'Nothing running'
  return judged.value ? 'All steady' : 'Warming up'
})

function sparkline(points: number[]) {
  if (points.length < 2) return ''
  const low = Math.min(...points)
  const high = Math.max(...points)
  const span = high - low || 1
  return points.map((value, index) => `${(index / (points.length - 1)) * 96},${22 - ((value - low) / span) * 20}`).join(' ')
}

function change(trend: MemoryTrend) {
  const delta = trend.current - trend.first
  if (Math.abs(delta) < 1024 * 1024) return 'no change'
  return `${delta > 0 ? '+' : '−'}${formatBytes(Math.abs(delta))}`
}

function trendText(trend: MemoryTrend) {
  if (trend.status === 'growing') return `Growing ${formatBytes(trend.growth_per_hour ?? 0)}/h`
  if (trend.status === 'steady') return 'Steady'
  return 'Warming up'
}

function restart(trend: MemoryTrend) {
  const service = projectById(trend.service_id)
  if (service) run(`restart:${trend.service_id}`, async () => {
    await runFailureAction(service, 'restart')
    await fetchReport(true)
  })
}

function openProject(serviceId: string) {
  const group = groupForService(serviceId)
  if (group) openDetails(group)
}

// ---- Servers to stop

type StopRow = { key: string; name: string; tag: string; detail: string; stop: () => Promise<void> }

const stopRows = computed<StopRow[]>(() => {
  const current = report.value
  if (!current) return []
  return [
    ...current.idle.map((server) => ({
      key: `idle:${server.service_id}`,
      name: label(server.project, server.name),
      tag: 'Idle',
      detail: `No output for ${since(server.quiet_since)}`,
      stop: async () => {
        const service = projectById(server.service_id)
        if (service) await stopProject(service)
      }
    })),
    ...current.leftovers.map((server: RunningServer) => ({
      key: `leftover:${server.key}`,
      name: server.worktree ? `${server.project} / ${server.worktree}` : server.project ?? server.command,
      tag: 'Left behind',
      detail: `${server.ports.map((port) => `:${port}`).join(' ')} · ${server.leftover_reason ?? ''}`,
      stop: () => stopRunningServer(server)
    }))
  ]
})

function stopServer(row: StopRow) {
  run(row.key, async () => {
    await row.stop()
    await fetchReport(true)
  })
}

// ---- Worktrees

const worktrees = computed(() => report.value?.worktrees ?? [])

function untrackAll() {
  run('worktrees', async () => {
    for (const worktree of worktrees.value) await untrack(`worktree:${worktree.root}`, worktree.service_ids)
  })
}

// ---- Disk

const DISK_SHOWN = 10
const showAllDisk = ref(false)
const expanded = ref<string | null>(null)

const diskProjects = computed(() => (disk.value?.projects ?? []).filter((project) => project.bytes > 0))
const visibleDisk = computed(() => showAllDisk.value ? diskProjects.value : diskProjects.value.slice(0, DISK_SHOWN))
const stoppedDisk = computed(() => diskProjects.value.filter((project) => !project.running))
const reclaimable = computed(() => stoppedDisk.value.reduce((sum, project) => sum + project.bytes, 0))
const largestDisk = computed(() => Math.max(1, ...diskProjects.value.map((project) => project.bytes)))

function cleanProject(project: ProjectDiskUse) {
  confirmFirst(`disk:${project.root}`, () => trashFolders(`disk:${project.root}`, project.folders.map((folder) => folder.path)))
}

// ---- Docker

const docker = computed(() => report.value?.docker ?? null)
const dockerCount = computed(() => docker.value ? docker.value.containers.length + docker.value.volumes.length + docker.value.images.length : 0)

const sectionHeader = 'flex h-11 items-center justify-between gap-3 border-b border-[var(--border)] px-4'
const row = 'grid min-h-[44px] items-center gap-3 border-b border-[var(--border)] px-4 py-1.5 transition-colors last:border-b-0 hover:bg-[var(--hover)]'
const empty = 'px-4 py-3.5 text-xs text-[var(--text-subtle)]'
const tag = 'shrink-0 rounded bg-[var(--panel-muted)] px-1.5 py-0.5 text-[11px] text-[var(--text-muted)]'
</script>

<template>
  <div class="flex h-full min-h-0 flex-col" :class="panelProjectClass">
    <header class="page-header flex h-[52px] shrink-0 items-center justify-between border-b border-[var(--border)] px-6">
      <h1 class="text-sm font-medium text-[var(--text-strong)]">Cleanup</h1>
      <button :class="btnGhostXs" @click="fetchReport(true); fetchDisk(true)">Check again</button>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto" :class="noScrollbar">
      <div v-if="!report" class="flex min-h-44 items-center justify-center" role="status" aria-label="Checking">
        <span :class="spinnerClass" aria-hidden="true"></span>
      </div>

      <div v-else class="w-full px-6 pb-8 pt-5">
        <p v-if="error" class="mb-3 rounded-md border border-[var(--danger-text)] bg-[var(--danger-bg)] px-3 py-2 text-xs text-[var(--danger-text)]">{{ error }}</p>

        <div class="grid gap-3 sm:grid-cols-3">
          <section class="p-4" :class="panelClass">
            <h2 class="text-xs text-[var(--text-muted)]">Disk you can get back</h2>
            <p class="mt-1 text-[28px] font-semibold leading-8 tracking-[-0.02em] text-[var(--text-strong)]">
              <template v-if="disk?.measured_at">{{ formatBytes(reclaimable) }}</template>
              <span v-else class="inline-flex h-8 items-center"><span :class="spinnerClass" aria-hidden="true"></span></span>
            </p>
            <p class="mt-1 text-xs text-[var(--text-muted)]">Dependencies and build output in {{ stoppedDisk.length }} project{{ stoppedDisk.length === 1 ? '' : 's' }} not running</p>
          </section>
          <section class="p-4" :class="panelClass">
            <h2 class="text-xs text-[var(--text-muted)]">Memory</h2>
            <p class="mt-1 text-[28px] font-semibold leading-8 tracking-[-0.02em]" :class="growing.length ? 'text-[var(--attention-text)]' : 'text-[var(--text-strong)]'">
              {{ memorySummary }}
            </p>
            <p class="mt-1 text-xs text-[var(--text-muted)]">
              {{ report.memory.length }} running service{{ report.memory.length === 1 ? '' : 's' }} tracked<template v-if="report.memory.length && !judged">, judged after 25 minutes</template>
            </p>
          </section>
          <section class="p-4" :class="panelClass">
            <h2 class="text-xs text-[var(--text-muted)]">To tidy</h2>
            <p class="mt-1 text-[28px] font-semibold leading-8 tracking-[-0.02em] text-[var(--text-strong)]">{{ stopRows.length + worktrees.length + dockerCount }}</p>
            <p class="mt-1 text-xs text-[var(--text-muted)]">Idle servers, leftovers, stale worktrees and Docker</p>
          </section>
        </div>

        <!-- Memory tracking -->
        <section class="mt-5 overflow-hidden" :class="panelClass" aria-label="Memory tracking">
          <div :class="sectionHeader">
            <h2 class="text-sm font-medium text-[var(--text-strong)]">Memory tracking</h2>
            <span class="text-xs text-[var(--text-subtle)]">Since each service started</span>
          </div>
          <div v-if="!report.memory.length" :class="empty">Nothing is running. Services are measured from the moment they start.</div>
          <div
            v-for="trend in report.memory"
            :key="trend.service_id"
            class="group"
            :class="[row, 'grid-cols-[minmax(0,1fr)_76px_84px_104px_minmax(110px,150px)_76px]']"
          >
            <button type="button" class="truncate text-left font-medium text-[var(--text-strong)] hover:underline" @click="openProject(trend.service_id)">{{ label(trend.project, trend.name) }}</button>
            <span class="text-xs tabular-nums text-[var(--text-strong)]">{{ formatBytes(trend.current) }}</span>
            <span class="text-xs tabular-nums text-[var(--text-muted)]" :title="`First measured at ${formatBytes(trend.first)}, peak ${formatBytes(trend.peak)}`">{{ change(trend) }}</span>
            <svg viewBox="0 0 96 24" class="h-6 w-24" preserveAspectRatio="none" aria-hidden="true">
              <polyline
                :points="sparkline(trend.points)"
                fill="none"
                stroke-width="1.5"
                vector-effect="non-scaling-stroke"
                stroke-linejoin="round"
                :stroke="trend.status === 'growing' ? 'var(--attention)' : 'var(--text-subtle)'"
              />
            </svg>
            <span class="flex items-center gap-1.5 text-xs" :class="trend.status === 'growing' ? 'font-medium text-[var(--attention-text)]' : 'text-[var(--text-muted)]'">
              <span class="inline-flex h-2 w-2 shrink-0 rounded-full" :class="trend.status === 'growing' ? 'bg-[var(--attention)]' : trend.status === 'steady' ? 'bg-[var(--live)]' : 'bg-[var(--text-subtle)]'"></span>
              {{ trendText(trend) }}
            </span>
            <span class="flex justify-end">
              <button
                v-if="trend.status === 'growing' || busy[`restart:${trend.service_id}`]"
                :class="btnGhostXs"
                :disabled="busy[`restart:${trend.service_id}`]"
                @click="restart(trend)"
              >Restart</button>
            </span>
          </div>
          <p class="border-t border-[var(--border)] px-4 py-2.5 text-xs leading-5 text-[var(--text-subtle)]">
            Measured every 30 seconds, in the background. The first 5 minutes are left out: dev servers fill caches as they start. Growing means memory kept rising for at least 20 minutes without coming back down. That can be a leak in your code or tooling holding on to more; a restart tells you which.
          </p>
        </section>

        <!-- Servers to stop -->
        <section class="mt-5 overflow-hidden" :class="panelClass" aria-label="Servers to stop">
          <div :class="sectionHeader">
            <h2 class="text-sm font-medium text-[var(--text-strong)]">Idle and left behind</h2>
            <span class="text-xs text-[var(--text-subtle)]">Idle: no output and next to no CPU for 2 hours</span>
          </div>
          <div v-if="!stopRows.length" :class="empty">Every running server is in use.</div>
          <div v-for="entry in stopRows" :key="entry.key" class="group" :class="[row, 'grid-cols-[minmax(0,1fr)_96px_minmax(0,1.2fr)_76px]']">
            <span class="truncate font-medium text-[var(--text-strong)]">{{ entry.name }}</span>
            <span class="text-xs" :class="entry.tag === 'Left behind' ? 'text-[var(--attention-text)]' : 'text-[var(--text-muted)]'">{{ entry.tag }}</span>
            <span class="truncate text-xs text-[var(--text-muted)]">{{ entry.detail }}</span>
            <span class="flex justify-end">
              <button :class="btnGhostXs" :disabled="busy[entry.key]" @click="stopServer(entry)">Stop</button>
            </span>
          </div>
        </section>

        <!-- Worktrees -->
        <section class="mt-5 overflow-hidden" :class="panelClass" aria-label="Stale worktrees">
          <div :class="sectionHeader">
            <h2 class="text-sm font-medium text-[var(--text-strong)]">Stale worktrees</h2>
            <button v-if="worktrees.length > 1" :class="btnGhostXs" :disabled="busy.worktrees" @click="untrackAll">Untrack all {{ worktrees.length }}</button>
          </div>
          <div v-if="!worktrees.length" :class="empty">No tracked worktree looks finished.</div>
          <div v-for="worktree in worktrees" :key="worktree.root" class="group" :class="[row, 'grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_84px]']">
            <span class="flex min-w-0 items-center gap-2">
              <span class="truncate font-medium text-[var(--text-strong)]">{{ worktree.project }} / {{ worktree.name }}</span>
              <span v-if="worktree.branch && worktree.branch !== worktree.name" :class="tag" class="font-mono">{{ worktree.branch }}</span>
            </span>
            <span class="truncate text-xs text-[var(--text-muted)]" :title="worktree.root">{{ worktree.detail }}<template v-if="worktree.last_commit_at"> Last commit {{ since(worktree.last_commit_at) }} ago.</template></span>
            <span class="flex justify-end">
              <button :class="btnGhostXs" :disabled="busy[`worktree:${worktree.root}`]" @click="untrack(`worktree:${worktree.root}`, worktree.service_ids)">Untrack</button>
            </span>
          </div>
          <p class="border-t border-[var(--border)] px-4 py-2.5 text-xs leading-5 text-[var(--text-subtle)]">
            Untracking takes it out of Multiprise. The folder and its branch stay as they are. Worktrees with uncommitted changes are never listed.
          </p>
        </section>

        <!-- Disk -->
        <section class="mt-5 overflow-hidden" :class="panelClass" aria-label="Disk use">
          <div :class="sectionHeader">
            <h2 class="text-sm font-medium text-[var(--text-strong)]">Disk use</h2>
            <span class="flex items-center gap-2 text-xs text-[var(--text-subtle)]">
              <span v-if="disk?.measuring" :class="spinnerClass" aria-hidden="true"></span>
              {{ disk?.measuring ? 'Measuring…' : disk?.measured_at ? `Measured ${since(disk.measured_at)} ago` : '' }}
            </span>
          </div>
          <div v-if="!disk?.measured_at && disk?.measuring" :class="empty">Measuring each project's dependencies and build output. The first time takes a minute.</div>
          <div v-else-if="!diskProjects.length" :class="empty">Nothing to clean.</div>
          <template v-for="project in visibleDisk" :key="project.root">
            <div class="group" :class="[row, 'grid-cols-[minmax(0,1fr)_92px_minmax(96px,170px)_128px]']">
              <button type="button" class="flex min-w-0 items-center gap-2 text-left" @click="expanded = expanded === project.root ? null : project.root">
                <svg viewBox="0 0 24 24" class="h-3 w-3 shrink-0 text-[var(--text-subtle)] transition" :class="expanded === project.root ? 'rotate-90' : ''" fill="none" stroke="currentColor" stroke-width="1.8">
                  <path d="M9 5l7 7-7 7" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <span class="truncate font-medium text-[var(--text-strong)]">{{ project.name }}</span>
                <span :class="tag">{{ project.folders.length }} folder{{ project.folders.length === 1 ? '' : 's' }}</span>
              </button>
              <span class="text-xs text-[var(--text-muted)]">{{ project.running ? 'Running' : project.last_run_at ? `Ran ${since(project.last_run_at)} ago` : 'Not run yet' }}</span>
              <span class="flex min-w-0 flex-col gap-1">
                <span class="text-xs tabular-nums text-[var(--text-strong)]">{{ formatBytes(project.bytes) }}</span>
                <span class="block h-[3px] rounded-full bg-[var(--electric)]" :style="{ width: `${Math.max(1, 100 * project.bytes / largestDisk)}%` }"></span>
              </span>
              <span class="flex justify-end">
                <button
                  :class="confirming === `disk:${project.root}` ? btnConfirm : btnGhostXs"
                  class="!h-7 !px-2.5 !text-xs"
                  :disabled="project.running || busy[`disk:${project.root}`]"
                  :title="project.running ? 'Stop it first: a running server needs its dependencies.' : 'Move these folders to the Trash'"
                  @click="cleanProject(project)"
                  @mouseleave="confirming === `disk:${project.root}` && (confirming = null)"
                >{{ confirming === `disk:${project.root}` ? 'Move to Trash?' : 'Clean' }}</button>
              </span>
            </div>
            <template v-if="expanded === project.root">
              <div
                v-for="folder in project.folders"
                :key="folder.path"
                class="grid h-8 grid-cols-[minmax(0,1fr)_92px_minmax(96px,170px)_128px] items-center gap-3 border-b border-[var(--border)] px-4 text-xs text-[var(--text-muted)]"
              >
                <span class="truncate pl-5 font-mono text-[11px]" :title="folder.path">{{ folder.relative }}</span>
                <span></span>
                <span class="tabular-nums">{{ formatBytes(folder.bytes) }}</span>
                <span></span>
              </div>
            </template>
          </template>
          <button
            v-if="diskProjects.length > DISK_SHOWN"
            type="button"
            class="flex h-9 w-full items-center justify-center border-t border-[var(--border)] text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text-strong)]"
            @click="showAllDisk = !showAllDisk"
          >{{ showAllDisk ? 'Show fewer' : `Show ${diskProjects.length - DISK_SHOWN} more` }}</button>
          <p class="border-t border-[var(--border)] px-4 py-2.5 text-xs leading-5 text-[var(--text-subtle)]">
            Only folders git ignores: node_modules, build output, caches. Cleaning moves them to the Trash; the next install or build brings them back.
          </p>
        </section>

        <!-- Docker -->
        <section v-if="docker?.available" class="mt-5 overflow-hidden" :class="panelClass" aria-label="Docker leftovers">
          <div :class="sectionHeader">
            <h2 class="text-sm font-medium text-[var(--text-strong)]">Docker leftovers</h2>
            <span class="text-xs text-[var(--text-subtle)]">Stopped containers, unused volumes, untagged images</span>
          </div>
          <div v-if="!dockerCount" :class="empty">Docker has nothing lying around.</div>
          <div v-for="container in docker.containers" :key="container.id" class="group" :class="[row, 'grid-cols-[minmax(0,1fr)_96px_minmax(0,1fr)_128px]']">
            <span class="truncate font-medium text-[var(--text-strong)]">{{ container.project ? `${container.project} / ${container.name}` : container.name }}</span>
            <span class="text-xs text-[var(--text-muted)]">Container</span>
            <span class="truncate text-xs text-[var(--text-muted)]">{{ container.image }} · {{ container.status }}</span>
            <span class="flex justify-end">
              <button
                :class="confirming === `container:${container.id}` ? btnConfirm : btnGhostXs"
                class="!h-7 !px-2.5 !text-xs"
                :disabled="busy[`container:${container.id}`]"
                @click="confirmFirst(`container:${container.id}`, () => removeDocker(`container:${container.id}`, { containers: [container.id] }))"
                @mouseleave="confirming === `container:${container.id}` && (confirming = null)"
              >{{ confirming === `container:${container.id}` ? 'Remove it?' : 'Remove' }}</button>
            </span>
          </div>
          <div v-for="volume in docker.volumes" :key="volume.name" class="group" :class="[row, 'grid-cols-[minmax(0,1fr)_96px_minmax(0,1fr)_128px]']">
            <span class="truncate font-medium text-[var(--text-strong)]">{{ volume.name }}</span>
            <span class="text-xs text-[var(--text-muted)]">Volume</span>
            <span class="truncate text-xs text-[var(--attention-text)]">Unused. Removing it deletes its data for good.</span>
            <span class="flex justify-end">
              <button
                :class="confirming === `volume:${volume.name}` ? btnConfirm : btnGhostXs"
                class="!h-7 !px-2.5 !text-xs"
                :disabled="busy[`volume:${volume.name}`]"
                @click="confirmFirst(`volume:${volume.name}`, () => removeDocker(`volume:${volume.name}`, { volumes: [volume.name] }))"
                @mouseleave="confirming === `volume:${volume.name}` && (confirming = null)"
              >{{ confirming === `volume:${volume.name}` ? 'Delete data?' : 'Remove' }}</button>
            </span>
          </div>
          <div v-for="image in docker.images" :key="image.id" class="group" :class="[row, 'grid-cols-[minmax(0,1fr)_96px_minmax(0,1fr)_128px]']">
            <span class="truncate font-mono text-xs font-medium text-[var(--text-strong)]">{{ image.id }}</span>
            <span class="text-xs text-[var(--text-muted)]">Image</span>
            <span class="truncate text-xs text-[var(--text-muted)]">{{ image.size }} · {{ image.created }}</span>
            <span class="flex justify-end">
              <button
                :class="confirming === `image:${image.id}` ? btnConfirm : btnGhostXs"
                class="!h-7 !px-2.5 !text-xs"
                :disabled="busy[`image:${image.id}`]"
                @click="confirmFirst(`image:${image.id}`, () => removeDocker(`image:${image.id}`, { images: [image.id] }))"
                @mouseleave="confirming === `image:${image.id}` && (confirming = null)"
              >{{ confirming === `image:${image.id}` ? 'Remove it?' : 'Remove' }}</button>
            </span>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
