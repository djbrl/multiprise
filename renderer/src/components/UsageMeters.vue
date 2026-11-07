<script setup lang="ts">
import { computed } from 'vue'
import { useNavigation } from '../composables/useNavigation'
import { formatBytes, useUsage } from '../composables/useUsage'
import { type MemoryPressure } from '../types'

// CPU and memory always in view at the foot of the sidebar; a click opens Activity.

defineProps<{ compact: boolean }>()

const { activeSection } = useNavigation()
const { machine, cpuLevel, memoryLevel } = useUsage()

const fillClass = (level: MemoryPressure) =>
  level === 'critical' ? 'bg-[var(--log-error)]' : level === 'warning' ? 'bg-[var(--attention)]' : 'bg-[var(--text-subtle)]'

const meters = computed(() => {
  if (!machine.value) return []
  const { cpu, memory_used: used, memory_total: total } = machine.value
  return [
    { label: 'CPU', percent: cpu ?? 0, value: cpu === null ? '–' : `${Math.round(cpu)}%`, level: cpuLevel.value },
    { label: 'Memory', percent: 100 * used / total, value: `${Math.round(100 * used / total)}%`, level: memoryLevel.value }
  ]
})

const summary = computed(() => {
  if (!machine.value) return 'Activity'
  const { cpu, memory_used: used, memory_total: total, memory_pressure: pressure } = machine.value
  return `CPU ${cpu === null ? '–' : `${Math.round(cpu)}%`}. Memory ${formatBytes(used)} of ${formatBytes(total)}${pressure ? `, pressure ${pressure}` : ''}.`
})
</script>

<template>
  <button
    type="button"
    class="mb-1 flex w-full shrink-0 flex-col gap-1.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--hover)]"
    :class="activeSection === 'activity' ? 'nav-selected bg-[var(--selection)]' : ''"
    :title="summary"
    :aria-label="`Activity. ${summary}`"
    @click="activeSection = 'activity'"
  >
    <span v-for="meter in meters" :key="meter.label" class="flex items-center gap-2 text-xs" :class="compact ? 'justify-center' : ''">
      <span v-if="!compact" class="w-[50px] shrink-0 text-[var(--text-muted)]">{{ meter.label }}</span>
      <span class="relative h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--text-subtle)_22%,transparent)]">
        <span class="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500" :class="fillClass(meter.level)" :style="{ width: `${Math.min(100, meter.percent)}%` }"></span>
      </span>
      <span v-if="!compact" class="w-[38px] shrink-0 text-right tabular-nums" :class="meter.level === 'normal' ? 'text-[var(--text-muted)]' : 'font-medium text-[var(--attention-text)]'">
        <span v-if="meter.level !== 'normal'" aria-hidden="true">! </span>{{ meter.value }}
      </span>
    </span>
    <span v-if="!meters.length && !compact" class="text-[var(--text-muted)]">Activity</span>
  </button>
</template>
