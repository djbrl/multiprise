<script setup lang="ts">
import { computed } from 'vue'
import { useBrowserTabs } from '../composables/useBrowserTabs'
import { useOverlays } from '../composables/useOverlays'
import { useProjects } from '../composables/useProjects'
import { useServiceActions } from '../composables/useServiceActions'
import { projectTitle, serviceFailed, serviceMetaLabels, serviceReady, serviceStatusLabel } from '../lib/services'
import { type ProjectView } from '../types'
import { btnPanelIcon, btnPanelSecondary, btnUnplug, inputBase, spinnerClass, statusDot, statusDotFailed, statusDotLive } from '../ui'
import ServiceFailure from './ServiceFailure.vue'

// One script service on the project page: a compact row while stopped, its command,
// port, environment, URL and processes when running or expanded.

const props = defineProps<{ service: ProjectView }>()

const { projectById } = useProjects()
const { configServiceId, externalMenuOpen, toggleExternalMenu, closeExternalMenus } = useOverlays()
const { openInAppBrowser } = useBrowserTabs()
const {
  actionFor, actionCommandDirty, actionDetailsOpen, actionErrors, processInstances, failureActionBusy, copiedServiceUrlId,
  isActionLoading, isStarting, toggleActionDetails, effectivePort, servicePid, persistServiceCommand, resetServiceCommand,
  startOrCancel, runFailureAction, killInstance, externalInstancesFor, startupConflictFor, startupConflictSummary,
  externalInstanceSummary, isResolvingConflict, resolveStartupConflict, killExternalInstance, startAnotherInstance,
  copyProjectUrl, openProjectUrl
} = useServiceActions()

const environmentSummary = computed(() => {
  const project = props.service.project
  const count = Object.keys(project.env ?? {}).length + (project.secret_env?.length ?? 0)
  const dependencies = (project.links ?? [])
    .map((id) => projectById(id))
    .filter((item): item is ProjectView => !!item)
    .map(projectTitle)
  const parts = [count ? `${count} ${count === 1 ? 'variable' : 'variables'}` : 'No variables']
  if (dependencies.length) parts.push(`depends on ${dependencies.join(', ')}`)
  return parts.join(' · ')
})
</script>

<template>
  <transition name="unfurl" mode="out-in">
    <div
      v-if="!service.status.running && !actionDetailsOpen[service.project.id]"
      :key="`summary-${service.project.id}`"
      class="rounded-xl bg-[var(--panel-muted)] px-3 py-2 transition-colors hover:bg-[var(--hover)]"
    >
    <div class="flex items-center justify-between gap-3">
      <div class="flex min-w-0 items-center gap-2">
        <span :class="statusDot"></span>
        <p class="truncate text-[13px] font-semibold text-[var(--text-strong)]">
          {{ projectTitle(service) }}
          <span
            v-if="serviceMetaLabels(service).length"
            class="ml-2 text-xs font-normal text-[var(--text-subtle)]"
          >
            {{ serviceMetaLabels(service).join(' · ') }}
          </span>
        </p>
      </div>
      <div class="flex items-center gap-2">
        <button
          :class="btnPanelSecondary"
          :disabled="isActionLoading('stop', service.project.id)"
          :title="isStarting(service) ? 'Stop starting this service' : undefined"
          @click="startOrCancel(service)"
        >
          <span v-if="isStarting(service)" :class="spinnerClass" aria-hidden="true"></span>
          {{ isStarting(service) ? 'Cancel' : 'Start' }}
        </button>
        <button
          :class="btnPanelIcon"
          title="Show details"
          @click="toggleActionDetails(service)"
        >
          <svg
            viewBox="0 0 24 24"
            class="h-4 w-4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          >
            <path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
    </div>
    <div
      v-if="startupConflictFor(service)"
      class="mt-2 rounded-lg border border-[var(--warning-border)] bg-[var(--warning-bg)] px-3 py-2 text-xs text-[var(--warning-text)]"
    >
      <p>
        Another instance is already running at
        <span class="font-mono">{{ startupConflictSummary(service) }}</span>.
      </p>
      <button
        class="mt-2"
        :class="btnPanelSecondary"
        :disabled="isResolvingConflict(service)"
        @click="resolveStartupConflict(service)"
      >
        <span
          v-if="isResolvingConflict(service)"
          :class="spinnerClass"
          aria-hidden="true"
        ></span>
        {{
          isResolvingConflict(service)
            ? 'Unplugging…'
            : 'Unplug and retry'
        }}
      </button>
    </div>
    <div
      v-if="actionErrors[service.project.id] && !startupConflictFor(service)"
      class="mt-2 rounded-md border border-[var(--warning-border)] bg-[var(--warning-bg)] px-2 py-1 text-xs text-[var(--warning-text)]"
    >
      {{ actionErrors[service.project.id] }}
    </div>
    <ServiceFailure
      v-if="service.status.error && !actionErrors[service.project.id] && !startupConflictFor(service)"
      :error="service.status.error"
      :code="service.status.failure_code"
      :busy="failureActionBusy[service.project.id]"
      @action="runFailureAction(service, $event)"
    />
    </div>

    <div
      v-else
      :key="`details-${service.project.id}`"
      class="relative overflow-hidden rounded-xl bg-[var(--panel-muted)] p-3"
      :class="service.status.running ? 'powered-service' : ''"
    >
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <span :class="[statusDot, serviceReady(service) ? statusDotLive : serviceFailed(service) ? statusDotFailed : '']" :aria-label="serviceStatusLabel(service)"></span>
          <p class="text-sm font-semibold text-[var(--text-strong)]">{{ projectTitle(service) }}</p>
          <span class="text-[10px] font-medium" :class="serviceFailed(service) ? 'text-[var(--log-error)]' : 'text-[var(--text-subtle)]'">{{ serviceStatusLabel(service) }}</span>
          <span v-if="serviceReady(service) && effectivePort(service)" class="font-mono text-[11px] text-[var(--text-subtle)]">
            :{{ effectivePort(service) }}
          </span>
          <span v-if="service.status.running && servicePid(service)" class="font-mono text-[10px] text-[var(--text-subtle)]">
            PID {{ servicePid(service) }}
          </span>
        </div>
        <div v-if="serviceMetaLabels(service).length" class="mt-2 text-xs text-[var(--text-subtle)]">
          {{ serviceMetaLabels(service).join(' · ') }}
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button
          v-if="!service.status.running"
          :class="btnPanelIcon"
          title="Hide details"
          @click="toggleActionDetails(service)"
        >
          <svg
            viewBox="0 0 24 24"
            class="h-4 w-4 rotate-180"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          >
            <path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
    </div>
    <div class="mt-3 space-y-2.5">
      <div v-if="!service.status.running" class="flex items-center gap-2">
        <input
          v-model="actionFor(service).command"
          :class="[inputBase, 'h-8 min-w-0 flex-1 py-1 font-mono text-[11px]']"
          placeholder="Start command"
          @input="actionCommandDirty[service.project.id] = true"
          @change="persistServiceCommand(service)"
        />
        <button
          v-if="service.project.command_source === 'user'"
          :class="btnPanelSecondary"
          title="Restore the automatically detected script"
          @click="resetServiceCommand(service)"
        >Auto</button>
      </div>
      <p v-else class="truncate font-mono text-[11px] text-[var(--text-muted)]" :title="actionFor(service).command || 'Not set'">
        {{ actionFor(service).command || 'Not set' }}
      </p>
      <div v-if="!service.status.running" class="flex flex-wrap items-center gap-3">
        <input
          v-model="actionFor(service).port"
          :class="[inputBase, 'w-24 text-sm']"
          placeholder="Port"
        />
      </div>
      <div class="flex items-center justify-between gap-3">
        <p class="min-w-0 truncate text-xs text-[var(--text-subtle)]">{{ environmentSummary }}</p>
        <button :class="btnPanelSecondary" class="shrink-0" @click="configServiceId = service.project.id">Environment…</button>
      </div>
      <div
        v-if="!service.status.running && externalInstancesFor(service).length"
        class="rounded-lg border border-[var(--warning-border)] bg-[var(--warning-bg)] px-3 py-2 text-xs text-[var(--warning-text)]"
      >
        <p v-if="startupConflictFor(service)">
          Another instance is already running at
          <span class="font-mono">{{ startupConflictSummary(service) }}</span>.
        </p>
        <p v-else>
          External instance detected:
          <span class="font-mono">{{ externalInstanceSummary(service) }}</span>
        </p>

        <div v-if="startupConflictFor(service)" class="mt-2 flex justify-end">
          <button
            :class="btnPanelSecondary"
            :disabled="isResolvingConflict(service)"
            @click="resolveStartupConflict(service)"
          >
            <span
              v-if="isResolvingConflict(service)"
              :class="spinnerClass"
              aria-hidden="true"
            ></span>
            {{
              isResolvingConflict(service)
                ? 'Unplugging…'
                : 'Unplug and retry'
            }}
          </button>
        </div>

        <div v-else class="relative mt-2 flex justify-end">
          <button :class="btnPanelSecondary" @click.stop="toggleExternalMenu(service.project.id)">
            Resolve
          </button>
          <transition name="fade">
            <div
              v-if="externalMenuOpen[service.project.id]"
              class="absolute right-0 top-full z-10 mt-2 w-44 rounded-lg border border-[var(--border)] bg-[var(--panel-bg)] p-1 shadow-lg"
              @click.stop
            >
              <button
                class="flex w-full items-center rounded-md px-2 py-1.5 text-xs text-[var(--text)] hover:bg-[var(--hover)]"
                :disabled="!externalInstancesFor(service)[0]?.pid"
                @click="
                  killExternalInstance(service);
                  closeExternalMenus();
                "
              >
                Unplug external
              </button>
              <button
                class="flex w-full items-center rounded-md px-2 py-1.5 text-xs text-[var(--text)] hover:bg-[var(--hover)]"
                @click="
                  startAnotherInstance(service);
                  closeExternalMenus();
                "
              >
                Start another instance
              </button>
            </div>
          </transition>
        </div>
      </div>
      <div v-else class="flex justify-end">
        <button
          :class="service.status.running ? btnUnplug : btnPanelSecondary"
          :disabled="isActionLoading('stop', service.project.id)"
          :title="isStarting(service) ? 'Stop starting this service' : undefined"
          @click="startOrCancel(service)"
        >
          <span
            v-if="isActionLoading(service.status.running ? 'stop' : 'start', service.project.id)"
            :class="spinnerClass"
            aria-hidden="true"
          ></span>
          {{
            isStarting(service)
              ? 'Cancel'
              : isActionLoading('stop', service.project.id)
              ? 'Unplugging…'
              : service.status.running
              ? 'Unplug'
              : 'Start'
          }}
        </button>
      </div>
    </div>
    <div
      v-if="actionErrors[service.project.id] && !startupConflictFor(service)"
      class="mt-2 rounded-md border border-[var(--warning-border)] bg-[var(--warning-bg)] px-2 py-1 text-xs text-[var(--warning-text)]"
    >
      {{ actionErrors[service.project.id] }}
    </div>
    <ServiceFailure
      v-if="service.status.error && !actionErrors[service.project.id] && !startupConflictFor(service)"
      :error="service.status.error"
      :code="service.status.failure_code"
      :busy="failureActionBusy[service.project.id]"
      @action="runFailureAction(service, $event)"
    />
    <div
      v-if="serviceReady(service) && effectivePort(service)"
      class="mt-3 flex items-center justify-between rounded-xl bg-[var(--highlight-bg)] px-2.5 py-2 text-[11px] text-[var(--text-muted)]"
    >
      <span class="truncate">
        <span class="font-mono text-[var(--text)]">http://localhost:{{ effectivePort(service) }}</span>
      </span>
      <div class="flex shrink-0 items-center gap-1">
        <button
          class="inline-flex h-7 w-7 items-center justify-center rounded-md bg-[#343434] text-white transition-colors hover:bg-[#252525]"
          :title="copiedServiceUrlId === service.project.id ? 'Copied' : 'Copy link'"
          :aria-label="copiedServiceUrlId === service.project.id ? 'Link copied' : 'Copy link'"
          @click="copyProjectUrl(service)"
        >
          <svg v-if="copiedServiceUrlId === service.project.id" viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <svg v-else viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="8" y="8" width="10" height="10" rx="2" />
            <path d="M6 15H5a2 2 0 01-2-2V5a2 2 0 012-2h8a2 2 0 012 2v1" stroke-linecap="round" />
          </svg>
        </button>
        <button
          class="inline-flex h-7 w-7 items-center justify-center rounded-md bg-[#343434] text-white transition-colors hover:bg-[#252525]"
          title="Open in system browser"
          aria-label="Open link in system browser"
          @click="openProjectUrl(service)"
        >
          <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.7">
            <path d="M5 12h13M13 7l5 5-5 5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button
          class="inline-flex h-7 items-center justify-center rounded-md bg-[var(--ghost-bg)] px-2 text-[10px] font-medium text-[var(--ghost-text)] transition-colors hover:bg-[var(--ghost-hover)]"
          title="Open in Multiprise"
          @click="openInAppBrowser(service)"
        >
          Open here
        </button>
      </div>
    </div>
    <div
      v-if="(processInstances[service.project.id] ?? []).length"
      class="mt-2 space-y-1 border-t border-[var(--border)] pt-2"
    >
      <div
        v-for="instance in processInstances[service.project.id] ?? []"
        :key="`${service.project.id}-${instance.pid}-${instance.port ?? 'n'}`"
        class="flex items-center justify-between gap-2 text-[11px] text-[var(--text-subtle)]"
      >
        <span class="min-w-0 truncate">
          <span class="font-mono text-[var(--text-muted)]">
            {{ instance.port ? `:${instance.port}` : 'port unknown' }}
          </span>
          <span class="ml-2">{{ instance.source === 'docker' ? 'Docker' : `PID ${instance.pid}` }}</span>
        </span>
        <button
          v-if="instance.source === 'external'"
          class="rounded px-1.5 py-1 text-[10px] text-[var(--text-muted)] hover:bg-[var(--hover)]"
          :disabled="isActionLoading('kill', service.project.id, instance.pid)"
          @click="killInstance(service, instance.pid)"
        >
          Unplug
        </button>
      </div>
    </div>
    </div>
  </transition>
</template>
