<script setup lang="ts">
import { computed, ref } from 'vue'

// The last few minutes as a percentage: the whole Mac in grey, the dev servers in the accent.
// Time runs on a fixed scale ending now, so a short history starts partway along.

export type ChartPoint = { at: number; total: number | null; servers: number | null }

const props = defineProps<{
  label: string
  points: ChartPoint[]
  windowMs: number
  now: number
  format: (point: ChartPoint) => { total: string; servers: string | null }
}>()

const WIDTH = 600
const HEIGHT = 120

const x = (at: number) => WIDTH * (1 - (props.now - at) / props.windowMs)
const y = (value: number) => HEIGHT * (1 - Math.min(100, value) / 100)

// Separate runs, so a stretch without a figure stays a gap in the line.
function runs(pick: (point: ChartPoint) => number | null) {
  const found: { at: number; value: number }[][] = []
  let current: { at: number; value: number }[] | null = null
  for (const point of props.points) {
    const value = pick(point)
    if (value === null) current = null
    else {
      if (!current) found.push(current = [])
      current.push({ at: point.at, value })
    }
  }
  return found
}

const linePath = (run: { at: number; value: number }[]) =>
  run.map((point, index) => `${index ? 'L' : 'M'}${x(point.at).toFixed(1)} ${y(point.value).toFixed(1)}`).join(' ')

const totalRuns = computed(() => runs((point) => point.total))
const serverRuns = computed(() => runs((point) => point.servers))
const serverAreas = computed(() => serverRuns.value.map((run) =>
  `${linePath(run)} L${x(run[run.length - 1].at).toFixed(1)} ${HEIGHT} L${x(run[0].at).toFixed(1)} ${HEIGHT} Z`))

const hovered = ref<ChartPoint | null>(null)
const hoverX = computed(() => hovered.value ? 100 * x(hovered.value.at) / WIDTH : 0)

function handleMove(event: MouseEvent) {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const at = props.now - props.windowMs * (1 - (event.clientX - box.left) / box.width)
  hovered.value = props.points.reduce<ChartPoint | null>((nearest, point) =>
    !nearest || Math.abs(point.at - at) < Math.abs(nearest.at - at) ? point : nearest, null)
}

function ago(at: number) {
  const seconds = Math.round((props.now - at) / 1000)
  if (seconds < 5) return 'Now'
  return seconds < 60 ? `${seconds} s ago` : `${Math.floor(seconds / 60)} min ${seconds % 60} s ago`
}

const tooltip = computed(() => hovered.value ? props.format(hovered.value) : null)
</script>

<template>
  <figure class="min-w-0">
    <div class="flex gap-2">
      <div class="relative min-w-0 flex-1" style="height: 120px" @mousemove="handleMove" @mouseleave="hovered = null">
        <svg :viewBox="`0 0 ${WIDTH} ${HEIGHT}`" preserveAspectRatio="none" class="absolute inset-0 h-full w-full overflow-visible" role="img" :aria-label="`${label} over the last few minutes`">
          <line v-for="level in [0, 50, 100]" :key="level" x1="0" :x2="WIDTH" :y1="y(level)" :y2="y(level)" stroke="var(--border)" stroke-width="1" vector-effect="non-scaling-stroke" />
          <path v-for="(area, index) in serverAreas" :key="index" :d="area" fill="var(--electric)" fill-opacity="0.16" />
          <path v-for="(run, index) in totalRuns" :key="index" :d="linePath(run)" fill="none" stroke="var(--text-subtle)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
          <path v-for="(run, index) in serverRuns" :key="index" :d="linePath(run)" fill="none" stroke="var(--electric)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
        </svg>
        <template v-if="hovered && tooltip">
          <span class="pointer-events-none absolute inset-y-0 w-px bg-[var(--text-subtle)]" :style="{ left: `${hoverX}%` }"></span>
          <div
            class="surface-raised pointer-events-none absolute top-1 z-10 whitespace-nowrap rounded-md border border-[var(--border)] bg-[var(--panel-bg)] px-2.5 py-1.5 text-xs shadow-sm"
            :style="hoverX > 55 ? { right: `${100 - hoverX + 1.5}%` } : { left: `${hoverX + 1.5}%` }"
          >
            <p class="text-[var(--text-subtle)]">{{ ago(hovered.at) }}</p>
            <p class="mt-0.5 text-[var(--text-strong)]">This Mac {{ tooltip.total }}</p>
            <p v-if="tooltip.servers" class="text-[var(--text-strong)]">Dev servers {{ tooltip.servers }}</p>
          </div>
        </template>
      </div>
      <div class="relative w-8 shrink-0 text-right text-[11px] tabular-nums text-[var(--text-subtle)]" aria-hidden="true">
        <span class="absolute right-0 top-0 -translate-y-1/2">100%</span>
        <span class="absolute right-0 top-1/2 -translate-y-1/2">50%</span>
        <span class="absolute bottom-0 right-0 translate-y-1/2">0%</span>
      </div>
    </div>
    <figcaption class="mt-2 flex items-center gap-4 text-xs text-[var(--text-muted)]">
      <span class="flex items-center gap-1.5"><span class="h-0.5 w-3 rounded-full bg-[var(--text-subtle)]"></span>This Mac</span>
      <span class="flex items-center gap-1.5"><span class="h-0.5 w-3 rounded-full bg-[var(--electric)]"></span>Dev servers</span>
      <span class="ml-auto text-[var(--text-subtle)]">Last {{ Math.round(windowMs / 60000) }} min</span>
    </figcaption>
  </figure>
</template>
