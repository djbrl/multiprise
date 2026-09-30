import { ref } from 'vue'
import { apiFetch } from '../lib/api'
import { type AppEvent } from '../types'
import { useLogs } from './useLogs'
import { usePorts } from './usePorts'
import { useProjects } from './useProjects'

// Status changes, log lines and project edits pushed by the backend as they happen.

const { projects, loadProjects } = useProjects()
const { applyLogEvent, clearLogs, refreshSelectedLogs } = useLogs()
const { schedulePortsReload } = usePorts()

const eventStreamConnected = ref(false)
let abortController: AbortController | null = null
let retryTimer: number | undefined
let projectsReloadTimer: number | undefined

// Many status events arrive together during a launch; reload the list once for them.
function scheduleProjectsReload() {
  if (projectsReloadTimer) return
  projectsReloadTimer = window.setTimeout(async () => {
    projectsReloadTimer = undefined
    await loadProjects()
  }, 120)
}

function handleAppEvent(event: AppEvent) {
  if (event.type === 'log') {
    applyLogEvent(event.id, event.entry, event.replace)
  } else if (event.type === 'logs-cleared') {
    clearLogs(event.id)
  } else if (event.type === 'status') {
    const view = projects.value.find((item) => item.project.id === event.id)
    if (view) view.status = event.status
    scheduleProjectsReload()
    schedulePortsReload()
  } else if (event.type === 'projects') {
    scheduleProjectsReload()
  }
}

// EventSource cannot send the API token header, so the stream is read through fetch.
async function connectEventStream() {
  if (abortController) return
  const controller = new AbortController()
  abortController = controller
  let connected = false
  try {
    const response = await apiFetch('/api/events', { signal: controller.signal })
    if (!response.ok || !response.body) throw new Error('Event stream unavailable')
    connected = true
    eventStreamConnected.value = true
    // Anything that happened while disconnected was missed; resynchronise once.
    await Promise.all([loadProjects(), refreshSelectedLogs()])
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += value
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n')
        if (data) {
          try {
            handleAppEvent(JSON.parse(data) as AppEvent)
          } catch (err) {
            console.error('[multiprise] bad event', err)
          }
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
  } catch (err) {
    // Aborted on unmount, or the backend went away; the retry below covers the latter.
  } finally {
    if (abortController === controller) abortController = null
    eventStreamConnected.value = false
  }
  if (controller.signal.aborted) return
  retryTimer = window.setTimeout(connectEventStream, connected ? 500 : 3000)
}

function disconnectEventStream() {
  if (retryTimer) window.clearTimeout(retryTimer)
  retryTimer = undefined
  if (projectsReloadTimer) window.clearTimeout(projectsReloadTimer)
  projectsReloadTimer = undefined
  abortController?.abort()
  abortController = null
}

export function useEventStream() {
  return { eventStreamConnected, connectEventStream, disconnectEventStream }
}
