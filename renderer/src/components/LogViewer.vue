<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { type LogLine } from '../types'
import { inputBase, noScrollbar } from '../ui'

// The merged log of a project's services: search, filters, pause/follow, and links for
// URLs and file:line references.

export type LogEntry = LogLine & {
  serviceId: string
  serviceName: string
  role: string
}
type ServiceOption = { id: string; name: string; role: string }
type Segment = { kind: 'text' | 'url' | 'file'; text: string; path?: string; line?: number; column?: number }

const props = defineProps<{ entries: LogEntry[]; services: ServiceOption[] }>()
const emit = defineEmits<{
  'open-url': [url: string]
  'open-file': [target: { serviceId: string; path: string; line?: number; column?: number }]
}>()

const MAX_VISIBLE = 500
const query = ref('')
const level = ref<'all' | 'errors' | 'warnings'>('all')
const stderrOnly = ref(false)
// Services hidden from the merged view.
const hidden = ref<string[]>([])
const paused = ref(false)
const pausedAtSeq = ref(0)
const scroller = ref<HTMLElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const pinnedToBottom = ref(true)

function levelOf(entry: { stream?: string; line?: string }) {
  const line = entry.line ?? ''
  // Many tools log progress and warnings to stderr, so the stream alone doesn't make a line an error.
  if (/\b(warn|warning|deprecated|deprecation)\b/i.test(line)) return 'warnings'
  if (/\b(error|err!|failed|failure|exception|fatal|panic|eaddrinuse|exited|unable to|cannot)\b/i.test(line)) return 'errors'
  if (entry.stream === 'stderr' && /^\s+at\s/.test(line)) return 'errors'
  return 'all'
}

const filtered = computed(() => {
  const text = query.value.trim().toLowerCase()
  return props.entries.filter((entry) =>
    !hidden.value.includes(entry.serviceId) &&
    (!stderrOnly.value || entry.stream === 'stderr') &&
    (level.value === 'all' || levelOf(entry) === level.value) &&
    (!text || entry.line.toLowerCase().includes(text) || entry.serviceName.toLowerCase().includes(text))
  )
})
// While paused, the view stays on the lines that had arrived; new ones are only counted.
const visible = computed(() => {
  const lines = paused.value ? filtered.value.filter((entry) => entry.seq <= pausedAtSeq.value) : filtered.value
  return lines.slice(-MAX_VISIBLE)
})
const newWhilePaused = computed(() => paused.value ? filtered.value.filter((entry) => entry.seq > pausedAtSeq.value).length : 0)
const anyFilter = computed(() => level.value !== 'all' || stderrOnly.value || hidden.value.length > 0)

function togglePause() {
  paused.value = !paused.value
  pausedAtSeq.value = props.entries.reduce((max, entry) => Math.max(max, entry.seq), 0)
  if (!paused.value) jumpToLatest()
}

function toggleService(id: string) {
  hidden.value = hidden.value.includes(id) ? hidden.value.filter((entry) => entry !== id) : [...hidden.value, id]
}

function clearFilters() {
  level.value = 'all'
  stderrOnly.value = false
  hidden.value = []
}

function scrollToBottom(force = false) {
  nextTick(() => {
    const container = scroller.value
    if (!container || (!force && !pinnedToBottom.value)) return
    container.scrollTop = container.scrollHeight
    pinnedToBottom.value = true
  })
}

function handleScroll() {
  const container = scroller.value
  if (!container) return
  pinnedToBottom.value = container.scrollHeight - container.scrollTop - container.clientHeight < 28
}

function jumpToLatest() {
  pinnedToBottom.value = true
  scrollToBottom(true)
}

// The list is capped, so its length stops changing; follow the newest line instead.
watch(() => {
  const newest = visible.value[visible.value.length - 1]
  return `${visible.value.length}|${newest?.seq ?? ''}|${newest?.repeat ?? ''}`
}, () => scrollToBottom())
watch(() => props.entries.length === 0, () => jumpToLatest(), { immediate: true })

// URLs, and source locations such as src/app.ts:12:5 or file:///x/y.js:3 (a line number is
// required, so plain words with a dot are left alone).
const LINK = /(https?:\/\/[^\s"'<>)\]]+)|((?:file:\/\/)?(?:\/|\.{1,2}\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z]{1,6}):(\d+)(?::(\d+))?/g

function segments(line: string): Segment[] {
  const parts: Segment[] = []
  let last = 0
  for (const match of line.matchAll(LINK)) {
    const index = match.index ?? 0
    if (index > last) parts.push({ kind: 'text', text: line.slice(last, index) })
    if (match[1]) {
      // Trailing punctuation belongs to the sentence, not the URL.
      const url = match[1].replace(/[.,;:!?]+$/, '')
      parts.push({ kind: 'url', text: url })
      last = index + url.length
      continue
    }
    parts.push({
      kind: 'file',
      text: match[0],
      path: match[2].replace(/^file:\/\//, ''),
      line: Number(match[3]),
      column: match[4] ? Number(match[4]) : undefined
    })
    last = index + match[0].length
  }
  if (last < line.length) parts.push({ kind: 'text', text: line.slice(last) })
  return parts
}

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

function highlight(value: string) {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return escapeHtml(value)
  const lower = value.toLowerCase()
  let result = ''
  let index = 0
  while (index < value.length) {
    const found = lower.indexOf(needle, index)
    if (found === -1) {
      result += escapeHtml(value.slice(index))
      break
    }
    result += escapeHtml(value.slice(index, found)) +
      `<mark class="rounded bg-[var(--highlight-bg)] px-1 text-[var(--highlight-text)]">${escapeHtml(value.slice(found, found + needle.length))}</mark>`
    index = found + needle.length
  }
  return result
}

function serviceTone(role: string) {
  if (role === 'backend') return 'text-[var(--log-backend)]'
  if (role === 'frontend') return 'text-[var(--log-frontend)]'
  if (role === 'service') return 'text-[var(--log-service)]'
  return 'text-[var(--log-default)]'
}

function lineTone(entry: LogEntry) {
  if (/^\s+at\s/.test(entry.line) && entry.stream === 'stderr') return 'text-[var(--text-muted)]'
  const kind = levelOf(entry)
  if (kind === 'errors') return 'text-[var(--log-error)]'
  if (kind === 'warnings') return 'text-[var(--log-warning)]'
  if (/\b(ready|started|listening|compiled|build finished|success|connected)\b/i.test(entry.line)) return 'text-[var(--log-success)]'
  return 'text-[var(--log-default)]'
}

function rowTone(entry: LogEntry) {
  const kind = levelOf(entry)
  if (kind === 'errors') return 'bg-[var(--log-error-bg)]'
  if (kind === 'warnings') return 'bg-[var(--log-warning-bg)]'
  return ''
}

function formatTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const chip = (active: boolean, activeClass: string) =>
  active ? activeClass : 'border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--hover)]'

defineExpose({
  focusSearch: () => searchInput.value?.focus(),
  search: (text: string) => {
    query.value = text
    searchInput.value?.focus()
  }
})
</script>

<template>
  <div class="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-3 py-2">
    <input
      ref="searchInput"
      v-model="query"
      :class="[inputBase, 'h-7 !w-auto min-w-[180px] flex-1 py-1 text-xs']"
      placeholder="Search logs (⌘F)"
      @keydown.esc="query = ''"
    />
    <button
      class="h-7 rounded-md border px-2.5 text-xs transition-colors"
      :class="chip(!anyFilter, 'border-[var(--text-muted)] bg-[var(--chip-active-bg)] text-[var(--text-strong)]')"
      @click="clearFilters"
    >All</button>
    <button
      class="h-7 rounded-md border px-2.5 text-xs transition-colors"
      :class="chip(level === 'errors', 'border-[var(--log-error)] bg-[var(--danger-bg)] text-[var(--log-error)]')"
      @click="level = level === 'errors' ? 'all' : 'errors'"
    >Errors</button>
    <button
      class="h-7 rounded-md border px-2.5 text-xs transition-colors"
      :class="chip(level === 'warnings', 'border-[var(--log-warning)] text-[var(--log-warning)]')"
      @click="level = level === 'warnings' ? 'all' : 'warnings'"
    >Warnings</button>
    <button
      class="h-7 rounded-md border px-2.5 text-xs transition-colors"
      :class="chip(stderrOnly, 'border-[var(--text-muted)] bg-[var(--chip-active-bg)] text-[var(--text-strong)]')"
      title="Only lines written to stderr"
      @click="stderrOnly = !stderrOnly"
    >stderr</button>
    <button
      class="h-7 rounded-md border px-2.5 text-xs transition-colors"
      :class="chip(paused, 'border-[var(--log-warning)] text-[var(--log-warning)]')"
      :title="paused ? 'Resume following new lines' : 'Freeze the view while you read'"
      @click="togglePause"
    >{{ paused ? `Resume${newWhilePaused ? ` · ${newWhilePaused} new` : ''}` : 'Pause' }}</button>
  </div>
  <div v-if="services.length > 1" class="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-3 py-2">
    <button
      v-for="service in services"
      :key="service.id"
      class="h-7 rounded-md border px-2.5 text-xs font-medium transition-colors"
      :class="hidden.includes(service.id) ? 'border-[var(--border)] text-[var(--text-subtle)] line-through opacity-60' : ['border-[var(--border)]', serviceTone(service.role)]"
      :title="hidden.includes(service.id) ? `Show ${service.name}` : `Hide ${service.name}`"
      @click="toggleService(service.id)"
    >{{ service.name }}</button>
  </div>
  <div class="relative min-h-0 flex-1">
    <div
      ref="scroller"
      class="surface-recess relative h-full min-h-0 overflow-y-auto bg-[var(--log-bg)] py-2 font-mono text-xs leading-[1.6]"
      :class="noScrollbar"
      @scroll="handleScroll"
    >
      <div v-if="visible.length === 0" class="flex h-full min-h-[220px] flex-col items-center justify-center gap-2 text-[var(--text-subtle)]">
        <svg viewBox="0 0 48 48" class="h-9 w-9 opacity-55" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M16 8v10M30 8v10M12 18h22v4c0 7-5 12-11 12v7" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M34 34l7 7M41 34l-7 7" stroke-linecap="round" />
        </svg>
        <p v-if="entries.length" class="font-sans text-xs">No lines match. <button class="underline" @click="clearFilters(); query = ''">Clear filters</button></p>
      </div>
      <div
        v-for="entry in visible"
        :key="entry.seq"
        class="flex min-w-0 gap-2.5 px-4 py-px"
        :class="rowTone(entry)"
      >
        <span class="w-[62px] shrink-0 text-[var(--text-subtle)]">{{ formatTime(entry.timestamp) }}</span>
        <span class="w-[92px] shrink-0 truncate" :class="serviceTone(entry.role)" :title="entry.serviceName">{{ entry.serviceName }}</span>
        <span class="min-w-0 flex-1 whitespace-pre-wrap break-words" :class="lineTone(entry)"><template v-for="(part, index) in segments(entry.line)" :key="index"><a
          v-if="part.kind === 'url'"
          href="#"
          class="underline decoration-dotted underline-offset-2 hover:text-[var(--text-strong)]"
          title="Open in the browser"
          @click.prevent="emit('open-url', part.text)"
          v-html="highlight(part.text)"
        ></a><a
          v-else-if="part.kind === 'file'"
          href="#"
          class="underline decoration-dotted underline-offset-2 hover:text-[var(--text-strong)]"
          title="Open in the editor"
          @click.prevent="emit('open-file', { serviceId: entry.serviceId, path: part.path!, line: part.line, column: part.column })"
          v-html="highlight(part.text)"
        ></a><span v-else v-html="highlight(part.text)"></span></template></span>
        <span
          v-if="entry.repeat && entry.repeat > 1"
          class="shrink-0 self-start rounded bg-[var(--selection)] px-1.5 text-[11px] text-[var(--text-muted)]"
          :title="`Printed ${entry.repeat} times in a row`"
        >×{{ entry.repeat }}</span>
      </div>
    </div>
    <button
      v-if="!pinnedToBottom && !paused"
      class="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md border border-[var(--border)] bg-[var(--panel-bg)] px-2.5 py-1 text-xs text-[var(--text)] shadow-lg hover:bg-[var(--hover)]"
      @click="jumpToLatest"
    >Jump to latest</button>
  </div>
</template>
