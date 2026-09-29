// Shared Tailwind class strings for buttons, inputs and panels.
export const panelClass = 'rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)]'
export const panelProjectClass = 'bg-[var(--panel-project)]'
export const btnBase =
  'inline-flex items-center gap-2 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-40'
export const btnSm = 'px-4 py-2.5 text-sm'
export const btnXs = 'px-3 py-1.5 text-xs'
export const btnSmText = 'px-3 py-1.5 text-sm'
export const btnGhost = `${btnBase} ${btnSm} bg-[var(--ghost-bg)] text-[var(--ghost-text)] hover:bg-[var(--ghost-hover)]`
export const btnGhostXs = `${btnBase} ${btnXs} bg-[var(--ghost-bg)] text-[var(--ghost-text)] hover:bg-[var(--ghost-hover)]`
export const btnPrimary = `${btnBase} ${btnSm} bg-[var(--primary)] text-[var(--primary-text)] hover:bg-[var(--primary-hover)]`
export const btnPrimaryXs = `${btnBase} ${btnXs} bg-[var(--primary)] text-[var(--primary-text)] hover:bg-[var(--primary-hover)]`
export const btnPrimarySm = `${btnBase} ${btnSmText} bg-[var(--primary)] text-[var(--primary-text)] hover:bg-[var(--primary-hover)]`
export const btnDangerSm = `${btnBase} ${btnSmText} bg-[var(--danger-bg)] text-[var(--danger-text)] hover:bg-[var(--danger-hover)]`
export const btnBlueXs = `${btnBase} ${btnXs} bg-[var(--text-strong)] text-[var(--app-bg)] hover:bg-[var(--text)]`
export const btnPanelPrimary =
  `${btnBase} h-8 px-3 text-sm bg-[var(--primary)] text-[var(--primary-text)] hover:bg-[var(--primary-hover)]`
export const btnPanelPrimaryLg =
  `${btnBase} h-11 min-w-[128px] justify-center px-5 text-sm bg-[var(--primary)] text-[var(--primary-text)] hover:bg-[var(--primary-hover)]`
export const btnPanelSecondary =
  `${btnBase} h-8 px-3 text-sm bg-[var(--ghost-bg)] text-[var(--ghost-text)] shadow-[0_1px_2px_rgba(24,24,27,0.12)] hover:bg-[var(--ghost-hover)]`
export const btnUnplug =
  btnBase + ' h-8 bg-[#353538] px-3 text-sm text-white hover:bg-[#252525]'
export const btnUnplugLg =
  btnBase + ' h-11 min-w-[128px] justify-center bg-[#353538] px-5 text-sm text-white hover:bg-[#252525]'
export const btnPanelTertiary =
  `${btnBase} h-8 px-3 text-sm bg-transparent text-[var(--text-muted)] hover:bg-[var(--hover)]`
export const btnPanelIcon =
  `${btnBase} h-8 w-8 justify-center p-0 bg-[var(--ghost-bg)] text-[var(--ghost-text)] hover:bg-[var(--ghost-hover)]`
export const chipBase =
  'inline-flex items-center rounded-full border border-[var(--chip-border)] bg-[var(--chip-bg)] px-3 py-1 text-xs font-medium text-[var(--chip-text)]'
export const chipActive =
  'border-2 border-[var(--text-strong)] bg-[var(--chip-active-bg)] text-[var(--chip-active-text)]'
export const statusDot = 'inline-flex h-2.5 w-2.5 shrink-0 rounded-full border border-[var(--status-border)] bg-[var(--status-bg)]'
// "!" so these win over statusDot's idle colours regardless of generated CSS order.
export const statusDotLive = '!border-[var(--live)] !bg-[var(--live)]'
export const statusDotFailed = '!border-[var(--log-error)] !bg-[var(--log-error)]'
export const inputBase =
  'w-full rounded-xl border border-[var(--input-border)] bg-[var(--input-bg)] px-3 py-2 text-sm text-[var(--input-text)] placeholder:text-[var(--input-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]'
export const noScrollbar =
  '[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
export const spinnerClass =
  'inline-flex h-4 w-4 animate-spin rounded-full border-2 border-[var(--spinner)] border-t-transparent'
export const toggleBase = 'relative inline-flex h-4 w-7 items-center'
export const toggleTrack =
  'h-4 w-7 rounded-full border border-[var(--toggle-border)] bg-[var(--toggle-bg)] transition peer-checked:bg-[var(--toggle-active)]'
export const toggleThumb =
  'pointer-events-none absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-[var(--toggle-thumb)] transition-transform peer-checked:translate-x-3'
