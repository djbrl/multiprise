<script setup lang="ts">
import { useOverlays } from '../composables/useOverlays'
import { useProjectPicker } from '../composables/useProjectPicker'
import { useProjects } from '../composables/useProjects'
import { useServiceActions } from '../composables/useServiceActions'
import { folderLabel } from '../lib/services'
import { btnPanelIcon, btnPanelPrimary, btnPanelTertiary, noScrollbar, spinnerClass } from '../ui'

// Add Projects: choose or drop folders, see the services found in each, then add them.

const { pickerOpen } = useOverlays()
const { error, folderGroups } = useProjects()
const { selectedFolders, projectPreviewMap, validSelectedFolders, addingProjects, closePicker, pickFolders, removeSelectedFolder, addSelectedProjects } = useProjectPicker()
const { deleteGroup } = useServiceActions()
</script>

<template>
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
                  No folders selected yet. Choose them, or drop them anywhere on this window.
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
</template>
