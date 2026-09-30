import { computed, reactive, ref } from 'vue'
import { type Group, type ProjectView } from '../types'

// Dialogs, menus and the palette. The native browser view always paints above the page,
// so it is hidden while any of these is open instead of covering it.

export type ManualPortTarget =
  | { kind: 'service'; serviceId: string }
  | { kind: 'group'; groupKey: string }

const paletteOpen = ref(false)
const onboardingOpen = ref(false)
// Exposed by the onboarding component, so folders dropped on the window reach it.
const onboarding = ref<{ addFolders: (paths: string[]) => Promise<void> } | null>(null)
const pickerOpen = ref(false)
// The service whose environment and links are being edited.
const configServiceId = ref<string | null>(null)
const manualPortTarget = ref<ManualPortTarget | null>(null)
const externalMenuOpen = reactive<Record<string, boolean>>({})

const groupMenu = reactive({ open: false, x: 0, y: 0, group: null as Group<ProjectView> | null })

function openGroupMenu(event: MouseEvent, group: Group<ProjectView>) {
  const menuWidth = 210
  const menuHeight = 120
  const padding = 12
  groupMenu.x = Math.max(padding, Math.min(event.clientX, window.innerWidth - menuWidth - padding))
  groupMenu.y = Math.max(padding, Math.min(event.clientY, window.innerHeight - menuHeight - padding))
  groupMenu.group = group
  groupMenu.open = true
}

function closeGroupMenu() {
  groupMenu.open = false
}

function toggleExternalMenu(id: string) {
  externalMenuOpen[id] = !externalMenuOpen[id]
}

function closeExternalMenus() {
  Object.keys(externalMenuOpen).forEach((key) => {
    externalMenuOpen[key] = false
  })
}

const overlayOpen = computed(() =>
  onboardingOpen.value ||
  paletteOpen.value ||
  !!configServiceId.value ||
  pickerOpen.value ||
  !!manualPortTarget.value ||
  groupMenu.open ||
  Object.values(externalMenuOpen).some(Boolean)
)

export function useOverlays() {
  return {
    paletteOpen,
    onboardingOpen,
    onboarding,
    pickerOpen,
    configServiceId,
    manualPortTarget,
    externalMenuOpen,
    toggleExternalMenu,
    closeExternalMenus,
    groupMenu,
    openGroupMenu,
    closeGroupMenu,
    overlayOpen
  }
}
