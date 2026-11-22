import { computed, reactive, ref } from 'vue'
import { apiFetch, errorMessage, jsonBody, throwResponseError } from '../lib/api'
import { type CleanupReport, type DiskReport } from '../types'
import { useProjects } from './useProjects'

// The Cleanup page's data: memory tracking, idle and left-behind servers, stale worktrees,
// Docker leftovers and disk use. The report is cheap and refreshed in the background so the
// sidebar can say when something needs a look; disk use is measured only when asked for.

const REPORT_MS = 60 * 1000
const DISK_POLL_MS = 3000

const { loadProjects } = useProjects()

const report = ref<CleanupReport | null>(null)
const disk = ref<DiskReport | null>(null)
const error = ref('')
const busy = reactive<Record<string, boolean>>({})

// What asks for a decision; servers still warming up or steady do not.
const attentionCount = computed(() => {
  const current = report.value
  if (!current) return 0
  return current.memory.filter((trend) => trend.status === 'growing').length +
    current.idle.length +
    current.leftovers.length +
    current.worktrees.length +
    current.docker.containers.length + current.docker.volumes.length + current.docker.images.length
})

async function fetchReport(fresh = false) {
  try {
    const response = await apiFetch(`/api/cleanup${fresh ? '?fresh=1' : ''}`)
    if (!response.ok) await throwResponseError(response, 'Unable to check what needs cleaning')
    report.value = await response.json()
  } catch (err) {
    error.value = errorMessage(err)
  }
}

let diskTimer: number | undefined

async function fetchDisk(refresh = false) {
  window.clearTimeout(diskTimer)
  try {
    const response = await apiFetch(`/api/cleanup/disk${refresh ? '?refresh=1' : ''}`)
    if (!response.ok) await throwResponseError(response, 'Unable to measure disk use')
    disk.value = await response.json()
    // Measuring runs in the background; ask again until it is done.
    if (disk.value?.measuring) diskTimer = window.setTimeout(() => fetchDisk(), DISK_POLL_MS)
  } catch (err) {
    error.value = errorMessage(err)
  }
}

async function run(key: string, action: () => Promise<void>) {
  if (busy[key]) return
  busy[key] = true
  error.value = ''
  try {
    await action()
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    busy[key] = false
  }
}

// Folders go to the Trash; the project rebuilds them on its next install or build.
function trashFolders(key: string, paths: string[]) {
  return run(key, async () => {
    const response = await apiFetch('/api/cleanup/disk/trash', jsonBody('POST', { paths }))
    if (!response.ok) await throwResponseError(response, 'Unable to move them to the Trash')
    await fetchDisk()
  })
}

function removeDocker(key: string, items: { containers?: string[]; volumes?: string[]; images?: string[] }) {
  return run(key, async () => {
    const response = await apiFetch('/api/cleanup/docker/remove', jsonBody('POST', items))
    if (!response.ok) await throwResponseError(response, 'Docker could not remove them')
    await fetchReport(true)
  })
}

// Untracking forgets the worktree's services; the folder and its branch stay as they are.
function untrack(key: string, serviceIds: string[]) {
  return run(key, async () => {
    for (const id of serviceIds) {
      const response = await apiFetch(`/api/projects/${id}`, { method: 'DELETE' })
      if (!response.ok && response.status !== 404) await throwResponseError(response, 'Unable to untrack it')
    }
    await loadProjects()
    await fetchReport(true)
  })
}

let reportTimer: number | undefined

function startCleanupChecks() {
  fetchReport()
  reportTimer = window.setInterval(() => {
    if (!document.hidden) fetchReport()
  }, REPORT_MS)
}

function stopCleanupChecks() {
  window.clearInterval(reportTimer)
  window.clearTimeout(diskTimer)
}

export function useCleanup() {
  return {
    report,
    disk,
    error,
    busy,
    attentionCount,
    fetchReport,
    fetchDisk,
    trashFolders,
    removeDocker,
    untrack,
    run,
    startCleanupChecks,
    stopCleanupChecks
  }
}
