import { computed, reactive, ref } from 'vue'
import { apiFetch, errorMessage, jsonBody, throwResponseError } from '../lib/api'
import { type RunningServer } from '../types'
import { useProjects } from './useProjects'

// Every dev server on this Mac, including ones Multiprise did not start. Nothing announces
// those, so the list is polled while it is on screen.

const { error, loadProjects } = useProjects()

const servers = ref<RunningServer[]>([])
const stopping = reactive<Record<string, boolean>>({})

const outsideServers = computed(() => servers.value.filter((server) => !server.managed))
const leftovers = computed(() => outsideServers.value.filter((server) => server.leftover))

async function fetchRunningServers() {
  try {
    const response = await apiFetch('/api/running')
    if (!response.ok) return
    const data = (await response.json()) as { servers: RunningServer[] }
    // Keep the same array when nothing changed, so the list does not re-render.
    if (JSON.stringify(data.servers) !== JSON.stringify(servers.value)) servers.value = data.servers
  } catch (err) {
    // The next refresh tries again.
  }
}

async function stopRunningServer(server: RunningServer) {
  if (stopping[server.key]) return
  stopping[server.key] = true
  error.value = ''
  try {
    const response = await apiFetch('/api/running/stop', jsonBody('POST', { key: server.key }))
    // Already gone is what was wanted.
    if (!response.ok && response.status !== 404) await throwResponseError(response, 'Unable to stop it')
    servers.value = servers.value.filter((entry) => entry.key !== server.key)
    // It may have been holding a port a tracked service was shown as blocked by.
    await loadProjects()
  } catch (err) {
    error.value = errorMessage(err, 'Unable to stop it')
  } finally {
    delete stopping[server.key]
  }
}

async function stopLeftovers() {
  await Promise.all(leftovers.value.map(stopRunningServer))
  await fetchRunningServers()
}

export function useRunningServers() {
  return { servers, outsideServers, leftovers, stopping, fetchRunningServers, stopRunningServer, stopLeftovers }
}
