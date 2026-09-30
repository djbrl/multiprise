<script setup lang="ts">
import { useOverlays } from '../composables/useOverlays'
import { useServiceActions } from '../composables/useServiceActions'
import { groupHasNpmServices, groupHasRunning } from '../lib/services'

// Right-click menu of a project in the sidebar.

const { groupMenu, closeGroupMenu } = useOverlays()
const { groupActionLoading, groupPrimaryAction, deleteGroup } = useServiceActions()
</script>

<template>
  <div>
    <div v-if="groupMenu.open" class="fixed inset-0 z-40" @click="closeGroupMenu"></div>
    <transition name="fade">
      <div
        v-if="groupMenu.open && groupMenu.group"
        class="fixed z-50 w-48 rounded-lg border border-[var(--border)] bg-[var(--panel-bg)] shadow-lg"
        :style="{ left: `${groupMenu.x}px`, top: `${groupMenu.y}px` }"
        @click.stop
      >
        <div class="px-3 pt-2 text-xs text-[var(--text-subtle)]">{{ groupMenu.group.name }}</div>
        <div class="mt-2 space-y-1 p-2">
          <button
            class="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs text-[var(--text)] hover:bg-[var(--hover)]"
            :disabled="!groupHasNpmServices(groupMenu.group) || groupActionLoading[groupMenu.group.key] === 'stop' || groupActionLoading[groupMenu.group.key] === 'delete'"
            @click="
              groupPrimaryAction(groupMenu.group, groupHasRunning(groupMenu.group));
              closeGroupMenu();
            "
          >
            <span>
              {{
                groupActionLoading[groupMenu.group.key] === 'launch'
                  ? 'Cancel launch'
                  : groupActionLoading[groupMenu.group.key] === 'stop'
                  ? 'Unplugging…'
                  : groupHasRunning(groupMenu.group)
                  ? 'Unplug'
                  : 'Launch'
              }}
            </span>
          </button>
          <button
            class="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs text-[var(--text)] hover:bg-[var(--hover)]"
            @click="
              deleteGroup(groupMenu.group);
              closeGroupMenu();
            "
          >
            <span>Untrack</span>
          </button>
        </div>
      </div>
    </transition>
  </div>
</template>
