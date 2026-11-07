<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useAgents } from '../composables/useAgents'
import { useSettings } from '../composables/useSettings'
import { apiFetch, openExternal } from '../lib/api'
import { type HostnameInfo, type ThemeName } from '../types'
import { btnPanelPrimary, btnPanelSecondary, inputBase, noScrollbar, panelClass, panelProjectClass } from '../ui'

// Settings are edited as a draft and saved together; leaving the page discards the draft.
// It also explains the hostname proxy and the command line tool, with their live state.

const { settingsDraft, scanIgnoreDraft, settingsSaving, settingsLoaded, saveFeedback, saveSettings, syncSettingsDraftFromSettings } = useSettings()

const { agentStatus, agentsBusy, agentsFailure, agentsConnected, loadAgentStatus, connectAgents, disconnectAgents } = useAgents()
const themeOptions: { value: ThemeName; label: string; swatch: string }[] = [
  { value: 'system', label: 'System', swatch: 'linear-gradient(135deg, #FFFFFF 50%, #27272A 50%)' },
  { value: 'light', label: 'Light', swatch: '#FFFFFF' },
  { value: 'dark', label: 'Dark', swatch: '#27272A' },
  { value: 'socket', label: 'Socket', swatch: '#F26A1B' }
]
const hostnameInfo = ref<HostnameInfo | null>(null)
const commandLineTool = ref<CommandLineToolStatus | null>(null)
const commandLineToolInstalling = ref(false)

async function fetchHostnameInfo() {
  try {
    const response = await apiFetch('/api/hostnames')
    if (response.ok) hostnameInfo.value = (await response.json()) as HostnameInfo
  } catch (err) {
    hostnameInfo.value = null
  }
}

async function refreshCommandLineTool() {
  try {
    commandLineTool.value = (await window.vibe?.cli?.status()) ?? null
  } catch (err) {
    commandLineTool.value = null
  }
}

async function installCommandLineTool() {
  if (!window.vibe?.cli || commandLineToolInstalling.value) return
  commandLineToolInstalling.value = true
  try {
    commandLineTool.value = await window.vibe.cli.install()
  } finally {
    commandLineToolInstalling.value = false
  }
}

// The hostname proxy restarts on another port or stops when those settings change.
async function save() {
  if (await saveSettings()) await fetchHostnameInfo()
}

onMounted(() => Promise.all([fetchHostnameInfo(), refreshCommandLineTool(), loadAgentStatus()]))

onBeforeUnmount(() => {
  syncSettingsDraftFromSettings()
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden" :class="panelProjectClass">
    <header class="page-header flex h-[52px] shrink-0 items-center justify-between gap-4 border-b border-[var(--border)] px-6">
      <h1 class="text-sm font-medium text-[var(--text-strong)]">Settings</h1>
      <div class="flex items-center gap-3">
        <span v-if="saveFeedback === 'saved'" class="text-xs text-[var(--success-text)]">Changes saved</span>
        <span v-else-if="saveFeedback === 'error'" class="text-xs text-[var(--warning-text)]">Could not save changes</span>
        <span v-if="!settingsLoaded" class="text-xs text-[var(--warning-text)]">Sync pending</span>
        <button
          :class="[
            btnPanelPrimary,
            saveFeedback === 'saved'
              ? 'ring-2 ring-[var(--success-border)]'
              : saveFeedback === 'noop' || saveFeedback === 'error'
              ? 'ring-2 ring-[var(--warning-border)]'
              : ''
          ]"
          :disabled="settingsSaving"
          @click="save"
        >
          <span class="inline-flex min-w-[44px] items-center justify-center">
            <svg v-if="saveFeedback === 'saved'" viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span v-else>{{ settingsSaving ? 'Saving…' : 'Save' }}</span>
          </span>
        </button>
      </div>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto px-6 py-5" :class="noScrollbar">
      <div class="grid w-full gap-3 lg:grid-cols-2">
        <section class="p-4 lg:col-span-2" :class="panelClass">
          <div class="flex items-center justify-between gap-4">
            <div>
              <p class="text-[13px] font-medium text-[var(--text-strong)]">Appearance</p>
              <p class="mt-1 text-xs text-[var(--text-subtle)]">System follows your Mac's light or dark setting.</p>
            </div>
            <div class="flex gap-0.5 rounded-md border border-[var(--border)] bg-[var(--panel-muted)] p-0.5">
              <button
                v-for="option in themeOptions"
                :key="option.value"
                type="button"
                class="flex h-7 items-center gap-1.5 rounded px-2.5 text-[13px] transition-colors"
                :class="settingsDraft.theme === option.value ? 'bg-[var(--primary)] text-[var(--primary-text)]' : 'text-[var(--text-muted)] hover:bg-[var(--hover)]'"
                @click="settingsDraft.theme = option.value"
              >
                <span class="h-2.5 w-2.5 rounded-full border border-black/15" :style="{ background: option.swatch }"></span>
                {{ option.label }}
              </button>
            </div>
          </div>
        </section>
        <section class="p-4" :class="panelClass">
          <div>
            <p class="text-[13px] font-medium text-[var(--text-strong)]">Port assignment</p>
            <p class="mt-1 text-xs leading-5 text-[var(--text-subtle)]">
              Choose whether multiprise selects free ports or asks before every launch.
            </p>
          </div>

          <div class="mt-4 grid grid-cols-2 gap-0.5 rounded-md border border-[var(--border)] bg-[var(--panel-muted)] p-0.5">
            <button
              type="button"
              class="h-7 rounded px-3 text-[13px] transition-colors"
              :class="settingsDraft.auto_port ? 'bg-[var(--primary)] text-[var(--primary-text)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'"
              @click="settingsDraft.auto_port = true"
            >
              Automatic
            </button>
            <button
              type="button"
              class="h-7 rounded px-3 text-[13px] transition-colors"
              :class="!settingsDraft.auto_port ? 'bg-[var(--primary)] text-[var(--primary-text)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'"
              @click="settingsDraft.auto_port = false"
            >
              Ask every time
            </button>
          </div>

          <div class="mt-5 border-t border-[var(--border)] pt-4" :class="!settingsDraft.auto_port ? 'opacity-45' : ''">
            <div>
              <p class="text-[13px] text-[var(--text-strong)]">Fallback base port</p>
              <p class="mt-0.5 text-xs text-[var(--text-subtle)]">Starting point when a service has no role-specific range.</p>
            </div>
            <input
              v-model.number="settingsDraft.port_base"
              type="number"
              min="1"
              max="65535"
              :disabled="!settingsDraft.auto_port"
              :class="[inputBase, 'mt-3 !w-36 text-left [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none']"
            />
          </div>
        </section>

        <section class="p-4" :class="panelClass">
          <div>
            <p class="text-[13px] font-medium text-[var(--text-strong)]">Launch readiness</p>
            <p class="mt-1 text-xs leading-5 text-[var(--text-subtle)]">Prepare dependencies and decide how long services have to open their port.</p>
          </div>
          <div class="mt-5 flex items-center justify-between gap-4">
            <span>
              <span class="block text-[13px] text-[var(--text-strong)]">Prepare automatically</span>
              <span class="mt-0.5 block text-xs text-[var(--text-subtle)]">Install missing dependencies and build missing startup targets.</span>
            </span>
            <div class="flex shrink-0 gap-0.5 rounded-md border border-[var(--border)] bg-[var(--panel-muted)] p-0.5">
              <button type="button" class="h-6 rounded px-2.5 text-xs transition-colors" :class="settingsDraft.auto_install ? 'bg-[var(--primary)] text-[var(--primary-text)]' : 'text-[var(--text-muted)] hover:bg-[var(--hover)]'" @click="settingsDraft.auto_install = true">On</button>
              <button type="button" class="h-6 rounded px-2.5 text-xs transition-colors" :class="!settingsDraft.auto_install ? 'bg-[var(--primary)] text-[var(--primary-text)]' : 'text-[var(--text-muted)] hover:bg-[var(--hover)]'" @click="settingsDraft.auto_install = false">Off</button>
            </div>
          </div>
          <div class="mt-5 flex items-center justify-between gap-4 border-t border-[var(--border)] pt-4">
            <span>
              <span class="block text-[13px] text-[var(--text-strong)]">Notifications</span>
              <span class="mt-0.5 block text-xs text-[var(--text-subtle)]">Notify when a service crashes, or is ready after a slow start, while Multiprise is in the background.</span>
            </span>
            <div class="flex shrink-0 gap-0.5 rounded-md border border-[var(--border)] bg-[var(--panel-muted)] p-0.5">
              <button type="button" class="h-6 rounded px-2.5 text-xs transition-colors" :class="settingsDraft.notifications ? 'bg-[var(--primary)] text-[var(--primary-text)]' : 'text-[var(--text-muted)] hover:bg-[var(--hover)]'" @click="settingsDraft.notifications = true">On</button>
              <button type="button" class="h-6 rounded px-2.5 text-xs transition-colors" :class="!settingsDraft.notifications ? 'bg-[var(--primary)] text-[var(--primary-text)]' : 'text-[var(--text-muted)] hover:bg-[var(--hover)]'" @click="settingsDraft.notifications = false">Off</button>
            </div>
          </div>
          <label class="mt-5 block border-t border-[var(--border)] pt-4">
            <span class="block text-[13px] text-[var(--text-strong)]">Startup timeout</span>
            <span class="mt-0.5 block text-xs text-[var(--text-subtle)]">Wait 10–30 seconds for the assigned port to become ready.</span>
            <div class="mt-3 flex items-center gap-2">
              <input v-model.number="settingsDraft.startup_timeout_ms" type="number" min="10000" max="30000" step="1000" :class="[inputBase, '!w-36 text-left']" />
              <span class="text-xs text-[var(--text-subtle)]">milliseconds</span>
            </div>
          </label>
        </section>

        <section class="p-4" :class="panelClass">
          <div>
            <p class="text-[13px] font-medium text-[var(--text-strong)]">Project discovery</p>
            <p class="mt-1 text-xs leading-5 text-[var(--text-subtle)]">
              Tune how deeply selected folders are inspected for launchable projects.
            </p>
          </div>

          <div class="mt-5 space-y-5">
            <label class="block">
              <span>
                <span class="block text-[13px] text-[var(--text-strong)]">Scan depth</span>
                <span class="mt-0.5 block text-xs text-[var(--text-subtle)]">Maximum nested folders to inspect.</span>
              </span>
              <input
                v-model.number="settingsDraft.scan_depth"
                type="number"
                min="1"
                max="64"
                :class="[inputBase, 'mt-3 !w-36 text-left [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none']"
              />
            </label>

            <label class="block border-t border-[var(--border)] pt-4">
              <span class="block text-[13px] text-[var(--text-strong)]">Ignored folders</span>
              <span class="mt-0.5 block text-xs text-[var(--text-subtle)]">Comma-separated names skipped during scanning.</span>
              <input
                v-model="scanIgnoreDraft"
                :class="[inputBase, 'mt-3']"
                placeholder="node_modules, .git, dist"
              />
            </label>
          </div>
        </section>

        <section class="p-4" :class="panelClass">
          <div>
            <p class="text-[13px] font-medium text-[var(--text-strong)]">Service supervision</p>
            <p class="mt-1 text-xs leading-5 text-[var(--text-subtle)]">What multiprise does when a running service crashes or stops answering.</p>
          </div>
          <div class="mt-5 flex items-center justify-between gap-4">
            <span>
              <span class="block text-[13px] text-[var(--text-strong)]">Restart after a crash</span>
              <span class="mt-0.5 block text-xs leading-5 text-[var(--text-subtle)]">A service that exits after it was ready is started again on the same port, after 1, 5 and 15 seconds, at most three times in ten minutes. The crash output stays in its logs; stopping the service cancels a pending restart.</span>
            </span>
            <div class="flex shrink-0 gap-0.5 rounded-md border border-[var(--border)] bg-[var(--panel-muted)] p-0.5">
              <button type="button" class="h-6 rounded px-2.5 text-xs transition-colors" :class="settingsDraft.auto_restart ? 'bg-[var(--primary)] text-[var(--primary-text)]' : 'text-[var(--text-muted)] hover:bg-[var(--hover)]'" @click="settingsDraft.auto_restart = true">On</button>
              <button type="button" class="h-6 rounded px-2.5 text-xs transition-colors" :class="!settingsDraft.auto_restart ? 'bg-[var(--primary)] text-[var(--primary-text)]' : 'text-[var(--text-muted)] hover:bg-[var(--hover)]'" @click="settingsDraft.auto_restart = false">Off</button>
            </div>
          </div>
          <div class="mt-5 border-t border-[var(--border)] pt-4">
            <span class="block text-[13px] text-[var(--text-strong)]">Services that stop answering</span>
            <span class="mt-0.5 block text-xs leading-5 text-[var(--text-subtle)]">Every 15 seconds, a ready service has to answer a request (logged by the service as <span class="font-mono">Multiprise health check</span>). After about 30 seconds without an answer it shows as failed with “Not responding”, but keeps running, since it may be paused in a debugger. It turns ready again as soon as it answers.</span>
          </div>
        </section>

        <section class="p-4 lg:col-span-2" :class="panelClass">
          <div class="grid gap-5 lg:grid-cols-2 lg:gap-8">
            <div>
              <p class="text-[13px] font-medium text-[var(--text-strong)]">Stable hostnames</p>
              <p class="mt-1 text-xs leading-5 text-[var(--text-subtle)]">
                Reach every service at a name that never changes, whatever port it holds, like
                <span class="font-mono text-[var(--text-muted)]">http://web.shop.localhost:{{ settingsDraft.proxy_port }}</span>
                for the web service of a shop project. A project's own name, like <span class="font-mono">shop.localhost</span>, leads to its frontend.
                Browsers resolve <span class="font-mono">*.localhost</span> to this Mac on their own, and hot reload keeps working.
              </p>
            </div>
            <div>
              <div class="flex items-center justify-between gap-4">
                <span>
                  <span class="block text-[13px] text-[var(--text-strong)]">Serve hostnames</span>
                  <span class="mt-0.5 block text-xs text-[var(--text-subtle)]">
                    <template v-if="hostnameInfo?.error">{{ hostnameInfo.error }}</template>
                    <template v-else-if="hostnameInfo?.port">Running on port {{ hostnameInfo.port }}. <button type="button" class="underline decoration-dotted hover:text-[var(--text)]" @click="openExternal(`http://localhost:${hostnameInfo.port}`)">See every name</button></template>
                    <template v-else>Off. Services stay reachable on their own ports.</template>
                  </span>
                </span>
                <div class="flex shrink-0 gap-0.5 rounded-md border border-[var(--border)] bg-[var(--panel-muted)] p-0.5">
                <button type="button" class="h-6 rounded px-2.5 text-xs transition-colors" :class="settingsDraft.hostnames ? 'bg-[var(--primary)] text-[var(--primary-text)]' : 'text-[var(--text-muted)] hover:bg-[var(--hover)]'" @click="settingsDraft.hostnames = true">On</button>
                <button type="button" class="h-6 rounded px-2.5 text-xs transition-colors" :class="!settingsDraft.hostnames ? 'bg-[var(--primary)] text-[var(--primary-text)]' : 'text-[var(--text-muted)] hover:bg-[var(--hover)]'" @click="settingsDraft.hostnames = false">Off</button>
              </div>
              </div>
              <div class="mt-4 flex items-center justify-between gap-4 border-t border-[var(--border)] pt-4" :class="!settingsDraft.hostnames ? 'opacity-45' : ''">
                <span>
                  <span class="block text-[13px] text-[var(--text-strong)]">Hostname port</span>
                  <span class="mt-0.5 block text-xs text-[var(--text-subtle)]">The port in every hostname. Changes apply when you save.</span>
                </span>
                <input
                  v-model.number="settingsDraft.proxy_port"
                  type="number"
                  min="1024"
                  max="65535"
                  :disabled="!settingsDraft.hostnames"
                  :class="[inputBase, '!w-28 shrink-0 text-left [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none']"
                />
              </div>
            </div>
          </div>
        </section>

        <section class="p-4 lg:col-span-2" :class="panelClass">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="max-w-2xl">
              <p class="text-[13px] font-medium text-[var(--text-strong)]">Command line and coding agents</p>
              <p class="mt-1 text-xs leading-5 text-[var(--text-subtle)]">
                The <span class="font-mono">multiprise</span> command drives the services you see here from a terminal, and its MCP server lets coding agents reuse them instead of starting duplicates on random ports. Both talk to this app and open it when needed.
              </p>
            </div>
            <div class="flex shrink-0 items-center gap-3">
              <span v-if="commandLineTool?.installed" class="text-xs text-[var(--success-text)]">Installed at {{ commandLineTool.path }}</span>
              <button
                v-else-if="commandLineTool?.packaged"
                type="button"
                :class="btnPanelSecondary"
                :disabled="commandLineToolInstalling"
                @click="installCommandLineTool"
              >
                {{ commandLineToolInstalling ? 'Installing…' : 'Install command line tool' }}
              </button>
              <span v-else class="text-xs text-[var(--text-subtle)]">From a source checkout: <span class="font-mono">npm run cli -- ls</span></span>
            </div>
          </div>
          <div class="mt-5 grid gap-4 lg:grid-cols-2">
            <div>
              <p class="text-[13px] text-[var(--text-strong)]">In a terminal</p>
              <div class="mt-2 space-y-1 surface-recess rounded-md border border-[var(--border)] bg-[var(--panel-muted)] px-3 py-2 font-mono text-xs leading-5 text-[var(--text-muted)]">
                <p><span class="text-[var(--text)]">multiprise ls</span> <span class="text-[var(--text-subtle)]"># every service, its status and URL</span></p>
                <p><span class="text-[var(--text)]">multiprise up</span> <span class="text-[var(--text-subtle)]"># start the project in this folder</span></p>
                <p><span class="text-[var(--text)]">multiprise logs web -f</span> <span class="text-[var(--text-subtle)]"># follow a service's output</span></p>
                <p><span class="text-[var(--text)]">multiprise url web</span> <span class="text-[var(--text-subtle)]"># print its URL</span></p>
              </div>
            </div>
            <div>
              <p class="text-[13px] text-[var(--text-strong)]">For coding agents</p>
              <div class="mt-2 flex items-center justify-between gap-3 surface-recess rounded-md border border-[var(--border)] bg-[var(--panel-muted)] px-3 py-2">
                <span class="min-w-0 text-xs" :class="agentsConnected ? 'text-[var(--success-text)]' : 'text-[var(--text-muted)]'">
                  {{ agentStatus && !agentStatus.installed ? 'Claude Code was not found on this Mac' : agentsConnected ? 'Claude Code runs its dev servers here' : 'Claude Code is not connected' }}
                </span>
                <button
                  v-if="agentStatus?.installed"
                  type="button"
                  :class="[btnPanelSecondary, 'shrink-0']"
                  :disabled="agentsBusy"
                  @click="agentsConnected ? disconnectAgents() : connectAgents()"
                >
                  {{ agentsBusy ? 'Working…' : agentsConnected ? 'Disconnect' : 'Connect' }}
                </button>
              </div>
              <p v-if="agentsFailure" class="mt-2 text-xs text-[var(--warning-text)]" role="alert">{{ agentsFailure }}</p>
              <p class="mt-2 text-xs leading-5 text-[var(--text-subtle)]">
                Connecting registers the MCP server for every project and adds a short note to <span class="font-mono">{{ agentStatus?.instructions_path ?? '~/.claude/CLAUDE.md' }}</span> telling sessions to start servers through Multiprise. Disconnecting removes both. Other clients run <span class="font-mono">multiprise mcp</span>.
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
