// Browser storage only remembers conveniences (layout, the last project); it can be
// unavailable or cleared, so every access falls back quietly.

export function readStored(key: string, storage: Storage = localStorage) {
  try {
    return storage.getItem(key)
  } catch (err) {
    return null
  }
}

export function writeStored(key: string, value: string | null, storage: Storage = localStorage) {
  try {
    if (value === null) storage.removeItem(key)
    else storage.setItem(key, value)
  } catch (err) {
    // Nothing to do: the value simply is not remembered.
  }
}

export function readStoredJson(key: string): unknown {
  const raw = readStored(key)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch (err) {
    return null
  }
}

export function writeStoredJson(key: string, value: unknown) {
  writeStored(key, JSON.stringify(value))
}

export const STORAGE_KEYS = {
  settings: 'multiprise_settings',
  selectedGroup: 'multiprise_selected_group',
  navigationSession: 'multiprise_navigation_session',
  recentScan: 'multiprise_recent_scan',
  recentGroups: 'multiprise_recent_groups',
  serviceSplit: 'multiprise_service_split_ratio',
  agentsOfferDismissed: 'multiprise_agents_offer_dismissed'
} as const
