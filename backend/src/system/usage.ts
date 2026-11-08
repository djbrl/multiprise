import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { type listListeningPorts } from '../network/ports'
import { getProcessPid, managedProcessIds } from '../services/processes'
import { describeFolder, dockerPs, listRunningServers, shortCommand, workingDirectories } from './running'
import {
  type AppUsage,
  type ContainerUsage,
  type MachineUsage,
  type MemoryPressure,
  type Project,
  type ResourceUse,
  type ServerUsage,
  type ServiceUsage,
  type UsageReport
} from '../types'

// What this Mac is doing, and how much of it the dev servers on it account for. CPU is always
// a share of the whole machine, so the figures add up: 100% is every core busy.

const execFileAsync = promisify(execFile)

const CPU_MIN_WINDOW_MS = 1000
const MACHINE_CACHE_MS = 1000
const FOOTPRINT_CACHE_MS = 10000
const DOCKER_STATS_CACHE_MS = 15000
const DOCKER_STATS_TIMEOUT_MS = 8000
const SINGLE_FOOTPRINT_CONCURRENCY = 4
// top takes about two seconds of CPU to read every process, so it is read seldom.
const TOP_CACHE_MS = 20000
const APPS_LISTED = 12

// The decimal point in ps and sysctl output follows the locale.
const stdoutOf = (file: string, args: string[]) =>
  execFileAsync(file, args, { env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 8 * 1024 * 1024 })
    .then((result) => result.stdout)
    .catch((err: { stdout?: string }) => err.stdout ?? '')

const round = (value: number) => Math.round(value * 10) / 10

// For readings that take seconds: only the first one is waited for, which a one-off question
// from the CLI needs; after that the last result answers while a new one is taken behind it.
function slowReading<Args extends unknown[], T>(read: (...args: Args) => Promise<T>, maxAgeMs: number) {
  let last: { at: number; value: T } | null = null
  let pending: Promise<void> | null = null
  return async (...args: Args) => {
    if (!pending && (!last || Date.now() - last.at > maxAgeMs)) {
      pending = read(...args)
        .then((value) => { last = { at: Date.now(), value } })
        .catch(() => {})
        .finally(() => { pending = null })
    }
    if (!last) await pending
    return last?.value ?? null
  }
}

function cpuTimes() {
  let idle = 0
  let total = 0
  for (const { times } of os.cpus()) {
    idle += times.idle
    total += times.user + times.nice + times.sys + times.idle + times.irq
  }
  return { idle, total }
}

let cpuBaseline = { at: Date.now(), ...cpuTimes() }
let cpuPercent: number | null = null

// Busy time since the last reading; a reading too soon after it would be mostly noise.
function machineCpu() {
  if (Date.now() - cpuBaseline.at < CPU_MIN_WINDOW_MS) return cpuPercent
  const now = cpuTimes()
  const total = now.total - cpuBaseline.total
  if (total > 0) cpuPercent = round(100 * (1 - (now.idle - cpuBaseline.idle) / total))
  cpuBaseline = { at: Date.now(), ...now }
  return cpuPercent
}

// App memory, wired and compressed, the same sum as Activity Monitor's Memory Used. Free memory
// alone says nothing on macOS, which keeps every spare page busy as cache.
export function parseVmStat(output: string) {
  const pageSize = Number(output.match(/page size of (\d+) bytes/)?.[1])
  const pages = (label: string) => Number(output.match(new RegExp(`^${label}:\\s+(\\d+)`, 'm'))?.[1])
  const used = pages('Anonymous pages') - pages('Pages purgeable') + pages('Pages wired down') + pages('Pages occupied by compressor')
  return Number.isFinite(used) && pageSize ? used * pageSize : null
}

const PRESSURE_LEVELS: Record<string, MemoryPressure> = { 1: 'normal', 2: 'warning', 4: 'critical' }

// `sysctl -n kern.memorystatus_vm_pressure_level vm.swapusage`, one value per line.
export function parseSystemMemory(output: string) {
  const [level, swap = ''] = output.trim().split('\n')
  const swapUsed = Number(swap.match(/used = ([\d.]+)M/)?.[1])
  return {
    pressure: PRESSURE_LEVELS[level?.trim()] ?? null,
    swapUsed: Number.isFinite(swapUsed) ? Math.round(swapUsed * 1024 * 1024) : 0
  }
}

let machineCache: { at: number; usage: Promise<MachineUsage> } | null = null

async function readMachineUsage(): Promise<MachineUsage> {
  const [vmStat, systemMemory] = await Promise.all([
    stdoutOf('vm_stat', []),
    stdoutOf('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level', 'vm.swapusage'])
  ])
  const total = os.totalmem()
  const { pressure, swapUsed } = parseSystemMemory(systemMemory)
  return {
    cpu: machineCpu(),
    cores: os.cpus().length,
    memory_used: Math.min(total, parseVmStat(vmStat) ?? total - os.freemem()),
    memory_total: total,
    memory_pressure: pressure,
    swap_used: swapUsed
  }
}

export function machineUsage() {
  if (!machineCache || Date.now() - machineCache.at > MACHINE_CACHE_MS) {
    machineCache = { at: Date.now(), usage: readMachineUsage() }
  }
  return machineCache.usage
}

export type ProcessUsage = { pid: number; ppid: number; pgid: number; cpu: number; rss: number; uid?: number; command?: string }

// `ps -A -o pid=,ppid=,pgid=,%cpu=,rss=,uid=,comm=`; %cpu is per core, rss is in kilobytes and
// comm is the executable as it was started, a path that may hold spaces or a bare name.
export function parseProcessUsage(output: string) {
  const processes: ProcessUsage[] = []
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)(?:\s+(\d+)\s+(.*?))?\s*$/)
    if (!match) continue
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      cpu: Number(match[4]),
      rss: Number(match[5]) * 1024,
      ...(match[6] ? { uid: Number(match[6]), command: match[7] } : {})
    })
  }
  return processes
}

// Each process counts once, for the nearest thing above it that owns it: a server's helpers
// count for that server, and a server started by another server counts for itself.
export function attributeProcesses(processes: ProcessUsage[], owners: { pids: Map<number, string>; groups: Map<number, string> }) {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]))
  const owned = new Map<string, ProcessUsage[]>()
  for (const entry of processes) {
    let current: ProcessUsage | undefined = entry
    let owner: string | undefined
    const seen = new Set<number>()
    while (current && !owner && !seen.has(current.pid)) {
      seen.add(current.pid)
      owner = owners.pids.get(current.pid) ?? owners.groups.get(current.pgid)
      current = byPid.get(current.ppid)
    }
    if (!owner) continue
    if (!owned.has(owner)) owned.set(owner, [])
    owned.get(owner)!.push(entry)
  }
  return owned
}

// `footprint -f bytes --noCategories <pid…>`.
export function parseFootprints(output: string) {
  const found = new Map<number, number>()
  for (const match of output.matchAll(/\[(\d+)\]:.*Footprint: (\d+) B/g)) {
    found.set(Number(match[1]), Number(match[2]))
  }
  return found
}

const footprintsOf = async (pids: number[]) =>
  parseFootprints(await stdoutOf('footprint', ['-f', 'bytes', '--noCategories', ...pids.map(String)]))

// A batch stops at the first process it may not inspect, so what it missed is asked for alone.
async function readFootprints(pids: number[]) {
  const found = await footprintsOf(pids)
  const missing = pids.filter((pid) => !found.has(pid))
  for (let index = 0; index < missing.length; index += SINGLE_FOOTPRINT_CONCURRENCY) {
    const results = await Promise.all(missing.slice(index, index + SINGLE_FOOTPRINT_CONCURRENCY).map((pid) => footprintsOf([pid])))
    for (const result of results) result.forEach((bytes, pid) => found.set(pid, bytes))
  }
  return found
}

// Resident size badly undercounts an idle server whose memory has been compressed or swapped
// out: 50 MB can be 3.6 GB in truth. Footprint is what Activity Monitor shows, but costs more
// to read, so it is refreshed slowly and resident size only stands in for what it cannot read.
const currentFootprints = slowReading(readFootprints, FOOTPRINT_CACHE_MS)

const TOP_UNITS: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }

// `top -l 1 -stats pid,mem`: footprint again, rounded (`4830M+`), but for every process,
// including those of macOS that footprint may not inspect.
export function parseTopMemory(output: string) {
  const found = new Map<number, number>()
  for (const match of output.matchAll(/^\s*(\d+)\s+([\d.]+)([BKMGT])[+-]?\s*$/gm)) {
    found.set(Number(match[1]), Math.round(Number(match[2]) * TOP_UNITS[match[3]]))
  }
  return found
}

// -F and -R skip the shared library and memory region counts, which top would otherwise add up.
const everyFootprint = slowReading(
  () => stdoutOf('top', ['-l', '1', '-F', '-R', '-stats', 'pid,mem', '-n', '100000']).then(parseTopMemory),
  TOP_CACHE_MS
)

// Interpreters run somebody's script, which says more than their name.
const INTERPRETER = /^(?:node|bun|deno|python[\d.]*|ruby|java|php|perl)$/
const SYSTEM_FOLDERS = ['/System/', '/usr/libexec/', '/usr/sbin/', '/sbin/', '/Library/Apple/']
// Tools the user may run themselves (git, make, a shell) live here too.
const SHARED_FOLDERS = ['/usr/bin/', '/bin/']
// Parts of macOS worth naming; the rest are added up together.
const SYSTEM_NAMES: Array<[RegExp, string]> = [
  [/^kernel_task$/, 'macOS kernel'],
  [/^WindowServer$/, 'WindowServer'],
  [/^com\.apple\.WebKit\./, 'Web pages (Safari and other apps)'],
  [/^com\.apple\.Virtualization\.VirtualMachine$/, 'Virtual machines (Docker and others)'],
  [/^(?:mds|mds_stores|mdworker|mdworker_shared|mdbulkimport|corespotlightd)$/, 'Spotlight'],
  [/^(?:photoanalysisd|mediaanalysisd)$/, 'Photos analysis']
]

// Bundles whose own name says little.
const APP_NAMES: Array<[RegExp, string]> = [
  [/\/claude-code\/[^/]+\/[^/]+\/claude\.app$/, 'Claude Code']
]

type ProcessKind = Pick<AppUsage, 'key' | 'kind' | 'name' | 'path'>

export function classifyProcess(entry: ProcessUsage, uid: number): ProcessKind {
  const command = entry.command ?? ''
  const name = path.basename(command) || `process ${entry.pid}`
  for (const [pattern, label] of SYSTEM_NAMES) {
    if (pattern.test(name)) return { key: `system:${label}`, kind: 'system', name: label, path: null }
  }
  // Helpers live inside their app (Google Chrome Helper.app inside Google Chrome.app).
  const bundle = command.match(/^(.*?\/([^/]+)\.app)(?:\/|$)/)
  if (bundle) {
    const named = APP_NAMES.find(([pattern]) => pattern.test(bundle[1]))
    return { key: `app:${bundle[1]}`, kind: 'app', name: named?.[1] ?? bundle[2], path: bundle[1] }
  }
  if (INTERPRETER.test(name)) return { key: `script:${entry.pid}`, kind: 'script', name, path: null }
  const system = SYSTEM_FOLDERS.some((folder) => command.startsWith(folder)) ||
    (entry.uid !== uid && (SHARED_FOLDERS.some((folder) => command.startsWith(folder)) || !command.includes('/')))
  if (system) return { key: 'system:other', kind: 'system', name: 'Other macOS processes', path: null }
  return { key: `program:${name}`, kind: 'program', name, path: null }
}

// Everything the dev servers do not account for, added up by app, script or program. A process
// a script started (esbuild under Vite) counts for the script.
export function groupApps(processes: ProcessUsage[], skip: Set<number>, memoryOf: (entry: ProcessUsage) => number, cores: number, uid: number) {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]))
  const kinds = new Map(processes.map((entry) => [entry.pid, classifyProcess(entry, uid)]))
  const groups = new Map<string, AppUsage & { pids: number[] }>()
  for (const entry of processes) {
    if (skip.has(entry.pid)) continue
    let kind = kinds.get(entry.pid)!
    if (kind.kind !== 'app' && kind.kind !== 'script') {
      const seen = new Set([entry.pid])
      for (let parent = byPid.get(entry.ppid); parent && parent.pid > 1 && !seen.has(parent.pid); parent = byPid.get(parent.ppid)) {
        seen.add(parent.pid)
        const above = kinds.get(parent.pid)!
        if (above.kind === 'script') kind = above
        if (above.kind === 'script' || above.kind === 'app') break
      }
    }
    const group = groups.get(kind.key) ?? { ...kind, detail: null, processes: 0, cpu: 0, memory: 0, pids: [] }
    group.processes += 1
    group.cpu += entry.cpu / cores
    group.memory += memoryOf(entry)
    group.pids.push(entry.pid)
    groups.set(kind.key, group)
  }
  return [...groups.values()].map((group) => ({ ...group, cpu: round(group.cpu) }))
}

// The heaviest by memory and the busiest by CPU, so a small process spinning a core is not missed.
export function heaviestApps<T extends AppUsage>(apps: T[], count = APPS_LISTED) {
  const byMemory = [...apps].sort((a, b) => b.memory - a.memory).slice(0, count)
  const byCpu = [...apps].sort((a, b) => b.cpu - a.cpu).slice(0, count).filter((app) => app.cpu > 0)
  return [...new Set([...byMemory, ...byCpu])].sort((a, b) => b.memory - a.memory)
}

// A script is named after the project it runs in, and shows what it runs.
async function nameScripts(apps: Array<AppUsage & { pids: number[] }>) {
  const scripts = apps.filter((app) => app.kind === 'script')
  if (!scripts.length) return
  const pids = scripts.map((app) => app.pids[0])
  const [args, folders] = await Promise.all([
    stdoutOf('ps', ['-ww', '-o', 'pid=,args=', '-p', pids.join(',')]),
    workingDirectories(pids)
  ])
  const commands = new Map([...args.matchAll(/^\s*(\d+)\s+(.+)$/gm)].map((match) => [Number(match[1]), match[2]]))
  for (const app of scripts) {
    const command = commands.get(app.pids[0])
    const folder = folders.get(app.pids[0])
    if (command) app.detail = shortCommand(command)
    if (folder && folder !== '/' && folder !== os.homedir()) {
      const place = describeFolder(folder)
      app.name = place.project ?? app.name
      app.path = folder
    } else if (app.detail) {
      app.name = app.detail
      app.detail = null
    }
  }
}

const SIZE_UNITS: Record<string, number> = {
  b: 1, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4
}

// One JSON object per line, from `docker stats --no-stream --format '{{json .}}'`.
// CPUPerc is per core, of the cores given to Docker.
export function parseDockerStats(output: string) {
  const stats = new Map<string, { cpu: number; memory: number }>()
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as { ID?: string; CPUPerc?: string; MemUsage?: string }
      const size = (row.MemUsage ?? '').match(/^([\d.]+)\s*([a-z]+)/i)
      if (!row.ID) continue
      stats.set(row.ID, {
        cpu: Number.parseFloat(row.CPUPerc ?? '') || 0,
        memory: size ? Math.round(Number(size[1]) * (SIZE_UNITS[size[2].toLowerCase()] ?? 0)) : 0
      })
    } catch (err) {
      continue
    }
  }
  return stats
}

// Containers from `docker ps --format '{{json .}}'`, added up by Compose project. Unlike the
// list of servers this keeps those publishing no port: a database still costs memory.
export function dockerProjects(ps: string, stats: Map<string, { cpu: number; memory: number }>, projects: Project[], cores: number) {
  const totals = new Map<string, ContainerUsage>()
  for (const line of ps.split('\n')) {
    if (!line.trim()) continue
    let row: { ID?: string; Names?: string; Labels?: string }
    try {
      row = JSON.parse(line)
    } catch (err) {
      continue
    }
    const used = row.ID ? stats.get(row.ID) : null
    if (!used) continue
    const labels = new Map((row.Labels ?? '').split(',').map((label) => {
      const equals = label.indexOf('=')
      return [label.slice(0, equals), label.slice(equals + 1)] as const
    }))
    const folder = labels.get('com.docker.compose.project.working_dir') ?? null
    const name = labels.get('com.docker.compose.project') ?? row.Names ?? row.ID!
    const key = `docker:${name}`
    const total = totals.get(key) ?? {
      key,
      name,
      path: folder,
      service_id: folder ? projects.find((project) => project.kind === 'docker_compose' && project.path === folder)?.id ?? null : null,
      containers: 0,
      cpu: 0,
      memory: 0
    }
    total.containers += 1
    total.cpu = round(total.cpu + used.cpu / cores)
    total.memory += used.memory
    totals.set(key, total)
  }
  return [...totals.values()]
}

const latestDockerStats = slowReading(
  () => execFileAsync('docker', ['stats', '--no-stream', '--format', '{{json .}}'], { timeout: DOCKER_STATS_TIMEOUT_MS })
    .then((result) => result.stdout, () => ''),
  DOCKER_STATS_CACHE_MS
)

const MULTIPRISE = 'multiprise'

export async function usageReport(listening: Awaited<ReturnType<typeof listListeningPorts>>, projects: Project[]): Promise<UsageReport> {
  const [machine, running, ps, dockerList] = await Promise.all([
    machineUsage(),
    listRunningServers(listening, projects),
    stdoutOf('ps', ['-A', '-o', 'pid=,ppid=,pgid=,%cpu=,rss=,uid=,comm=']),
    dockerPs()
  ])
  const outside = running.filter((server) => server.kind === 'process' && !server.managed && server.pid)
  const pids = new Map<number, string>([[process.pid, MULTIPRISE]])
  for (const server of outside) pids.set(server.pid!, server.key)
  const groups = new Map<number, string>()
  for (const id of managedProcessIds()) {
    const pid = getProcessPid(id)
    if (pid) groups.set(pid, id)
  }

  const processes = parseProcessUsage(ps)
  const owned = attributeProcesses(processes, { pids, groups })
  const ownedPids = [...owned.values()].flat().map((entry) => entry.pid)
  const [footprints, allFootprints] = await Promise.all([
    currentFootprints(ownedPids).then((bytes) => bytes ?? new Map<number, number>()),
    everyFootprint()
  ])
  const useOf = (owner: string): ResourceUse => {
    const entries = owned.get(owner) ?? []
    return {
      cpu: round(entries.reduce((sum, entry) => sum + entry.cpu, 0) / machine.cores),
      memory: entries.reduce((sum, entry) => sum + (footprints.get(entry.pid) ?? entry.rss), 0)
    }
  }

  const services = new Map<string, ServiceUsage>()
  const addToService = (project: Project, use: ResourceUse) => {
    const known = services.get(project.id)
    const rootPath = project.root_path ?? project.path
    services.set(project.id, {
      service_id: project.id,
      name: project.name,
      project: path.basename(rootPath),
      project_path: rootPath,
      cpu: round((known?.cpu ?? 0) + use.cpu),
      memory: (known?.memory ?? 0) + use.memory
    })
  }
  for (const id of managedProcessIds()) {
    const project = projects.find((entry) => entry.id === id)
    if (project) addToService(project, useOf(id))
  }

  const containers: ContainerUsage[] = []
  const dockerStats = dockerList.trim() ? parseDockerStats(await latestDockerStats() ?? '') : new Map<string, { cpu: number; memory: number }>()
  for (const container of dockerProjects(dockerList, dockerStats, projects, machine.cores)) {
    const project = projects.find((entry) => entry.id === container.service_id)
    if (project) addToService(project, container)
    else containers.push(container)
  }

  const servers: ServerUsage[] = outside.map((server) => ({ server, ...useOf(server.key) }))

  // Without top's reading, resident size would undercount macOS's own processes badly.
  let apps: AppUsage[] = []
  if (allFootprints) {
    const memoryOf = (entry: ProcessUsage) => allFootprints.get(entry.pid) ?? entry.rss
    const heaviest = heaviestApps(groupApps(processes, new Set(ownedPids), memoryOf, machine.cores, process.getuid?.() ?? -1))
    await nameScripts(heaviest)
    apps = heaviest.map(({ pids: _pids, ...app }) => app)
  }

  const byMemory = (a: ResourceUse, b: ResourceUse) => b.memory - a.memory
  return {
    machine,
    multiprise: useOf(MULTIPRISE),
    services: [...services.values()].sort(byMemory),
    servers: servers.sort(byMemory),
    containers: containers.sort(byMemory),
    apps
  }
}
