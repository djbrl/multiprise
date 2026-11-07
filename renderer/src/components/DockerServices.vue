<script setup lang="ts">
import { useServiceActions } from '../composables/useServiceActions'
import { projectTitle, serviceFailed, serviceReady, serviceStarting, serviceStatusLabel } from '../lib/services'
import { type ProjectView } from '../types'
import { btnGhostXs, spinnerClass, statusDot, statusDotFailed, statusDotLive } from '../ui'

// Docker Compose services of the open project; Launch leaves them alone, so each starts on its own.

defineProps<{ services: ProjectView[] }>()

const { actionFor, isActionLoading, toggleService } = useServiceActions()
</script>

<template>
  <div>
    <div class="flex h-[42px] items-center justify-between gap-3 border-b border-[var(--border)] px-4">
      <h2 class="text-[13px] font-medium text-[var(--text-strong)]">
        Docker <span class="font-normal text-[var(--text-subtle)]">{{ services.length }}</span>
      </h2>
      <span class="text-xs text-[var(--text-subtle)]">Excluded from Launch</span>
    </div>
    <div
      v-for="service in services"
      :key="service.project.id"
      class="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-2"
    >
      <div class="flex min-w-0 items-center gap-2">
        <span :class="[statusDot, serviceReady(service) ? statusDotLive : serviceFailed(service) ? statusDotFailed : '']" :aria-label="serviceStatusLabel(service)"></span>
        <div class="min-w-0">
          <p class="truncate text-[13px] font-medium text-[var(--text-strong)]">{{ projectTitle(service) }}</p>
          <p class="truncate font-mono text-[11px] text-[var(--text-subtle)]">
            {{ actionFor(service).command || 'docker compose up' }}
          </p>
        </div>
      </div>
      <button
        :class="btnGhostXs"
        :disabled="serviceStarting(service) || isActionLoading(service.status.running ? 'stop' : 'start', service.project.id)"
        @click="toggleService(service)"
      >
        <span
          v-if="isActionLoading(service.status.running ? 'stop' : 'start', service.project.id)"
          :class="[spinnerClass, '!h-3 !w-3']"
          aria-hidden="true"
        ></span>
        {{ service.status.running ? 'Stop' : 'Start' }}
      </button>
    </div>
  </div>
</template>
