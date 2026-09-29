<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { noScrollbar } from '../ui'

// ⌘K: jump to a project, start/stop/open services, run app actions, or search the logs.

export type PaletteCommand = {
  id: string
  title: string
  group: string
  subtitle?: string
  shortcut?: string
  // Extra words that should find this command.
  keywords?: string
  run: () => unknown
}

const props = defineProps<{ commands: PaletteCommand[] }>()
const emit = defineEmits<{ close: []; 'search-logs': [query: string] }>()

const query = ref('')
const active = ref(0)
const input = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)

// Letters must appear in order; runs of consecutive letters and word starts score higher.
function score(text: string, needle: string) {
  if (!needle) return 1
  const haystack = text.toLowerCase()
  let position = 0
  let total = 0
  let streak = 0
  for (const char of needle) {
    const found = haystack.indexOf(char, position)
    if (found === -1) return 0
    streak = found === position ? streak + 1 : 0
    const wordStart = found === 0 || /[\s/·._-]/.test(haystack[found - 1])
    total += 1 + streak * 2 + (wordStart ? 3 : 0)
    position = found + 1
  }
  return total - haystack.length / 100
}

type Row = PaletteCommand & { rank: number }

const results = computed<Row[]>(() => {
  const needle = query.value.trim().toLowerCase()
  const ranked = props.commands
    .map((command) => ({
      ...command,
      rank: Math.max(score(command.title, needle), score(`${command.group} ${command.title} ${command.keywords ?? ''}`, needle) * 0.8)
    }))
    .filter((command) => command.rank > 0)
  if (needle) ranked.sort((a, b) => b.rank - a.rank)
  // Letters scattered across a long title still "match"; drop those far behind the best.
  const best = ranked[0]?.rank ?? 0
  const rows = (needle ? ranked.filter((command) => command.rank >= best * 0.45) : ranked).slice(0, 60)
  if (needle) {
    rows.push({
      id: 'search-logs',
      title: `Search logs for “${query.value.trim()}”`,
      group: 'Logs',
      rank: 0,
      run: () => emit('search-logs', query.value.trim())
    })
  }
  return rows
})

// Keep group headings for a plain listing; a ranked search reads better as one list.
const showGroups = computed(() => !query.value.trim())

watch(query, () => { active.value = 0 })
watch(active, async () => {
  await nextTick()
  list.value?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
})

async function runAt(index: number) {
  const command = results.value[index]
  if (!command) return
  emit('close')
  await command.run()
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    active.value = Math.min(results.value.length - 1, active.value + 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    active.value = Math.max(0, active.value - 1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    runAt(active.value)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  }
}

onMounted(() => input.value?.focus())
</script>

<template>
  <div class="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 px-5 pt-[12vh]" @click.self="emit('close')">
    <div class="flex max-h-[min(560px,76vh)] w-[min(640px,94vw)] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] shadow-2xl">
      <div class="flex items-center gap-3 border-b border-[var(--border)] px-4">
        <svg viewBox="0 0 24 24" class="h-4 w-4 shrink-0 text-[var(--text-subtle)]" fill="none" stroke="currentColor" stroke-width="1.8">
          <circle cx="11" cy="11" r="6.5" />
          <path d="M16 16l4 4" stroke-linecap="round" />
        </svg>
        <input
          ref="input"
          v-model="query"
          class="h-12 min-w-0 flex-1 bg-transparent text-[15px] text-[var(--text-strong)] outline-none placeholder:text-[var(--text-subtle)]"
          placeholder="Jump to a project, start a service, search logs…"
          spellcheck="false"
          @keydown="onKeydown"
        />
        <kbd class="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--text-subtle)]">esc</kbd>
      </div>
      <div ref="list" class="min-h-0 flex-1 overflow-y-auto p-2" :class="noScrollbar">
        <p v-if="!results.length" class="px-3 py-6 text-center text-sm text-[var(--text-subtle)]">Nothing matches.</p>
        <template v-for="(command, index) in results" :key="command.id">
          <p
            v-if="showGroups && (index === 0 || results[index - 1].group !== command.group)"
            class="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]"
          >{{ command.group }}</p>
          <button
            type="button"
            class="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors"
            :class="index === active ? 'bg-[var(--selection)]' : 'hover:bg-[var(--hover)]'"
            :data-active="index === active"
            @mousemove="active = index"
            @click="runAt(index)"
          >
            <span class="min-w-0">
              <span class="block truncate text-sm text-[var(--text-strong)]">{{ command.title }}</span>
              <span v-if="command.subtitle" class="block truncate text-[11px] text-[var(--text-subtle)]">{{ command.subtitle }}</span>
            </span>
            <span class="flex shrink-0 items-center gap-2">
              <span v-if="!showGroups" class="text-[10px] text-[var(--text-subtle)]">{{ command.group }}</span>
              <kbd v-if="command.shortcut" class="rounded border border-[var(--border)] px-1.5 py-0.5 font-sans text-[10px] text-[var(--text-subtle)]">{{ command.shortcut }}</kbd>
            </span>
          </button>
        </template>
      </div>
      <div class="flex flex-wrap gap-x-4 gap-y-1 border-t border-[var(--border)] px-4 py-2 text-[10px] text-[var(--text-subtle)]">
        <span>↑↓ to move · ↩ to run</span>
        <span>⌘K palette</span>
        <span>⌘F search logs</span>
        <span>⌘↩ launch project</span>
        <span>⌘. stop project</span>
        <span>⌘1–9 switch project</span>
        <span>⌘, settings</span>
      </div>
    </div>
  </div>
</template>
