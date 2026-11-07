<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { apiFetch } from '../lib/api'
import { type DetectedVariable, type EnvFileStatus, type EnvironmentResponse, type EnvVariable, type ServiceOption } from '../types'
import { btnPanelIcon, btnPanelPrimary, btnPanelSecondary, inputBase, noScrollbar } from '../ui'

// Edits the variables one service starts with, and which of its project's services start first.

// `stored`: the backend already holds a secret value, which is kept unless something is typed.
// `detected`: declared by the project's .env.example, so the row is always shown.
type Row = { id: number; key: string; value: string; secret: boolean; stored: boolean; detected: DetectedVariable | null }
let nextRowId = 0

const props = defineProps<{
  service: ServiceOption
  services: ServiceOption[]
}>()
const emit = defineEmits<{ close: []; saved: [] }>()

const loading = ref(true)
const saving = ref(false)
const error = ref('')
const rows = reactive<Row[]>([])
const links = ref<string[]>([])
const initialLinks = ref<string[]>([])
const envFile = ref<EnvFileStatus | null>(null)

// Links only make sense within a project: its other services.
const siblings = computed(() => props.services.filter((entry) => entry.id !== props.service.id && entry.project === props.service.project))
const detectedRows = computed(() => rows.filter((row) => row.detected))
const customRows = computed(() => rows.filter((row) => !row.detected))
const unsetCount = computed(() => detectedRows.value.filter((row) => rowState(row) === 'unset').length)

const readError = async (response: Response, fallback: string) => (await response.text().catch(() => '')) || fallback

function rowState(row: Row): 'here' | 'env-file' | 'unset' {
  if (row.value || row.stored) return 'here'
  if (row.detected?.in_env_file) return 'env-file'
  return 'unset'
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const response = await apiFetch(`/api/projects/${props.service.id}/environment`)
    if (!response.ok) throw new Error(await readError(response, 'Could not load the environment'))
    const data = (await response.json()) as EnvironmentResponse
    const configured = new Map(data.variables.map((variable) => [variable.key, variable]))
    const next: Row[] = data.env_file.variables.map((detected) => {
      const variable = configured.get(detected.key)
      configured.delete(detected.key)
      return { id: nextRowId++, key: detected.key, value: variable?.value ?? '', secret: variable?.secret ?? false, stored: !!variable?.secret, detected }
    })
    for (const variable of configured.values()) {
      next.push({ id: nextRowId++, key: variable.key, value: variable.value ?? '', secret: variable.secret, stored: variable.secret, detected: null })
    }
    rows.splice(0, rows.length, ...next)
    links.value = [...data.links]
    initialLinks.value = [...data.links]
    envFile.value = data.env_file
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function addRow() {
  rows.push({ id: nextRowId++, key: '', value: '', secret: false, stored: false, detected: null })
}

function removeRow(row: Row) {
  rows.splice(rows.indexOf(row), 1)
}

function useServiceUrl(row: Row, event: Event) {
  const select = event.target as HTMLSelectElement
  if (select.value) {
    row.value = `{{services.${select.value}.url}}`
    row.secret = false
  }
  select.value = ''
}

function toggleLink(id: string) {
  links.value = links.value.includes(id) ? links.value.filter((entry) => entry !== id) : [...links.value, id]
}

async function save() {
  saving.value = true
  error.value = ''
  try {
    const variables = rows
      // A detected variable left empty is simply not set by Multiprise (.env may still set it).
      .filter((row) => row.key.trim() && (!row.detected || row.value || (row.secret && row.stored)))
      .map((row) => ({
        key: row.key.trim(),
        value: row.secret && row.stored && !row.value ? null : row.value,
        secret: row.secret
      }))
    const saved = await apiFetch(`/api/projects/${props.service.id}/environment`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variables })
    })
    if (!saved.ok) throw new Error(await readError(saved, 'Could not save the variables'))
    if ([...links.value].sort().join() !== [...initialLinks.value].sort().join()) {
      const linked = await apiFetch(`/api/projects/${props.service.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ links: links.value })
      })
      if (!linked.ok) throw new Error(await readError(linked, 'Could not save the start order'))
    }
    emit('saved')
    emit('close')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}

onMounted(load)

const stateLabel = { here: 'Set here', 'env-file': 'In .env', unset: 'Not set' } as const
const stateClass = {
  here: 'text-[var(--success-text)]',
  'env-file': 'text-[var(--text-subtle)]',
  unset: 'text-[var(--warning-text)]'
} as const
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="flex max-h-[min(760px,calc(100vh-56px))] w-[min(780px,94vw)] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] shadow-2xl">
      <div class="flex shrink-0 items-start justify-between border-b border-[var(--border)] px-5 py-4">
        <div>
          <h2 class="text-lg font-semibold text-[var(--text-strong)]">{{ service.name }} environment</h2>
          <p class="mt-0.5 text-xs text-[var(--text-subtle)]">What {{ service.name }} starts with. Values set here win over .env files and apply on its next start.</p>
        </div>
        <button :class="btnPanelIcon" title="Close" @click="emit('close')">
          <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M6 6l12 12M18 6l-12 12" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>

      <div class="min-h-0 flex-1 space-y-7 overflow-y-auto p-5" :class="noScrollbar">
        <p v-if="loading" class="text-sm text-[var(--text-subtle)]">Loading…</p>
        <template v-else>
          <section v-if="detectedRows.length">
            <div class="flex items-baseline justify-between gap-4">
              <p class="text-sm font-medium text-[var(--text-strong)]">
                From <span class="font-mono text-[13px]">{{ envFile?.example }}</span>
              </p>
              <p class="text-xs" :class="unsetCount ? 'text-[var(--warning-text)]' : 'text-[var(--text-subtle)]'">
                {{ unsetCount ? `${unsetCount} not set anywhere` : 'All set' }}
              </p>
            </div>
            <div class="mt-3 divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
              <div v-for="row in detectedRows" :key="row.id" class="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2">
                <div class="min-w-0">
                  <p class="truncate font-mono text-xs text-[var(--text-strong)]" :title="row.key">{{ row.key }}</p>
                  <p class="text-[11px]" :class="stateClass[rowState(row)]">{{ stateLabel[rowState(row)] }}</p>
                </div>
                <div class="flex min-w-0 items-center gap-1.5">
                  <input
                    v-model="row.value"
                    :type="row.secret ? 'password' : 'text'"
                    :class="[inputBase, 'h-8 min-w-0 flex-1 py-1 font-mono text-xs']"
                    :placeholder="row.secret && row.stored ? 'Stored; type to replace' : row.detected?.in_env_file ? 'Using the value in .env' : row.detected?.example || 'Value'"
                    spellcheck="false"
                    autocomplete="off"
                  />
                  <select
                    v-if="siblings.length"
                    class="h-8 w-8 shrink-0 cursor-pointer appearance-none rounded-lg bg-[var(--panel-muted)] text-center text-xs text-[var(--text-muted)] hover:bg-[var(--hover)]"
                    title="Use another service's URL"
                    @change="useServiceUrl(row, $event)"
                  >
                    <option value="">🔗</option>
                    <option v-for="sibling in siblings" :key="sibling.id" :value="sibling.name">{{ sibling.name }} URL</option>
                  </select>
                </div>
                <button
                  type="button"
                  class="h-8 rounded-lg px-2 text-[11px] transition-colors"
                  :class="row.secret ? 'bg-[var(--primary)] text-[var(--primary-text)]' : 'text-[var(--text-subtle)] hover:bg-[var(--hover)]'"
                  :title="row.secret ? 'Stored encrypted with the macOS Keychain' : 'Keep this value encrypted'"
                  @click="row.secret = !row.secret"
                >Secret</button>
              </div>
            </div>
          </section>

          <section>
            <div class="flex items-baseline justify-between gap-4">
              <p class="text-sm font-medium text-[var(--text-strong)]">{{ detectedRows.length ? 'Other variables' : 'Variables' }}</p>
              <button type="button" class="text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-strong)]" @click="addRow">+ Add variable</button>
            </div>
            <p v-if="!customRows.length" class="mt-2 text-xs text-[var(--text-subtle)]">
              None yet. Multiprise always sets PORT{{ siblings.length ? ', and BACKEND_PORT / FRONTEND_PORT for linked services' : '' }}.
            </p>
            <div v-else class="mt-3 space-y-2">
              <div v-for="row in customRows" :key="row.id" class="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto_auto] items-center gap-2">
                <input v-model="row.key" :class="[inputBase, 'h-8 py-1 font-mono text-xs']" placeholder="NAME" spellcheck="false" />
                <div class="flex min-w-0 items-center gap-1.5">
                  <input
                    v-model="row.value"
                    :type="row.secret ? 'password' : 'text'"
                    :class="[inputBase, 'h-8 min-w-0 flex-1 py-1 font-mono text-xs']"
                    :placeholder="row.secret && row.stored ? 'Stored; type to replace' : 'Value'"
                    spellcheck="false"
                    autocomplete="off"
                  />
                  <select
                    v-if="siblings.length"
                    class="h-8 w-8 shrink-0 cursor-pointer appearance-none rounded-lg bg-[var(--panel-muted)] text-center text-xs text-[var(--text-muted)] hover:bg-[var(--hover)]"
                    title="Use another service's URL"
                    @change="useServiceUrl(row, $event)"
                  >
                    <option value="">🔗</option>
                    <option v-for="sibling in siblings" :key="sibling.id" :value="sibling.name">{{ sibling.name }} URL</option>
                  </select>
                </div>
                <button
                  type="button"
                  class="h-8 rounded-lg px-2 text-[11px] transition-colors"
                  :class="row.secret ? 'bg-[var(--primary)] text-[var(--primary-text)]' : 'text-[var(--text-subtle)] hover:bg-[var(--hover)]'"
                  @click="row.secret = !row.secret"
                >Secret</button>
                <button :class="btnPanelIcon" class="!h-8 !w-8" title="Remove" @click="removeRow(row)">
                  <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M6 6l12 12M18 6l-12 12" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
              </div>
            </div>
            <p class="mt-3 text-[11px] leading-5 text-[var(--text-subtle)]">
              Secret values are encrypted with a key kept in the macOS Keychain and never shown again.
              <template v-if="siblings.length">🔗 fills in another service's current URL, which follows it if its port changes.</template>
            </p>
          </section>

          <section v-if="siblings.length">
            <p class="text-sm font-medium text-[var(--text-strong)]">Start first</p>
            <p class="mt-0.5 text-xs leading-5 text-[var(--text-subtle)]">
              Pick the services {{ service.name }} needs running, such as its API or database. Whenever {{ service.name }} starts, including on its own, Multiprise starts these first.
            </p>
            <div class="mt-3 flex flex-wrap gap-2">
              <button
                v-for="option in siblings"
                :key="option.id"
                type="button"
                class="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors"
                :class="links.includes(option.id)
                  ? 'border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-text)]'
                  : 'border-[var(--border)] bg-[var(--panel-muted)] text-[var(--text)] hover:bg-[var(--hover)]'"
                @click="toggleLink(option.id)"
              >
                <span v-if="links.includes(option.id)">✓</span>
                {{ option.name }}
              </button>
            </div>
          </section>
        </template>
      </div>

      <div class="flex shrink-0 items-center justify-between gap-4 border-t border-[var(--border)] px-5 py-3">
        <p class="min-w-0 text-xs text-[var(--warning-text)]">{{ error }}</p>
        <div class="flex shrink-0 gap-2">
          <button type="button" :class="btnPanelSecondary" @click="emit('close')">Cancel</button>
          <button type="button" :class="btnPanelPrimary" :disabled="loading || saving" @click="save">{{ saving ? 'Saving…' : 'Save' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
