<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { btnPanelIcon, btnPanelPrimary, btnPanelSecondary, inputBase, noScrollbar } from '../ui'

// Edits one service's environment variables (plain or secret) and the services it depends on.

type ServiceOption = { id: string; name: string; project: string }
type EnvVariable = { key: string; value: string | null; secret: boolean }
type EnvFileStatus = { example: string | null; has_env: boolean; missing: string[] }
type EnvironmentResponse = { variables: EnvVariable[]; links: string[]; env_file: EnvFileStatus }
// A secret row's value is only sent when typed; `stored` marks one the backend already holds.
type Row = { key: string; value: string; secret: boolean; stored: boolean }

const props = defineProps<{
  service: ServiceOption
  services: ServiceOption[]
  api: (path: string, init?: RequestInit) => Promise<Response>
}>()
const emit = defineEmits<{ close: []; saved: [] }>()

const loading = ref(true)
const saving = ref(false)
const error = ref('')
const rows = reactive<Row[]>([])
const links = ref<string[]>([])
const initialLinks = ref<string[]>([])
const envFile = ref<EnvFileStatus | null>(null)

const others = computed(() => props.services.filter((entry) => entry.id !== props.service.id))
const sameProject = computed(() => others.value.filter((entry) => entry.project === props.service.project))
const otherProjects = computed(() => others.value.filter((entry) => entry.project !== props.service.project))
const exampleService = computed(() => sameProject.value[0]?.name ?? others.value[0]?.name ?? 'api')
const templateExample = computed(() => `{{services.${exampleService.value}.url}}`)
const missingNow = computed(() => {
  const keys = new Set(rows.map((row) => row.key.trim()))
  return (envFile.value?.missing ?? []).filter((key) => !keys.has(key))
})

const readError = async (response: Response, fallback: string) => (await response.text().catch(() => '')) || fallback

async function load() {
  loading.value = true
  error.value = ''
  try {
    const response = await props.api(`/api/projects/${props.service.id}/environment`)
    if (!response.ok) throw new Error(await readError(response, 'Could not load the environment'))
    const data = (await response.json()) as EnvironmentResponse
    rows.splice(0, rows.length, ...data.variables.map((variable) => ({
      key: variable.key,
      value: variable.value ?? '',
      secret: variable.secret,
      stored: variable.secret
    })))
    links.value = [...data.links]
    initialLinks.value = [...data.links]
    envFile.value = data.env_file
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function addRow(key = '') {
  rows.push({ key, value: '', secret: false, stored: false })
}

function addMissing() {
  missingNow.value.forEach((key) => addRow(key))
}

function toggleLink(id: string) {
  links.value = links.value.includes(id) ? links.value.filter((entry) => entry !== id) : [...links.value, id]
}

async function save() {
  saving.value = true
  error.value = ''
  try {
    const variables = rows
      .filter((row) => row.key.trim())
      .map((row) => ({
        key: row.key.trim(),
        // An untouched stored secret is kept as it is.
        value: row.secret && row.stored && !row.value ? null : row.value,
        secret: row.secret
      }))
    const saved = await props.api(`/api/projects/${props.service.id}/environment`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variables })
    })
    if (!saved.ok) throw new Error(await readError(saved, 'Could not save the variables'))
    if ([...links.value].sort().join() !== [...initialLinks.value].sort().join()) {
      const linked = await props.api(`/api/projects/${props.service.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ links: links.value })
      })
      if (!linked.ok) throw new Error(await readError(linked, 'Could not save the dependencies'))
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
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="flex max-h-[min(720px,calc(100vh-56px))] w-[min(760px,94vw)] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] shadow-2xl">
      <div class="flex shrink-0 items-start justify-between border-b border-[var(--border)] px-5 py-4">
        <div>
          <h2 class="text-lg font-semibold text-[var(--text-strong)]">{{ service.name }}: environment and links</h2>
          <p class="mt-0.5 text-xs text-[var(--text-subtle)]">Used the next time {{ service.name }} starts.</p>
        </div>
        <button :class="btnPanelIcon" title="Close" @click="emit('close')">
          <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M6 6l12 12M18 6l-12 12" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>

      <div class="min-h-0 flex-1 space-y-6 overflow-y-auto p-5" :class="noScrollbar">
        <p v-if="loading" class="text-sm text-[var(--text-subtle)]">Loading…</p>
        <template v-else>
          <div
            v-if="envFile?.example && missingNow.length"
            class="flex items-start justify-between gap-4 rounded-lg border border-[var(--warning-border)] bg-[var(--warning-bg)] px-3 py-2.5 text-xs text-[var(--warning-text)]"
          >
            <p>
              <span class="font-mono">{{ envFile.example }}</span>
              {{ envFile.has_env ? 'lists variables that are not set:' : 'exists but there is no .env, so these are not set:' }}
              <span class="font-mono">{{ missingNow.join(', ') }}</span>.
            </p>
            <button type="button" class="shrink-0 font-medium underline" @click="addMissing">Add them here</button>
          </div>

          <section>
            <div class="flex items-end justify-between gap-4">
              <div>
                <p class="text-sm font-medium text-[var(--text-strong)]">Variables</p>
                <p class="mt-0.5 text-xs leading-5 text-[var(--text-subtle)]">
                  Point at other services with
                  <span class="font-mono" v-text="templateExample"></span>,
                  <span class="font-mono">.port</span> or <span class="font-mono">.host_url</span>.
                  Secret values are encrypted with a key kept in the macOS Keychain and never shown again.
                </p>
              </div>
              <button type="button" :class="btnPanelSecondary" class="shrink-0" @click="addRow()">Add variable</button>
            </div>
            <div v-if="!rows.length" class="mt-3 rounded-lg bg-[var(--panel-muted)] px-3 py-4 text-center text-xs text-[var(--text-subtle)]">
              No variables yet. The service still gets PORT and the linked ports Multiprise sets.
            </div>
            <div v-else class="mt-3 space-y-2">
              <div v-for="(row, index) in rows" :key="index" class="flex items-center gap-2">
                <input
                  v-model="row.key"
                  :class="[inputBase, 'h-9 !w-52 shrink-0 py-1 font-mono text-xs']"
                  placeholder="NAME"
                  spellcheck="false"
                />
                <input
                  v-model="row.value"
                  :type="row.secret ? 'password' : 'text'"
                  :class="[inputBase, 'h-9 min-w-0 flex-1 py-1 font-mono text-xs']"
                  :placeholder="row.secret && row.stored ? 'Stored; type to replace' : row.secret ? 'Secret value' : 'Value'"
                  spellcheck="false"
                  autocomplete="off"
                />
                <button
                  type="button"
                  class="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs transition-colors"
                  :class="row.secret ? 'bg-[var(--primary)] text-[var(--primary-text)]' : 'bg-[var(--panel-muted)] text-[var(--text-muted)] hover:bg-[var(--hover)]'"
                  :title="row.secret ? 'Stored encrypted; click to make it a plain variable' : 'Keep this value encrypted'"
                  @click="row.secret = !row.secret"
                >
                  <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8">
                    <rect x="5" y="11" width="14" height="9" rx="2" />
                    <path :d="row.secret ? 'M8 11V8a4 4 0 0 1 8 0v3' : 'M8 11V8a4 4 0 0 1 7.5-2'" stroke-linecap="round" />
                  </svg>
                  Secret
                </button>
                <button type="button" :class="btnPanelIcon" title="Remove" @click="rows.splice(index, 1)">
                  <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M6 6l12 12M18 6l-12 12" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
              </div>
            </div>
          </section>

          <section>
            <p class="text-sm font-medium text-[var(--text-strong)]">Depends on</p>
            <p class="mt-0.5 text-xs text-[var(--text-subtle)]">These start first whenever {{ service.name }} starts.</p>
            <p v-if="!others.length" class="mt-3 text-xs text-[var(--text-subtle)]">No other services yet.</p>
            <div v-for="group in [{ label: service.project, items: sameProject }, { label: 'Other projects', items: otherProjects }]" :key="group.label">
              <template v-if="group.items.length">
                <p class="mt-3 text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">{{ group.label }}</p>
                <div class="mt-1.5 flex flex-wrap gap-2">
                  <button
                    v-for="option in group.items"
                    :key="option.id"
                    type="button"
                    class="rounded-lg border px-3 py-1.5 text-xs transition-colors"
                    :class="links.includes(option.id)
                      ? 'border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-text)]'
                      : 'border-[var(--border)] bg-[var(--panel-muted)] text-[var(--text)] hover:bg-[var(--hover)]'"
                    @click="toggleLink(option.id)"
                  >
                    {{ group.label === 'Other projects' ? `${option.project}/${option.name}` : option.name }}
                  </button>
                </div>
              </template>
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
