<script setup lang="ts">
import { useBrowserTabs } from '../composables/useBrowserTabs'
import { btnPanelIcon, btnPanelSecondary, noScrollbar, spinnerClass } from '../ui'

// The in-app browser's tabs, toolbar, and the placeholder its native page view covers.

const {
  browserState, browserAddress, browserAddressEditing, browserViewport, activeBrowserTab,
  browserAction, activateBrowserTab, closeBrowserTab, navigateBrowser, toggleBrowserAttachment
} = useBrowserTabs()
</script>

<template>
  <div class="mt-3 flex h-9 shrink-0 items-end gap-1 overflow-x-auto border-b border-white/10 px-1" :class="noScrollbar">
    <button
      v-for="tab in browserState.tabs"
      :key="tab.id"
      class="group flex h-8 min-w-[130px] max-w-[190px] items-center gap-2 rounded-t-lg px-2.5 text-left text-[11px] transition-colors"
      :class="tab.id === browserState.activeTabId ? 'bg-white/10 text-white' : 'text-white/45 hover:bg-white/5 hover:text-white/80'"
      :title="`${tab.title || tab.url || 'New tab'} — Delete or middle-click to close`"
      @click="activateBrowserTab(tab.id)"
      @keydown.delete.prevent="closeBrowserTab(tab.id)"
      @auxclick.middle.prevent="closeBrowserTab(tab.id)"
    >
      <span v-if="tab.loading" :class="[spinnerClass, '!h-3 !w-3 !border']" aria-hidden="true"></span>
      <span v-else class="h-1.5 w-1.5 shrink-0 rounded-full" :class="tab.error ? 'bg-[var(--log-error)]' : tab.detached ? 'bg-white/35' : 'bg-[var(--live)]'"></span>
      <span class="min-w-0 flex-1 truncate">{{ tab.title || tab.url || 'New tab' }}</span>
      <span class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-white/10 group-hover:opacity-100 group-focus-visible:opacity-100" title="Close tab" aria-hidden="true" @click.stop="closeBrowserTab(tab.id)">×</span>
    </button>
    <button class="mb-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-lg text-white/50 hover:bg-white/10 hover:text-white" title="New tab" @click="browserAction('new')">+</button>
  </div>

  <div v-if="activeBrowserTab" class="flex h-11 shrink-0 items-center gap-1.5 border-b border-white/10 py-1.5">
    <button :class="btnPanelIcon" :disabled="!activeBrowserTab.canGoBack" title="Back" @click="browserAction('back')">
      <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M15 5l-7 7 7 7" stroke-linecap="round" stroke-linejoin="round" /></svg>
    </button>
    <button :class="btnPanelIcon" :disabled="!activeBrowserTab.canGoForward" title="Forward" @click="browserAction('forward')">
      <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 5l7 7-7 7" stroke-linecap="round" stroke-linejoin="round" /></svg>
    </button>
    <button :class="btnPanelIcon" :title="activeBrowserTab.loading ? 'Stop loading' : 'Reload'" @click="browserAction('reload')">
      <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M19 8a8 8 0 10.5 7M19 4v4h-4" stroke-linecap="round" stroke-linejoin="round" /></svg>
    </button>
    <form class="min-w-0 flex-1" @submit.prevent="navigateBrowser">
      <input
        v-model="browserAddress"
        class="h-8 w-full rounded-lg border border-white/15 bg-black/20 px-3 font-mono text-[11px] text-white placeholder:text-white/35 focus:border-[var(--primary)] focus:outline-none"
        placeholder="Enter a local URL"
        @focus="browserAddressEditing = true"
        @blur="browserAddressEditing = false"
      />
    </form>
    <button :class="btnPanelIcon" :disabled="!activeBrowserTab.url" title="Open in system browser" @click="browserAction('external')">
      <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 5h5v5M19 5l-9 9" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 13v5a1 1 0 01-1 1H6a1 1 0 01-1-1V8a1 1 0 011-1h5" stroke-linecap="round"/></svg>
    </button>
    <button :class="btnPanelSecondary" title="Toggle developer tools" @click="browserAction('devtools')">DevTools</button>
    <button :class="btnPanelSecondary" :title="activeBrowserTab.detached ? 'Bring this page back into Multiprise' : 'Open this page in its own Multiprise window'" @click="toggleBrowserAttachment">
      {{ activeBrowserTab.detached ? 'Attach' : 'Detach' }}
    </button>
  </div>

  <div v-if="!browserState.tabs.length" class="flex min-h-0 flex-1 items-center justify-center text-sm text-white/40">
    Open a running service here to create a browser tab.
  </div>
  <div v-else-if="activeBrowserTab?.detached" class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center text-white/45">
    <p class="text-sm text-white/70">This page is open in a detached window.</p>
    <button :class="btnPanelSecondary" @click="toggleBrowserAttachment">Attach to this panel</button>
  </div>
  <div v-else ref="browserViewport" class="min-h-0 flex-1 rounded-b-xl bg-white"></div>
</template>
