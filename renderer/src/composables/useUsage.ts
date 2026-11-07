import { computed, ref, watch } from 'vue'
import { apiFetch } from '../lib/api'
import { type MachineUsage, type MemoryPressure, type UsageReport } from '../types'
import { useNavigation } from './useNavigation'

// How busy this Mac is, for the sidebar, and what each server takes while Activity is open.
// The graphs remember the last few minutes the app was open; nothing is saved.

export type UsageSample = {
  at: number
  cpu: number | null
  memory: number
  serversCpu: number | null
  serversMemory: number | null
}

const SAMPLE_MS = 3000
const HISTORY_MS = 6 * 60 * 1000
// Longer than this between samples (the window was hidden) and a line would join across a gap.
const GAP_MS = SAMPLE_MS * 4

const { activeSection } = useNavigation()

const machine = ref<MachineUsage | null>(null)
const report = ref<UsageReport | null>(null)
const history = ref<UsageSample[]>([])

export const serversTotal = (usage: UsageReport) => {
  const rows = [...usage.services, ...usage.servers, ...usage.containers]
  return {
    cpu: rows.reduce((sum, row) => sum + row.cpu, 0),
    memory: rows.reduce((sum, row) => sum + row.memory, 0)
  }
}

function record(usage: MachineUsage, detail: UsageReport | null) {
  const now = Date.now()
  const total = detail ? serversTotal(detail) : null
  const last = history.value[history.value.length - 1]
  const kept = last && now - last.at > GAP_MS ? [] : history.value.filter((sample) => now - sample.at <= HISTORY_MS)
  history.value = [...kept, {
    at: now,
    cpu: usage.cpu,
    memory: 100 * usage.memory_used / usage.memory_total,
    serversCpu: total ? Math.min(100, total.cpu) : null,
    serversMemory: total ? Math.min(100, 100 * total.memory / usage.memory_total) : null
  }]
}

let sampling = false

async function sample() {
  if (document.hidden || sampling) return
  sampling = true
  try {
    const detailed = activeSection.value === 'activity'
    const response = await apiFetch(detailed ? '/api/usage' : '/api/usage/machine')
    if (!response.ok) return
    const data = await response.json()
    const detail = detailed ? data as UsageReport : null
    if (detail) report.value = detail
    machine.value = detail ? detail.machine : data as MachineUsage
    record(machine.value, detail)
  } catch (err) {
    // The next sample tries again.
  } finally {
    sampling = false
  }
}

let timer: number | undefined
let stopWatching: (() => void) | undefined

function startUsage() {
  sample()
  timer = window.setInterval(sample, SAMPLE_MS)
  document.addEventListener('visibilitychange', sample)
  stopWatching = watch(activeSection, (section) => {
    if (section === 'activity') sample()
  })
}

function stopUsage() {
  window.clearInterval(timer)
  document.removeEventListener('visibilitychange', sample)
  stopWatching?.()
}

// Using most of the memory is normal on a Mac; pressure is what says it has become a problem.
const BUSY_CPU = 90

const cpuLevel = computed<MemoryPressure>(() => (machine.value?.cpu ?? 0) >= BUSY_CPU ? 'warning' : 'normal')
const memoryLevel = computed<MemoryPressure>(() => machine.value?.memory_pressure ?? 'normal')

export function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1).replace(/\.0$/, '')} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}

export function useUsage() {
  return { machine, report, history, cpuLevel, memoryLevel, historyMs: HISTORY_MS, sample, startUsage, stopUsage }
}
