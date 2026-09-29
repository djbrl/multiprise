<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import multipriseIconUrl from '../assets/multiprise-icon.svg'
import { btnPanelPrimaryLg, btnPanelSecondary, noScrollbar, spinnerClass } from '../ui'

// First run: what Multiprise does, adding the first projects, and the optional CLI/MCP setup.

type ServicePreview = { name: string; role: string; start: string }
type Preview = { path: string; name: string; has_services: boolean; error?: string | null; services?: ServicePreview[] }

const props = defineProps<{ api: (path: string, init?: RequestInit) => Promise<Response> }>()
const emit = defineEmits<{ done: []; 'projects-added': [] }>()

const MCP_SETUP_COMMAND = 'claude mcp add multiprise -- multiprise mcp'
const steps = ['Welcome', 'Projects', 'Terminal', 'Ready'] as const
const step = ref(0)

const folders = ref<string[]>([])
const previews = reactive<Record<string, Preview>>({})
const choosing = ref(false)
const adding = ref(false)
const addedCount = ref(0)
const error = ref('')

const cli = ref<CommandLineToolStatus | null>(null)
const installingCli = ref(false)
const copied = ref(false)

const addable = computed(() => folders.value.filter((folder) => previews[folder]?.has_services))
const serviceCount = computed(() => addable.value.reduce((total, folder) => total + (previews[folder]?.services?.length ?? 0), 0))

async function addFolders(paths: string[]) {
  const fresh = paths.filter((entry) => !folders.value.includes(entry))
  if (!fresh.length) return
  folders.value = [...folders.value, ...fresh]
  error.value = ''
  try {
    const response = await props.api('/api/projects/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roots: fresh })
    })
    if (!response.ok) throw new Error(await response.text() || 'Could not look inside those folders')
    const data = (await response.json()) as { projects: Preview[] }
    // Results are keyed by the resolved path; map them back to what was added.
    data.projects.forEach((preview, index) => { previews[fresh[index]] = preview })
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function chooseFolders() {
  choosing.value = true
  try {
    const response = await props.api('/api/fs/pick', { method: 'POST' })
    if (response.ok) await addFolders(((await response.json()) as { paths: string[] }).paths)
  } finally {
    choosing.value = false
  }
}

function removeFolder(folder: string) {
  folders.value = folders.value.filter((entry) => entry !== folder)
  delete previews[folder]
}

async function addProjects() {
  adding.value = true
  error.value = ''
  const failures: string[] = []
  for (const folder of addable.value) {
    const response = await props.api('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folder })
    }).catch(() => null)
    if (response?.ok) addedCount.value += 1
    else failures.push(`${previews[folder]?.name ?? folder}: ${response ? await response.text() : 'no answer'}`)
  }
  adding.value = false
  if (addedCount.value) emit('projects-added')
  if (failures.length) {
    error.value = failures.join('\n')
    return
  }
  step.value = 2
}

async function installCli() {
  if (!window.vibe?.cli) return
  installingCli.value = true
  try {
    cli.value = await window.vibe.cli.install()
  } finally {
    installingCli.value = false
  }
}

async function copyMcp() {
  await window.vibe?.copyText?.(MCP_SETUP_COMMAND)
  copied.value = true
  window.setTimeout(() => { copied.value = false }, 1600)
}

onMounted(async () => {
  cli.value = (await window.vibe?.cli?.status().catch(() => null)) ?? null
})

defineExpose({
  // Folders dropped on the window while onboarding is open land here.
  addFolders: (paths: string[]) => {
    step.value = 1
    return addFolders(paths)
  }
})

const roleTone: Record<string, string> = {
  backend: 'text-[var(--log-backend)]',
  frontend: 'text-[var(--log-frontend)]'
}
</script>

<template>
  <div class="fixed inset-0 z-[65] flex items-center justify-center bg-[var(--app-bg)] p-6">
    <div class="flex h-full max-h-[640px] w-full max-w-[640px] flex-col">
      <div class="flex items-center justify-center gap-2">
        <span
          v-for="(label, index) in steps"
          :key="label"
          class="h-1.5 rounded-full transition-all duration-300"
          :class="index === step ? 'w-8 bg-[var(--electric)]' : index < step ? 'w-4 bg-[var(--text-subtle)]' : 'w-4 bg-[var(--border)]'"
          :aria-label="label"
        ></span>
      </div>

      <transition name="fade" mode="out-in">
        <!-- 1. Welcome -->
        <section v-if="step === 0" key="welcome" class="flex flex-1 flex-col items-center justify-center text-center">
          <img :src="multipriseIconUrl" alt="" class="h-20 w-20" />
          <h1 class="mt-6 text-3xl font-semibold tracking-[-0.04em] text-[var(--text-strong)]">Welcome to Multiprise</h1>
          <p class="mt-2 max-w-md text-[15px] leading-6 text-[var(--text-muted)]">One place to start, watch and stop every local project you work on.</p>
          <div class="mt-9 grid w-full gap-3 text-left sm:grid-cols-3">
            <div v-for="feature in [
              { title: 'Finds the services', body: 'Point it at a project folder; it reads package.json, Cargo and Compose files.' },
              { title: 'Stable ports', body: 'Each service gets a free port, and keeps it, so URLs never change.' },
              { title: 'Everything in view', body: 'Logs, crashes, restarts and URLs for all of them, in one window.' }
            ]" :key="feature.title" class="rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] p-4">
              <p class="text-sm font-semibold text-[var(--text-strong)]">{{ feature.title }}</p>
              <p class="mt-1 text-xs leading-5 text-[var(--text-muted)]">{{ feature.body }}</p>
            </div>
          </div>
          <button :class="btnPanelPrimaryLg" class="mt-10" @click="step = 1">Get started</button>
        </section>

        <!-- 2. Projects -->
        <section v-else-if="step === 1" key="projects" class="flex min-h-0 flex-1 flex-col pt-10">
          <h1 class="text-2xl font-semibold tracking-[-0.03em] text-[var(--text-strong)]">Add your projects</h1>
          <p class="mt-1 text-sm text-[var(--text-muted)]">Choose the top folder of each project. You will see what Multiprise finds before anything is saved.</p>

          <button
            type="button"
            class="mt-6 flex shrink-0 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[var(--border)] px-6 py-8 text-center transition-colors hover:border-[var(--electric)] hover:bg-[var(--hover)]"
            :disabled="choosing"
            @click="chooseFolders"
          >
            <span v-if="choosing" :class="spinnerClass" aria-hidden="true"></span>
            <svg v-else viewBox="0 0 24 24" class="h-7 w-7 text-[var(--electric)]" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke-linejoin="round" />
              <path d="M12 10v6M9 13h6" stroke-linecap="round" />
            </svg>
            <span class="text-sm font-medium text-[var(--text-strong)]">Choose folders</span>
            <span class="text-xs text-[var(--text-subtle)]">or drop them anywhere on this window</span>
          </button>

          <div v-if="folders.length" class="mt-4 min-h-0 flex-1 space-y-2 overflow-y-auto" :class="noScrollbar">
            <div v-for="folder in folders" :key="folder" class="rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-3" :class="previews[folder] && !previews[folder].has_services ? 'opacity-60' : ''">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="truncate text-sm font-semibold text-[var(--text-strong)]">{{ previews[folder]?.name ?? folder.split('/').pop() }}</p>
                  <p class="truncate text-[11px] text-[var(--text-subtle)]">{{ folder }}</p>
                </div>
                <button type="button" class="text-xs text-[var(--text-subtle)] hover:text-[var(--text)]" @click="removeFolder(folder)">Remove</button>
              </div>
              <p v-if="!previews[folder]" class="mt-2 text-xs text-[var(--text-subtle)]">Looking for services…</p>
              <p v-else-if="!previews[folder].has_services" class="mt-2 text-xs text-[var(--warning-text)]">{{ previews[folder].error || 'No services found here' }}</p>
              <div v-else class="mt-2 flex flex-wrap gap-1.5">
                <span v-for="preview in previews[folder].services" :key="preview.name + preview.start" class="inline-flex items-center gap-1.5 rounded-md bg-[var(--panel-muted)] px-2 py-1 text-[11px]">
                  <span class="font-semibold" :class="roleTone[preview.role] ?? 'text-[var(--text)]'">{{ preview.name }}</span>
                  <span class="font-mono text-[10px] text-[var(--text-subtle)]">{{ preview.start }}</span>
                </span>
              </div>
            </div>
          </div>
          <div v-else class="flex-1"></div>

          <p v-if="error" class="mt-3 whitespace-pre-wrap text-xs text-[var(--warning-text)]">{{ error }}</p>
          <div class="mt-5 flex shrink-0 items-center justify-between gap-3">
            <button type="button" class="text-sm text-[var(--text-subtle)] hover:text-[var(--text)]" @click="step = 2">Skip for now</button>
            <button :class="btnPanelPrimaryLg" :disabled="!addable.length || adding" @click="addProjects">
              <span v-if="adding" :class="spinnerClass" aria-hidden="true"></span>
              {{ addable.length ? `Add ${addable.length} project${addable.length === 1 ? '' : 's'} · ${serviceCount} service${serviceCount === 1 ? '' : 's'}` : 'Add projects' }}
            </button>
          </div>
        </section>

        <!-- 3. Terminal and agents -->
        <section v-else-if="step === 2" key="terminal" class="flex flex-1 flex-col justify-center">
          <h1 class="text-2xl font-semibold tracking-[-0.03em] text-[var(--text-strong)]">Use it from your terminal and coding agents</h1>
          <p class="mt-1 text-sm text-[var(--text-muted)]">Optional. You can set this up later in Settings.</p>

          <div class="mt-7 rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] p-5">
            <div class="flex items-start justify-between gap-4">
              <div>
                <p class="text-sm font-semibold text-[var(--text-strong)]">The <span class="font-mono">multiprise</span> command</p>
                <p class="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                  <span class="font-mono">multiprise up</span> in a project folder starts it; <span class="font-mono">logs</span>, <span class="font-mono">url</span> and <span class="font-mono">down</span> do the rest.
                </p>
              </div>
              <span v-if="cli?.installed" class="shrink-0 text-xs font-medium text-[var(--success-text)]">Installed</span>
              <button v-else-if="cli?.packaged" :class="btnPanelSecondary" class="shrink-0" :disabled="installingCli" @click="installCli">
                {{ installingCli ? 'Installing…' : 'Install' }}
              </button>
              <span v-else class="shrink-0 text-xs text-[var(--text-subtle)]">In the installed app</span>
            </div>
          </div>

          <div class="mt-3 rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] p-5">
            <p class="text-sm font-semibold text-[var(--text-strong)]">Coding agents (MCP)</p>
            <p class="mt-1 text-xs leading-5 text-[var(--text-muted)]">Agents reuse the services you already run, read their logs and get their URLs, instead of starting duplicates.</p>
            <div class="mt-3 flex items-center justify-between gap-3 rounded-lg bg-[var(--panel-muted)] px-3 py-2">
              <span class="min-w-0 truncate font-mono text-xs text-[var(--text)]">{{ MCP_SETUP_COMMAND }}</span>
              <button type="button" class="shrink-0 text-xs text-[var(--text-muted)] hover:text-[var(--text-strong)]" @click="copyMcp">{{ copied ? 'Copied' : 'Copy' }}</button>
            </div>
          </div>

          <div class="mt-8 flex items-center justify-between">
            <button type="button" class="text-sm text-[var(--text-subtle)] hover:text-[var(--text)]" @click="step = 1">Back</button>
            <button :class="btnPanelPrimaryLg" @click="step = 3">Continue</button>
          </div>
        </section>

        <!-- 4. Ready -->
        <section v-else key="ready" class="flex flex-1 flex-col items-center justify-center text-center">
          <div class="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--electric)] text-white">
            <svg viewBox="0 0 24 24" class="h-7 w-7" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </div>
          <h1 class="mt-6 text-2xl font-semibold tracking-[-0.03em] text-[var(--text-strong)]">You're set</h1>
          <p class="mt-2 max-w-md text-sm leading-6 text-[var(--text-muted)]">
            {{ addedCount ? `${addedCount} project${addedCount === 1 ? ' is' : 's are'} ready. Press Launch on one to start its services, backend first.` : 'Add a project whenever you like, from the home screen or by dropping a folder on the window.' }}
          </p>
          <div class="mt-8 grid gap-2 text-left text-xs text-[var(--text-muted)]">
            <p><kbd class="mr-2 rounded border border-[var(--border)] px-1.5 py-0.5">⌘K</kbd>find a project or run any command</p>
            <p><kbd class="mr-2 rounded border border-[var(--border)] px-1.5 py-0.5">⌘↩</kbd>launch the open project</p>
            <p><kbd class="mr-2 rounded border border-[var(--border)] px-1.5 py-0.5">⌘F</kbd>search its logs</p>
          </div>
          <button :class="btnPanelPrimaryLg" class="mt-10" @click="emit('done')">Open Multiprise</button>
        </section>
      </transition>
    </div>
  </div>
</template>
