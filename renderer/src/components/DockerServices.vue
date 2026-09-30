<script setup lang="ts">
import { useServiceActions } from '../composables/useServiceActions'
import { projectTitle, serviceFailed, serviceReady, serviceStarting, serviceStatusLabel } from '../lib/services'
import { type ProjectView } from '../types'
import { btnPanelSecondary, btnUnplug, spinnerClass, statusDot, statusDotFailed, statusDotLive } from '../ui'

// Docker Compose services of the open project; Launch leaves them alone, so each starts on its own.

defineProps<{ services: ProjectView[] }>()

const { actionFor, isActionLoading, toggleService } = useServiceActions()
</script>

<template>
  <div
      class="rounded-2xl bg-[var(--panel-bg)] p-3"
  >
    <div class="flex items-start justify-between gap-3">
      <div class="flex items-center gap-2">
        <svg viewBox="0 0 24 24" class="h-4 w-4 text-[var(--text-subtle)]" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M3 7h6v4H3z" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M9 7h6v4H9z" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M15 7h6v4h-6z" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M3 13h6v4H3z" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M9 13h6v4H9z" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M15 13h6v4h-6z" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <div>
          <p class="text-[15px] font-semibold text-[var(--text-strong)]">Docker</p>
        </div>
      </div>
      <span class="text-[11px] text-[var(--text-subtle)]">Excluded from Launch</span>
    </div>
    <div class="mt-3 space-y-2">
      <div
        v-for="service in services"
        :key="service.project.id"
        class="relative overflow-hidden rounded-xl bg-[var(--panel-muted)] px-3 py-2.5"
        :class="service.status.running ? 'powered-service' : ''"
      >
        <div class="flex items-center justify-between gap-3">
          <div class="flex min-w-0 items-center gap-2">
            <span :class="[statusDot, serviceReady(service) ? statusDotLive : serviceFailed(service) ? statusDotFailed : '']" :aria-label="serviceStatusLabel(service)"></span>
            <div class="min-w-0">
              <p class="truncate text-[13px] font-semibold text-[var(--text-strong)]">{{ projectTitle(service) }}</p>
              <p class="truncate font-mono text-[10px] text-[var(--text-subtle)]">
                {{ actionFor(service).command || 'docker compose up' }}
              </p>
            </div>
          </div>
          <button
            :class="service.status.running ? btnUnplug : btnPanelSecondary"
            :disabled="serviceStarting(service) || isActionLoading(service.status.running ? 'stop' : 'start', service.project.id)"
            @click="toggleService(service)"
          >
            <span
              v-if="isActionLoading(service.status.running ? 'stop' : 'start', service.project.id)"
              :class="spinnerClass"
              aria-hidden="true"
            ></span>
            {{ service.status.running ? 'Unplug' : 'Start' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
