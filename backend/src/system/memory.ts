import path from 'node:path'
import { getLogs, getProcessStatus, managedProcessIds } from '../services/processes'
import { type IdleServer, type MemoryTrend, type Project } from '../types'
import { managedServiceUse } from './usage'

// Memory tracking: every running service is measured in the background, from the moment it
// starts, so memory that keeps climbing shows up without the app being open. Dev servers grow
// on their own at first (caches, the first compile), so the first minutes are not judged, and
// only steady growth that never comes back down counts. Multiprise cannot tell a leak in the
// project's code from its tooling holding on to more, so it says "growing", not "leaking".

export const SAMPLE_MS = 30 * 1000
// Ignored when judging growth: startup, the first build, the first pages served.
export const WARMUP_MS = 5 * 60 * 1000
// At least this much settled time before saying anything.
const MIN_JUDGED_MS = 20 * 60 * 1000
// Growth is judged over the most recent stretch, so an old spike does not count forever.
const WINDOW_MS = 2 * 60 * 60 * 1000
const KEEP_MS = 12 * 60 * 60 * 1000
const MB = 1024 * 1024
// Growing means at least this much an hour, and this much in all, without falling back.
const MIN_GROWTH_PER_HOUR = 30 * MB
const MIN_RISE = 50 * MB
const MIN_FIT = 0.6
const CHART_POINTS = 48

// Idle: no output for this long, from a service that has run at least as long, and barely any CPU.
export const IDLE_MS = 2 * 60 * 60 * 1000
const IDLE_CPU_WINDOW_MS = 30 * 60 * 1000
const IDLE_MAX_CPU = 1

export type Sample = { at: number; memory: number; cpu: number }

type Run = { startedAt: string; samples: Sample[] }

const runs = new Map<string, Run>()

export type GrowthAnalysis = Pick<MemoryTrend, 'status' | 'current' | 'first' | 'peak' | 'growth_per_hour' | 'measured_ms'>

// A least-squares line through the readings: its slope, and how well it fits (r²).
function fitLine(samples: Sample[]) {
  const n = samples.length
  const meanX = samples.reduce((sum, sample) => sum + sample.at, 0) / n
  const meanY = samples.reduce((sum, sample) => sum + sample.memory, 0) / n
  let covariance = 0
  let varianceX = 0
  let varianceY = 0
  for (const sample of samples) {
    covariance += (sample.at - meanX) * (sample.memory - meanY)
    varianceX += (sample.at - meanX) ** 2
    varianceY += (sample.memory - meanY) ** 2
  }
  const slope = varianceX ? covariance / varianceX : 0
  const fit = varianceX && varianceY ? (covariance * covariance) / (varianceX * varianceY) : 0
  return { slope, fit }
}

export function analyzeGrowth(samples: Sample[], startedAtMs: number): GrowthAnalysis {
  const current = samples[samples.length - 1]?.memory ?? 0
  const base = {
    current,
    first: samples[0]?.memory ?? 0,
    peak: samples.reduce((peak, sample) => Math.max(peak, sample.memory), 0),
    measured_ms: samples.length > 1 ? samples[samples.length - 1].at - samples[0].at : 0
  }
  const settled = samples.filter((sample) => sample.at - startedAtMs >= WARMUP_MS)
  const last = settled[settled.length - 1]
  const recent = last ? settled.filter((sample) => last.at - sample.at <= WINDOW_MS) : []
  if (recent.length < 10 || recent[recent.length - 1].at - recent[0].at < MIN_JUDGED_MS) {
    return { ...base, status: 'warming-up', growth_per_hour: null }
  }
  const { slope, fit } = fitLine(recent)
  const perHour = slope * 60 * 60 * 1000
  const rise = current - recent[0].memory
  const recentPeak = recent.reduce((peak, sample) => Math.max(peak, sample.memory), 0)
  const growing = perHour >= Math.max(MIN_GROWTH_PER_HOUR, recent[0].memory * 0.1) &&
    fit >= MIN_FIT &&
    rise >= MIN_RISE &&
    // Still at (or near) its highest: memory that is freed again is a cache, not a climb.
    current >= recentPeak * 0.95
  return { ...base, status: growing ? 'growing' : 'steady', growth_per_hour: Math.round(perHour) }
}

// Evenly spaced readings for a sparkline.
export function chartPoints(samples: Sample[], count = CHART_POINTS) {
  if (samples.length <= count) return samples.map((sample) => sample.memory)
  return Array.from({ length: count }, (_, index) => samples[Math.round(index * (samples.length - 1) / (count - 1))].memory)
}

export function quietSince(options: { startedAtMs: number; lastOutputMs: number | null; samples: Sample[]; now: number }) {
  const { startedAtMs, lastOutputMs, samples, now } = options
  const quiet = Math.max(startedAtMs, lastOutputMs ?? startedAtMs)
  if (now - quiet < IDLE_MS) return null
  // Busy without printing anything (a job, a watcher at work) is not idle.
  const recent = samples.filter((sample) => now - sample.at <= IDLE_CPU_WINDOW_MS)
  if (recent.length && recent.reduce((sum, sample) => sum + sample.cpu, 0) / recent.length > IDLE_MAX_CPU) return null
  return quiet
}

export async function sampleMemory(now = Date.now()) {
  const running = new Set<string>()
  const use = await managedServiceUse().catch(() => new Map())
  for (const id of managedProcessIds()) {
    const status = getProcessStatus(id)
    if (!status.running || !status.started_at) continue
    running.add(id)
    let run = runs.get(id)
    // A restart starts a new run: growth before it says nothing about the new process.
    if (!run || run.startedAt !== status.started_at) {
      run = { startedAt: status.started_at, samples: [] }
      runs.set(id, run)
    }
    const reading = use.get(id)
    if (!reading) continue
    run.samples.push({ at: now, memory: reading.memory, cpu: reading.cpu })
    while (run.samples.length && now - run.samples[0].at > KEEP_MS) run.samples.shift()
  }
  for (const id of runs.keys()) {
    if (!running.has(id)) runs.delete(id)
  }
}

const describe = (project: Project) => {
  const root = project.root_path ?? project.path
  return { service_id: project.id, name: project.name, project: path.basename(root), project_path: root }
}

export function memoryTrends(projects: Project[]): MemoryTrend[] {
  const trends: MemoryTrend[] = []
  for (const project of projects) {
    const run = runs.get(project.id)
    if (!run?.samples.length) continue
    trends.push({
      ...describe(project),
      started_at: run.startedAt,
      ...analyzeGrowth(run.samples, Date.parse(run.startedAt)),
      points: chartPoints(run.samples)
    })
  }
  const order = { growing: 0, steady: 1, 'warming-up': 2 }
  return trends.sort((a, b) => order[a.status] - order[b.status] || b.current - a.current)
}

export function idleServers(projects: Project[], now = Date.now()): IdleServer[] {
  const idle: IdleServer[] = []
  for (const project of projects) {
    const status = getProcessStatus(project.id)
    if (!status.ready || !status.started_at) continue
    const lines = getLogs(project.id)
    const lastLine = lines[lines.length - 1]
    const quiet = quietSince({
      startedAtMs: Date.parse(status.started_at),
      lastOutputMs: lastLine ? Date.parse(lastLine.timestamp) : null,
      samples: runs.get(project.id)?.samples ?? [],
      now
    })
    if (quiet !== null) idle.push({ ...describe(project), started_at: status.started_at, quiet_since: new Date(quiet).toISOString() })
  }
  return idle.sort((a, b) => Date.parse(a.quiet_since) - Date.parse(b.quiet_since))
}

export type MemoryTracker = { stop: () => void }

export function trackMemory(intervalMs = SAMPLE_MS): MemoryTracker {
  let busy = false
  const tick = () => {
    if (busy) return
    busy = true
    sampleMemory().catch(() => {}).finally(() => { busy = false })
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  tick()
  return { stop: () => clearInterval(timer) }
}
