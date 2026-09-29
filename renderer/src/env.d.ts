export {}

declare global {
  type BrowserTabState = {
    id: string
    title: string
    url: string
    loading: boolean
    error?: string | null
    detached: boolean
    canGoBack: boolean
    canGoForward: boolean
  }

  type BrowserState = {
    activeTabId: string | null
    visible: boolean
    tabs: BrowserTabState[]
  }

  type BrowserBounds = {
    x: number
    y: number
    width: number
    height: number
  }

  type CommandLineToolStatus = {
    installed: boolean
    // Only the packaged app ships the launcher that gets linked.
    packaged: boolean
    path: string
  }

  interface Window {
    vibe?: {
      ping?: () => Promise<{ ok: boolean; time: string }>
      backendHealth?: () => Promise<{ ok: boolean; url: string | null; port: number | null; token?: string | null; time: string }>
      openExternal?: (url: string) => Promise<void>
      copyText?: (text: string) => Promise<{ ok: boolean }>
      cli?: {
        status: () => Promise<CommandLineToolStatus>
        install: () => Promise<CommandLineToolStatus>
      }
      browser?: {
        open: (url: string, options?: { title?: string }) => Promise<BrowserState>
        getState: () => Promise<BrowserState>
        action: (action: string, payload?: Record<string, unknown>) => Promise<BrowserState>
        setBounds: (bounds: BrowserBounds) => Promise<BrowserState>
        hide: () => Promise<BrowserState>
        onState: (callback: (state: BrowserState) => void) => () => void
      }
    }
  }
}
