<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import multipriseIconUrl from './assets/multiprise-icon.svg'

type ProjectKind = 'command' | 'docker_compose'
type ProcessPhase = 'stopped' | 'starting' | 'ready' | 'failed'
type CommandSource = 'auto' | 'user'
type Framework = 'vite' | 'next' | 'nuxt' | 'nest' | 'node' | 'cargo' | 'docker' | 'unknown'

type Project = {
  id: string
  name: string
  path: string
  root_path?: string
  tags: string[]
  command?: string | null
  command_source?: CommandSource
  package_manager?: string | null
  install_root?: string | null
  framework?: Framework
  stop_command?: string | null
  port?: number | null
  kind: ProjectKind
  role?: 'backend' | 'frontend' | 'service'
  docker_running?: boolean
  docker_started_at?: string | null
  last_exit_code?: number | null
  last_exit_at?: string | null
  last_error?: string | null
  created_at: string
}

type ProcessStatus = {
  phase: ProcessPhase
  running: boolean
  ready: boolean
  pid?: number | null
  started_at?: string | null
  ready_at?: string | null
  error?: string | null
  exit_code?: number | null
}

type ProjectView = {
  project: Project
  status: ProcessStatus
}

type DetectResponse = {
  scripts: Record<string, string>
  suggested_command?: string | null
  suggested_script?: string | null
  package_manager?: string | null
  package_root?: string | null
  framework: Framework
  has_docker_compose: boolean
}

type LogLine = {
  timestamp: string
  stream: 'stdout' | 'stderr'
  line: string
}

type Settings = {
  auto_port: boolean
  auto_install: boolean
  port_base: number
  startup_timeout_ms: number
  scan_depth: number
  scan_ignore: string[]
  theme: ThemeKey
}

type ScanResult = {
  path: string
  name: string
  scripts: Record<string, string>
  suggested_command?: string | null
  framework?: Framework
  has_docker_compose: boolean
}

type ServicePreview = {
  name: string
  role?: 'backend' | 'frontend' | 'service'
  cwd?: string
  start?: string
  source?: 'package.json' | 'Cargo.toml' | 'compose'
  framework?: Framework
}

type ProjectPreview = {
  path: string
  name: string
  has_services: boolean
  error?: string | null
  services?: ServicePreview[]
}

type RecentProject = ScanResult & {
  last_seen?: string
}

type ProcessSource = 'managed' | 'docker' | 'external' | 'none'

type ProcessInstance = {
  pid: number
  port?: number | null
  command?: string | null
  source: ProcessSource
  cwd?: string | null
  reason?: 'assigned-port' | 'startup-conflict'
}

type UsedPort = {
  port: number
  project_id?: string | null
  project_name?: string | null
  project_path?: string | null
  source: ProcessSource
  pid?: number | null
  command?: string | null
}

type ServiceRole = 'backend' | 'frontend' | 'service'

type Group<T> = {
  key: string
  name: string
  path: string
  items: T[]
}

type ThemeKey = 'light' | 'dark'

type ThemeTokens = {
  appBg: string
  sidebarBg: string
  panelBg: string
  panelProject: string
  panelMuted: string
  border: string
  text: string
  textMuted: string
  textSubtle: string
  textStrong: string
  primary: string
  primaryHover: string
  primaryText: string
  ghostBg: string
  ghostHover: string
  ghostText: string
  tagBg: string
  tagBorder: string
  tagText: string
  chipBg: string
  chipBorder: string
  chipText: string
  chipActiveBg: string
  chipActiveBorder: string
  chipActiveText: string
  inputBg: string
  inputBorder: string
  inputText: string
  inputPlaceholder: string
  logBg: string
  logBorder: string
  statusBg: string
  statusBorder: string
  live: string
  successBg: string
  successBorder: string
  successText: string
  warningBg: string
  warningBorder: string
  warningText: string
  dangerBg: string
  dangerHover: string
  dangerText: string
  highlightBg: string
  highlightText: string
  hover: string
  selection: string
  toggleBg: string
  toggleBorder: string
  toggleActive: string
  toggleThumb: string
  spinner: string
  logBackend: string
  logFrontend: string
  logService: string
  logDefault: string
  logError: string
  logWarning: string
  logSuccess: string
  electric: string
  electricHot: string
  circuit: string
}

const projects = ref<ProjectView[]>([])
const loading = ref(false)
const hasLoadedOnce = ref(false)
const error = ref('')
const backendStatus = ref<'unknown' | 'online' | 'offline'>('unknown')
const apiBase = ref('')
const apiToken = ref('')
const apiError = ref('')

async function ensureApiBase() {
  if (apiBase.value) return apiBase.value
  try {
    const health = await window.vibe?.backendHealth?.()
    if (health?.url) {
      apiToken.value = health.token ?? ''
      apiBase.value = health.url
    }
  } catch (err) {
    apiError.value = err instanceof Error ? err.message : String(err)
  }
  return apiBase.value
}

async function apiFetch(path: string, options?: RequestInit) {
  const base = await ensureApiBase()
  if (!base) {
    throw new Error('Backend not available')
  }
  const url = `${base}${path}`
  const headers = new Headers(options?.headers)
  if (apiToken.value) headers.set('x-multiprise-token', apiToken.value)
  return fetch(url, { ...options, headers })
}

async function openExternal(url: string) {
  if (!window.vibe?.openExternal) {
    throw new Error('System browser integration is unavailable.')
  }
  await window.vibe.openExternal(url)
}


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

async function browserAction(action: string, payload?: Record<string, unknown>) {
  const state = await window.vibe?.browser?.action(action, payload)
  applyBrowserState(state)
  if (['new', 'activate', 'attach'].includes(action) && projectPanelMode.value === 'browser') {
    await nextTick()
    observeBrowserViewport()
  }
}

async function syncBrowserBounds() {
  if (activeSection.value !== 'projects' || projectPanelMode.value !== 'browser' || !browserViewportRef.value) return
  if (overlayOpen.value) return
  const rect = browserViewportRef.value.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return
  const state = await window.vibe?.browser?.setBounds({
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  })
  applyBrowserState(state)
}

function observeBrowserViewport() {
  browserResizeObserver?.disconnect()
  if (!browserViewportRef.value) return
  browserResizeObserver = new ResizeObserver(() => syncBrowserBounds())
  browserResizeObserver.observe(browserViewportRef.value)
  syncBrowserBounds()
}

async function openInAppBrowser(item: ProjectView) {
  const url = projectUrl(item)
  if (!url || !window.vibe?.browser) return
  activeSection.value = 'projects'
  projectPanelMode.value = 'browser'
  const projectName = folderLabel(projectRootPath(item))
  const serviceName = projectTitle(item)
  const title = projectName === serviceName ? serviceName : `${projectName} · ${serviceName}`
  const state = await window.vibe.browser.open(url, { title })
  applyBrowserState(state)
  await nextTick()
  observeBrowserViewport()
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



const detected = reactive<Record<string, DetectResponse>>({})
const logs = reactive<Record<string, LogLine[]>>({})
const actionState = reactive<Record<string, { command: string; port: string }>>({})
const actionCommandDirty = reactive<Record<string, boolean>>({})
const logFilter = ref('')
const logRoleFilter = ref<'all' | 'backend' | 'frontend'>('all')
const logLevelFilter = ref<'all' | 'errors' | 'warnings'>('all')
const logsScrollRef = ref<HTMLElement | null>(null)
const logsPinnedToBottom = ref(true)
const actionDetailsOpen = reactive<Record<string, boolean>>({})
const actionErrors = reactive<Record<string, string>>({})
const actionErrorTimers: Record<string, number> = {}
const vscodeErrors = reactive<Record<string, string>>({})
const vscodeErrorTimers: Record<string, number> = {}
const groupActionLoading = reactive<Record<string, 'launch' | 'stop' | 'delete' | null>>({})
const copiedServiceUrlId = ref<string | null>(null)
let copiedServiceUrlTimer: number | undefined
const logsRefreshing = ref(false)
const addingProjects = ref(false)
const importLoading = reactive<Record<string, boolean>>({})

const themes: Record<ThemeKey, ThemeTokens> = {
  light: {
    appBg: '#F3F4F6', sidebarBg: '#FAFAFA', panelBg: '#FFFFFF', panelProject: '#F7F7F8', panelMuted: '#ECEDEF', border: '#DFE1E5',
    text: '#3F4045', textMuted: '#686A71', textSubtle: '#92949C', textStrong: '#242529',
    primary: '#EA580C', primaryHover: '#C2410C', primaryText: '#FFFFFF',
    ghostBg: '#FFFFFF', ghostHover: '#F0F1F3', ghostText: '#303136',
    tagBg: '#F0F1F3', tagBorder: '#DDDFE3', tagText: '#55575E',
    chipBg: '#EDEEF0', chipBorder: '#DADCE1', chipText: '#55575E', chipActiveBg: '#FFFFFF', chipActiveBorder: '#EA580C', chipActiveText: '#7C2D12',
    inputBg: '#FFFFFF', inputBorder: '#D5D7DC', inputText: '#292A2E', inputPlaceholder: '#95979E',
    logBg: '#29292D', logBorder: '#454545', statusBg: '#A7A9B0', statusBorder: '#878990', live: '#EA580C',
    successBg: '#E5EBE3', successBorder: '#B5C3B0', successText: '#50634C',
    warningBg: '#F1E6DC', warningBorder: '#D0B295', warningText: '#815E3E',
    dangerBg: '#EEE0DE', dangerHover: '#E5D3D0', dangerText: '#7E4F49',
    highlightBg: '#FFFFFF', highlightText: '#242529', hover: '#F0F1F3', selection: '#ECEDEF',
    toggleBg: '#D9DBDF', toggleBorder: '#C4C6CC', toggleActive: '#EA580C', toggleThumb: '#FFFFFF', spinner: '#EA580C',
    logBackend: '#F3A36B', logFrontend: '#8ABCB2', logService: '#B4A8CC', logDefault: '#E8E8E5', logError: '#E49A90', logWarning: '#E5B96F', logSuccess: '#98C0A2',
    electric: '#EA580C', electricHot: '#F97316', circuit: 'rgba(38, 39, 43, 0.018)'
  },
  dark: {
    appBg: '#151515', sidebarBg: '#232323', panelBg: '#272727', panelProject: '#1C1C1C', panelMuted: '#303030', border: '#3D3D3D',
    text: '#E5E5E5', textMuted: '#A3A3A3', textSubtle: '#737373', textStrong: '#FAFAFA',
    primary: '#F97316', primaryHover: '#FB923C', primaryText: '#FFFFFF',
    ghostBg: '#353535', ghostHover: '#414141', ghostText: '#F5F5F5',
    tagBg: '#303030', tagBorder: '#454545', tagText: '#D4D4D4',
    chipBg: '#303030', chipBorder: '#454545', chipText: '#D4D4D4', chipActiveBg: '#3A3A3A', chipActiveBorder: '#F97316', chipActiveText: '#FFFFFF',
    inputBg: '#1E1E1E', inputBorder: '#454545', inputText: '#FAFAFA', inputPlaceholder: '#737373',
    logBg: '#181818', logBorder: '#454545', statusBg: '#525252', statusBorder: '#666666', live: '#F97316',
    successBg: '#25342A', successBorder: '#46634F', successText: '#A7D2B0',
    warningBg: '#392E25', warningBorder: '#72533A', warningText: '#E2B78F',
    dangerBg: '#402A2A', dangerHover: '#523434', dangerText: '#E7A7A0',
    highlightBg: '#1E1E1E', highlightText: '#FAFAFA', hover: '#303030', selection: '#343434',
    toggleBg: '#414141', toggleBorder: '#555555', toggleActive: '#F97316', toggleThumb: '#FFFFFF', spinner: '#FB923C',
    logBackend: '#F3A36B', logFrontend: '#8ABCB2', logService: '#B4A8CC', logDefault: '#E8E8E5', logError: '#E49A90', logWarning: '#E5B96F', logSuccess: '#98C0A2',
    electric: '#F97316', electricHot: '#FB923C', circuit: 'rgba(255, 255, 255, 0.018)'
  }
}

function normalizeTheme(value?: string | null): ThemeKey {
  return value === 'dark' ? 'dark' : 'light'
}

const panelClass = 'rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)]'
const panelProjectClass = 'bg-[var(--panel-project)]'
const btnBase =
  'inline-flex items-center gap-2 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-40'
const btnSm = 'px-4 py-2.5 text-sm'
const btnXs = 'px-3 py-1.5 text-xs'
const btnSmText = 'px-3 py-1.5 text-sm'
const btnGhost = `${btnBase} ${btnSm} bg-[var(--ghost-bg)] text-[var(--ghost-text)] hover:bg-[var(--ghost-hover)]`
const btnGhostXs = `${btnBase} ${btnXs} bg-[var(--ghost-bg)] text-[var(--ghost-text)] hover:bg-[var(--ghost-hover)]`
const btnPrimary = `${btnBase} ${btnSm} bg-[var(--primary)] text-[var(--primary-text)] hover:bg-[var(--primary-hover)]`
const btnPrimaryXs = `${btnBase} ${btnXs} bg-[var(--primary)] text-[var(--primary-text)] hover:bg-[var(--primary-hover)]`
const btnPrimarySm = `${btnBase} ${btnSmText} bg-[var(--primary)] text-[var(--primary-text)] hover:bg-[var(--primary-hover)]`
const btnDangerSm = `${btnBase} ${btnSmText} bg-[var(--danger-bg)] text-[var(--danger-text)] hover:bg-[var(--danger-hover)]`
const btnBlueXs = `${btnBase} ${btnXs} bg-[var(--text-strong)] text-[var(--app-bg)] hover:bg-[var(--text)]`
const btnPanelPrimary =
  `${btnBase} h-8 px-3 text-sm bg-[var(--primary)] text-[var(--primary-text)] hover:bg-[var(--primary-hover)]`
const btnPanelPrimaryLg =
  `${btnBase} h-11 min-w-[128px] justify-center px-5 text-sm bg-[var(--primary)] text-[var(--primary-text)] hover:bg-[var(--primary-hover)]`
const btnPanelSecondary =
  `${btnBase} h-8 px-3 text-sm bg-[var(--ghost-bg)] text-[var(--ghost-text)] shadow-[0_1px_2px_rgba(24,24,27,0.12)] hover:bg-[var(--ghost-hover)]`
const btnUnplug =
  btnBase + ' h-8 bg-[#353538] px-3 text-sm text-white hover:bg-[#252525]'
const btnUnplugLg =
  btnBase + ' h-11 min-w-[128px] justify-center bg-[#353538] px-5 text-sm text-white hover:bg-[#252525]'
const btnPanelTertiary =
  `${btnBase} h-8 px-3 text-sm bg-transparent text-[var(--text-muted)] hover:bg-[var(--hover)]`
const btnPanelIcon =
  `${btnBase} h-8 w-8 justify-center p-0 bg-[var(--ghost-bg)] text-[var(--ghost-text)] hover:bg-[var(--ghost-hover)]`
const chipBase =
  'inline-flex items-center rounded-full border border-[var(--chip-border)] bg-[var(--chip-bg)] px-3 py-1 text-xs font-medium text-[var(--chip-text)]'
const chipActive =
  'border-2 border-[var(--text-strong)] bg-[var(--chip-active-bg)] text-[var(--chip-active-text)]'
const statusDot = 'inline-flex h-2.5 w-2.5 shrink-0 rounded-full border border-[var(--status-border)] bg-[var(--status-bg)]'
// "!" so these win over statusDot's idle colours regardless of generated CSS order.
const statusDotLive = '!border-[var(--live)] !bg-[var(--live)]'
const statusDotFailed = '!border-[var(--log-error)] !bg-[var(--log-error)]'
const inputBase =
  'w-full rounded-xl border border-[var(--input-border)] bg-[var(--input-bg)] px-3 py-2 text-sm text-[var(--input-text)] placeholder:text-[var(--input-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]'
const noScrollbar =
  '[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
const spinnerClass =
  'inline-flex h-4 w-4 animate-spin rounded-full border-2 border-[var(--spinner)] border-t-transparent'
const toggleBase = 'relative inline-flex h-4 w-7 items-center'
const toggleTrack =
  'h-4 w-7 rounded-full border border-[var(--toggle-border)] bg-[var(--toggle-bg)] transition peer-checked:bg-[var(--toggle-active)]'
const toggleThumb =
  'pointer-events-none absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-[var(--toggle-thumb)] transition-transform peer-checked:translate-x-3'

const selectedGroupKey = ref<string | null>(null)
const sidebarCollapsed = ref(false)
const projectSearch = ref('')
const editingId = ref<string | null>(null)
const editingName = ref('')

const pickerOpen = ref(false)
const selectedFolders = ref<string[]>([])
const scanLoading = ref(false)
const scanResults = ref<ScanResult[]>([])
const recentProjects = ref<RecentProject[]>([])
const scanSelection = reactive<Record<string, boolean>>({})
const scanId = ref<string | null>(null)
const scanStatus = ref<'idle' | 'running' | 'done' | 'stopped'>('idle')
let scanTimer: number | undefined

const faviconFailed = reactive<Record<string, boolean>>({})
const projectPreviewMap = reactive<Record<string, ProjectPreview>>({})
const processInstances = reactive<Record<string, ProcessInstance[]>>({})
const instancesLoading = ref(false)
const actionLoading = reactive<Record<string, boolean>>({})
const usedPorts = ref<UsedPort[]>([])
const portsLoading = ref(false)
const portsRefreshing = ref(false)
const portsError = ref('')
const groupMenuOpen = ref(false)
const groupMenuX = ref(0)
const groupMenuY = ref(0)
const groupMenuGroup = ref<Group<ProjectView> | null>(null)
const externalMenuOpen = reactive<Record<string, boolean>>({})

const settings = reactive<Settings>({
  auto_port: true,
  auto_install: true,
  port_base: 3000,
  startup_timeout_ms: 20000,
  scan_depth: 8,
  scan_ignore: [],
  theme: 'light',
})
const settingsDraft = reactive<Settings>({
  auto_port: true,
  auto_install: true,
  port_base: 3000,
  startup_timeout_ms: 20000,
  scan_depth: 8,
  scan_ignore: [],
  theme: 'light',
})
const settingsSaving = ref(false)
const settingsLoaded = ref(false)
const scanIgnoreDraft = ref('')
const saveFeedback = ref<'saved' | 'noop' | 'error' | ''>('')
let saveFeedbackTimer: number | undefined

const activeTheme = computed<ThemeKey>(() => activeSection.value === 'settings' ? settingsDraft.theme : settings.theme)
const themeTokens = computed(() => themes[activeTheme.value])

function createThemeStyle(tokens: ThemeTokens, colorScheme: ThemeKey): Record<string, string> {
  return ({
      '--app-bg': tokens.appBg,
      '--sidebar-bg': tokens.sidebarBg,
      '--panel-bg': tokens.panelBg,
      '--panel-project': tokens.panelProject,
      '--panel-muted': tokens.panelMuted,
      '--border': tokens.border,
      '--text': tokens.text,
      '--text-muted': tokens.textMuted,
      '--text-subtle': tokens.textSubtle,
      '--text-strong': tokens.textStrong,
      '--primary': tokens.primary,
      '--primary-hover': tokens.primaryHover,
      '--primary-text': tokens.primaryText,
      '--ghost-bg': tokens.ghostBg,
      '--ghost-hover': tokens.ghostHover,
      '--ghost-text': tokens.ghostText,
      '--tag-bg': tokens.tagBg,
      '--tag-border': tokens.tagBorder,
      '--tag-text': tokens.tagText,
      '--chip-bg': tokens.chipBg,
      '--chip-border': tokens.chipBorder,
      '--chip-text': tokens.chipText,
      '--chip-active-bg': tokens.chipActiveBg,
      '--chip-active-border': tokens.chipActiveBorder,
      '--chip-active-text': tokens.chipActiveText,
      '--input-bg': tokens.inputBg,
      '--input-border': tokens.inputBorder,
      '--input-text': tokens.inputText,
      '--input-placeholder': tokens.inputPlaceholder,
      '--log-bg': tokens.logBg,
      '--log-border': tokens.logBorder,
      '--status-bg': tokens.statusBg,
      '--status-border': tokens.statusBorder,
      '--live': tokens.live,
      '--success-bg': tokens.successBg,
      '--success-border': tokens.successBorder,
      '--success-text': tokens.successText,
      '--warning-bg': tokens.warningBg,
      '--warning-border': tokens.warningBorder,
      '--warning-text': tokens.warningText,
      '--danger-bg': tokens.dangerBg,
      '--danger-hover': tokens.dangerHover,
      '--danger-text': tokens.dangerText,
      '--highlight-bg': tokens.highlightBg,
      '--highlight-text': tokens.highlightText,
      '--hover': tokens.hover,
      '--selection': tokens.selection,
      '--toggle-bg': tokens.toggleBg,
      '--toggle-border': tokens.toggleBorder,
      '--toggle-active': tokens.toggleActive,
      '--toggle-thumb': tokens.toggleThumb,
      '--spinner': tokens.spinner,
      '--log-backend': tokens.logBackend,
      '--log-frontend': tokens.logFrontend,
      '--log-service': tokens.logService,
      '--log-default': tokens.logDefault,
      '--log-error': tokens.logError,
      '--log-warning': tokens.logWarning,
      '--log-success': tokens.logSuccess,
      '--electric': tokens.electric,
      '--electric-hot': tokens.electricHot,
      '--circuit': tokens.circuit,
      'color-scheme': colorScheme
    }) as Record<string, string>
}

const themeStyle = computed(() => createThemeStyle(themeTokens.value, activeTheme.value))
const sidebarThemeStyle = computed(() => {
  const isDark = activeTheme.value === 'dark'
  return {
    ...createThemeStyle(themeTokens.value, activeTheme.value),
    '--sidebar-bg': isDark ? '#242424' : '#EEEDE9',
    '--border': isDark ? '#3A3A3A' : '#D8D5CE',
    '--panel-bg': isDark ? '#303030' : '#F8F7F4',
    '--panel-muted': isDark ? '#343434' : '#E3E1DC',
    '--input-bg': isDark ? '#1E1E1E' : '#FAF9F6',
    '--input-border': isDark ? '#444444' : '#D2CFC8',
    '--hover': isDark ? '#313131' : '#E4E1DB',
    '--selection': isDark ? '#373737' : '#DDD9D1'
  }
})

const refreshMs = 2000
const telemetryRefreshMs = 750
const portsRefreshMs = 2000
let refreshTimer: number | undefined
let telemetryTimer: number | undefined
let lastPortsRefreshAt = 0
const documentVisible = ref(!document.hidden)
const SETTINGS_STORAGE_KEY = 'multiprise_settings'
const SELECTED_GROUP_STORAGE_KEY = 'multiprise_selected_group'
const NAVIGATION_SESSION_KEY = 'multiprise_navigation_session'
const RECENT_SCAN_STORAGE_KEY = 'multiprise_recent_scan'
const RECENT_GROUPS_STORAGE_KEY = 'multiprise_recent_groups'
const SERVICE_SPLIT_STORAGE_KEY = 'multiprise_service_split_ratio'

const servicesPaneCollapsed = ref(false)
const serviceSplitRatio = ref(0.38)
const splitContainerWidth = ref(0)
const projectSplitRef = ref<HTMLElement | null>(null)
let projectSplitResizeObserver: ResizeObserver | undefined
let splitDragging = false

function constrainedServiceWidth(totalWidth: number) {
  const dividerWidth = 10
  const available = Math.max(0, totalWidth - dividerWidth)
  const minimumServices = Math.min(280, available * 0.42)
  const minimumFocus = Math.min(480, Math.max(0, available - minimumServices))
  const maximumServices = Math.max(minimumServices, available - minimumFocus)
  return Math.min(maximumServices, Math.max(minimumServices, available * serviceSplitRatio.value))
}

const projectSplitStyle = computed(() => {
  if (servicesPaneCollapsed.value) {
    return { gridTemplateColumns: '0px 0px minmax(0, 1fr)' }
  }
  const width = splitContainerWidth.value || 1000
  return { gridTemplateColumns: `${Math.round(constrainedServiceWidth(width))}px 10px minmax(0, 1fr)` }
})

function saveServiceSplitRatio() {
  try {
    localStorage.setItem(SERVICE_SPLIT_STORAGE_KEY, String(serviceSplitRatio.value))
  } catch (err) {
    // Layout persistence is optional.
  }
}

function loadServiceSplitRatio() {
  try {
    const stored = Number(localStorage.getItem(SERVICE_SPLIT_STORAGE_KEY))
    if (Number.isFinite(stored) && stored >= 0.2 && stored <= 0.7) {
      serviceSplitRatio.value = stored
    }
  } catch (err) {
    // Use the default split when storage is unavailable.
  }
}

function updateProjectSplitWidth() {
  splitContainerWidth.value = projectSplitRef.value?.getBoundingClientRect().width ?? 0
}

function observeProjectSplit() {
  projectSplitResizeObserver?.disconnect()
  if (!projectSplitRef.value) return
  updateProjectSplitWidth()
  projectSplitResizeObserver = new ResizeObserver(updateProjectSplitWidth)
  projectSplitResizeObserver.observe(projectSplitRef.value)
}

function handleServiceResize(event: PointerEvent) {
  if (!splitDragging || !projectSplitRef.value) return
  const rect = projectSplitRef.value.getBoundingClientRect()
  if (rect.width <= 0) return
  const requested = Math.max(0, event.clientX - rect.left)
  const dividerWidth = 10
  const available = Math.max(1, rect.width - dividerWidth)
  const minimumServices = Math.min(280, available * 0.42)
  const minimumFocus = Math.min(480, Math.max(0, available - minimumServices))
  const maximumServices = Math.max(minimumServices, available - minimumFocus)
  const width = Math.min(maximumServices, Math.max(minimumServices, requested))
  serviceSplitRatio.value = width / available
}

function stopServiceResize() {
  if (!splitDragging) return
  splitDragging = false
  document.body.classList.remove('resizing-project-panes')
  window.removeEventListener('pointermove', handleServiceResize)
  window.removeEventListener('pointerup', stopServiceResize)
  window.removeEventListener('pointercancel', stopServiceResize)
  saveServiceSplitRatio()
  syncBrowserBounds()
}

function startServiceResize(event: PointerEvent) {
  if (servicesPaneCollapsed.value) return
  event.preventDefault()
  splitDragging = true
  document.body.classList.add('resizing-project-panes')
  window.addEventListener('pointermove', handleServiceResize)
  window.addEventListener('pointerup', stopServiceResize)
  window.addEventListener('pointercancel', stopServiceResize)
}

function resetServiceSplit() {
  serviceSplitRatio.value = 0.38
  saveServiceSplitRatio()
}

async function toggleServicesPane() {
  servicesPaneCollapsed.value = !servicesPaneCollapsed.value
  await nextTick()
  updateProjectSplitWidth()
  syncBrowserBounds()
}

const folderGroups = computed(() => groupByFolder(projects.value, (item) => projectRootPath(item)))
const recentGroupKeys = ref<string[]>([])
// Home illustration: one lit socket per running service, up to the four drawn.
const homeLiveSockets = computed(() => Math.min(4, projects.value.filter((item) => serviceReady(item)).length))

const homeProjectGroups = computed(() => {
  const byKey = new Map(folderGroups.value.map((group) => [group.key, group]))
  const ordered = recentGroupKeys.value
    .map((key) => byKey.get(key))
    .filter((group): group is Group<ProjectView> => !!group)
  const recentKeys = new Set(ordered.map((group) => group.key))

  for (const group of folderGroups.value) {
    if (!recentKeys.has(group.key)) ordered.push(group)
  }

  return ordered.slice(0, 5)
})
const filteredFolderGroups = computed(() => {
  const query = projectSearch.value.trim().toLowerCase()
  if (!query) return folderGroups.value
  return folderGroups.value.filter((group) =>
    `${group.name} ${group.path}`.toLowerCase().includes(query)
  )
})
const selectedGroup = computed(
  () => folderGroups.value.find((group) => group.key === selectedGroupKey.value) ?? null
)
const npmServices = computed(() =>
  selectedGroup.value ? selectedGroup.value.items.filter((item) => !isDockerService(item)) : []
)
const dockerServices = computed(() =>
  selectedGroup.value ? selectedGroup.value.items.filter((item) => isDockerService(item)) : []
)
const activeSection = ref<'home' | 'projects' | 'settings'>('home')
const projectPanelMode = ref<'logs' | 'browser'>('logs')
const restoreProjectOnLoad = ref(false)
const browserState = ref<BrowserState>({ activeTabId: null, visible: false, tabs: [] })
const browserAddress = ref('')
const browserAddressEditing = ref(false)
const browserViewportRef = ref<HTMLElement | null>(null)
let browserResizeObserver: ResizeObserver | undefined
let stopBrowserStateListener: (() => void) | undefined
const scanGroups = computed(() => groupByFolder(scanResults.value, (item) => item.path))
const showResultsPanel = computed(() => scanStatus.value !== 'idle')
const recentImportable = computed(() =>
  recentProjects.value
    .filter(
      (recent) =>
        !projects.value.some(
          (project) => normalizePath(projectRootPath(project)) === normalizePath(recent.path)
        )
    )
    .slice(0, 3)
)
const validSelectedFolders = computed(() =>
  selectedFolders.value.filter((path) => projectPreviewMap[path]?.has_services)
)
const projectsExpanded = ref(true)
const activePortsExpanded = ref(true)

type ManualPortTarget =
  | { kind: 'service'; serviceId: string }
  | { kind: 'group'; groupKey: string }

const manualPortTarget = ref<ManualPortTarget | null>(null)
const manualPortInputs = reactive<Record<string, string>>({})
const manualPortError = ref('')

const manualPortServices = computed(() => {
  const target = manualPortTarget.value
  if (!target) return []
  if (target.kind === 'service') {
    const service = projects.value.find((item) => item.project.id === target.serviceId)
    return service ? [service] : []
  }
  const group = folderGroups.value.find((item) => item.key === target.groupKey)
  return group?.items.filter((item) => !isDockerService(item) && !item.status.running) ?? []
})

const manualPortsValid = computed(() => {
  const values = manualPortServices.value.map((service) => parsePort(manualPortInputs[service.project.id] ?? ''))
  if (!values.length || values.some((port) => !port || port < 1 || port > 65535)) return false
  return new Set(values).size === values.length
})

function ensureActionState(project: ProjectView) {
  const id = project.project.id
  if (!actionState[id]) {
    actionState[id] = {
      command: project.project.command ?? detected[id]?.suggested_command ?? '',
      port: project.project.port ? String(project.project.port) : '',
    }
  }
  return actionState[id]
}

function syncActionDefaults() {
  projects.value.forEach((project) => {
    const state = ensureActionState(project)
    if (!actionCommandDirty[project.project.id]) {
      state.command = project.project.command ?? detected[project.project.id]?.suggested_command ?? ''
    }
  })
}

function serviceReady(service: ProjectView) {
  return service.status.phase === 'ready' || (service.status.ready && service.status.running)
}

function serviceStarting(service: ProjectView) {
  return service.status.phase === 'starting'
}

function serviceFailed(service: ProjectView) {
  return service.status.phase === 'failed'
}

function serviceStatusLabel(service: ProjectView) {
  if (serviceStarting(service)) return 'Starting'
  if (serviceReady(service)) return 'Ready'
  if (serviceFailed(service)) return 'Failed'
  return 'Stopped'
}

function projectTitle(item: ProjectView) {
  return item.project.name || item.project.path.split('/').pop() || 'Untitled'
}

function projectRootPath(item: ProjectView) {
  return item.project.root_path ?? item.project.path
}

const projectPalette = [
  '#5B8FD9',
  '#A87767',
  '#6F9C93',
  '#8E83A6',
  '#718FAE',
  '#A97882',
  '#87976A',
  '#A87959'
]

function accentForValue(value: string) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0
  }
  return projectPalette[Math.abs(hash) % projectPalette.length]
}

function groupAccent(group: Group<ProjectView>) {
  return accentForValue(group.path || group.name)
}

function groupAccentStyle(group: Group<ProjectView>) {
  return { '--project-accent': groupAccent(group) } as Record<string, string>
}

function actionKey(action: string, id: string, extra?: string | number) {
  return extra === undefined ? `${action}:${id}` : `${action}:${id}:${extra}`
}

function isActionLoading(action: string, id: string, extra?: string | number) {
  return !!actionLoading[actionKey(action, id, extra)]
}

function setActionLoading(action: string, id: string, value: boolean, extra?: string | number) {
  actionLoading[actionKey(action, id, extra)] = value
}

function actionFor(item: ProjectView) {
  return ensureActionState(item)
}

function isActionDetailsOpen(service: ProjectView) {
  return actionDetailsOpen[service.project.id] ?? false
}

function toggleActionDetails(service: ProjectView) {
  actionDetailsOpen[service.project.id] = !isActionDetailsOpen(service)
}

function setActionError(id: string, message: string) {
  if (!message) return
  actionErrors[id] = message
  if (actionErrorTimers[id]) {
    window.clearTimeout(actionErrorTimers[id])
  }
  actionErrorTimers[id] = window.setTimeout(() => {
    delete actionErrors[id]
    delete actionErrorTimers[id]
  }, 4500)
}

function setVSCodeError(id: string, message: string) {
  if (!message) return
  vscodeErrors[id] = message
  if (vscodeErrorTimers[id]) {
    window.clearTimeout(vscodeErrorTimers[id])
  }
  vscodeErrorTimers[id] = window.setTimeout(() => {
    delete vscodeErrors[id]
    delete vscodeErrorTimers[id]
  }, 4500)
}

function parsePort(value: string) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function servicePort(service: ProjectView) {
  const state = actionFor(service)
  if (state.port.trim() === '') {
    return undefined
  }
  return parsePort(state.port)
}

function groupForService(service: ProjectView) {
  return folderGroups.value.find((entry) =>
    entry.items.some((item) => item.project.id === service.project.id)
  )
}

function buildEnvForService(service: ProjectView) {
  const group = groupForService(service)
  if (!group) return {}
  const backendService = group.items.find((item) => serviceRole(item) === 'backend')
  const frontendService = group.items.find((item) => serviceRole(item) === 'frontend')
  const backendPort = backendService ? linkedServicePort(backendService) : undefined
  const frontendPort = frontendService ? linkedServicePort(frontendService) : undefined
  const env: Record<string, string> = {}
  if (backendPort) {
    env.BACKEND_PORT = String(backendPort)
  }
  if (frontendPort) {
    env.FRONTEND_PORT = String(frontendPort)
  }
  return env
}

// The port a sibling service should be wired to: the one it is actually using when
// running; otherwise the typed port only matters in manual mode.
function linkedServicePort(item: ProjectView) {
  if (item.status.running && item.project.port) return item.project.port
  if (settings.auto_port) return item.project.port ?? undefined
  return servicePort(item) ?? item.project.port ?? undefined
}

function effectivePort(item: ProjectView) {
  if (item.project.port) {
    return item.project.port
  }
  const value = Number.parseInt(actionFor(item).port, 10)
  return Number.isFinite(value) ? value : null
}

function initials(name: string) {
  const cleaned = name.trim()
  if (!cleaned) return 'PR'
  const parts = cleaned.split(/[\s-_]+/).filter(Boolean)
  if (parts.length === 1) {
    const word = parts[0]
    return (word.slice(0, 2) || word.slice(0, 1)).toUpperCase()
  }
  const first = parts[0][0] ?? ''
  const second = parts[1][0] ?? ''
  return `${first}${second}`.toUpperCase()
}

function projectUrl(item: ProjectView) {
  const port = effectivePort(item)
  if (!port) return ''
  return `http://localhost:${port}`
}

async function openProjectUrl(item: ProjectView) {
  const url = projectUrl(item)
  if (!url) return
  try {
    await openExternal(url)
  } catch (err) {
    setActionError(item.project.id, err instanceof Error ? err.message : 'Unable to open link')
  }
}

async function copyProjectUrl(item: ProjectView) {
  const url = projectUrl(item)
  if (!url) return
  try {
    if (!window.vibe?.copyText) throw new Error('Clipboard integration is unavailable.')
    await window.vibe.copyText(url)
    copiedServiceUrlId.value = item.project.id
    if (copiedServiceUrlTimer) window.clearTimeout(copiedServiceUrlTimer)
    copiedServiceUrlTimer = window.setTimeout(() => {
      copiedServiceUrlId.value = null
      copiedServiceUrlTimer = undefined
    }, 1600)
  } catch (err) {
    setActionError(item.project.id, 'Unable to copy link')
  }
}

async function openProjectInFinder(target: ProjectView) {
  const response = await apiFetch(`/api/projects/${target.project.id}/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: 'finder' }),
  })
  if (!response.ok) {
    await throwResponseError(response, 'Unable to open folder')
  }
}

async function openProjectInEditorOrFinder(group: Group<ProjectView>) {
  const target = group.items[0]
  if (!target) return
  try {
    const response = await apiFetch(`/api/projects/${target.project.id}/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'vscode' }),
    })
    if (response.ok) return
  } catch (err) {
    // fall through to finder
  }

  try {
    await openProjectInFinder(target)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to open folder'
    error.value = message
    setVSCodeError(target.project.id, message)
  }
}

function openPrimaryFrontend() {
  const target = primaryBrowserTarget.value
  if (!target) return
  openProjectUrl(target)
}

function openDetails(group: Group<ProjectView>) {
  rememberGroup(group.key)
  if (activeSection.value !== 'projects') {
    activeSection.value = 'projects'
  }
  selectedGroupKey.value = group.key
}

function goHome() {
  activeSection.value = 'home'
  selectedGroupKey.value = null
}

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
  if (sidebarCollapsed.value) {
    projectSearch.value = ''
  }
}

function toggleProjectsSection() {
  if (activeSection.value !== 'projects') {
    activeSection.value = 'projects'
    projectsExpanded.value = true
  } else {
    projectsExpanded.value = !projectsExpanded.value
  }
}

function toggleActivePortsSection() {
  activePortsExpanded.value = !activePortsExpanded.value
  if (activePortsExpanded.value) {
    fetchUsedPorts()
  }
}

function handleGroupClick(group: Group<ProjectView>) {
  openDetails(group)
}

function openGroupMenu(event: MouseEvent, group: Group<ProjectView>) {
  event.preventDefault()
  const menuWidth = 210
  const menuHeight = 120
  const padding = 12
  const maxX = window.innerWidth - menuWidth - padding
  const maxY = window.innerHeight - menuHeight - padding
  groupMenuX.value = Math.max(padding, Math.min(event.clientX, maxX))
  groupMenuY.value = Math.max(padding, Math.min(event.clientY, maxY))
  groupMenuGroup.value = group
  groupMenuOpen.value = true
}

function closeGroupMenu() {
  groupMenuOpen.value = false
}

function toggleExternalMenu(service: ProjectView) {
  const id = service.project.id
  externalMenuOpen[id] = !externalMenuOpen[id]
}

function closeExternalMenus() {
  Object.keys(externalMenuOpen).forEach((key) => {
    externalMenuOpen[key] = false
  })
}

function openGroupForService(service: ProjectView) {
  const group = folderGroups.value.find((entry) =>
    entry.items.some((item) => item.project.id === service.project.id)
  )
  if (group) {
    activeSection.value = 'projects'
    projectsExpanded.value = true
    selectedGroupKey.value = group.key
  }
}

function openGroupForUsedPort(item: UsedPort) {
  if (!item.project_id) return
  const group = folderGroups.value.find((entry) =>
    entry.items.some((project) => project.project.id === item.project_id)
  )
  if (!group) return
  activeSection.value = 'projects'
  projectsExpanded.value = true
  selectedGroupKey.value = group.key
}

function usedPortProjectName(item: UsedPort) {
  const matchedProject = item.project_id
    ? projects.value.find((project) => project.project.id === item.project_id)
    : undefined
  const pathForName = matchedProject ? projectRootPath(matchedProject) : item.project_path
  if (pathForName) {
    const derived = deriveProjectNameFromPath(pathForName)
    if (derived) return derived
  }
  if (item.project_id) {
    if (matchedProject) {
      const name = projectTitle(matchedProject).trim()
      if (name) return name
    }
    const group = folderGroups.value.find((entry) =>
      entry.items.some((project) => project.project.id === item.project_id)
    )
    if (group) return group.name
  }
  if (item.project_name && item.project_name.trim()) return item.project_name
  if (item.project_path) {
    const normalized = normalizePath(item.project_path)
    const direct = projects.value.find(
      (project) => normalizePath(projectRootPath(project)) === normalized
    )
    if (direct) return projectTitle(direct)
    const group = folderGroups.value.find((entry) => normalized.startsWith(normalizePath(entry.path)))
    if (group) return group.name
    const parts = item.project_path.split('/').filter(Boolean)
    return parts[parts.length - 1] ?? item.project_path
  }
  return 'External'
}

function usedPortProjectDetail(item: UsedPort) {
  if (item.project_id) {
    const match = projects.value.find((project) => project.project.id === item.project_id)
    if (match) return projectRootPath(match)
  }
  if (item.project_path) return item.project_path
  return ''
}

function deriveProjectNameFromPath(path: string) {
  const normalized = normalizePath(path)
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length === 0) return ''
  const last = parts[parts.length - 1]
  if (last === 'backend' || last === 'frontend') {
    return parts[parts.length - 2] ?? last
  }
  return last
}

function usedPortTitle(item: UsedPort) {
  const name = usedPortProjectName(item)
  const detail = usedPortProjectDetail(item)
  return detail ? `${name} — ${detail}` : name
}

function closeDetails() {
  selectedGroupKey.value = null
  editingId.value = null
}

function normalizePath(path: string) {
  if (path.length > 1 && path.endsWith('/')) {
    return path.replace(/\/+$/, '')
  }
  return path
}

function loadRecentProjectsFromStorage() {
  try {
    const raw = localStorage.getItem(RECENT_SCAN_STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as RecentProject[]
    if (!Array.isArray(parsed)) return
    recentProjects.value = parsed.filter((entry) => entry && typeof entry.path === 'string')
  } catch (err) {
    return
  }
}

function saveRecentProjectsToStorage() {
  try {
    localStorage.setItem(RECENT_SCAN_STORAGE_KEY, JSON.stringify(recentProjects.value))
  } catch (err) {
    return
  }
}

function updateRecentProjects(projectsList: ScanResult[]) {
  if (!projectsList.length) return
  const now = new Date().toISOString()
  const map = new Map<string, RecentProject>()
  projectsList.forEach((project) => {
    map.set(normalizePath(project.path), { ...project, last_seen: now })
  })
  recentProjects.value.forEach((project) => {
    const key = normalizePath(project.path)
    if (!map.has(key)) {
      map.set(key, project)
    }
  })
  recentProjects.value = Array.from(map.values()).slice(0, 12)
  saveRecentProjectsToStorage()
}

function groupByFolder<T>(items: T[], getPath: (item: T) => string): Group<T>[] {
  if (items.length === 0) return []
  const groups = new Map<string, Group<T>>()
  items.forEach((item) => {
    const groupKey = normalizePath(getPath(item))
    const groupName = groupKey.split('/').filter(Boolean).pop() || groupKey
    const group = groups.get(groupKey)
    if (group) {
      group.items.push(item)
    } else {
      groups.set(groupKey, {
        key: groupKey,
        name: groupName,
        path: groupKey,
        items: [item],
      })
    }
  })

  const grouped = Array.from(groups.values())
  grouped.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
  grouped.forEach((group) => {
    group.items.sort((a, b) => normalizePath(getPath(a)).localeCompare(normalizePath(getPath(b)), undefined, { numeric: true }))
  })
  return grouped
}

const backendKeywords = new Set(['backend', 'server', 'api'])
const frontendKeywords = new Set(['frontend', 'client', 'web', 'app', 'ui'])

// Words from the service's own folders (relative to its project root) and name.
// Matching whole words avoids misreading parents like "~/capital" or "/Applications".
function serviceRoleWords(item: ProjectView) {
  const servicePath = normalizePath(item.project.path)
  const rootPath = normalizePath(item.project.root_path ?? item.project.path)
  const relative = servicePath.startsWith(`${rootPath}/`) ? servicePath.slice(rootPath.length + 1) : ''
  return `${relative}/${projectTitle(item)}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

function serviceRole(item: ProjectView): ServiceRole {
  // Discovery already classified the service from its folder, framework and scripts.
  if (item.project.role === 'backend' || item.project.role === 'frontend') return item.project.role
  const words = serviceRoleWords(item)
  if (words.some((word) => backendKeywords.has(word))) return 'backend'
  if (words.some((word) => frontendKeywords.has(word))) return 'frontend'
  return 'service'
}

function isDockerService(item: ProjectView) {
  return item.project.kind === 'docker_compose'
}

function formatRoleLabel(role: string) {
  if (!role) return ''
  return role.charAt(0).toUpperCase() + role.slice(1)
}

function serviceMetaLabels(item: ProjectView) {
  const labels: string[] = []
  const role = serviceRole(item)
  if (role !== 'service') {
    labels.push(formatRoleLabel(role))
  }
  if (item.project.kind === 'docker_compose') {
    labels.push('Docker')
  }
  return labels
}

function groupInitials(group: Group<ProjectView>) {
  const name = group.name.trim()
  if (!name) return '?'
  const parts = name.split(/[\s_-]+/).filter(Boolean)
  const letters = parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '')
  return letters.join('') || name.slice(0, 1).toUpperCase()
}

function isFrontendService(item: ProjectView) {
  return serviceRole(item) === 'frontend'
}

function groupFaviconCandidates(group: Group<ProjectView>) {
  const frontends = group.items.filter((item) => serviceRole(item) === 'frontend')
  const others = group.items.filter((item) => serviceRole(item) !== 'frontend')
  return [...frontends, ...others].map((item) => item.project.id)
}

function groupFaviconId(group: Group<ProjectView>) {
  const candidates = groupFaviconCandidates(group)
  for (const id of candidates) {
    if (!faviconFailed[id]) {
      return id
    }
  }
  return null
}

function groupFaviconUrl(group: Group<ProjectView>) {
  const id = groupFaviconId(group)
  return id && apiBase.value
    ? `${apiBase.value}/api/projects/${id}/favicon?token=${encodeURIComponent(apiToken.value)}`
    : ''
}

function handleFaviconError(id: string | null) {
  if (!id) return
  faviconFailed[id] = true
}

const serviceBuckets = computed(() => {
  if (!selectedGroup.value) {
    return { backend: [] as ProjectView[], frontend: [] as ProjectView[], service: [] as ProjectView[] }
  }
  const backend = selectedGroup.value.items.filter((item) => serviceRole(item) === 'backend')
  const frontend = selectedGroup.value.items.filter((item) => serviceRole(item) === 'frontend')
  const service = selectedGroup.value.items.filter((item) => serviceRole(item) === 'service')
  if (backend.length === 0 && frontend.length === 0) {
    return { backend: service, frontend: [], service: [] }
  }
  return { backend, frontend, service }
})

const selectedBackend = computed(() => serviceBuckets.value.backend)
const selectedFrontend = computed(() => serviceBuckets.value.frontend)
const selectedServices = computed(() => serviceBuckets.value.service)
const primaryBrowserTarget = computed(() => {
  if (!selectedGroup.value) return null
  const candidates = selectedGroup.value.items.filter((item) => effectivePort(item) !== null)
  if (candidates.length === 0) return null
  return candidates.find((item) => isFrontendService(item)) ?? candidates[0]
})
const selectedLogLines = computed(() => {
  if (!selectedGroup.value) return []
  const entries = selectedGroup.value.items.flatMap((item) => {
    const serviceName = projectTitle(item)
    return (logs[item.project.id] ?? []).map((entry) => ({
      ...entry,
      serviceName,
      role: serviceRole(item),
    }))
  })
  entries.sort((a, b) => {
    const timeA = new Date(a.timestamp).getTime()
    const timeB = new Date(b.timestamp).getTime()
    return timeA - timeB
  })
  const roleFilter = logRoleFilter.value
  const roleFiltered =
    roleFilter === 'all' ? entries : entries.filter((entry) => entry.role === roleFilter)
  const levelFilter = logLevelFilter.value
  const levelFiltered =
    levelFilter === 'all'
      ? roleFiltered
      : roleFiltered.filter((entry) => logEntryLevel(entry) === levelFilter)
  const query = logFilter.value.trim().toLowerCase()
  const filtered = query
    ? levelFiltered.filter(
        (entry) =>
          entry.line.toLowerCase().includes(query) ||
          entry.serviceName.toLowerCase().includes(query)
      )
    : levelFiltered
  return filtered.slice(-200)
})
function servicePid(service: ProjectView) {
  return service.status.pid ?? (processInstances[service.project.id] ?? []).find((instance) => instance.pid)?.pid ?? null
}

function formatTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function logServiceTone(entry: { role?: string }) {
  switch (entry.role) {
    case 'backend':
      return 'text-[var(--log-backend)]'
    case 'frontend':
      return 'text-[var(--log-frontend)]'
    case 'service':
      return 'text-[var(--log-service)]'
    default:
      return 'text-[var(--log-default)]'
  }
}

function logEntryLevel(entry: { stream?: string; line?: string }) {
  const line = entry.line ?? ''
  // Many tools log progress and warnings to stderr, so the stream alone doesn't make a line an error.
  if (/\b(warn|warning|deprecated|deprecation)\b/i.test(line)) {
    return 'warnings'
  }
  if (/\b(error|err!|failed|failure|exception|fatal|panic|eaddrinuse|exited|unable to|cannot)\b/i.test(line)) {
    return 'errors'
  }
  if (entry.stream === 'stderr' && /^\s+at\s/.test(line)) {
    return 'errors'
  }
  return 'all'
}

function logLineTone(entry: { stream?: string; line?: string }) {
  const line = entry.line ?? ''
  if (/^\s+at\s/.test(line) && entry.stream === 'stderr') {
    return 'text-[var(--text-muted)]'
  }
  if (logEntryLevel(entry) === 'errors') {
    return 'text-[var(--log-error)]'
  }
  if (logEntryLevel(entry) === 'warnings') {
    return 'text-[var(--log-warning)]'
  }
  if (/\b(ready|started|listening|compiled|build finished|success|connected)\b/i.test(line)) {
    return 'text-[var(--log-success)]'
  }
  return 'text-[var(--log-default)]'
}

function logRowTone(entry: { stream?: string; line?: string }) {
  if (logEntryLevel(entry) === 'errors') {
    return 'border-l-[var(--log-error)] bg-[color-mix(in_srgb,var(--danger-bg)_35%,transparent)]'
  }
  if (logEntryLevel(entry) === 'warnings') {
    return 'border-l-[var(--log-warning)]'
  }
  return 'border-l-transparent'
}

function scrollLogsToBottom(force = false) {
  nextTick(() => {
    const container = logsScrollRef.value
    if (!container) return
    if (!force && !logsPinnedToBottom.value) return
    container.scrollTop = container.scrollHeight
    logsPinnedToBottom.value = true
  })
}

function handleLogsScroll() {
  const container = logsScrollRef.value
  if (!container) return
  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
  logsPinnedToBottom.value = distanceFromBottom < 28
}

function jumpToLatest() {
  logsPinnedToBottom.value = true
  scrollLogsToBottom(true)
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function highlightText(value: string, query: string) {
  const trimmed = query.trim()
  if (!trimmed) {
    return escapeHtml(value)
  }
  const lowerValue = value.toLowerCase()
  const lowerQuery = trimmed.toLowerCase()
  if (!lowerValue.includes(lowerQuery)) {
    return escapeHtml(value)
  }
  let result = ''
  let index = 0
  while (index < value.length) {
    const matchIndex = lowerValue.indexOf(lowerQuery, index)
    if (matchIndex === -1) {
      result += escapeHtml(value.slice(index))
      break
    }
    result += escapeHtml(value.slice(index, matchIndex))
    result += `<mark class="rounded bg-[var(--highlight-bg)] px-1 text-[var(--highlight-text)]">${escapeHtml(
      value.slice(matchIndex, matchIndex + trimmed.length)
    )}</mark>`
    index = matchIndex + trimmed.length
  }
  return result
}

async function throwResponseError(response: Response, fallback: string) {
  let message = fallback
  try {
    const text = await response.text()
    if (text.trim()) {
      message = text.trim()
    }
  } catch (err) {
    // ignore
  }
  throw new Error(message)
}

async function checkHealth() {
  try {
    const response = await apiFetch('/api/health')
    backendStatus.value = response.ok ? 'online' : 'offline'
  } catch (err) {
    backendStatus.value = 'offline'
  }
}

// Background polling must not wipe errors raised by user actions, so it only
// clears the error it set itself.
let projectsLoadError = ''

async function loadProjects(options: { showLoading?: boolean } = {}) {
  const showLoading = options.showLoading ?? false
  if (showLoading || !hasLoadedOnce.value) {
    loading.value = true
  }
  try {
    const response = await apiFetch('/api/projects')
    if (!response.ok) {
      throw new Error('Failed to load projects')
    }
    const data = (await response.json()) as { projects: ProjectView[] }
    projects.value = data.projects
    hasLoadedOnce.value = true
    const groups = groupByFolder(data.projects, (item) => projectRootPath(item))
    restoreSelectedGroup(groups)
    if (selectedGroupKey.value) {
      const stillExists = groups.some((group) => group.key === selectedGroupKey.value)
      if (!stillExists) {
        selectedGroupKey.value = null
      }
    }
    const groupKeys = new Set(groups.map((group) => group.key))
    Object.keys(groupActionLoading).forEach((key) => {
      if (!groupKeys.has(key)) {
        delete groupActionLoading[key]
      }
    })
    const projectIds = new Set(data.projects.map((project) => project.project.id))
    Object.keys(actionDetailsOpen).forEach((id) => {
      if (!projectIds.has(id)) {
        delete actionDetailsOpen[id]
      }
    })
    Object.keys(actionErrors).forEach((id) => {
      if (!projectIds.has(id)) {
        delete actionErrors[id]
      }
    })
    Object.keys(vscodeErrors).forEach((id) => {
      if (!projectIds.has(id)) {
        delete vscodeErrors[id]
      }
    })
    Object.keys(faviconFailed).forEach((id) => {
      if (!projectIds.has(id)) {
        delete faviconFailed[id]
      }
    })
    for (const record of [processInstances, logs, detected, actionState] as Array<Record<string, unknown>>) {
      Object.keys(record).forEach((id) => {
        if (!projectIds.has(id)) delete record[id]
      })
    }
    Object.keys(actionLoading).forEach((key) => {
      const parts = key.split(':')
      const id = parts[1]
      if (id && !projectIds.has(id)) {
        delete actionLoading[key]
      }
    })
    syncActionDefaults()
    if (projectsLoadError && error.value === projectsLoadError) error.value = ''
    projectsLoadError = ''
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    projectsLoadError = message === 'Failed to fetch' || message === 'Backend not available'
      ? 'Cannot reach the Multiprise service manager. Retrying…'
      : message
    error.value = projectsLoadError
  } finally {
    loading.value = false
  }
}

async function openPicker() {
  pickerOpen.value = true
  scanResults.value = []
  Object.keys(scanSelection).forEach((key) => delete scanSelection[key])
  scanId.value = null
  scanStatus.value = 'idle'
  scanLoading.value = false
  clearScanTimer()
  if (selectedFolders.value.length) {
    await refreshProjectPreviews()
  }
}

function closePicker() {
  pickerOpen.value = false
  if (scanStatus.value === 'running') {
    stopScan()
  }
}

async function pickFolders() {
  error.value = ''
  try {
    const response = await apiFetch('/api/fs/pick', {
      method: 'POST',
    })
    if (!response.ok) {
      throw new Error('Folder picker failed')
    }
    const data = (await response.json()) as { paths: string[] }
    if (data.paths.length) {
      const merged = new Set([...selectedFolders.value, ...data.paths])
      selectedFolders.value = Array.from(merged)
      await refreshProjectPreviews()
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error'
  }
}

function removeSelectedFolder(path: string) {
  selectedFolders.value = selectedFolders.value.filter((entry) => entry !== path)
  delete projectPreviewMap[path]
}

function folderLabel(path: string) {
  const normalized = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path
  const parts = normalized.split('/').filter(Boolean)
  return parts[parts.length - 1] || path
}

function clearSelectedFolders() {
  selectedFolders.value = []
}

async function refreshProjectPreviews() {
  if (selectedFolders.value.length === 0) return
  try {
    const response = await apiFetch('/api/projects/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roots: selectedFolders.value })
    })
    if (!response.ok) {
      throw new Error('Inspect failed')
    }
    const data = (await response.json()) as { projects: ProjectPreview[] }
    data.projects.forEach((project) => {
      projectPreviewMap[project.path] = project
    })
  } catch (err) {
    // ignore
  }
}

function clearScanTimer() {
  if (scanTimer) {
    window.clearInterval(scanTimer)
    scanTimer = undefined
  }
}

function applyScanResults(projects: ScanResult[]) {
  const roots = selectedFolders.value.map((root) => normalizePath(root))
  const filtered = projects.filter((project) => {
    if (!project.suggested_command || project.suggested_command === 'N/A') return false
    if (roots.length === 0) return false
    const projectPath = normalizePath(project.path)
    return roots.some((root) => projectPath.startsWith(root))
  })
  scanResults.value = filtered
  updateRecentProjects(filtered)
  filtered.forEach((project) => {
    if (scanSelection[project.path] === undefined) {
      scanSelection[project.path] = true
    }
  })
}

async function startScan() {
  if (selectedFolders.value.length === 0) {
    error.value = 'Select one or more folders to scan.'
    return
  }
  if (scanStatus.value === 'running' && scanId.value) {
    await stopScan()
  }
  scanLoading.value = true
  scanStatus.value = 'running'
  error.value = ''
  scanResults.value = []
  Object.keys(scanSelection).forEach((key) => delete scanSelection[key])
  try {
    const response = await apiFetch('/api/projects/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roots: selectedFolders.value }),
    })
    if (!response.ok) {
      throw new Error('Scan failed')
    }
    const data = (await response.json()) as {
      id: string
      status: 'running' | 'done' | 'stopped'
      projects: ScanResult[]
    }
    scanId.value = data.id
    scanStatus.value = data.status
    applyScanResults(data.projects)
    if (data.status === 'running') {
      clearScanTimer()
      scanTimer = window.setInterval(() => {
        pollScan()
      }, 1200)
    } else {
      scanLoading.value = false
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error'
    scanLoading.value = false
  }
}

async function pollScan() {
  if (!scanId.value) return
  try {
    const response = await apiFetch(`/api/projects/scan/${scanId.value}`)
    if (!response.ok) {
      throw new Error('Scan status failed')
    }
    const data = (await response.json()) as {
      id: string
      status: 'running' | 'done' | 'stopped'
      projects: ScanResult[]
    }
    scanStatus.value = data.status
    applyScanResults(data.projects)
    if (data.status !== 'running') {
      scanLoading.value = false
      clearScanTimer()
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error'
    scanLoading.value = false
    clearScanTimer()
  }
}

async function stopScan() {
  if (!scanId.value) return
  try {
    await apiFetch(`/api/projects/scan/${scanId.value}/stop`, {
      method: 'POST',
    })
  } catch (err) {
    return
  } finally {
    scanStatus.value = 'stopped'
    scanLoading.value = false
    clearScanTimer()
  }
}

async function addSelectedProjects() {
  const selected = validSelectedFolders.value
  if (!selected.length) return
  if (addingProjects.value) return
  error.value = ''
  addingProjects.value = true
  try {
    const recentPayload: ScanResult[] = selected.map((path) => ({
      path,
      name: folderLabel(path),
      scripts: {},
      suggested_command: null,
      package_manager: null,
      has_docker_compose: false
    }))
    updateRecentProjects(recentPayload)

    // Add every folder even if one fails, and keep only the failures selected for a retry.
    const failures: string[] = []
    for (const path of selected) {
      try {
        const response = await apiFetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path
          }),
        })
        if (!response.ok) {
          await throwResponseError(response, 'Failed to add project')
        }
        removeSelectedFolder(path)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to add project'
        if (message === 'Project already exists') {
          removeSelectedFolder(path)
          continue
        }
        failures.push(`${folderLabel(path)}: ${message}`)
      }
    }
    await loadProjects()
    if (failures.length) {
      error.value = `Could not add ${failures.length === 1 ? 'a folder' : `${failures.length} folders`} — ${failures.join('; ')}`
      return
    }
    pickerOpen.value = false
    clearSelectedFolders()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error'
  } finally {
    addingProjects.value = false
  }
}

async function importRecentProject(project: ScanResult) {
  if (importLoading[project.path]) return
  error.value = ''
  importLoading[project.path] = true
  try {
    updateRecentProjects([project])
    const response = await apiFetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: project.path,
        name: project.name,
      }),
    })
    if (!response.ok) {
      await throwResponseError(response, 'Failed to add project')
    }
    await loadProjects()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error'
  } finally {
    importLoading[project.path] = false
  }
}

async function detectProject(project: ProjectView) {
  error.value = ''
  try {
    const response = await apiFetch(`/api/projects/${project.project.id}/detect`, {
      method: 'POST',
    })
    if (!response.ok) {
      throw new Error('Detection failed')
    }
    const data = (await response.json()) as DetectResponse
    detected[project.project.id] = data
    const state = ensureActionState(project)
    if (!state.command && data.suggested_command) {
      state.command = data.suggested_command
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error'
  }
}

async function persistServiceCommand(project: ProjectView) {
  const id = project.project.id
  const command = ensureActionState(project).command.trim()
  if (!command || command === (project.project.command ?? '')) {
    actionCommandDirty[id] = false
    return
  }
  try {
    const response = await apiFetch(`/api/projects/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, command_source: 'user' })
    })
    if (!response.ok) await throwResponseError(response, 'Failed to save command')
    actionCommandDirty[id] = false
    await loadProjects()
  } catch (err) {
    setActionError(id, err instanceof Error ? err.message : 'Failed to save command')
  }
}

async function resetServiceCommand(project: ProjectView) {
  const id = project.project.id
  try {
    const response = await apiFetch(`/api/projects/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: null, command_source: 'auto' })
    })
    if (!response.ok) await throwResponseError(response, 'Failed to restore automatic command')
    const data = (await response.json()) as ProjectView
    actionCommandDirty[id] = false
    ensureActionState(project).command = data.project.command ?? ''
    await loadProjects()
  } catch (err) {
    setActionError(id, err instanceof Error ? err.message : 'Failed to restore automatic command')
  }
}

async function toggleService(project: ProjectView) {
  if (project.status.running) {
    await stopProject(project)
  } else if (!settings.auto_port && !isDockerService(project)) {
    requestManualPorts({ kind: 'service', serviceId: project.project.id })
  } else {
    await startProject(project)
  }
}

function requestManualPorts(target: ManualPortTarget) {
  manualPortError.value = ''
  manualPortTarget.value = target
  nextTick(() => {
    manualPortServices.value.forEach((service) => {
      manualPortInputs[service.project.id] = String(servicePort(service) ?? effectivePort(service) ?? '')
    })
  })
}

function closeManualPortPrompt() {
  manualPortTarget.value = null
  manualPortError.value = ''
}

async function confirmManualPorts() {
  if (!manualPortsValid.value || !manualPortTarget.value) {
    manualPortError.value = 'Enter a unique port between 1 and 65535 for every service.'
    return
  }
  const target = manualPortTarget.value
  const selectedPorts = Object.fromEntries(
    manualPortServices.value.map((service) => [
      service.project.id,
      parsePort(manualPortInputs[service.project.id] ?? '') as number
    ])
  )
  closeManualPortPrompt()
  if (target.kind === 'service') {
    const service = projects.value.find((item) => item.project.id === target.serviceId)
    if (service) await startProject(service, { port: selectedPorts[service.project.id] })
    return
  }
  const group = folderGroups.value.find((item) => item.key === target.groupKey)
  if (group) await launchGroup(group, selectedPorts)
}

async function startProject(project: ProjectView, options: {
  forceAutoPort?: boolean
  port?: number
  env?: Record<string, string>
} = {}) {
  error.value = ''
  const port = options.port ?? (options.forceAutoPort || settings.auto_port ? undefined : servicePort(project))
  const env = options.env ?? buildEnvForService(project)
  if (isActionLoading('start', project.project.id)) return false
  setActionLoading('start', project.project.id, true)
  if (actionErrors[project.project.id]) {
    delete actionErrors[project.project.id]
  }
  try {
    const response = await apiFetch(`/api/projects/${project.project.id}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: ensureActionState(project).command || undefined,
        port,
        env: Object.keys(env).length ? env : undefined,
        role: serviceRole(project),
        force_auto_port: options.forceAutoPort ? true : undefined,
      }),
    })
    if (!response.ok) {
      await throwResponseError(response, 'Failed to start project')
    }
    await loadProjects()
    await refreshSelectedLogs()
    await fetchLogs(project.project.id)
    await fetchInstances(project)
    await fetchUsedPorts()
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to start service'
    error.value = message
    setActionError(project.project.id, message)
    await loadProjects()
    await fetchLogs(project.project.id)
    await fetchInstances(project)
    await fetchUsedPorts({ silent: true })
    return false
  } finally {
    setActionLoading('start', project.project.id, false)
  }
}

async function stopProject(project: ProjectView) {
  error.value = ''
  if (isActionLoading('stop', project.project.id)) return
  setActionLoading('stop', project.project.id, true)
  try {
    const response = await apiFetch(`/api/projects/${project.project.id}/stop`, {
      method: 'POST',
    })
    if (!response.ok) {
      await throwResponseError(response, 'Failed to stop project')
    }
    await loadProjects()
    await refreshSelectedLogs()
    await fetchLogs(project.project.id)
    await fetchInstances(project)
    await fetchUsedPorts()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error'
  } finally {
    setActionLoading('stop', project.project.id, false)
  }
}

async function renameProject(project: ProjectView) {
  if (!editingName.value.trim()) {
    editingId.value = null
    return
  }
  error.value = ''
  try {
    const response = await apiFetch(`/api/projects/${project.project.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editingName.value.trim() }),
    })
    if (!response.ok) {
      throw new Error('Failed to rename')
    }
    editingId.value = null
    await loadProjects()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error'
  }
}

function beginRename(project: ProjectView) {
  editingId.value = project.project.id
  editingName.value = projectTitle(project)
}

async function fetchInstances(project: ProjectView) {
  try {
    const response = await apiFetch(`/api/projects/${project.project.id}/process/instances`)
    if (!response.ok) {
      throw new Error('Process scan failed')
    }
    const data = (await response.json()) as { instances: ProcessInstance[] }
    processInstances[project.project.id] = data.instances
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error'
  }
}

async function refreshSelectedInstances() {
  if (!selectedGroup.value || instancesLoading.value) return
  instancesLoading.value = true
  try {
    for (const service of selectedGroup.value.items) {
      processInstances[service.project.id] = []
      await fetchInstances(service)
    }
    await loadProjects()
  } finally {
    instancesLoading.value = false
  }
}

async function killInstance(project: ProjectView, pid: number) {
  error.value = ''
  if (isActionLoading('kill', project.project.id, pid)) return false
  setActionLoading('kill', project.project.id, true, pid)
  try {
    const response = await apiFetch('/api/projects/' + project.project.id + '/process/kill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid }),
    })
    if (!response.ok) {
      await throwResponseError(response, 'Failed to unplug process')
    }
    await fetchInstances(project)
    await loadProjects()
    await fetchUsedPorts({ silent: true })
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to unplug process'
    error.value = message
    setActionError(project.project.id, message)
    return false
  } finally {
    setActionLoading('kill', project.project.id, false, pid)
  }
}

function logsMatch(current: LogLine[], incoming: LogLine[]) {
  if (current.length !== incoming.length) return false
  return current.every((entry, index) => {
    const candidate = incoming[index]
    return candidate && entry.timestamp === candidate.timestamp && entry.stream === candidate.stream && entry.line === candidate.line
  })
}

async function fetchLogs(id: string) {
  try {
    const response = await apiFetch(`/api/projects/${id}/logs?tail=200`)
    if (!response.ok) return
    const data = (await response.json()) as { logs: LogLine[] }
    const current = logs[id] ?? []
    if (!logsMatch(current, data.logs)) logs[id] = data.logs
  } catch (err) {
    return
  }
}

async function refreshSelectedLogs() {
  if (!selectedGroup.value || logsRefreshing.value) return
  logsRefreshing.value = true
  try {
    await Promise.all(selectedGroup.value.items.map((service) => fetchLogs(service.project.id)))
  } finally {
    logsRefreshing.value = false
  }
}

function externalInstancesFor(service: ProjectView) {
  return (processInstances[service.project.id] ?? []).filter((instance) => instance.source === 'external')
}

function externalPrimaryInstance(service: ProjectView) {
  return externalInstancesFor(service)[0] ?? null
}

function startupConflictFor(service: ProjectView) {
  return externalInstancesFor(service).find((instance) => instance.reason === 'startup-conflict') ?? null
}

function startupConflictSummary(service: ProjectView) {
  const conflict = startupConflictFor(service)
  if (!conflict) return ''
  const location = conflict.port ? ':' + conflict.port : 'an unknown port'
  return location + ' · PID ' + conflict.pid
}

function externalInstanceSummary(service: ProjectView) {
  const instances = externalInstancesFor(service)
  if (instances.length === 0) return ''
  return instances
    .map((instance) => {
      const portLabel = instance.port ? `:${instance.port}` : 'Port ?'
      const pidLabel = instance.pid ? `PID ${instance.pid}` : 'PID ?'
      return `${portLabel} · ${pidLabel}`
    })
    .join(' · ')
}

async function startAnotherInstance(service: ProjectView) {
  if (!settings.auto_port) {
    requestManualPorts({ kind: 'service', serviceId: service.project.id })
    return
  }
  await startProject(service, { forceAutoPort: true })
}

async function killExternalInstance(service: ProjectView) {
  const primary = externalPrimaryInstance(service)
  if (!primary?.pid) return
  await killInstance(service, primary.pid)
}

async function resolveStartupConflict(service: ProjectView) {
  const conflict = startupConflictFor(service)
  if (!conflict?.pid || isActionLoading('resolve-conflict', service.project.id, conflict.pid)) return

  setActionLoading('resolve-conflict', service.project.id, true, conflict.pid)
  try {
    const unplugged = await killInstance(service, conflict.pid)
    if (!unplugged) return
    await startProject(service)
  } finally {
    setActionLoading('resolve-conflict', service.project.id, false, conflict.pid)
  }
}

function formatPortSource(source: ProcessSource) {
  if (source === 'managed') return 'Managed'
  if (source === 'docker') return 'Docker'
  if (source === 'external') return 'External'
  return 'Unknown'
}

function groupReadyCount(group: Group<ProjectView>) {
  return group.items.filter((item) => !isDockerService(item) && serviceReady(item)).length
}

function groupServiceCount(group: Group<ProjectView>) {
  return group.items.filter((item) => !isDockerService(item)).length
}

function groupRunningCount(group: Group<ProjectView>) {
  return group.items.filter((item) => !isDockerService(item) && item.status.running).length
}

function groupHasNpmServices(group: Group<ProjectView>) {
  return groupServiceCount(group) > 0
}

function groupHasRunning(group: Group<ProjectView>) {
  return groupRunningCount(group) > 0
}

async function launchGroup(group: Group<ProjectView>, manualPorts?: Record<string, number>) {
  if (groupActionLoading[group.key]) return
  if (!settings.auto_port && !manualPorts) {
    requestManualPorts({ kind: 'group', groupKey: group.key })
    return
  }
  groupActionLoading[group.key] = 'launch'
  try {
    const regularServices = group.items.filter((service) => !isDockerService(service))
    const backendServices = regularServices.filter((service) => serviceRole(service) === 'backend')
    const frontendServices = regularServices.filter((service) => serviceRole(service) === 'frontend')
    const supportServices = regularServices.filter((service) => serviceRole(service) === 'service')
    const primaryBackend = backendServices[0]
    const primaryFrontend = frontendServices[0]
    const rolesToAllocate: ServiceRole[] = []
    const existingBackendPort = primaryBackend
      ? servicePort(primaryBackend) ?? (primaryBackend.status.running ? effectivePort(primaryBackend) ?? undefined : undefined)
      : undefined
    const existingFrontendPort = primaryFrontend
      ? servicePort(primaryFrontend) ?? (primaryFrontend.status.running ? effectivePort(primaryFrontend) ?? undefined : undefined)
      : undefined

    if (settings.auto_port && primaryBackend && !primaryBackend.status.running && !existingBackendPort) rolesToAllocate.push('backend')
    if (settings.auto_port && primaryFrontend && !primaryFrontend.status.running && !existingFrontendPort) rolesToAllocate.push('frontend')

    let allocatedPorts: Partial<Record<ServiceRole, number>> = {}
    if (rolesToAllocate.length) {
      const response = await apiFetch('/api/ports/allocate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roles: rolesToAllocate })
      })
      if (!response.ok) await throwResponseError(response, 'Failed to allocate ports')
      allocatedPorts = ((await response.json()) as { ports?: Partial<Record<ServiceRole, number>> }).ports ?? {}
    }

    const backendPort = primaryBackend
      ? manualPorts?.[primaryBackend.project.id] ?? existingBackendPort ?? allocatedPorts.backend
      : undefined
    const frontendPort = primaryFrontend
      ? manualPorts?.[primaryFrontend.project.id] ?? existingFrontendPort ?? allocatedPorts.frontend
      : undefined
    const groupEnv: Record<string, string> = {}
    if (backendPort) groupEnv.BACKEND_PORT = String(backendPort)
    if (frontendPort) groupEnv.FRONTEND_PORT = String(frontendPort)

    const launchStage = async (services: ProjectView[]) => {
      let allReady = true
      for (const service of services) {
        if (serviceReady(service)) continue
        const role = serviceRole(service)
        const port = manualPorts?.[service.project.id] ?? (role === 'backend'
          ? backendPort
          : role === 'frontend'
            ? frontendPort
            : undefined)
        const ready = await startProject(service, {
          port,
          env: Object.keys(groupEnv).length ? groupEnv : undefined
        })
        if (!ready) allReady = false
      }
      return allReady
    }

    await launchStage(supportServices)
    const backendsReady = await launchStage(backendServices)
    if (backendsReady) {
      await launchStage(frontendServices)
    } else {
      for (const frontend of frontendServices.filter((service) => !service.status.running)) {
        setActionError(frontend.project.id, 'Waiting for the backend to become ready before launching this service.')
      }
    }
    await loadProjects()
    await refreshSelectedLogs()
    await fetchUsedPorts()
  } finally {
    groupActionLoading[group.key] = null
  }
}

async function stopGroup(group: Group<ProjectView>) {
  if (groupActionLoading[group.key]) return
  groupActionLoading[group.key] = 'stop'
  try {
    for (const service of group.items) {
      if (isDockerService(service)) continue
      if (service.status.running) {
        await stopProject(service)
      }
    }
  } finally {
    groupActionLoading[group.key] = null
  }
}

async function deleteGroup(group: Group<ProjectView>) {
  if (groupActionLoading[group.key]) return
  const running = group.items.filter((service) => service.status.running).length
  const warning = running ? `\n\n${running} running service${running === 1 ? ' will' : 's will'} be stopped.` : ''
  if (!window.confirm(`Untrack ${group.name}?${warning}`)) return
  error.value = ''
  groupActionLoading[group.key] = 'delete'
  let failed = 0
  try {
    for (const service of group.items) {
      const response = await apiFetch(`/api/projects/${service.project.id}`, {
        method: 'DELETE'
      })
      if (!response.ok) {
        failed += 1
      }
    }
  } catch (err) {
    failed += 1
  }
  groupActionLoading[group.key] = null
  if (failed > 0) {
    error.value = `Failed to untrack ${failed} service${failed === 1 ? '' : 's'}.`
  }
  if (selectedGroupKey.value === group.key) {
    selectedGroupKey.value = null
  }
  await loadProjects()
}

function saveSelectedGroupToStorage(key: string | null) {
  try {
    if (!key) {
      localStorage.removeItem(SELECTED_GROUP_STORAGE_KEY)
      return
    }
    localStorage.setItem(SELECTED_GROUP_STORAGE_KEY, key)
  } catch (err) {
    return
  }
}

function loadSelectedGroupFromStorage() {
  try {
    return localStorage.getItem(SELECTED_GROUP_STORAGE_KEY)
  } catch (err) {
    return null
  }
}

function loadRecentGroupsFromStorage() {
  try {
    const raw = localStorage.getItem(RECENT_GROUPS_STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return
    recentGroupKeys.value = parsed.filter((key): key is string => typeof key === 'string').slice(0, 8)
  } catch (err) {
    return
  }
}

function rememberGroup(key: string) {
  recentGroupKeys.value = [key, ...recentGroupKeys.value.filter((entry) => entry !== key)].slice(0, 8)
  try {
    localStorage.setItem(RECENT_GROUPS_STORAGE_KEY, JSON.stringify(recentGroupKeys.value))
  } catch (err) {
    return
  }
}

function initializeNavigationSession() {
  activeSection.value = 'home'
  selectedGroupKey.value = null
  try {
    restoreProjectOnLoad.value = sessionStorage.getItem(NAVIGATION_SESSION_KEY) === 'active'
    sessionStorage.setItem(NAVIGATION_SESSION_KEY, 'active')
  } catch (err) {
    restoreProjectOnLoad.value = false
  }
}

function restoreSelectedGroup(groups: Group<ProjectView>[]) {
  if (!restoreProjectOnLoad.value || selectedGroupKey.value) return
  const stored = loadSelectedGroupFromStorage()
  if (!stored) return
  const match = groups.find((group) => group.key === stored)
  if (!match) return
  selectedGroupKey.value = stored
  activeSection.value = 'projects'
  projectsExpanded.value = true
}

function usedPortsMatch(current: UsedPort[], incoming: UsedPort[]) {
  if (current.length !== incoming.length) return false
  return current.every((entry, index) => {
    const candidate = incoming[index]
    return candidate && entry.port === candidate.port && entry.pid === candidate.pid && entry.project_id === candidate.project_id && entry.source === candidate.source
  })
}

async function fetchUsedPorts(options: { silent?: boolean } = {}) {
  if (portsRefreshing.value) return
  portsRefreshing.value = true
  portsError.value = ''
  if (!options.silent) portsLoading.value = true
  try {
    const response = await apiFetch('/api/ports/used')
    if (!response.ok) throw new Error('Failed to load ports')
    const data = (await response.json()) as { ports: UsedPort[] }
    if (!usedPortsMatch(usedPorts.value, data.ports)) usedPorts.value = data.ports
    lastPortsRefreshAt = Date.now()
  } catch (err) {
    portsError.value = err instanceof Error ? err.message : 'Unknown error'
  } finally {
    portsRefreshing.value = false
    if (!options.silent) portsLoading.value = false
  }
}

function applySettingsPatch(patch: Partial<Settings>) {
  if (typeof patch.auto_port === 'boolean') {
    settings.auto_port = patch.auto_port
  }
  if (typeof patch.auto_install === 'boolean') {
    settings.auto_install = patch.auto_install
  }
  if (typeof patch.startup_timeout_ms === 'number' && Number.isFinite(patch.startup_timeout_ms)) {
    settings.startup_timeout_ms = Math.min(Math.max(Math.floor(patch.startup_timeout_ms), 10000), 30000)
  }
  if (typeof patch.port_base === 'number' && Number.isFinite(patch.port_base)) {
    settings.port_base = Math.min(Math.max(Math.floor(patch.port_base), 1), 65535)
  }
  if (typeof patch.scan_depth === 'number' && Number.isFinite(patch.scan_depth)) {
    settings.scan_depth = Math.min(Math.max(Math.floor(patch.scan_depth), 1), 64)
  }
  if (Array.isArray(patch.scan_ignore)) {
    settings.scan_ignore = patch.scan_ignore.map((value) => value.trim()).filter(Boolean)
  }
  if (typeof patch.theme === 'string') {
    settings.theme = normalizeTheme(patch.theme)
  }
  syncSettingsDraftFromSettings()
}

function normalizeDraftSettings(draft: Settings) {
  return {
    auto_port: !!draft.auto_port,
    auto_install: !!draft.auto_install,
    startup_timeout_ms: Math.min(Math.max(Math.floor(draft.startup_timeout_ms ?? settings.startup_timeout_ms), 10000), 30000),
    port_base: Math.min(Math.max(Math.floor(draft.port_base ?? settings.port_base), 1), 65535),
    scan_depth: Math.min(Math.max(Math.floor(draft.scan_depth ?? settings.scan_depth), 1), 64),
    scan_ignore: scanIgnoreDraft.value
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    theme: normalizeTheme(draft.theme)
  } satisfies Settings
}

function syncSettingsDraftFromSettings() {
  settingsDraft.auto_port = settings.auto_port
  settingsDraft.auto_install = settings.auto_install
  settingsDraft.startup_timeout_ms = settings.startup_timeout_ms
  settingsDraft.port_base = settings.port_base
  settingsDraft.scan_depth = settings.scan_depth
  settingsDraft.scan_ignore = [...settings.scan_ignore]
  settingsDraft.theme = settings.theme
  scanIgnoreDraft.value = settings.scan_ignore.join(', ')
}

const settingsDirty = computed(() => {
  const draft = normalizeDraftSettings(settingsDraft)
  return (
    draft.auto_port !== settings.auto_port ||
    draft.auto_install !== settings.auto_install ||
    draft.startup_timeout_ms !== settings.startup_timeout_ms ||
    draft.port_base !== settings.port_base ||
    draft.scan_depth !== settings.scan_depth ||
    draft.theme !== settings.theme ||
    draft.scan_ignore.join(',') !== settings.scan_ignore.join(',')
  )
})

function setSaveFeedback(value: 'saved' | 'noop' | 'error') {
  saveFeedback.value = value
  if (saveFeedbackTimer) {
    window.clearTimeout(saveFeedbackTimer)
  }
  saveFeedbackTimer = window.setTimeout(() => {
    saveFeedback.value = ''
  }, 1600)
}

function loadSettingsFromStorage() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Partial<Settings>
    applySettingsPatch(parsed)
  } catch (err) {
    return
  }
}

function saveSettingsToStorage() {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  } catch (err) {
    return
  }
}

async function fetchSettings() {
  try {
    const response = await apiFetch('/api/settings')
    if (!response.ok) {
      throw new Error('Failed to load settings')
    }
    const data = (await response.json()) as Settings
    applySettingsPatch(data)
    saveSettingsToStorage()
    settingsLoaded.value = true
  } catch (err) {
    settingsLoaded.value = false
  }
}

async function saveSettings() {
  if (!settingsDirty.value) {
    setSaveFeedback('noop')
    return
  }
  settingsSaving.value = true
  try {
    const payload = normalizeDraftSettings(settingsDraft)
    const response = await apiFetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      throw new Error('Failed to save settings')
    }
    const data = (await response.json()) as Settings
    applySettingsPatch(data)
    saveSettingsToStorage()
    settingsLoaded.value = true
    setSaveFeedback('saved')
  } catch (err) {
    setSaveFeedback('error')
    return
  } finally {
    settingsSaving.value = false
  }
}

watch(activeSection, async (section) => {
  if (section !== 'settings') syncSettingsDraftFromSettings()
})

// The native browser view always paints above the page, so it is hidden while
// any modal or menu is open instead of covering it.
const overlayOpen = computed(() =>
  pickerOpen.value ||
  !!manualPortTarget.value ||
  groupMenuOpen.value ||
  Object.values(externalMenuOpen).some(Boolean)
)

watch(
  [activeSection, projectPanelMode, selectedGroupKey, () => activeBrowserTab.value?.detached, overlayOpen],
  async ([section, panelMode]) => {
    const shouldAttachView = section === 'projects' && panelMode === 'browser' && !!selectedGroupKey.value &&
      !activeBrowserTab.value?.detached && !overlayOpen.value
    if (shouldAttachView) {
      await nextTick()
      observeBrowserViewport()
      return
    }
    browserResizeObserver?.disconnect()
    const state = await window.vibe?.browser?.hide()
    applyBrowserState(state)
  }
)

watch(selectedGroupKey, async (key, previousKey) => {
  saveSelectedGroupToStorage(key)
  await nextTick()
  observeProjectSplit()
  if (key !== previousKey) projectPanelMode.value = 'logs'
  if (!key) return
  logsPinnedToBottom.value = true
  await refreshSelectedLogs()
  await refreshSelectedInstances()
  scrollLogsToBottom(true)
})

// A crash or exit changes which processes own the ports; refresh them so stale
// "external instance" rows don't hide the Start action.
watch(
  () => selectedGroup.value?.items.map((item) => `${item.project.id}:${item.status.phase}:${item.status.pid ?? ''}`).join('|') ?? '',
  (current, previous) => {
    if (previous && current !== previous) refreshSelectedInstances()
  }
)

// The visible list is capped at 200 lines, so its length stops changing; track the newest entry.
watch(
  () => {
    const lines = selectedLogLines.value
    const newest = lines[lines.length - 1]
    return `${lines.length}|${newest?.timestamp ?? ''}|${newest?.line ?? ''}`
  },
  () => {
    scrollLogsToBottom()
  }
)


function handleWindowClick() {
  if (groupMenuOpen.value) {
    closeGroupMenu()
  }
  closeExternalMenus()
}

function handleWindowKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    closeGroupMenu()
    closeExternalMenus()
    closeManualPortPrompt()
  }
}

async function refreshLiveTelemetry() {
  if (document.hidden || projects.value.length === 0) return
  if (selectedGroup.value) await refreshSelectedLogs()
  if (Date.now() - lastPortsRefreshAt >= portsRefreshMs) {
    await fetchUsedPorts({ silent: true })
  }
}

async function handleVisibilityChange() {
  documentVisible.value = !document.hidden
  if (!documentVisible.value) return
  await Promise.all([loadProjects(), refreshSelectedLogs(), fetchUsedPorts({ silent: true })])
  await nextTick()
  syncBrowserBounds()
}

async function startAutoRefresh() {
  if (!refreshTimer) {
    refreshTimer = window.setInterval(async () => {
      if (document.hidden) return
      await checkHealth()
      await loadProjects()
    }, refreshMs)
  }
  if (!telemetryTimer) {
    telemetryTimer = window.setInterval(refreshLiveTelemetry, telemetryRefreshMs)
  }
}

function stopAutoRefresh() {
  if (refreshTimer) {
    window.clearInterval(refreshTimer)
    refreshTimer = undefined
  }
  if (telemetryTimer) {
    window.clearInterval(telemetryTimer)
    telemetryTimer = undefined
  }
}

onMounted(async () => {
  initializeNavigationSession()
  loadRecentGroupsFromStorage()
  loadServiceSplitRatio()
  await ensureApiBase()
  // The cached copy only avoids a theme flash; the backend's saved settings always win.
  loadSettingsFromStorage()
  await fetchSettings()
  await checkHealth()
  await loadProjects({ showLoading: true })
  loadRecentProjectsFromStorage()
  if (activePortsExpanded.value) {
    await fetchUsedPorts()
  }
  await startAutoRefresh()
  if (pickerOpen.value && selectedFolders.value.length) {
    await refreshProjectPreviews()
  }
  if (window.vibe?.browser) {
    applyBrowserState(await window.vibe.browser.getState())
    stopBrowserStateListener = window.vibe.browser.onState(applyBrowserState)
    await window.vibe.browser.hide()
  }
  window.addEventListener('click', handleWindowClick)
  window.addEventListener('keydown', handleWindowKeydown)
  window.addEventListener('resize', closeGroupMenu)
  window.addEventListener('resize', syncBrowserBounds)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  await nextTick()
  observeProjectSplit()
  await refreshLiveTelemetry()
})

onBeforeUnmount(() => {
  stopAutoRefresh()
  clearScanTimer()
  if (copiedServiceUrlTimer) window.clearTimeout(copiedServiceUrlTimer)
  browserResizeObserver?.disconnect()
  projectSplitResizeObserver?.disconnect()
  stopServiceResize()
  stopBrowserStateListener?.()
  window.vibe?.browser?.hide()
  window.removeEventListener('click', handleWindowClick)
  window.removeEventListener('keydown', handleWindowKeydown)
  window.removeEventListener('resize', closeGroupMenu)
  window.removeEventListener('resize', syncBrowserBounds)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
})
</script>

<template>
  <div class="multiprise-shell relative h-screen overflow-hidden bg-[var(--app-bg)] font-sans text-[var(--text)]" :style="themeStyle">
    <div class="app-drag-region pointer-events-none absolute inset-x-0 top-0 z-30 h-9"></div>
    <main
      class="grid h-full min-h-0 overflow-hidden pt-9 transition-[grid-template-columns] duration-200 ease-out"
      :class="sidebarCollapsed ? 'grid-cols-[48px_1fr]' : 'grid-cols-[260px_1fr]'"
    >
      <aside
        class="relative flex min-h-0 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--sidebar-bg)] text-[var(--text)] shadow-sm transition-[background-color,border-color,color,box-shadow] duration-200"
        :class="sidebarCollapsed ? 'm-2 h-[calc(100%-16px)]' : 'm-3 mr-0 h-[calc(100%-24px)]'"
        :style="sidebarThemeStyle"
      >
        <div
          class="flex h-14 shrink-0 items-center border-b border-[var(--border)] px-3"
          :class="sidebarCollapsed ? 'justify-center' : 'justify-between'"
        >
          <button
            v-if="!sidebarCollapsed"
            class="group flex min-w-0 items-center gap-2.5 text-left"
            @click="goHome"
            title="Home"
          >
            <img :src="multipriseIconUrl" alt="" class="h-8 w-8 shrink-0" />
            <span>
              <span class="block truncate text-[16px] font-semibold tracking-[-0.025em] text-[var(--text-strong)]">multiprise</span>
            </span>
          </button>
          <button
            class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text-strong)]"
            :title="sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
            @click="toggleSidebar"
          >
            <svg viewBox="0 0 24 24" class="h-4 w-4 transition-transform" :class="sidebarCollapsed ? 'rotate-180' : ''" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M15 5l-7 7 7 7" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </div>

        <nav class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pb-3 pt-2" :class="sidebarCollapsed ? ['px-1', noScrollbar] : 'px-2'">
          <div v-if="!sidebarCollapsed" class="relative my-1">
            <svg viewBox="0 0 24 24" class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-subtle)]" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="11" cy="11" r="6" />
              <path d="M16 16l4 4" stroke-linecap="round" />
            </svg>
            <input
              v-model="projectSearch"
              class="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--input-bg)] pl-8 pr-3 text-xs text-[var(--input-text)] placeholder:text-[var(--input-placeholder)] focus:border-[var(--text-subtle)] focus:outline-none"
              placeholder="Search projects"
            />
          </div>

          <button
            v-if="!sidebarCollapsed && (usedPorts.length || portsLoading || portsError)"
            class="flex items-center justify-between px-2 py-1.5 text-left text-[13px] font-medium text-[var(--text-muted)]"
            :class="activePortsExpanded ? 'text-[var(--text-strong)]' : 'text-[var(--text-muted)]'"
            @click="toggleActivePortsSection"
          >
            <span class="flex items-center gap-2">
              <svg viewBox="0 0 24 24" class="h-3.5 w-3.5 text-[var(--electric)]" fill="none" stroke="currentColor" stroke-width="1.7">
                <path d="M8 3v5M16 3v5M6 8h12v3a6 6 0 01-6 6v4" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span>
                <span class="block leading-4">Plugged in</span>
                <span class="block text-[9px] font-normal text-[var(--text-subtle)]">Active local ports</span>
              </span>
            </span>
            <svg
              viewBox="0 0 24 24"
              class="h-3.5 w-3.5 text-[var(--text-subtle)] transition"
              :class="activePortsExpanded ? 'rotate-90' : ''"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            >
              <path d="M9 5l7 7-7 7" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <transition name="unfurl">
            <div v-if="!sidebarCollapsed && activePortsExpanded && (usedPorts.length || portsLoading || portsError)" class="space-y-0.5 px-1 pb-2">
              <div v-if="portsError" class="px-2 py-1 text-sm text-[var(--text-subtle)]">{{ portsError }}</div>
              <div v-else-if="portsLoading" class="flex items-center px-2 py-1 text-sm text-[var(--text-subtle)]">
                <span :class="spinnerClass" aria-hidden="true"></span>
                <span class="sr-only">Loading ports</span>
              </div>
              <div v-else class="max-h-40 space-y-0.5 overflow-y-auto pr-1" :class="noScrollbar">
                <button
                  v-for="item in usedPorts"
                  :key="item.port"
                  type="button"
                  class="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] text-[var(--text-muted)] transition-colors"
                  :class="item.project_id ? 'hover:bg-[var(--hover)]' : 'cursor-default opacity-70'"
                  :disabled="!item.project_id"
                  :title="usedPortTitle(item)"
                  @click="openGroupForUsedPort(item)"
                >
                  <span class="h-2 w-2 shrink-0 rounded-full bg-[var(--live)]"></span>
                  <span class="flex min-w-0 flex-1 items-baseline gap-2">
                    <span class="shrink-0 font-mono text-[12px] font-semibold text-[var(--electric)]">:{{ item.port }}</span>
                    <span class="truncate text-[10px] text-[var(--text-muted)]">{{ usedPortProjectName(item) }}</span>
                  </span>
                </button>
              </div>
            </div>
          </transition>
          <div
            class="flex items-center justify-between px-2 py-1.5 text-left text-[13px] font-medium text-[var(--text-muted)]"
            :class="activeSection === 'projects' ? 'text-[var(--text-strong)]' : 'text-[var(--text-muted)]'"
          >
            <button class="flex flex-1 items-center justify-between text-left" @click="toggleProjectsSection">
              <span>
                <span class="block leading-4">{{ sidebarCollapsed ? 'Projects' : 'Tracked projects' }}</span>
                <span v-if="!sidebarCollapsed" class="block text-[9px] font-normal text-[var(--text-subtle)]">Saved project folders</span>
              </span>
              <svg
                v-if="!sidebarCollapsed"
                viewBox="0 0 24 24"
                class="h-3.5 w-3.5 text-[var(--text-subtle)] transition"
                :class="projectsExpanded ? 'rotate-90' : ''"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
              >
                <path d="M9 5l7 7-7 7" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
            <button
              type="button"
              class="ml-2 inline-flex h-7 w-7 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--panel-bg)] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover)]"
              :class="sidebarCollapsed ? 'hidden' : ''"
              @click.stop="openPicker"
              title="Add project"
            >
              <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M12 5v14M5 12h14" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          </div>
          <transition name="unfurl">
            <div v-if="projectsExpanded" class="space-y-0.5 px-1">
              <div v-if="folderGroups.length === 0" class="px-2 py-1 text-sm text-[var(--text-subtle)]">
                {{ sidebarCollapsed ? 'None' : 'No tracked projects.' }}
              </div>
              <div v-else-if="!filteredFolderGroups.length && !sidebarCollapsed" class="px-2 py-2 text-xs text-[var(--text-subtle)]">
                No projects match “{{ projectSearch }}”.
              </div>
              <button
                v-for="group in filteredFolderGroups"
                :key="group.key"
                class="group flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--hover)]"
                :title="sidebarCollapsed ? group.name : undefined"
                :class="activeSection === 'projects' && selectedGroupKey === group.key ? 'bg-[var(--selection)] text-[var(--text-strong)]' : ''"
                @click="handleGroupClick(group)"
                @contextmenu.prevent="openGroupMenu($event, group)"
              >
                <span class="flex min-w-0 flex-1 items-center gap-2" :class="sidebarCollapsed ? 'justify-center' : ''">
                  <span
                    :class="[statusDot, group.items.some((item) => serviceReady(item)) ? statusDotLive : '']"
                    :aria-label="group.items.some((item) => serviceReady(item)) ? 'Live' : 'Idle'"
                  ></span>
                  <span
                    v-if="!sidebarCollapsed"
                    class="block truncate text-[13px]"
                    :class="group.items.some((item) => serviceReady(item)) ? 'font-semibold text-[var(--text-strong)]' : 'text-[var(--text-muted)]'"
                  >
                    {{ group.name }}
                  </span>
                </span>
              </button>
            </div>
          </transition>
          <div class="mt-auto space-y-1 pt-2">
            <button
              class="flex h-10 w-full items-center rounded-lg px-3 text-left text-[13px] font-medium transition-colors hover:bg-[var(--hover)]"
              :class="activeSection === 'settings' ? 'bg-[var(--selection)] text-[var(--text-strong)]' : 'text-[var(--text-muted)]'"
              @click="activeSection = 'settings'"
              title="Settings"
            >
              <svg v-if="sidebarCollapsed" viewBox="0 0 24 24" class="mx-auto h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
              </svg>
              <span v-else>Settings</span>
            </button>
          </div>
        </nav>
      </aside>

      <section class="flex h-full min-h-0 flex-col overflow-hidden">
        <div class="flex-1 min-h-0 overflow-hidden p-3">
          <div v-if="activeSection === 'home'" class="h-full min-h-0">
            <div class="h-full min-h-0 overflow-y-auto rounded-2xl" :class="[panelProjectClass, noScrollbar]">
              <div class="mx-auto grid min-h-full w-full max-w-[1380px] xl:grid-cols-[minmax(0,1.08fr)_minmax(390px,0.92fr)]">
                <section class="flex min-h-[470px] flex-col justify-center border-b border-[var(--border)] px-8 py-12 sm:px-12 xl:border-b-0 xl:border-r xl:px-16 xl:py-16">
                  <div class="max-w-2xl">
                    <h1 class="max-w-xl text-[clamp(2.35rem,4vw,3.7rem)] font-semibold leading-[1.03] tracking-[-0.055em] text-[var(--text-strong)]">
                      Run local projects without the port shuffle.
                    </h1>
                    <p class="mt-5 max-w-xl text-base leading-7 text-[var(--text-muted)]">
                      Choose a project folder once. multiprise finds its services, assigns free ports, and keeps every process within reach.
                    </p>
                    <button
                      class="mt-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--panel-project)]"
                      :class="[btnPanelPrimaryLg, 'min-w-[156px]']"
                      @click="openPicker"
                    >
                      <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                        <path d="M12 5v14M5 12h14" stroke-linecap="round" />
                      </svg>
                      Add project
                    </button>
                  </div>

                  <svg
                    viewBox="0 0 620 150"
                    class="mt-14 h-auto w-full max-w-[620px] text-[var(--border)]"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path d="M4 77H120" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                    <path d="M500 77H616" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                    <path class="animate-current-flow" d="M4 77H120" stroke="var(--electric)" stroke-width="2" stroke-linecap="round" stroke-dasharray="5 16" />
                    <rect x="120" y="25" width="380" height="104" rx="30" fill="var(--panel-bg)" stroke="currentColor" stroke-width="2" />
                    <!-- Each socket is the brand mark (brand/mark.svg); one lights up per running service. -->
                    <g
                      v-for="(x, index) in [176, 266, 356, 446]"
                      :key="x"
                      :transform="`translate(${x - 256 * 0.15} ${77 - 256 * 0.15}) scale(0.15)`"
                      class="home-socket"
                      :class="index < homeLiveSockets ? 'is-live' : ''"
                    >
                      <circle cx="256" cy="256" r="236" fill="var(--panel-muted)" />
                      <circle cx="256" cy="256" r="206" stroke="currentColor" stroke-width="30" />
                      <rect x="237" y="72" width="38" height="96" rx="19" fill="currentColor" />
                      <path d="M167 234 L211 275 L167 317" stroke="currentColor" stroke-width="30" stroke-linecap="round" stroke-linejoin="round" />
                      <path class="home-socket-cursor" d="M269 317 H345" stroke="currentColor" stroke-width="30" stroke-linecap="round" />
                    </g>
                    <circle cx="484" cy="42" r="5" :fill="homeLiveSockets ? 'var(--electric)' : 'currentColor'" />
                  </svg>
                </section>

                <section class="flex min-h-[470px] flex-col px-8 py-10 sm:px-12 xl:px-12 xl:py-14">
                  <div>
                    <h2 class="text-xl font-semibold tracking-[-0.025em] text-[var(--text-strong)]">
                      {{ homeProjectGroups.length ? 'Open a project' : 'Your projects' }}
                    </h2>
                    <p class="mt-1 text-sm text-[var(--text-muted)]">
                      {{ folderGroups.length ? folderGroups.length + ' tracked on this machine' : 'Nothing tracked on this machine yet' }}
                    </p>
                  </div>

                  <div v-if="loading" class="flex min-h-44 items-center justify-center" role="status" aria-label="Loading projects">
                    <span :class="spinnerClass" aria-hidden="true"></span>
                  </div>

                  <div v-else-if="homeProjectGroups.length" class="mt-7 border-t border-[var(--border)]">
                    <button
                      v-for="group in homeProjectGroups"
                      :key="group.key"
                      type="button"
                      class="group flex w-full items-center gap-4 border-b border-[var(--border)] px-1 py-4 text-left transition-colors duration-150 hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--primary)]"
                      @click="handleGroupClick(group)"
                    >
                      <span
                        :class="[statusDot, groupReadyCount(group) ? statusDotLive : '']"
                        :aria-label="groupReadyCount(group) ? groupReadyCount(group) + ' services live' : 'Idle'"
                      ></span>
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-[15px] font-semibold text-[var(--text-strong)]">{{ group.name }}</span>
                        <span class="mt-0.5 block truncate text-xs text-[var(--text-subtle)]">{{ group.path }}</span>
                      </span>
                      <span class="shrink-0 text-right text-xs text-[var(--text-muted)]">
                        <span v-if="groupReadyCount(group)" class="block font-medium text-[var(--electric)]">
                          {{ groupReadyCount(group) }} live
                        </span>
                        <span v-else class="block">{{ groupServiceCount(group) }} service{{ groupServiceCount(group) === 1 ? '' : 's' }}</span>
                      </span>
                      <svg viewBox="0 0 24 24" class="h-4 w-4 shrink-0 text-[var(--text-subtle)] transition-transform duration-150 group-hover:translate-x-0.5" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                        <path d="M9 5l7 7-7 7" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                    </button>
                  </div>

                  <div v-else-if="!recentImportable.length" class="flex flex-1 flex-col justify-center py-12">
                    <p class="max-w-sm text-lg font-medium text-[var(--text-strong)]">Choose a parent folder to begin.</p>
                    <p class="mt-2 max-w-sm text-sm leading-6 text-[var(--text-muted)]">
                      Services stay grouped under the folder you select, so one project remains one project.
                    </p>
                  </div>

                  <div v-if="recentImportable.length" class="mt-auto pt-10">
                    <div class="flex items-center justify-between gap-4">
                      <h2 class="text-sm font-semibold text-[var(--text-strong)]">
                        {{ homeProjectGroups.length ? 'Not tracked yet' : 'Recently found' }}
                      </h2>
                      <span class="text-xs text-[var(--text-subtle)]">Add in one click</span>
                    </div>
                    <div class="mt-3 border-t border-[var(--border)]">
                      <button
                        v-for="project in recentImportable"
                        :key="project.path"
                        type="button"
                        class="flex w-full items-center gap-3 border-b border-[var(--border)] px-1 py-3 text-left transition-colors duration-150 hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--primary)] disabled:cursor-wait disabled:opacity-60"
                        :disabled="importLoading[project.path]"
                        @click="importRecentProject(project)"
                      >
                        <span class="min-w-0 flex-1">
                          <span class="block truncate text-sm font-medium text-[var(--text-strong)]">{{ project.name }}</span>
                          <span class="mt-0.5 block truncate text-[11px] text-[var(--text-subtle)]">{{ project.path }}</span>
                        </span>
                        <span v-if="importLoading[project.path]" :class="spinnerClass" aria-hidden="true"></span>
                        <span v-else class="shrink-0 text-xs font-semibold text-[var(--text-muted)]">Add</span>
                      </button>
                    </div>
                  </div>

                  <p v-if="error" class="mt-4 text-sm text-[var(--warning-text)]" role="alert">{{ error }}</p>
                </section>
              </div>
            </div>
          </div>

          <div v-else-if="activeSection === 'projects'" class="h-full min-h-0">
            <div
              class="flex h-full w-full min-h-0 flex-col overflow-hidden rounded-2xl"
              :class="[panelProjectClass, noScrollbar]"
              :style="selectedGroup ? groupAccentStyle(selectedGroup) : undefined"
            >
              <div v-if="loading" class="flex items-center text-sm text-[var(--text-subtle)]">
                <span :class="spinnerClass" aria-hidden="true"></span>
                <span class="sr-only">Loading projects</span>
              </div>
              <div
                v-if="error"
                class="mb-3 flex items-start justify-between gap-3 rounded-xl bg-[var(--danger-bg)] px-3 py-2 text-sm text-[var(--danger-text)]"
                role="alert"
              >
                <span class="min-w-0 break-words">{{ error }}</span>
                <button class="shrink-0 rounded px-1 opacity-70 hover:opacity-100" aria-label="Dismiss error" @click="error = ''">×</button>
              </div>
              <div v-if="!selectedGroup" class="flex h-full flex-col items-center justify-center text-center text-[var(--text-muted)]">
                <p class="text-sm text-[var(--text-subtle)]">Choose a tracked project from the sidebar.</p>
                <button class="mt-4" :class="btnPanelSecondary" @click="goHome">Go home</button>
              </div>
              <transition v-else name="project-switch" mode="out-in">
                <div :key="selectedGroup.key" class="flex h-full min-h-0 flex-col">
                <div class="relative flex h-[82px] shrink-0 items-center justify-between gap-4 overflow-hidden border-b border-[var(--border)] px-5">
                  <div class="flex min-w-0 items-center gap-3">
                    <div class="flex items-center gap-2">
                      <span
                        class="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[var(--panel-muted)] text-sm font-semibold text-[var(--text-muted)]"
                      >
                        <img
                          v-if="groupFaviconUrl(selectedGroup)"
                          :src="groupFaviconUrl(selectedGroup)"
                          class="h-full w-full object-cover"
                          alt=""
                          @error="handleFaviconError(groupFaviconId(selectedGroup))"
                        />
                        <span v-else>{{ groupInitials(selectedGroup) }}</span>
                      </span>
                    </div>
                    <div class="min-w-0">
                      <p class="truncate text-xl font-semibold tracking-[-0.02em] text-[var(--text-strong)]">
                        {{ selectedGroup.name }}
                      </p>
                      <button
                        class="mt-0.5 inline-flex max-w-full items-center gap-1.5 rounded-md text-[11px] text-[var(--text-subtle)] transition-colors hover:text-[var(--text)]"
                        @click="openProjectInEditorOrFinder(selectedGroup)"
                        title="View source code"
                      >
                        <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.5">
                          <path d="M8 8l-4 4 4 4M16 8l4 4-4 4" stroke-linecap="round" stroke-linejoin="round" />
                        </svg>
                        <span class="truncate">{{ selectedGroup.path }}</span>
                      </button>
                    </div>
                  </div>
                  <div class="flex items-center justify-end gap-3">
                    <span v-if="groupHasNpmServices(selectedGroup)" class="text-xs font-medium text-[var(--text-muted)]">
                      {{ groupReadyCount(selectedGroup) }}/{{ groupServiceCount(selectedGroup) }} ready
                    </span>
                    <button
                      :class="groupHasRunning(selectedGroup) ? btnUnplugLg : btnPanelPrimaryLg"
                      :disabled="!groupHasNpmServices(selectedGroup) || !!groupActionLoading[selectedGroup.key]"
                      @click="groupHasRunning(selectedGroup) ? stopGroup(selectedGroup) : launchGroup(selectedGroup)"
                    >
                      <span v-if="groupActionLoading[selectedGroup.key]" :class="spinnerClass" aria-hidden="true"></span>
                      <svg v-else-if="!groupHasRunning(selectedGroup)" viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8">
                        <path d="M8 6l10 6-10 6z" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                      {{
                        groupActionLoading[selectedGroup.key] === 'launch'
                          ? 'Launching…'
                          : groupActionLoading[selectedGroup.key] === 'stop'
                          ? 'Unplugging…'
                          : groupHasRunning(selectedGroup)
                          ? 'Unplug'
                          : 'Launch'
                      }}
                    </button>
                  </div>
                </div>
                <div
                  v-if="selectedGroup.items.length && vscodeErrors[selectedGroup.items[0].project.id]"
                  class="mx-5 mt-3 rounded-md border border-[var(--warning-border)] bg-[var(--warning-bg)] px-3 py-2 text-xs text-[var(--warning-text)]"
                >
                  {{ vscodeErrors[selectedGroup.items[0].project.id] }}
                </div>

                <div class="flex-1 min-h-0 overflow-hidden">
                  <div
                    ref="projectSplitRef"
                    class="project-split grid h-full min-h-0 overflow-hidden transition-[grid-template-columns] duration-150 ease-out"
                    :style="projectSplitStyle"
                  >
                    <!-- Explicit columns: v-show's display:none would otherwise shift the panes into the collapsed 0px tracks. -->
                    <div
                      v-show="!servicesPaneCollapsed"
                      class="relative col-start-1 row-start-1 flex h-full min-h-0 min-w-0 flex-col gap-4 overflow-y-auto p-4"
                      :class="noScrollbar"
                    >
                      <div class="rounded-2xl bg-[var(--panel-bg)] p-3">
                        <div class="relative flex items-center justify-between gap-3">
                          <div class="flex items-center gap-2">
                            <svg viewBox="0 0 24 24" class="h-4 w-4 text-[var(--text-subtle)]" fill="none" stroke="currentColor" stroke-width="1.5">
                              <path d="M5 6h14v4H5z" stroke-linecap="round" stroke-linejoin="round" />
                              <path d="M5 14h14v4H5z" stroke-linecap="round" stroke-linejoin="round" />
                            </svg>
                            <p class="text-[15px] font-semibold text-[var(--text-strong)]">Services</p>
                          </div>
                          <button
                            type="button"
                            class="inline-flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-subtle)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text-strong)]"
                            title="Collapse services"
                            aria-label="Collapse services"
                            @click="toggleServicesPane"
                          >
                            <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.6">
                              <path d="M15 5l-7 7 7 7" stroke-linecap="round" stroke-linejoin="round" />
                            </svg>
                          </button>
                        </div>
                        <div class="mt-3 space-y-2">
                          <div v-if="npmServices.length === 0" class="text-sm text-[var(--text-subtle)]">
                            No script services found.
                          </div>
                          <div v-for="service in npmServices" :key="service.project.id">
                            <transition name="unfurl" mode="out-in">
                              <div
                                v-if="!service.status.running && !isActionDetailsOpen(service)"
                                :key="`summary-${service.project.id}`"
                                class="rounded-xl bg-[var(--panel-muted)] px-3 py-2 transition-colors hover:bg-[var(--hover)]"
                              >
                              <div class="flex items-center justify-between gap-3">
                                <div class="flex min-w-0 items-center gap-2">
                                  <span :class="statusDot"></span>
                                  <p class="truncate text-[13px] font-semibold text-[var(--text-strong)]">
                                    {{ projectTitle(service) }}
                                    <span
                                      v-if="serviceMetaLabels(service).length"
                                      class="ml-2 text-xs font-normal text-[var(--text-subtle)]"
                                    >
                                      {{ serviceMetaLabels(service).join(' · ') }}
                                    </span>
                                  </p>
                                </div>
                                <div class="flex items-center gap-2">
                                  <button
                                    :class="btnPanelSecondary"
                                    :disabled="isActionLoading('start', service.project.id)"
                                    @click="toggleService(service)"
                                  >
                                    <span v-if="isActionLoading('start', service.project.id)" :class="spinnerClass" aria-hidden="true"></span>
                                    {{ isActionLoading('start', service.project.id) ? 'Starting…' : 'Start' }}
                                  </button>
                                  <button
                                    :class="btnPanelIcon"
                                    title="Show details"
                                    @click="toggleActionDetails(service)"
                                  >
                                    <svg
                                      viewBox="0 0 24 24"
                                      class="h-4 w-4"
                                      fill="none"
                                      stroke="currentColor"
                                      stroke-width="1.5"
                                    >
                                      <path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round" />
                                    </svg>
                                  </button>
                                </div>
                              </div>
                              <div
                                v-if="startupConflictFor(service)"
                                class="mt-2 rounded-lg border border-[var(--warning-border)] bg-[var(--warning-bg)] px-3 py-2 text-xs text-[var(--warning-text)]"
                              >
                                <p>
                                  Another instance is already running at
                                  <span class="font-mono">{{ startupConflictSummary(service) }}</span>.
                                </p>
                                <button
                                  class="mt-2"
                                  :class="btnPanelSecondary"
                                  :disabled="isActionLoading('resolve-conflict', service.project.id, startupConflictFor(service)?.pid ?? 0)"
                                  @click="resolveStartupConflict(service)"
                                >
                                  <span
                                    v-if="isActionLoading('resolve-conflict', service.project.id, startupConflictFor(service)?.pid ?? 0)"
                                    :class="spinnerClass"
                                    aria-hidden="true"
                                  ></span>
                                  {{
                                    isActionLoading('resolve-conflict', service.project.id, startupConflictFor(service)?.pid ?? 0)
                                      ? 'Unplugging…'
                                      : 'Unplug and retry'
                                  }}
                                </button>
                              </div>
                              <div
                                v-if="actionErrors[service.project.id] && !startupConflictFor(service)"
                                class="mt-2 rounded-md border border-[var(--warning-border)] bg-[var(--warning-bg)] px-2 py-1 text-xs text-[var(--warning-text)]"
                              >
                                {{ actionErrors[service.project.id] }}
                              </div>
                              <div
                                v-if="service.status.error && !actionErrors[service.project.id] && !startupConflictFor(service)"
                                class="mt-2 rounded-md border border-[var(--warning-border)] bg-[var(--warning-bg)] px-2 py-1 text-xs text-[var(--warning-text)]"
                              >
                                {{ service.status.error }}
                              </div>
                              </div>

                              <div
                                v-else
                                :key="`details-${service.project.id}`"
                                class="relative overflow-hidden rounded-xl bg-[var(--panel-muted)] p-3"
                                :class="service.status.running ? 'powered-service' : ''"
                              >
                              <div class="flex items-start justify-between gap-3">
                                <div class="min-w-0">
                                  <div class="flex items-center gap-2">
                                    <span :class="[statusDot, serviceReady(service) ? statusDotLive : serviceFailed(service) ? statusDotFailed : '']" :aria-label="serviceStatusLabel(service)"></span>
                                    <p class="text-sm font-semibold text-[var(--text-strong)]">{{ projectTitle(service) }}</p>
                                    <span class="text-[10px] font-medium" :class="serviceFailed(service) ? 'text-[var(--log-error)]' : 'text-[var(--text-subtle)]'">{{ serviceStatusLabel(service) }}</span>
                                    <span v-if="serviceReady(service) && effectivePort(service)" class="font-mono text-[11px] text-[var(--text-subtle)]">
                                      :{{ effectivePort(service) }}
                                    </span>
                                    <span v-if="service.status.running && servicePid(service)" class="font-mono text-[10px] text-[var(--text-subtle)]">
                                      PID {{ servicePid(service) }}
                                    </span>
                                  </div>
                                  <div v-if="serviceMetaLabels(service).length" class="mt-2 text-xs text-[var(--text-subtle)]">
                                    {{ serviceMetaLabels(service).join(' · ') }}
                                  </div>
                                </div>
                                <div class="flex items-center gap-2">
                                  <button
                                    v-if="!service.status.running"
                                    :class="btnPanelIcon"
                                    title="Hide details"
                                    @click="toggleActionDetails(service)"
                                  >
                                    <svg
                                      viewBox="0 0 24 24"
                                      class="h-4 w-4 rotate-180"
                                      fill="none"
                                      stroke="currentColor"
                                      stroke-width="1.5"
                                    >
                                      <path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round" />
                                    </svg>
                                  </button>
                                </div>
                              </div>
                              <div class="mt-3 space-y-2.5">
                                <div v-if="!service.status.running" class="flex items-center gap-2">
                                  <input
                                    v-model="actionFor(service).command"
                                    :class="[inputBase, 'h-8 min-w-0 flex-1 py-1 font-mono text-[11px]']"
                                    placeholder="Start command"
                                    @input="actionCommandDirty[service.project.id] = true"
                                    @change="persistServiceCommand(service)"
                                  />
                                  <button
                                    v-if="service.project.command_source === 'user'"
                                    :class="btnPanelSecondary"
                                    title="Restore the automatically detected script"
                                    @click="resetServiceCommand(service)"
                                  >Auto</button>
                                </div>
                                <p v-else class="truncate font-mono text-[11px] text-[var(--text-muted)]" :title="actionFor(service).command || 'Not set'">
                                  {{ actionFor(service).command || 'Not set' }}
                                </p>
                                <div v-if="!service.status.running" class="flex flex-wrap items-center gap-3">
                                  <input
                                    v-model="actionFor(service).port"
                                    :class="[inputBase, 'w-24 text-sm']"
                                    placeholder="Port"
                                  />
                                </div>
                                <div
                                  v-if="!service.status.running && externalInstancesFor(service).length"
                                  class="rounded-lg border border-[var(--warning-border)] bg-[var(--warning-bg)] px-3 py-2 text-xs text-[var(--warning-text)]"
                                >
                                  <p v-if="startupConflictFor(service)">
                                    Another instance is already running at
                                    <span class="font-mono">{{ startupConflictSummary(service) }}</span>.
                                  </p>
                                  <p v-else>
                                    External instance detected:
                                    <span class="font-mono">{{ externalInstanceSummary(service) }}</span>
                                  </p>

                                  <div v-if="startupConflictFor(service)" class="mt-2 flex justify-end">
                                    <button
                                      :class="btnPanelSecondary"
                                      :disabled="isActionLoading('resolve-conflict', service.project.id, startupConflictFor(service)?.pid ?? 0)"
                                      @click="resolveStartupConflict(service)"
                                    >
                                      <span
                                        v-if="isActionLoading('resolve-conflict', service.project.id, startupConflictFor(service)?.pid ?? 0)"
                                        :class="spinnerClass"
                                        aria-hidden="true"
                                      ></span>
                                      {{
                                        isActionLoading('resolve-conflict', service.project.id, startupConflictFor(service)?.pid ?? 0)
                                          ? 'Unplugging…'
                                          : 'Unplug and retry'
                                      }}
                                    </button>
                                  </div>

                                  <div v-else class="relative mt-2 flex justify-end">
                                    <button :class="btnPanelSecondary" @click.stop="toggleExternalMenu(service)">
                                      Resolve
                                    </button>
                                    <transition name="fade">
                                      <div
                                        v-if="externalMenuOpen[service.project.id]"
                                        class="absolute right-0 top-full z-10 mt-2 w-44 rounded-lg border border-[var(--border)] bg-[var(--panel-bg)] p-1 shadow-lg"
                                        @click.stop
                                      >
                                        <button
                                          class="flex w-full items-center rounded-md px-2 py-1.5 text-xs text-[var(--text)] hover:bg-[var(--hover)]"
                                          :disabled="!externalPrimaryInstance(service)?.pid"
                                          @click="
                                            killExternalInstance(service);
                                            closeExternalMenus();
                                          "
                                        >
                                          Unplug external
                                        </button>
                                        <button
                                          class="flex w-full items-center rounded-md px-2 py-1.5 text-xs text-[var(--text)] hover:bg-[var(--hover)]"
                                          @click="
                                            startAnotherInstance(service);
                                            closeExternalMenus();
                                          "
                                        >
                                          Start another instance
                                        </button>
                                      </div>
                                    </transition>
                                  </div>
                                </div>
                                <div v-else class="flex justify-end">
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
                                    {{
                                      serviceStarting(service)
                                        ? 'Starting…'
                                        : isActionLoading(service.status.running ? 'stop' : 'start', service.project.id)
                                        ? service.status.running
                                          ? 'Unplugging…'
                                          : 'Starting…'
                                        : service.status.running
                                        ? 'Unplug'
                                        : 'Start'
                                    }}
                                  </button>
                                </div>
                              </div>
                              <div
                                v-if="actionErrors[service.project.id] && !startupConflictFor(service)"
                                class="mt-2 rounded-md border border-[var(--warning-border)] bg-[var(--warning-bg)] px-2 py-1 text-xs text-[var(--warning-text)]"
                              >
                                {{ actionErrors[service.project.id] }}
                              </div>
                              <div
                                v-if="service.status.error && !actionErrors[service.project.id] && !startupConflictFor(service)"
                                class="mt-2 rounded-md border border-[var(--warning-border)] bg-[var(--warning-bg)] px-2 py-1 text-xs text-[var(--warning-text)]"
                              >
                                {{ service.status.error }}
                              </div>
                              <div
                                v-if="serviceReady(service) && effectivePort(service)"
                                class="mt-3 flex items-center justify-between rounded-xl bg-[var(--highlight-bg)] px-2.5 py-2 text-[11px] text-[var(--text-muted)]"
                              >
                                <span class="truncate">
                                  <span class="font-mono text-[var(--text)]">http://localhost:{{ effectivePort(service) }}</span>
                                </span>
                                <div class="flex shrink-0 items-center gap-1">
                                  <button
                                    class="inline-flex h-7 w-7 items-center justify-center rounded-md bg-[#343434] text-white transition-colors hover:bg-[#252525]"
                                    :title="copiedServiceUrlId === service.project.id ? 'Copied' : 'Copy link'"
                                    :aria-label="copiedServiceUrlId === service.project.id ? 'Link copied' : 'Copy link'"
                                    @click="copyProjectUrl(service)"
                                  >
                                    <svg v-if="copiedServiceUrlId === service.project.id" viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8">
                                      <path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round" />
                                    </svg>
                                    <svg v-else viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.5">
                                      <rect x="8" y="8" width="10" height="10" rx="2" />
                                      <path d="M6 15H5a2 2 0 01-2-2V5a2 2 0 012-2h8a2 2 0 012 2v1" stroke-linecap="round" />
                                    </svg>
                                  </button>
                                  <button
                                    class="inline-flex h-7 w-7 items-center justify-center rounded-md bg-[#343434] text-white transition-colors hover:bg-[#252525]"
                                    title="Open in system browser"
                                    aria-label="Open link in system browser"
                                    @click="openProjectUrl(service)"
                                  >
                                    <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.7">
                                      <path d="M5 12h13M13 7l5 5-5 5" stroke-linecap="round" stroke-linejoin="round" />
                                    </svg>
                                  </button>
                                  <button
                                    class="inline-flex h-7 items-center justify-center rounded-md bg-[var(--ghost-bg)] px-2 text-[10px] font-medium text-[var(--ghost-text)] transition-colors hover:bg-[var(--ghost-hover)]"
                                    title="Open in Multiprise"
                                    @click="openInAppBrowser(service)"
                                  >
                                    Open here
                                  </button>
                                </div>
                              </div>
                              <div
                                v-if="(processInstances[service.project.id] ?? []).length"
                                class="mt-2 space-y-1 border-t border-[var(--border)] pt-2"
                              >
                                <div
                                  v-for="instance in processInstances[service.project.id] ?? []"
                                  :key="`${service.project.id}-${instance.pid}-${instance.port ?? 'n'}`"
                                  class="flex items-center justify-between gap-2 text-[11px] text-[var(--text-subtle)]"
                                >
                                  <span class="min-w-0 truncate">
                                    <span class="font-mono text-[var(--text-muted)]">
                                      {{ instance.port ? `:${instance.port}` : 'port unknown' }}
                                    </span>
                                    <span class="ml-2">{{ instance.source === 'docker' ? 'Docker' : `PID ${instance.pid}` }}</span>
                                  </span>
                                  <button
                                    v-if="instance.source === 'external'"
                                    class="rounded px-1.5 py-1 text-[10px] text-[var(--text-muted)] hover:bg-[var(--hover)]"
                                    :disabled="isActionLoading('kill', service.project.id, instance.pid)"
                                    @click="killInstance(service, instance.pid)"
                                  >
                                    Unplug
                                  </button>
                                </div>
                              </div>
                              </div>
                            </transition>
                          </div>
                        </div>
                      </div>

                      <div
                        v-if="dockerServices.length"
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
                            v-for="service in dockerServices"
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


                    </div>

                    <button
                      v-show="!servicesPaneCollapsed"
                      type="button"
                      class="group relative z-10 col-start-2 row-start-1 flex h-full min-h-0 cursor-col-resize touch-none items-center justify-center outline-none"
                      title="Drag to resize · Double-click to reset"
                      aria-label="Resize services and output panels"
                      @pointerdown="startServiceResize"
                      @dblclick="resetServiceSplit"
                    >
                      <span class="h-10 w-1 rounded-full bg-[var(--border)] transition-colors group-hover:bg-[var(--primary)]"></span>
                    </button>

                    <div class="col-start-3 row-start-1 flex h-full min-h-0 min-w-0 flex-col p-4">
                      <div class="focus-panel relative flex h-full min-h-0 flex-col overflow-hidden rounded-2xl bg-[#343434] p-4">
                        <div class="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 pb-3">
                          <div class="flex min-w-0 items-center gap-2">
                            <button
                              v-if="servicesPaneCollapsed"
                              type="button"
                              class="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium text-white/55 transition-colors hover:bg-white/10 hover:text-white"
                              title="Show services"
                              @click="toggleServicesPane"
                            >
                              <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.6">
                                <path d="M9 5l7 7-7 7" stroke-linecap="round" stroke-linejoin="round" />
                              </svg>
                              Services
                            </button>
                            <div class="flex items-center rounded-lg bg-black/15 p-1" role="tablist" aria-label="Project output">
                            <button
                              class="rounded-md px-3 py-1.5 text-xs font-semibold transition-colors"
                              :class="projectPanelMode === 'logs' ? 'bg-white/[0.12] text-white' : 'text-white/55 hover:text-white'"
                              @click="projectPanelMode = 'logs'"
                            >
                              Logs
                            </button>
                            <button
                              class="flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors"
                              :class="projectPanelMode === 'browser' ? 'bg-white/[0.12] text-white' : 'text-white/55 hover:text-white'"
                              @click="projectPanelMode = 'browser'"
                            >
                              Browser
                              <span v-if="browserState.tabs.length" class="rounded bg-white/10 px-1.5 py-0.5 text-[9px] text-white/70">{{ browserState.tabs.length }}</span>
                            </button>
                            </div>
                          </div>
                          <span v-if="projectPanelMode === 'logs'" class="flex items-center gap-2 text-[11px] text-white/45">
                            <span class="h-1.5 w-1.5 rounded-full bg-[var(--live)]" :class="documentVisible ? 'animate-pulse' : 'opacity-40'"></span>
                            {{ documentVisible ? 'Live' : 'Paused' }} · {{ selectedLogLines.length }} lines
                          </span>
                          <span v-else-if="activeBrowserTab?.detached" class="text-[11px] text-white/45">Detached window</span>
                        </div>

                        <template v-if="projectPanelMode === 'logs'">
                          <div class="mt-3 flex flex-wrap items-center gap-1.5">
                            <input
                              v-model="logFilter"
                              :class="[inputBase, 'h-8 w-full py-1.5 text-xs sm:w-auto sm:flex-1']"
                              placeholder="Search logs"
                            />
                            <button
                              class="h-8 rounded-lg border px-2.5 text-[11px] transition-colors"
                              :class="logRoleFilter === 'all' && logLevelFilter === 'all' ? 'border-[var(--text-muted)] bg-[var(--chip-active-bg)] text-[var(--text-strong)]' : 'border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--hover)]'"
                              @click="logRoleFilter = 'all'; logLevelFilter = 'all'"
                            >All</button>
                            <button
                              class="h-8 rounded-lg border px-2.5 text-[11px] transition-colors"
                              :class="logLevelFilter === 'errors' ? 'border-[var(--log-error)] bg-[var(--danger-bg)] text-[var(--log-error)]' : 'border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--hover)]'"
                              @click="logLevelFilter = logLevelFilter === 'errors' ? 'all' : 'errors'"
                            >Errors</button>
                            <button
                              class="h-8 rounded-lg border px-2.5 text-[11px] transition-colors"
                              :class="logLevelFilter === 'warnings' ? 'border-[var(--log-warning)] text-[var(--log-warning)]' : 'border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--hover)]'"
                              @click="logLevelFilter = logLevelFilter === 'warnings' ? 'all' : 'warnings'"
                            >Warnings</button>
                            <button
                              class="h-8 rounded-lg border px-2.5 text-[11px] transition-colors"
                              :class="logRoleFilter === 'backend' ? 'border-[var(--log-backend)] text-[var(--log-backend)]' : 'border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--hover)]'"
                              @click="logRoleFilter = logRoleFilter === 'backend' ? 'all' : 'backend'"
                            >Backend</button>
                            <button
                              class="h-8 rounded-lg border px-2.5 text-[11px] transition-colors"
                              :class="logRoleFilter === 'frontend' ? 'border-[var(--log-frontend)] text-[var(--log-frontend)]' : 'border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--hover)]'"
                              @click="logRoleFilter = logRoleFilter === 'frontend' ? 'all' : 'frontend'"
                            >Frontend</button>
                          </div>
                          <div class="relative mt-3 flex-1 min-h-0">
                            <div
                              ref="logsScrollRef"
                              class="relative h-full min-h-0 overflow-y-auto rounded-xl bg-[var(--log-bg)] px-2 py-2.5 font-mono text-[11px] leading-[1.55]"
                              :class="noScrollbar"
                              @scroll="handleLogsScroll"
                            >
                              <div v-if="selectedLogLines.length === 0" class="flex h-full min-h-[220px] items-center justify-center">
                                <svg viewBox="0 0 48 48" class="h-9 w-9 text-[var(--text-subtle)] opacity-55" fill="none" stroke="currentColor" stroke-width="1.5">
                                  <path d="M16 8v10M30 8v10M12 18h22v4c0 7-5 12-11 12v7" stroke-linecap="round" stroke-linejoin="round" />
                                  <path d="M34 34l7 7M41 34l-7 7" stroke-linecap="round" />
                                </svg>
                              </div>
                              <div
                                v-for="entry in selectedLogLines"
                                :key="`${entry.timestamp}-${entry.serviceName}-${entry.line}`"
                                class="flex min-w-0 gap-2 border-l-2 px-2 py-0.5"
                                :class="logRowTone(entry)"
                              >
                                <span class="w-[58px] shrink-0 text-[10px] text-[var(--text-subtle)]">{{ formatTime(entry.timestamp) }}</span>
                                <span class="w-[58px] shrink-0 truncate text-[10px] font-semibold" :class="logServiceTone(entry)">{{ entry.serviceName }}</span>
                                <span class="min-w-0 flex-1 whitespace-pre-wrap break-words" :class="logLineTone(entry)" v-html="highlightText(entry.line, logFilter)"></span>
                              </div>
                            </div>
                            <button
                              v-if="!logsPinnedToBottom"
                              class="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-[var(--border)] bg-[var(--panel-bg)] px-3 py-1.5 text-[11px] text-[var(--text)] shadow-lg hover:bg-[var(--hover)]"
                              @click="jumpToLatest"
                            >Jump to latest</button>
                          </div>
                        </template>

                        <template v-else>
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
                          <div v-else ref="browserViewportRef" class="min-h-0 flex-1 rounded-b-xl bg-white"></div>
                        </template>
                      </div>
                    </div>
                  </div>
                </div>
                </div>
              </transition>
            </div>
          </div>

          <div v-else class="h-full min-h-0">
            <div class="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl" :class="panelProjectClass">
              <div class="flex h-[76px] shrink-0 items-center justify-between gap-4 border-b border-[var(--border)] px-5">
                <div>
                  <p class="text-lg font-semibold text-[var(--text-strong)]">Settings</p>
                  <p class="mt-0.5 text-xs text-[var(--text-subtle)]">Control how multiprise launches and discovers projects.</p>
                </div>
                <div class="flex items-center gap-3">
                  <span v-if="saveFeedback === 'saved'" class="text-xs text-[var(--success-text)]">Changes saved</span>
                  <span v-else-if="saveFeedback === 'error'" class="text-xs text-[var(--warning-text)]">Could not save changes</span>
                  <span v-if="!settingsLoaded" class="text-xs text-[var(--warning-text)]">Sync pending</span>
                  <button
                    :class="[
                      btnPanelPrimary,
                      'h-10 px-5',
                      saveFeedback === 'saved'
                        ? 'ring-2 ring-[var(--success-border)]'
                        : saveFeedback === 'noop' || saveFeedback === 'error'
                        ? 'ring-2 ring-[var(--warning-border)]'
                        : ''
                    ]"
                    :disabled="settingsSaving"
                    @click="saveSettings"
                  >
                    <span class="inline-flex min-w-[68px] items-center justify-center">
                      <svg v-if="saveFeedback === 'saved'" viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                      <span v-else>{{ settingsSaving ? 'Saving…' : 'Save' }}</span>
                    </span>
                  </button>
                </div>
              </div>

              <div class="min-h-0 flex-1 overflow-y-auto p-5" :class="noScrollbar">
                <div class="grid w-full gap-4 lg:grid-cols-2">
                  <section class="rounded-2xl bg-[var(--panel-muted)] p-5 lg:col-span-2">
                    <div class="flex items-center justify-between gap-4">
                      <div>
                        <p class="text-[15px] font-semibold text-[var(--text-strong)]">Appearance</p>
                        <p class="mt-1 text-xs text-[var(--text-subtle)]">Choose the workspace theme.</p>
                      </div>
                      <div class="flex rounded-xl bg-[var(--panel-bg)] p-1">
                        <button
                          type="button"
                          class="flex items-center gap-2 rounded-lg px-4 py-2 text-sm transition-colors duration-150"
                          :class="settingsDraft.theme === 'light' ? 'bg-[var(--primary)] text-[var(--primary-text)]' : 'text-[var(--text-muted)] hover:bg-[var(--hover)]'"
                          @click="settingsDraft.theme = 'light'"
                        >
                          <span class="h-3 w-3 rounded-full border border-black/10 bg-white"></span>
                          Light
                        </button>
                        <button
                          type="button"
                          class="flex items-center gap-2 rounded-lg px-4 py-2 text-sm transition-colors duration-150"
                          :class="settingsDraft.theme === 'dark' ? 'bg-[var(--primary)] text-[var(--primary-text)]' : 'text-[var(--text-muted)] hover:bg-[var(--hover)]'"
                          @click="settingsDraft.theme = 'dark'"
                        >
                          <span class="h-3 w-3 rounded-full bg-[#27272B]"></span>
                          Dark
                        </button>
                      </div>
                    </div>
                  </section>
                  <section class="rounded-2xl bg-[var(--panel-muted)] p-5">
                    <div>
                      <p class="text-[15px] font-semibold text-[var(--text-strong)]">Port assignment</p>
                      <p class="mt-1 text-xs leading-5 text-[var(--text-subtle)]">
                        Choose whether multiprise selects free ports or asks before every launch.
                      </p>
                    </div>

                    <div class="mt-5 grid grid-cols-2 rounded-xl border border-[var(--border)] bg-[var(--panel-muted)] p-1">
                      <button
                        type="button"
                        class="rounded-lg px-3 py-2 text-sm transition-colors"
                        :class="settingsDraft.auto_port ? 'bg-[var(--electric)] text-[var(--primary-text)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'"
                        @click="settingsDraft.auto_port = true"
                      >
                        Automatic
                      </button>
                      <button
                        type="button"
                        class="rounded-lg px-3 py-2 text-sm transition-colors"
                        :class="!settingsDraft.auto_port ? 'bg-[var(--electric)] text-[var(--primary-text)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'"
                        @click="settingsDraft.auto_port = false"
                      >
                        Ask every time
                      </button>
                    </div>

                    <div class="mt-5 border-t border-[var(--border)] pt-4" :class="!settingsDraft.auto_port ? 'opacity-45' : ''">
                      <div>
                        <p class="text-sm text-[var(--text)]">Fallback base port</p>
                        <p class="mt-0.5 text-xs text-[var(--text-subtle)]">Starting point when a service has no role-specific range.</p>
                      </div>
                      <input
                        v-model.number="settingsDraft.port_base"
                        type="number"
                        min="1"
                        max="65535"
                        :disabled="!settingsDraft.auto_port"
                        :class="[inputBase, 'mt-3 !w-36 text-left text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none']"
                      />
                    </div>
                  </section>

                  <section class="rounded-2xl bg-[var(--panel-muted)] p-5">
                    <div>
                      <p class="text-[15px] font-semibold text-[var(--text-strong)]">Launch readiness</p>
                      <p class="mt-1 text-xs leading-5 text-[var(--text-subtle)]">Prepare dependencies and decide how long services have to open their port.</p>
                    </div>
                    <div class="mt-5 flex items-center justify-between gap-4">
                      <span>
                        <span class="block text-sm text-[var(--text)]">Prepare automatically</span>
                        <span class="mt-0.5 block text-xs text-[var(--text-subtle)]">Install missing dependencies and build missing startup targets.</span>
                      </span>
                      <div class="flex shrink-0 rounded-lg bg-[var(--panel-bg)] p-1">
                        <button type="button" class="rounded-md px-3 py-1.5 text-xs transition-colors" :class="settingsDraft.auto_install ? 'bg-[var(--primary)] text-[var(--primary-text)]' : 'text-[var(--text-muted)] hover:bg-[var(--hover)]'" @click="settingsDraft.auto_install = true">On</button>
                        <button type="button" class="rounded-md px-3 py-1.5 text-xs transition-colors" :class="!settingsDraft.auto_install ? 'bg-[var(--primary)] text-[var(--primary-text)]' : 'text-[var(--text-muted)] hover:bg-[var(--hover)]'" @click="settingsDraft.auto_install = false">Off</button>
                      </div>
                    </div>
                    <label class="mt-5 block border-t border-[var(--border)] pt-4">
                      <span class="block text-sm text-[var(--text)]">Startup timeout</span>
                      <span class="mt-0.5 block text-xs text-[var(--text-subtle)]">Wait 10–30 seconds for the assigned port to become ready.</span>
                      <div class="mt-3 flex items-center gap-2">
                        <input v-model.number="settingsDraft.startup_timeout_ms" type="number" min="10000" max="30000" step="1000" :class="[inputBase, '!w-36 text-left text-sm']" />
                        <span class="text-xs text-[var(--text-subtle)]">milliseconds</span>
                      </div>
                    </label>
                  </section>

                  <section class="rounded-2xl bg-[var(--panel-muted)] p-5">
                    <div>
                      <p class="text-[15px] font-semibold text-[var(--text-strong)]">Project discovery</p>
                      <p class="mt-1 text-xs leading-5 text-[var(--text-subtle)]">
                        Tune how deeply selected folders are inspected for launchable projects.
                      </p>
                    </div>

                    <div class="mt-5 space-y-5">
                      <label class="block">
                        <span>
                          <span class="block text-sm text-[var(--text)]">Scan depth</span>
                          <span class="mt-0.5 block text-xs text-[var(--text-subtle)]">Maximum nested folders to inspect.</span>
                        </span>
                        <input
                          v-model.number="settingsDraft.scan_depth"
                          type="number"
                          min="1"
                          max="64"
                          :class="[inputBase, 'mt-3 !w-36 text-left text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none']"
                        />
                      </label>

                      <label class="block border-t border-[var(--border)] pt-4">
                        <span class="block text-sm text-[var(--text)]">Ignored folders</span>
                        <span class="mt-0.5 block text-xs text-[var(--text-subtle)]">Comma-separated names skipped during scanning.</span>
                        <input
                          v-model="scanIgnoreDraft"
                          :class="[inputBase, 'mt-3 text-sm']"
                          placeholder="node_modules, .git, dist"
                        />
                      </label>
                    </div>
                  </section>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>

    <div v-if="groupMenuOpen" class="fixed inset-0 z-40" @click="closeGroupMenu"></div>
    <transition name="fade">
      <div
        v-if="groupMenuOpen && groupMenuGroup"
        class="fixed z-50 w-48 rounded-lg border border-[var(--border)] bg-[var(--panel-bg)] shadow-lg"
        :style="{ left: `${groupMenuX}px`, top: `${groupMenuY}px` }"
        @click.stop
      >
        <div class="px-3 pt-2 text-xs text-[var(--text-subtle)]">{{ groupMenuGroup.name }}</div>
        <div class="mt-2 space-y-1 p-2">
          <button
            class="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs text-[var(--text)] hover:bg-[var(--hover)]"
            :disabled="!groupHasNpmServices(groupMenuGroup) || !!groupActionLoading[groupMenuGroup.key]"
            @click="
              groupHasRunning(groupMenuGroup) ? stopGroup(groupMenuGroup) : launchGroup(groupMenuGroup);
              closeGroupMenu();
            "
          >
            <span>
              {{
                groupActionLoading[groupMenuGroup.key] === 'launch'
                  ? 'Launching…'
                  : groupActionLoading[groupMenuGroup.key] === 'stop'
                  ? 'Unplugging…'
                  : groupHasRunning(groupMenuGroup)
                  ? 'Unplug'
                  : 'Launch'
              }}
            </span>
          </button>
          <button
            class="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs text-[var(--text)] hover:bg-[var(--hover)]"
            @click="
              deleteGroup(groupMenuGroup);
              closeGroupMenu();
            "
          >
            <span>Untrack</span>
          </button>
        </div>
      </div>
    </transition>

    <transition name="modal-fade">
      <div
        v-if="manualPortTarget"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5"
        @click.self="closeManualPortPrompt"
      >
        <transition name="modal-slide">
          <div
            v-if="manualPortTarget"
            class="w-[min(520px,94vw)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] shadow-2xl"
          >
            <div class="flex items-start justify-between border-b border-[var(--border)] px-5 py-4">
              <div>
                <h2 class="text-lg font-semibold text-[var(--text-strong)]">Choose launch ports</h2>
                <p class="mt-0.5 text-xs text-[var(--text-subtle)]">Manual assignment is enabled. Every service needs a unique port.</p>
              </div>
              <button :class="btnPanelIcon" title="Close" @click="closeManualPortPrompt">
                <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M6 6l12 12M18 6l-12 12" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </div>

            <div class="space-y-2 p-5">
              <label
                v-for="service in manualPortServices"
                :key="service.project.id"
                class="flex items-center justify-between gap-5 rounded-lg border border-[var(--border)] bg-[var(--panel-muted)] px-3 py-3"
              >
                <span class="min-w-0">
                  <span class="block truncate text-sm font-medium text-[var(--text)]">{{ projectTitle(service) }}</span>
                  <span class="mt-0.5 block text-[11px] capitalize text-[var(--text-subtle)]">{{ serviceRole(service) }}</span>
                </span>
                <input
                  v-model="manualPortInputs[service.project.id]"
                  type="number"
                  min="1"
                  max="65535"
                  :class="[inputBase, '!w-28 shrink-0 text-right font-mono text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none']"
                  placeholder="Port"
                  @input="manualPortError = ''"
                />
              </label>
              <p v-if="manualPortError" class="text-xs text-[var(--warning-text)]">{{ manualPortError }}</p>
            </div>

            <div class="flex items-center justify-end gap-2 border-t border-[var(--border)] px-5 py-4">
              <button :class="btnPanelTertiary" @click="closeManualPortPrompt">Cancel</button>
              <button :class="btnPanelPrimary" :disabled="!manualPortsValid" @click="confirmManualPorts">
                Launch
              </button>
            </div>
          </div>
        </transition>
      </div>
    </transition>

    <transition name="modal-fade">
      <div v-if="pickerOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5" @click.self="closePicker">
        <transition name="modal-slide">
          <div
            v-if="pickerOpen"
            class="flex max-h-[min(680px,calc(100vh-56px))] w-[min(720px,94vw)] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] shadow-2xl"
          >
            <div class="flex shrink-0 items-start justify-between border-b border-[var(--border)] px-5 py-4">
              <div>
                <h2 class="text-lg font-semibold text-[var(--text-strong)]">Add Projects</h2>
                <p class="mt-0.5 text-xs text-[var(--text-subtle)]">Choose project folders. Multiprise discovers runnable services automatically.</p>
              </div>
              <button :class="btnPanelIcon" title="Close" @click="closePicker">
                <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M6 6l12 12M18 6l-12 12" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </div>

            <div class="min-h-0 flex-1 overflow-y-auto p-5" :class="noScrollbar">
              <div class="flex items-center justify-between gap-4">
                <div>
                  <p class="text-sm font-medium text-[var(--text-strong)]">Project folders</p>
                  <p class="text-xs text-[var(--text-subtle)]">You can select more than one folder at a time.</p>
                </div>
                <button :class="btnPanelPrimary" @click="pickFolders">Choose folders</button>
              </div>

              <div class="mt-4 rounded-lg border border-[var(--border)] bg-[var(--panel-muted)] p-2">
                  <div v-if="selectedFolders.length === 0" class="flex min-h-28 items-center justify-center px-4 text-center text-sm text-[var(--text-subtle)]">
                    No folders selected yet.
                  </div>
                  <div
                    v-for="folder in selectedFolders"
                    :key="folder"
                    class="mb-2 rounded-lg border border-[var(--border)] bg-[var(--panel-bg)] px-3 py-2.5 last:mb-0"
                    :class="projectPreviewMap[folder]?.has_services ? '' : 'opacity-60'"
                  >
                    <div class="flex items-center justify-between gap-3">
                      <div class="min-w-0">
                        <p class="truncate text-sm font-medium text-[var(--text)]">{{ folderLabel(folder) }}</p>
                        <p class="mt-0.5 truncate text-[11px] text-[var(--text-subtle)]">{{ folder }}</p>
                      </div>
                      <button :class="btnPanelIcon" @click="removeSelectedFolder(folder)" title="Remove">
                        <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.5">
                          <path d="M6 6l12 12M18 6l-12 12" stroke-linecap="round" stroke-linejoin="round" />
                        </svg>
                      </button>
                    </div>
                    <div class="mt-2">
                      <div v-if="projectPreviewMap[folder]?.has_services" class="flex flex-wrap gap-1.5">
                        <span
                          v-for="service in projectPreviewMap[folder]?.services ?? []"
                          :key="`${folder}-${service.name}-${service.cwd ?? ''}`"
                          class="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--panel-muted)] px-2 py-1 text-[11px] text-[var(--text-muted)]"
                          :title="service.start"
                        >
                          <span class="font-medium text-[var(--text)]">{{ service.name }}</span>
                          <span class="truncate font-mono text-[10px] text-[var(--text-subtle)]">{{ service.start }}</span>
                        </span>
                      </div>
                      <div v-else-if="projectPreviewMap[folder]?.error" class="text-xs text-[var(--warning-text)]">
                        {{ projectPreviewMap[folder]?.error }}
                      </div>
                      <div v-else class="text-xs text-[var(--text-subtle)]">Discovering services…</div>
                    </div>
                  </div>
              </div>

              <details v-if="folderGroups.length" class="mt-4 rounded-lg border border-[var(--border)] bg-[var(--panel-muted)]">
                <summary class="cursor-pointer select-none px-3 py-2.5 text-xs font-medium text-[var(--text-muted)]">
                  Manage tracked projects · {{ folderGroups.length }}
                </summary>
                <div class="max-h-44 space-y-1 overflow-y-auto border-t border-[var(--border)] p-2" :class="noScrollbar">
                  <div v-for="group in folderGroups" :key="group.key" class="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-[var(--hover)]">
                    <div class="min-w-0">
                      <p class="truncate text-xs text-[var(--text)]">{{ group.name }}</p>
                      <p class="truncate text-[10px] text-[var(--text-subtle)]">{{ group.path }}</p>
                    </div>
                    <button class="rounded-md px-2 py-1 text-[11px] text-[var(--text-muted)] hover:bg-[var(--panel-bg)]" @click="deleteGroup(group)">
                      Untrack
                    </button>
                  </div>
                </div>
              </details>

              <p v-if="error" class="mt-3 text-xs text-[var(--warning-text)]">{{ error }}</p>
            </div>

            <div class="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border)] px-5 py-4">
                  <button :class="btnPanelTertiary" @click="closePicker">Cancel</button>
                  <button
                    :class="btnPanelPrimary"
                    @click="addSelectedProjects"
                    :disabled="validSelectedFolders.length === 0 || addingProjects"
                  >
                    <span v-if="addingProjects" :class="spinnerClass" aria-hidden="true"></span>
                    {{ addingProjects ? 'Adding…' : `Add ${validSelectedFolders.length || ''} project${validSelectedFolders.length === 1 ? '' : 's'}` }}
                  </button>
            </div>
          </div>
        </transition>
      </div>
    </transition>

  </div>
</template>

<style scoped>
.app-drag-region {
  -webkit-app-region: drag;
}

:global(body.resizing-project-panes),
:global(body.resizing-project-panes *) {
  cursor: col-resize !important;
  user-select: none !important;
}

:global(body.resizing-project-panes) .project-split {
  transition: none !important;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.unfurl-enter-active,
.unfurl-leave-active {
  overflow: hidden;
  transition: max-height 0.18s ease;
}

.unfurl-enter-from,
.unfurl-leave-to {
  max-height: 0;
}

.unfurl-enter-to,
.unfurl-leave-from {
  max-height: 640px;
}

.project-switch-enter-active,
.project-switch-leave-active {
  transition: opacity 0.08s ease, transform 0.1s ease-out;
}

.project-switch-enter-from {
  opacity: 0;
  transform: translateY(3px);
}

.project-switch-leave-to {
  opacity: 0;
  transform: translateY(-2px);
}

.multiprise-shell,
.multiprise-shell aside,
.multiprise-shell section {
  transition: background-color 0.18s ease, border-color 0.18s ease, color 0.18s ease;
}

.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity 0.2s ease;
}

.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}

.modal-slide-enter-active,
.modal-slide-leave-active {
  transition: transform 0.25s ease, opacity 0.25s ease;
}

.modal-slide-enter-from,
.modal-slide-leave-to {
  opacity: 0;
  transform: translateY(12px);
}

.multiprise-shell {
  background: var(--app-bg);
}

.multiprise-shell::before {
  position: absolute;
  inset: 0;
  pointer-events: none;
  content: "";
  background-image:
    linear-gradient(var(--circuit) 1px, transparent 1px),
    linear-gradient(90deg, var(--circuit) 1px, transparent 1px);
  background-position: 0 0;
  background-size: 44px 44px;
}


.focus-panel {
  --text: #E7E5E0;
  --text-muted: #B2B0AA;
  --text-subtle: #85858C;
  --text-strong: #FAFAF8;
  --border: #505050;
  --hover: #464646;
  --selection: #464646;
  --panel-bg: #3B3B3B;
  --panel-muted: #343434;
  --ghost-bg: #454545;
  --ghost-hover: #515151;
  --ghost-text: #F0EFEB;
  --input-bg: #2A2A2A;
  --input-border: #555555;
  --input-text: #F5F4F0;
  --input-placeholder: #85858C;
  --chip-active-bg: #474747;
  --danger-bg: #4A302D;
}

.home-socket {
  color: var(--text-subtle);
  transition: color 0.4s ease;
}
.home-socket.is-live {
  color: var(--electric);
}
.home-socket.is-live .home-socket-cursor {
  animation: home-socket-blink 1.1s steps(1) infinite;
}
@keyframes home-socket-blink {
  50% { opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .home-socket.is-live .home-socket-cursor { animation: none; }
}

.powered-service {
  background: var(--panel-muted);
}

@media (prefers-reduced-motion: reduce) {
  .animate-current-flow,
  .animate-electric-pulse {
    animation: none !important;
  }

  .project-switch-enter-active,
  .project-switch-leave-active,
  .multiprise-shell,
  .multiprise-shell aside,
  .multiprise-shell section {
    transition: none !important;
  }
}

</style>
