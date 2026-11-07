import { computed, ref } from 'vue'
import { apiFetch, errorMessage, throwResponseError } from '../lib/api'
import { readStored, STORAGE_KEYS, writeStored } from '../lib/storage'
import { type AgentStatus } from '../types'

// Whether Claude Code runs its dev servers through Multiprise, and the switch for it. It edits
// the user's own Claude Code setup, so it only ever happens when they press the button.

const status = ref<AgentStatus | null>(null)
const busy = ref(false)
const failure = ref('')
const dismissed = ref(readStored(STORAGE_KEYS.agentsOfferDismissed) === '1')

const isConnected = computed(() => !!status.value?.connected && !!status.value.instructions)
const showOffer = computed(() => !!status.value?.installed && !isConnected.value && !dismissed.value)

async function loadAgentStatus() {
  try {
    const response = await apiFetch('/api/agents')
    if (response.ok) status.value = (await response.json()) as AgentStatus
  } catch (err) {
    status.value = null
  }
}

async function change(action: 'connect' | 'disconnect') {
  if (busy.value) return
  busy.value = true
  failure.value = ''
  try {
    const response = await apiFetch(`/api/agents/${action}`, { method: 'POST' })
    if (!response.ok) await throwResponseError(response, `Unable to ${action} Claude Code`)
    status.value = (await response.json()) as AgentStatus
  } catch (err) {
    failure.value = errorMessage(err, `Unable to ${action} Claude Code`)
  } finally {
    busy.value = false
  }
}

function dismissOffer() {
  dismissed.value = true
  writeStored(STORAGE_KEYS.agentsOfferDismissed, '1')
}

export function useAgents() {
  return {
    agentStatus: status,
    agentsBusy: busy,
    agentsFailure: failure,
    agentsConnected: isConnected,
    showAgentsOffer: showOffer,
    loadAgentStatus,
    connectAgents: () => change('connect'),
    disconnectAgents: () => change('disconnect'),
    dismissAgentsOffer: dismissOffer
  }
}
