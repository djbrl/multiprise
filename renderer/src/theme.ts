import { type ThemeName } from './types'

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

export const themes: Record<ThemeName, ThemeTokens> = {
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

export function normalizeTheme(value?: string | null): ThemeName {
  return value === 'dark' ? 'dark' : 'light'
}

// Every token becomes a variable of the same name in kebab case: appBg is --app-bg.
export function themeStyle(theme: ThemeName): Record<string, string> {
  const style: Record<string, string> = { 'color-scheme': theme }
  for (const [name, value] of Object.entries(themes[theme])) {
    style[`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`] = value
  }
  return style
}

// The sidebar sits on a warmer, slightly darker surface than the panels.
export function sidebarThemeStyle(theme: ThemeName): Record<string, string> {
  const isDark = theme === 'dark'
  return {
    ...themeStyle(theme),
    '--sidebar-bg': isDark ? '#242424' : '#EEEDE9',
    '--border': isDark ? '#3A3A3A' : '#D8D5CE',
    '--panel-bg': isDark ? '#303030' : '#F8F7F4',
    '--panel-muted': isDark ? '#343434' : '#E3E1DC',
    '--input-bg': isDark ? '#1E1E1E' : '#FAF9F6',
    '--input-border': isDark ? '#444444' : '#D2CFC8',
    '--hover': isDark ? '#313131' : '#E4E1DB',
    '--selection': isDark ? '#373737' : '#DDD9D1'
  }
}
