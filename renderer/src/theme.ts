import { ref } from 'vue'
import { type ResolvedTheme, type ThemeName } from './types'

// Colors for each theme, applied as CSS variables on the app's root element.

export type ThemeTokens = {
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
  ghostBorder: string
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
  liveText: string
  attention: string
  attentionText: string
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
  logErrorBg: string
  logWarningBg: string
  electric: string
}

export const themes: Record<ResolvedTheme, ThemeTokens> = {
  light: {
    appBg: '#FFFFFF', sidebarBg: '#FAFAFA', panelBg: '#FFFFFF', panelProject: '#FFFFFF', panelMuted: '#F7F7F8', border: '#E8E8EA',
    text: '#3F3F46', textMuted: '#5F5F67', textSubtle: '#6E6E76', textStrong: '#18181B',
    primary: '#18181B', primaryHover: '#3F3F46', primaryText: '#FFFFFF',
    ghostBg: '#FFFFFF', ghostHover: '#F4F4F5', ghostText: '#18181B', ghostBorder: '#D4D4D8',
    tagBg: '#F4F4F5', tagBorder: '#E4E4E7', tagText: '#52525B',
    chipBg: '#F4F4F5', chipBorder: '#E4E4E7', chipText: '#52525B', chipActiveBg: '#FFFFFF', chipActiveBorder: '#18181B', chipActiveText: '#18181B',
    inputBg: '#FFFFFF', inputBorder: '#D4D4D8', inputText: '#18181B', inputPlaceholder: '#71717A',
    logBg: '#FFFFFF', logBorder: '#E8E8EA', statusBg: '#B4B4BB', statusBorder: '#B4B4BB', live: '#16A34A', liveText: '#15803D',
    attention: '#EA580C', attentionText: '#C2410C',
    successBg: '#ECFDF3', successBorder: '#ABEFC6', successText: '#15803D',
    warningBg: '#FFF7ED', warningBorder: '#FED7AA', warningText: '#9A3412',
    dangerBg: '#FEF2F2', dangerHover: '#FEE2E2', dangerText: '#B91C1C',
    highlightBg: '#FEF08A', highlightText: '#18181B', hover: '#F4F4F5', selection: '#EDEDEF',
    toggleBg: '#D4D4D8', toggleBorder: '#C4C4CA', toggleActive: '#18181B', toggleThumb: '#FFFFFF', spinner: '#71717A',
    logBackend: '#5F5F67', logFrontend: '#5F5F67', logService: '#5F5F67', logDefault: '#18181B', logError: '#B91C1C', logWarning: '#92400E', logSuccess: '#18181B',
    logErrorBg: '#FEF2F2', logWarningBg: '#FFFBEB',
    electric: '#EA580C'
  },
  dark: {
    appBg: '#111113', sidebarBg: '#161618', panelBg: '#111113', panelProject: '#111113', panelMuted: '#18181B', border: '#27272A',
    text: '#D4D4D8', textMuted: '#A6A6AE', textSubtle: '#92929A', textStrong: '#EDEDEF',
    primary: '#EDEDEF', primaryHover: '#D4D4D8', primaryText: '#111113',
    ghostBg: '#111113', ghostHover: '#1F1F22', ghostText: '#EDEDEF', ghostBorder: '#3C3C42',
    tagBg: '#1F1F22', tagBorder: '#2E2E32', tagText: '#C4C4CC',
    chipBg: '#1F1F22', chipBorder: '#2E2E32', chipText: '#C4C4CC', chipActiveBg: '#28282C', chipActiveBorder: '#EDEDEF', chipActiveText: '#EDEDEF',
    inputBg: '#111113', inputBorder: '#3C3C42', inputText: '#EDEDEF', inputPlaceholder: '#85858D',
    logBg: '#111113', logBorder: '#27272A', statusBg: '#5C5C63', statusBorder: '#5C5C63', live: '#3DD68C', liveText: '#3DD68C',
    attention: '#F97316', attentionText: '#FB923C',
    successBg: '#10291C', successBorder: '#1F5C3B', successText: '#3DD68C',
    warningBg: '#2B1D10', warningBorder: '#6B4216', warningText: '#FDBA74',
    dangerBg: '#2E1715', dangerHover: '#3D1E1B', dangerText: '#FF9D94',
    highlightBg: '#854D0E', highlightText: '#FEFCE8', hover: '#1F1F22', selection: '#28282C',
    toggleBg: '#3C3C42', toggleBorder: '#4A4A50', toggleActive: '#EDEDEF', toggleThumb: '#111113', spinner: '#A6A6AE',
    logBackend: '#A6A6AE', logFrontend: '#A6A6AE', logService: '#A6A6AE', logDefault: '#EDEDEF', logError: '#FF9D94', logWarning: '#F2CC70', logSuccess: '#EDEDEF',
    logErrorBg: '#2E1715', logWarningBg: '#2A2212',
    electric: '#F97316'
  },
  // The logo as a material: an orange body, off-white plates on it, recesses cut into them.
  // The gradients and shadows are in style.css, under [data-theme='socket'].
  socket: {
    appBg: '#FFFCF7', sidebarBg: 'transparent', panelBg: '#FFFEFB', panelProject: 'transparent', panelMuted: '#F9EEE1', border: '#EFE2D2',
    text: '#4A2F1C', textMuted: '#6F5240', textSubtle: '#7A5D49', textStrong: '#2B1609',
    primary: '#F26A1B', primaryHover: '#E25A12', primaryText: '#2B1609',
    ghostBg: '#FFFEFB', ghostHover: '#FBF1E6', ghostText: '#2B1609', ghostBorder: '#E2D0BC',
    tagBg: '#F9EEE1', tagBorder: '#EADCCB', tagText: '#5A3A25',
    chipBg: '#F9EEE1', chipBorder: '#EADCCB', chipText: '#5A3A25', chipActiveBg: '#FFFEFB', chipActiveBorder: '#E25A12', chipActiveText: '#2B1609',
    inputBg: '#F9EEE1', inputBorder: '#E2D0BC', inputText: '#2B1609', inputPlaceholder: '#7A5D49',
    logBg: '#FBF3E8', logBorder: '#EFE2D2', statusBg: '#BCA893', statusBorder: '#BCA893', live: '#16A34A', liveText: '#15803D',
    attention: '#EA580C', attentionText: '#B8440A',
    successBg: '#ECFDF3', successBorder: '#ABEFC6', successText: '#15803D',
    warningBg: '#FFF1E2', warningBorder: '#F5C9A0', warningText: '#8F3A0A',
    dangerBg: '#FDE7E2', dangerHover: '#FBD9D2', dangerText: '#A8231A',
    highlightBg: '#FFD9B8', highlightText: '#2B1609', hover: '#FDF6EC', selection: '#F3E4D3',
    toggleBg: '#E2D0BC', toggleBorder: '#D5C0AA', toggleActive: '#F26A1B', toggleThumb: '#FFFFFF', spinner: '#B8440A',
    logBackend: '#6F5240', logFrontend: '#6F5240', logService: '#6F5240', logDefault: '#2B1609', logError: '#A8231A', logWarning: '#6E4700', logSuccess: '#2B1609',
    logErrorBg: '#FDE7E2', logWarningBg: '#FFF1CF',
    electric: '#E25A12'
  }
}

export function normalizeTheme(value?: string | null): ThemeName {
  return value === 'light' || value === 'dark' || value === 'socket' ? value : 'system'
}

// Whether macOS is in dark mode, kept current as the user switches it.
const darkQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
export const systemPrefersDark = ref(darkQuery?.matches ?? false)
darkQuery?.addEventListener('change', (event) => { systemPrefersDark.value = event.matches })

export function resolveTheme(theme: ThemeName): ResolvedTheme {
  if (theme !== 'system') return theme
  return systemPrefersDark.value ? 'dark' : 'light'
}

// Every token becomes a variable of the same name in kebab case: appBg is --app-bg.
export function themeStyle(theme: ResolvedTheme): Record<string, string> {
  const style: Record<string, string> = { 'color-scheme': theme === 'dark' ? 'dark' : 'light' }
  for (const [name, value] of Object.entries(themes[theme])) {
    style[`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`] = value
  }
  return style
}

// On the Socket theme the sidebar is the orange body itself, so everything on it is dark ink.
export function sidebarThemeStyle(theme: ResolvedTheme): Record<string, string> {
  if (theme !== 'socket') return themeStyle(theme)
  return {
    ...themeStyle(theme),
    '--text': '#2B1609',
    '--text-muted': '#2B1609',
    '--text-subtle': '#2B1609',
    '--text-strong': '#2B1609',
    '--border': 'transparent',
    '--hover': 'rgba(255, 252, 247, 0.22)',
    '--selection': '#FFFCF7',
    '--status-bg': 'transparent',
    '--status-border': '#2B1609',
    '--attention': '#2B1609',
    '--attention-text': '#2B1609',
    '--log-error': '#2B1609'
  }
}
