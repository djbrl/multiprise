// Shared Tailwind class strings for buttons, inputs and panels. btn-*, surface-* name the
// surface for the Socket theme's materials in style.css.
export const panelClass = 'surface-raised rounded-lg border border-[var(--border)] bg-[var(--panel-bg)]'
export const panelProjectClass = 'bg-[var(--panel-project)]'
const btnBase =
  'inline-flex items-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40'
const btnXs = 'h-7 px-2.5 text-xs'
const primaryColors = 'btn-primary bg-[var(--primary)] text-[var(--primary-text)] hover:bg-[var(--primary-hover)]'
const secondaryColors = 'btn-secondary border border-[var(--ghost-border)] bg-[var(--ghost-bg)] text-[var(--ghost-text)] hover:bg-[var(--ghost-hover)]'
export const btnGhostXs = `${btnBase} ${btnXs} ${secondaryColors}`
export const btnPanelPrimary = `${btnBase} h-8 px-3 text-[13px] ${primaryColors}`
export const btnPanelPrimaryLg = `${btnBase} h-8 justify-center px-3 text-[13px] ${primaryColors}`
export const btnPanelSecondary = `${btnBase} h-8 px-3 text-[13px] ${secondaryColors}`
export const btnUnplug = btnPanelSecondary
export const btnUnplugLg = `${btnBase} h-8 justify-center px-3 text-[13px] ${primaryColors}`
// The second press of an action that takes two.
export const btnConfirm =
  `${btnBase} h-8 px-3 text-[13px] border border-[var(--danger-text)] bg-[var(--danger-bg)] text-[var(--danger-text)] hover:bg-[var(--danger-hover)]`
export const btnPanelTertiary =
  `${btnBase} h-8 px-3 text-[13px] bg-transparent text-[var(--text-muted)] hover:bg-[var(--hover)]`
export const btnPanelIcon = `${btnBase} h-8 w-8 justify-center p-0 ${secondaryColors}`
export const statusDot = 'inline-flex h-2 w-2 shrink-0 rounded-full border border-[var(--status-border)] bg-[var(--status-bg)]'
// "!" so these win over statusDot's idle colours regardless of generated CSS order.
export const statusDotLive = 'status-live !border-[var(--live)] !bg-[var(--live)]'
export const statusDotFailed = '!border-[var(--log-error)] !bg-[var(--log-error)]'
export const inputBase =
  'surface-recess w-full rounded-md border border-[var(--input-border)] bg-[var(--input-bg)] px-2.5 py-1.5 text-[13px] text-[var(--input-text)] placeholder:text-[var(--input-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--text-subtle)]/40'
export const noScrollbar =
  '[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
export const spinnerClass =
  'inline-flex h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--spinner)] border-t-transparent'
export const toggleThumb =
  'pointer-events-none absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-[var(--toggle-thumb)] transition-transform peer-checked:translate-x-3'
