<script setup lang="ts">
import { useOverlays } from '../composables/useOverlays'
import { useServiceActions } from '../composables/useServiceActions'
import { projectTitle, serviceRole } from '../lib/services'
import { btnPanelIcon, btnPanelPrimary, btnPanelTertiary, inputBase } from '../ui'

// With "Ask every time" port assignment, each launch asks for the ports first.

const { manualPortTarget } = useOverlays()
const { manualPortServices, manualPortInputs, manualPortError, manualPortsValid, closeManualPortPrompt, confirmManualPorts } = useServiceActions()
</script>

<template>
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
</template>
