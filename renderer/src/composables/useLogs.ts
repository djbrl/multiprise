import { computed, reactive, ref } from 'vue'
import { type LogEntry } from '../components/LogViewer.vue'
import { apiFetch, errorMessage, jsonBody, throwResponseError } from '../lib/api'
import { projectTitle, serviceRole } from '../lib/services'
import { type LogLine } from '../types'
import { useNavigation } from './useNavigation'
import { pruneRecord, useProjects } from './useProjects'

// Service output: a snapshot per service on demand, then new lines from the event stream.

const MAX_CLIENT_LOG_LINES = 2000
const LOG_FETCH_TAIL = 1000

const { error, onProjectsLoaded } = useProjects()
const { selectedGroup } = useNavigation()

const logs = reactive<Record<string, LogLine[]>>({})
const logsRefreshing = ref(false)
// The open project's log viewer, for the palette's "Search logs".
const logViewer = ref<{ search: (text: string) => void; focusSearch: () => void } | null>(null)

onProjectsLoaded((ids) => pruneRecord(logs, (id) => ids.has(id)))

async function fetchLogs(id: string) {
  try {
    const response = await apiFetch(`/api/projects/${id}/logs?tail=${LOG_FETCH_TAIL}`)
    if (!response.ok) return
    const data = (await response.json()) as { logs: LogLine[] }
    // Lines streamed while the request was in flight are newer than the snapshot; keep them.
    const snapshotSeq = data.logs[data.logs.length - 1]?.seq ?? 0
    const streamed = (logs[id] ?? []).filter((entry) => entry.seq > snapshotSeq)
    logs[id] = [...data.logs, ...streamed]
  } catch (err) {
    // The next event or refresh fills it in.
  }
}

function applyLogEvent(id: string, entry: LogLine, replace: boolean) {
  const current = logs[id] ?? (logs[id] = [])
  const last = current[current.length - 1]
  if (replace && last?.seq === entry.seq) {
    current.splice(current.length - 1, 1, entry)
    return
  }
  if (last && entry.seq <= last.seq) return
  current.push(entry)
  if (current.length > MAX_CLIENT_LOG_LINES) current.splice(0, current.length - MAX_CLIENT_LOG_LINES)
}

function clearLogs(id: string) {
  logs[id] = []
}

async function refreshSelectedLogs() {
  if (!selectedGroup.value || logsRefreshing.value) return
  logsRefreshing.value = true
  try {
    await Promise.all(selectedGroup.value.items.map((service) => fetchLogs(service.project.id)))
  } finally {
    logsRefreshing.value = false
  }
}

// Every line of the open project's services, oldest first; LogViewer filters them.
const projectLogEntries = computed<LogEntry[]>(() => {
  if (!selectedGroup.value) return []
  const entries = selectedGroup.value.items.flatMap((item) => {
    const serviceName = projectTitle(item)
    const role = serviceRole(item)
    return (logs[item.project.id] ?? []).map((entry) => ({ ...entry, serviceId: item.project.id, serviceName, role }))
  })
  return entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime() || a.seq - b.seq)
})

const projectLogServices = computed(() =>
  (selectedGroup.value?.items ?? []).map((item) => ({ id: item.project.id, name: projectTitle(item), role: serviceRole(item) }))
)

// A source location printed in a log line, opened in the editor.
async function openLogFile(target: { serviceId: string; path: string; line?: number; column?: number }) {
  try {
    const response = await apiFetch(`/api/projects/${target.serviceId}/open-file`, jsonBody('POST', { path: target.path, line: target.line, column: target.column }))
    if (!response.ok) await throwResponseError(response, 'Unable to open the file')
  } catch (err) {
    error.value = errorMessage(err, 'Unable to open the file')
  }
}

export function useLogs() {
  return {
    logViewer,
    fetchLogs,
    applyLogEvent,
    clearLogs,
    openLogFile,
    refreshSelectedLogs,
    projectLogEntries,
    projectLogServices
  }
}
