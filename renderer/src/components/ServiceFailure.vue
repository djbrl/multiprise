<script setup lang="ts">
import { computed } from 'vue'
import { type FailureCode } from '../types'
import { spinnerClass } from '../ui'

// A failed service's error with the fixes that apply to its kind of failure.

export type FailureAction = 'retry' | 'retry-new-port' | 'install' | 'build' | 'environment' | 'settings' | 'restart'

const props = defineProps<{
  error: string
  code?: FailureCode | null
  // The action in progress, if any.
  busy?: FailureAction | null
}>()
const emit = defineEmits<{ action: [action: FailureAction] }>()

const ACTIONS: Partial<Record<FailureCode, Array<{ action: FailureAction; label: string }>>> = {
  'port-in-use': [{ action: 'retry-new-port', label: 'Retry on a new port' }],
  'dependencies-missing': [{ action: 'install', label: 'Install dependencies and retry' }],
  'missing-build': [{ action: 'build', label: 'Build and retry' }, { action: 'retry', label: 'Retry' }],
  'environment-missing': [{ action: 'environment', label: 'Open environment' }, { action: 'retry', label: 'Retry' }],
  timeout: [{ action: 'retry', label: 'Retry' }, { action: 'settings', label: 'Change startup timeout' }],
  'not-responding': [{ action: 'restart', label: 'Restart' }]
}

// The existing-instance case has its own "Unplug and retry" prompt in the service card.
const actions = computed(() => props.code === 'existing-instance'
  ? []
  : (props.code ? ACTIONS[props.code] : undefined) ?? [{ action: 'retry' as FailureAction, label: 'Retry' }])

const pendingLabel: Partial<Record<FailureAction, string>> = {
  install: 'Installing…',
  build: 'Building…',
  restart: 'Restarting…'
}
</script>

<template>
  <div class="mt-2 rounded-md border border-[var(--warning-border)] bg-[var(--warning-bg)] px-2 py-1.5 text-xs text-[var(--warning-text)]">
    <p class="whitespace-pre-wrap break-words">{{ error }}</p>
    <div v-if="actions.length" class="mt-1.5 flex flex-wrap gap-1.5">
      <button
        v-for="(item, index) in actions"
        :key="item.action"
        type="button"
        class="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium transition-colors disabled:opacity-50"
        :class="index === 0
          ? 'bg-[var(--warning-text)] text-[var(--warning-bg)] hover:opacity-90'
          : 'border border-[var(--warning-border)] hover:bg-[color-mix(in_srgb,var(--warning-text)_10%,transparent)]'"
        :disabled="!!busy"
        @click="emit('action', item.action)"
      >
        <span v-if="busy === item.action" :class="[spinnerClass, '!h-3 !w-3 !border-current !border-t-transparent']" aria-hidden="true"></span>
        {{ busy === item.action ? pendingLabel[item.action] ?? 'Starting…' : item.label }}
      </button>
    </div>
  </div>
</template>
