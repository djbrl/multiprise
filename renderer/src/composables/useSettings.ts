import { computed, reactive, ref } from 'vue'
import { apiFetch, jsonBody } from '../lib/api'
import { readStoredJson, STORAGE_KEYS, writeStoredJson } from '../lib/storage'
import { normalizeTheme } from '../theme'
import { type Settings } from '../types'

// The saved settings, and the draft the Settings page edits until Save.

const defaults = (): Settings => ({
  auto_port: true,
  auto_install: true,
  notifications: true,
  auto_restart: true,
  hostnames: true,
  proxy_port: 7331,
  onboarded: false,
  port_base: 3000,
  startup_timeout_ms: 20000,
  scan_depth: 8,
  scan_ignore: [],
  theme: 'light'
})

const settings = reactive<Settings>(defaults())
const settingsDraft = reactive<Settings>(defaults())
// Edited as text; split on commas when saved.
const scanIgnoreDraft = ref('')
const settingsSaving = ref(false)
const settingsLoaded = ref(false)
const saveFeedback = ref<'saved' | 'noop' | 'error' | ''>('')
let saveFeedbackTimer: number | undefined

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(Math.floor(value), min), max)
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function applySettingsPatch(patch: Partial<Settings>) {
  for (const key of ['auto_port', 'auto_install', 'notifications', 'auto_restart', 'hostnames', 'onboarded'] as const) {
    if (typeof patch[key] === 'boolean') settings[key] = patch[key]
  }
  if (isNumber(patch.proxy_port)) settings.proxy_port = clamp(patch.proxy_port, 1024, 65535)
  if (isNumber(patch.startup_timeout_ms)) settings.startup_timeout_ms = clamp(patch.startup_timeout_ms, 10000, 30000)
  if (isNumber(patch.port_base)) settings.port_base = clamp(patch.port_base, 1, 65535)
  if (isNumber(patch.scan_depth)) settings.scan_depth = clamp(patch.scan_depth, 1, 64)
  if (Array.isArray(patch.scan_ignore)) {
    settings.scan_ignore = patch.scan_ignore.map((value) => value.trim()).filter(Boolean)
  }
  if (typeof patch.theme === 'string') settings.theme = normalizeTheme(patch.theme)
  syncSettingsDraftFromSettings()
}

function normalizeDraftSettings(draft: Settings): Settings {
  return {
    auto_port: !!draft.auto_port,
    auto_install: !!draft.auto_install,
    notifications: !!draft.notifications,
    auto_restart: !!draft.auto_restart,
    hostnames: !!draft.hostnames,
    proxy_port: clamp(draft.proxy_port ?? settings.proxy_port, 1024, 65535),
    onboarded: settings.onboarded,
    startup_timeout_ms: clamp(draft.startup_timeout_ms ?? settings.startup_timeout_ms, 10000, 30000),
    port_base: clamp(draft.port_base ?? settings.port_base, 1, 65535),
    scan_depth: clamp(draft.scan_depth ?? settings.scan_depth, 1, 64),
    scan_ignore: scanIgnoreDraft.value.split(',').map((value) => value.trim()).filter(Boolean),
    theme: normalizeTheme(draft.theme)
  }
}

// Discards unsaved edits.
function syncSettingsDraftFromSettings() {
  Object.assign(settingsDraft, { ...settings, scan_ignore: [...settings.scan_ignore] })
  scanIgnoreDraft.value = settings.scan_ignore.join(', ')
}

const settingsDirty = computed(() => {
  const draft = normalizeDraftSettings(settingsDraft)
  return (
    draft.auto_port !== settings.auto_port ||
    draft.auto_install !== settings.auto_install ||
    draft.notifications !== settings.notifications ||
    draft.auto_restart !== settings.auto_restart ||
    draft.hostnames !== settings.hostnames ||
    draft.proxy_port !== settings.proxy_port ||
    draft.startup_timeout_ms !== settings.startup_timeout_ms ||
    draft.port_base !== settings.port_base ||
    draft.scan_depth !== settings.scan_depth ||
    draft.theme !== settings.theme ||
    draft.scan_ignore.join(',') !== settings.scan_ignore.join(',')
  )
})

function setSaveFeedback(value: 'saved' | 'noop' | 'error') {
  saveFeedback.value = value
  if (saveFeedbackTimer) window.clearTimeout(saveFeedbackTimer)
  saveFeedbackTimer = window.setTimeout(() => {
    saveFeedback.value = ''
  }, 1600)
}

// The cached copy only avoids a theme flash; the backend's saved settings always win.
function loadSettingsFromStorage() {
  const stored = readStoredJson(STORAGE_KEYS.settings)
  if (stored && typeof stored === 'object') applySettingsPatch(stored as Partial<Settings>)
}

function saveSettingsToStorage() {
  writeStoredJson(STORAGE_KEYS.settings, settings)
}

async function fetchSettings() {
  try {
    const response = await apiFetch('/api/settings')
    if (!response.ok) throw new Error('Failed to load settings')
    applySettingsPatch((await response.json()) as Settings)
    saveSettingsToStorage()
    settingsLoaded.value = true
  } catch (err) {
    settingsLoaded.value = false
  }
}

// Saves the draft; returns whether anything was saved.
async function saveSettings() {
  if (!settingsDirty.value) {
    setSaveFeedback('noop')
    return false
  }
  settingsSaving.value = true
  try {
    const response = await apiFetch('/api/settings', jsonBody('PATCH', normalizeDraftSettings(settingsDraft)))
    if (!response.ok) throw new Error('Failed to save settings')
    applySettingsPatch((await response.json()) as Settings)
    saveSettingsToStorage()
    settingsLoaded.value = true
    setSaveFeedback('saved')
    return true
  } catch (err) {
    setSaveFeedback('error')
    return false
  } finally {
    settingsSaving.value = false
  }
}

// Saves one setting right away, outside the Settings page (theme toggle, onboarding).
async function patchSetting(patch: Partial<Settings>) {
  applySettingsPatch(patch)
  saveSettingsToStorage()
  const response = await apiFetch('/api/settings', jsonBody('PATCH', patch)).catch(() => null)
  if (response?.ok) applySettingsPatch((await response.json()) as Settings)
}

export function useSettings() {
  return {
    settings,
    settingsDraft,
    scanIgnoreDraft,
    settingsSaving,
    settingsLoaded,
    settingsDirty,
    saveFeedback,
    loadSettingsFromStorage,
    fetchSettings,
    saveSettings,
    patchSetting,
    syncSettingsDraftFromSettings
  }
}
