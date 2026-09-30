import { ref } from 'vue'

// The service manager's address and token come from the main process on first use.
export const apiBase = ref('')
export const apiToken = ref('')
export const apiError = ref('')

export async function ensureApiBase() {
  if (apiBase.value) return apiBase.value
  try {
    const health = await window.vibe?.backendHealth?.()
    if (health?.url) {
      apiToken.value = health.token ?? ''
      apiBase.value = health.url
    }
  } catch (err) {
    apiError.value = err instanceof Error ? err.message : String(err)
  }
  return apiBase.value
}

export async function apiFetch(path: string, options?: RequestInit) {
  const base = await ensureApiBase()
  if (!base) {
    throw new Error('Backend not available')
  }
  const headers = new Headers(options?.headers)
  if (apiToken.value) headers.set('x-multiprise-token', apiToken.value)
  return fetch(`${base}${path}`, { ...options, headers })
}

// A JSON request body with its content type.
export function jsonBody(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

// Errors from the backend are plain-text messages meant for the user.
export async function throwResponseError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const text = await response.text()
    if (text.trim()) {
      message = text.trim()
    }
  } catch (err) {
    // Keep the fallback.
  }
  throw new Error(message)
}

export function errorMessage(err: unknown, fallback = 'Unknown error') {
  return err instanceof Error ? err.message : fallback
}

export async function openExternal(url: string) {
  if (!window.vibe?.openExternal) {
    throw new Error('System browser integration is unavailable.')
  }
  await window.vibe.openExternal(url)
}
