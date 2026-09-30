import { computed, nextTick, ref } from 'vue'
import { errorMessage, openExternal } from '../lib/api'
import { folderLabel, projectRootPath, projectTitle } from '../lib/services'
import { type ProjectView } from '../types'
import { useNavigation } from './useNavigation'
import { useOverlays } from './useOverlays'
import { useProjects } from './useProjects'
import { useServiceActions } from './useServiceActions'

// The in-app browser. Its pages are native views owned by the main process, laid over the
// placeholder element the project page renders, so this keeps their bounds in sync.

const { activeSection, projectPanelMode, selectedGroupKey } = useNavigation()
const { overlayOpen } = useOverlays()
const { error } = useProjects()
const { projectUrl } = useServiceActions()

const browserState = ref<BrowserState>({ activeTabId: null, visible: false, tabs: [] })
const browserAddress = ref('')
const browserAddressEditing = ref(false)
// The placeholder element the native view covers.
const browserViewport = ref<HTMLElement | null>(null)
let resizeObserver: ResizeObserver | undefined
let stopStateListener: (() => void) | undefined

const activeBrowserTab = computed(() =>
  browserState.value.tabs.find((tab) => tab.id === browserState.value.activeTabId) ?? null
)

function applyBrowserState(state?: BrowserState | null) {
  if (!state) return
  browserState.value = state
  if (!browserAddressEditing.value) {
    browserAddress.value = state.tabs.find((tab) => tab.id === state.activeTabId)?.url ?? ''
  }
}

async function syncBrowserBounds() {
  if (activeSection.value !== 'projects' || projectPanelMode.value !== 'browser' || !browserViewport.value) return
  if (overlayOpen.value) return
  const rect = browserViewport.value.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return
  applyBrowserState(await window.vibe?.browser?.setBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }))
}

function observeBrowserViewport() {
  resizeObserver?.disconnect()
  if (!browserViewport.value) return
  resizeObserver = new ResizeObserver(() => syncBrowserBounds())
  resizeObserver.observe(browserViewport.value)
  syncBrowserBounds()
}

async function browserAction(action: string, payload?: Record<string, unknown>) {
  applyBrowserState(await window.vibe?.browser?.action(action, payload))
  if (['new', 'activate', 'attach'].includes(action) && projectPanelMode.value === 'browser') {
    await nextTick()
    observeBrowserViewport()
  }
}

async function openInAppBrowser(item: ProjectView) {
  const url = projectUrl(item)
  if (!url || !window.vibe?.browser) return
  activeSection.value = 'projects'
  projectPanelMode.value = 'browser'
  const projectName = folderLabel(projectRootPath(item))
  const serviceName = projectTitle(item)
  const title = projectName === serviceName ? serviceName : `${projectName} · ${serviceName}`
  applyBrowserState(await window.vibe.browser.open(url, { title }))
  await nextTick()
  observeBrowserViewport()
}

// Links in log lines: local URLs open in the in-app browser, others in the default browser.
async function openLogUrl(url: string) {
  try {
    const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[\w.-]+\.localhost)(:\d+)?(\/|$)/i.test(url)
    if (local && window.vibe?.browser) {
      activeSection.value = 'projects'
      projectPanelMode.value = 'browser'
      applyBrowserState(await window.vibe.browser.open(url, { title: url }))
      await nextTick()
      observeBrowserViewport()
    } else {
      await openExternal(url)
    }
  } catch (err) {
    error.value = errorMessage(err, 'Unable to open the link')
  }
}

async function activateBrowserTab(id: string) {
  activeSection.value = 'projects'
  projectPanelMode.value = 'browser'
  await browserAction('activate', { id })
  await nextTick()
  observeBrowserViewport()
}

async function closeBrowserTab(id: string) {
  await browserAction('close', { id })
  if (!browserState.value.tabs.length) {
    projectPanelMode.value = 'logs'
  }
}

async function navigateBrowser() {
  const value = browserAddress.value.trim()
  if (!value) return
  // Leave the field so later tab updates show the resolved URL instead of being ignored.
  ;(document.activeElement as HTMLElement | null)?.blur()
  browserAddressEditing.value = false
  await browserAction('navigate', { url: value })
}

async function toggleBrowserAttachment() {
  const tab = activeBrowserTab.value
  if (!tab) return
  await browserAction(tab.detached ? 'attach' : 'detach', { id: tab.id })
  if (tab.detached) {
    await nextTick()
    observeBrowserViewport()
  }
}

// Shows the native view only while the project's Browser tab is visible and nothing covers it.
async function updateBrowserVisibility() {
  const visible = activeSection.value === 'projects' && projectPanelMode.value === 'browser' && !!selectedGroupKey.value &&
    !activeBrowserTab.value?.detached && !overlayOpen.value
  if (visible) {
    await nextTick()
    observeBrowserViewport()
    return
  }
  resizeObserver?.disconnect()
  applyBrowserState(await window.vibe?.browser?.hide())
}

async function connectBrowser() {
  if (!window.vibe?.browser) return
  applyBrowserState(await window.vibe.browser.getState())
  stopStateListener = window.vibe.browser.onState(applyBrowserState)
  await window.vibe.browser.hide()
}

function disconnectBrowser() {
  resizeObserver?.disconnect()
  stopStateListener?.()
  window.vibe?.browser?.hide()
}

export function useBrowserTabs() {
  return {
    browserState,
    browserAddress,
    browserAddressEditing,
    browserViewport,
    activeBrowserTab,
    syncBrowserBounds,
    browserAction,
    openInAppBrowser,
    openLogUrl,
    activateBrowserTab,
    closeBrowserTab,
    navigateBrowser,
    toggleBrowserAttachment,
    updateBrowserVisibility,
    connectBrowser,
    disconnectBrowser
  }
}
