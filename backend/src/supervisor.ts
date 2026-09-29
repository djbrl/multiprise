import { subscribe } from './events'
import { launchService, lastLaunchPayload, type Launches } from './launch'
import {
  appendProcessLog,
  getProcessPid,
  managedProcessIds,
  markProcessResponsive,
  markProcessUnresponsive,
  probeProcess
} from './processes'
import { type AppState } from './state'
import { type ProcessStatus } from './types'

// Watches managed services after they are ready: flags the ones that stop answering and
// relaunches the ones that crash, a bounded number of times.

export type SupervisorOptions = {
  healthIntervalMs?: number
  probeTimeoutMs?: number
  // Consecutive failed probes before a service is shown as not responding.
  unresponsiveAfter?: number
  // Wait before each restart attempt; its length is also the number of attempts per window.
  restartDelaysMs?: number[]
  restartWindowMs?: number
}

export type Supervisor = { stop: () => void }

// Probes are real requests that request-logging servers print, so they stay infrequent.
const DEFAULTS: Required<SupervisorOptions> = {
  healthIntervalMs: 15000,
  probeTimeoutMs: 2000,
  unresponsiveAfter: 2,
  restartDelaysMs: [1000, 5000, 15000],
  restartWindowMs: 10 * 60 * 1000
}

const note = (id: string, message: string) => appendProcessLog(id, 'stdout', `[multiprise] ${message}`)

export function superviseServices(state: AppState, launches: Launches, options: SupervisorOptions = {}): Supervisor {
  const config = { ...DEFAULTS, ...options }
  let stopped = false

  // --- Liveness
  const failedProbes = new Map<string, number>()
  let probing = false
  const probeAll = async () => {
    if (probing || stopped) return
    probing = true
    try {
      await Promise.all(managedProcessIds().map(async (id) => {
        const alive = await probeProcess(id, config.probeTimeoutMs)
        if (alive === null || stopped) return
        if (alive) {
          failedProbes.delete(id)
          markProcessResponsive(id)
          return
        }
        const failures = (failedProbes.get(id) ?? 0) + 1
        failedProbes.set(id, failures)
        if (failures === config.unresponsiveAfter) {
          const project = state.projects.find((entry) => entry.id === id)
          const seconds = Math.round((failures * config.healthIntervalMs) / 1000)
          markProcessUnresponsive(id, `Not responding on port ${project?.port ?? '?'} for about ${seconds}s. ` +
            'It may be stuck or paused in a debugger; restart it if it does not recover.')
        }
      }))
    } finally {
      probing = false
    }
  }
  const healthTimer = setInterval(probeAll, config.healthIntervalMs)
  healthTimer.unref()

  // --- Crash restarts
  const previous = new Map<string, ProcessStatus>()
  const pending = new Map<string, NodeJS.Timeout>()
  const restartTimes = new Map<string, number[]>()

  const cancelPending = (id: string) => {
    const timer = pending.get(id)
    if (timer) clearTimeout(timer)
    pending.delete(id)
  }

  const scheduleRestart = (id: string) => {
    const now = Date.now()
    const recent = (restartTimes.get(id) ?? []).filter((time) => now - time < config.restartWindowMs)
    restartTimes.set(id, recent)
    if (recent.length >= config.restartDelaysMs.length) {
      const minutes = Math.round(config.restartWindowMs / 60000)
      note(id, `Restarted ${recent.length} times in ${minutes} minutes; leaving it stopped. Fix the error above, then start it again.`)
      return
    }
    const delay = config.restartDelaysMs[recent.length]
    recent.push(now + delay)
    note(id, `Restarting in ${Math.max(1, Math.round(delay / 1000))}s (attempt ${recent.length} of ${config.restartDelaysMs.length})…`)
    cancelPending(id)
    const timer = setTimeout(() => {
      pending.delete(id)
      restart(id).catch((err) => console.error('[multiprise] restart failed:', err))
    }, delay)
    timer.unref()
    pending.set(id, timer)
  }

  const restart = async (id: string) => {
    const project = state.projects.find((entry) => entry.id === id)
    // Deleted, started by hand, or shutting down in the meantime.
    if (stopped || !project || getProcessPid(id) || launches.has(id)) return
    const payload = lastLaunchPayload(id) ?? {}
    try {
      await launchService(state, launches, project, { ...payload, port: project.port ?? payload.port }, { keepLogs: true })
      note(id, 'Restarted.')
    } catch (err) {
      if (stopped) return
      note(id, `Restart failed: ${err instanceof Error ? err.message : String(err)}`)
      scheduleRestart(id)
    }
  }

  const unsubscribe = subscribe((event) => {
    if (event.type !== 'status') return
    const before = previous.get(event.id)
    previous.set(event.id, event.status)
    // Any other change (Stop, a manual start, a relaunch in progress) supersedes a pending restart.
    if (event.status.phase !== 'failed') {
      cancelPending(event.id)
      return
    }
    // Only services that were up count as crashing; a failed launch is a configuration problem.
    const crashed = !event.status.running && !!before?.running && (before.phase === 'ready' || before.phase === 'failed')
    if (crashed && !stopped && state.settings.auto_restart) scheduleRestart(event.id)
  })

  return {
    stop: () => {
      stopped = true
      clearInterval(healthTimer)
      unsubscribe()
      for (const id of [...pending.keys()]) cancelPending(id)
    }
  }
}
