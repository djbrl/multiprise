<script setup lang="ts">
import { useBrowserTabs } from '../composables/useBrowserTabs'
import { btnPanelIcon, btnPanelSecondary, inputBase, noScrollbar, spinnerClass } from '../ui'

// The in-app browser's tabs, toolbar, and the placeholder its native page view covers.

const {
  browserState, browserAddress, browserAddressEditing, activeBrowserTab,
  browserAction, activateBrowserTab, closeBrowserTab, navigateBrowser, toggleBrowserAttachment
} = useBrowserTabs()
</script>

<template>
  <div class="flex h-9 shrink-0 items-end gap-1 overflow-x-auto border-b border-[var(--border)] px-2" :class="noScrollbar">
    <button
      v-for="tab in browserState.tabs"
      :key="tab.id"
      class="group flex h-8 min-w-[130px] max-w-[190px] items-center gap-2 rounded-t-md px-2.5 text-left text-xs transition-colors"
      :class="tab.id === browserState.activeTabId ? 'bg-[var(--selection)] text-[var(--text-strong)]' : 'text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text-strong)]'"
      :title="`${tab.title || tab.url || 'New tab'} — Delete or middle-click to close`"
      @click="activateBrowserTab(tab.id)"
      @keydown.delete.prevent="closeBrowserTab(tab.id)"
      @auxclick.middle.prevent="closeBrowserTab(tab.id)"
    >
      <span v-if="tab.loading" :class="[spinnerClass, '!h-3 !w-3 !border']" aria-hidden="true"></span>
      <span v-else class="h-1.5 w-1.5 shrink-0 rounded-full" :class="tab.error ? 'bg-[var(--log-error)]' : tab.detached ? 'bg-[var(--text-subtle)]' : 'bg-[var(--live)]'"></span>
      <span class="min-w-0 flex-1 truncate">{{ tab.title || tab.url || 'New tab' }}</span>
      <span class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[var(--hover)] group-hover:opacity-100 group-focus-visible:opacity-100" title="Close tab" aria-hidden="true" @click.stop="closeBrowserTab(tab.id)">×</span>
    </button>
    <button class="mb-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text-strong)]" title="New tab" @click="browserAction('new')">+</button>
  </div>

  <div v-if="activeBrowserTab" class="flex h-11 shrink-0 items-center gap-1.5 border-b border-[var(--border)] px-2 py-1.5">
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
        :class="[inputBase, 'h-8 font-mono text-xs']"
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

  <div v-if="!browserState.tabs.length" class="flex min-h-0 flex-1 items-center justify-center text-[13px] text-[var(--text-subtle)]">
    Open a running service here to create a browser tab.
  </div>
  <div v-else-if="activeBrowserTab?.detached" class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center">
    <p class="text-[13px] text-[var(--text-muted)]">This page is open in a detached window.</p>
    <button :class="btnPanelSecondary" @click="toggleBrowserAttachment">Attach to this panel</button>
  </div>
  <div v-else ref="browserViewport" class="min-h-0 flex-1 bg-white"></div>
</template>
