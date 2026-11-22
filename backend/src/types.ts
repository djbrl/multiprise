// Types shared by the backend, the CLI and the renderer (which imports them with
// `import type`). Keep this file free of runtime imports so the renderer can use it.

export type ProjectKind = 'command' | 'docker_compose'
export type ServiceRole = 'backend' | 'frontend' | 'service'
export type CommandSource = 'auto' | 'user'
export type Framework = 'vite' | 'next' | 'nuxt' | 'nest' | 'node' | 'cargo' | 'docker' | 'unknown'
export type ProcessPhase = 'stopped' | 'starting' | 'ready' | 'failed'

export type ProcessSource = 'managed' | 'docker' | 'external' | 'none'

export type Project = {
  id: string
  name: string
  path: string
  root_path?: string
  tags: string[]
  command?: string | null
  command_source?: CommandSource
  package_manager?: string | null
  install_root?: string | null
  framework?: Framework
  stop_command?: string | null
  port?: number | null
  icon_path?: string | null
  kind: ProjectKind
  role?: ServiceRole
  docker_running?: boolean
  docker_started_at?: string | null
  last_exit_code?: number | null
  last_exit_at?: string | null
  last_error?: string | null
  created_at: string
  // Variables set for this service; values may reference other services ({{services.api.url}}).
  env?: Record<string, string>
  // Names of variables whose values are kept encrypted outside projects.json.
  secret_env?: string[]
  // Ids of services this one depends on: they start first and can be referenced in env.
  links?: string[]
}

// One container of a Docker Compose service, from `docker compose ps`.
export type ContainerState = {
  service: string
  state: string
  health: string
  exit_code: number | null
  ports: number[]
}

// Why a start failed or a running service turned failed (see failures.ts), so the app can offer a fix.
export type FailureCode =
  | 'missing-build'
  | 'existing-instance'
  | 'port-in-use'
  | 'runtime-missing'
  | 'dependencies-missing'
  | 'environment-missing'
  | 'version-mismatch'
  | 'unhealthy-response'
  | 'timeout'
  | 'early-exit'
  | 'launch-error'
  | 'not-responding'

export type ProcessStatus = {
  phase: ProcessPhase
  running: boolean
  ready: boolean
  pid?: number | null
  started_at?: string | null
  ready_at?: string | null
  error?: string | null
  exit_code?: number | null
  // What kind of failure `error` describes.
  failure_code?: FailureCode | null
  containers?: ContainerState[]
}

export type ProjectView = {
  project: Project
  status: ProcessStatus
}

export type DetectResponse = {
  scripts: Record<string, string>
  suggested_command?: string | null
  suggested_script?: string | null
  package_manager?: string | null
  package_root?: string | null
  framework: Framework
  has_docker_compose: boolean
}

export type LogLine = {
  // Increases across all services; identifies a line when it is updated in place.
  seq: number
  timestamp: string
  stream: 'stdout' | 'stderr'
  line: string
  // How many consecutive times this exact line was printed.
  repeat?: number
}

// 'system' follows macOS: light or dark as the Mac is set.
export type ThemeName = 'system' | 'light' | 'dark' | 'socket'
export type ResolvedTheme = Exclude<ThemeName, 'system'>

export type Settings = {
  auto_port: boolean
  auto_install: boolean
  notifications: boolean
  // Relaunch a service that crashes after it was ready (a few times, with backoff).
  auto_restart: boolean
  // Serve every service at a stable http://<service>.<project>.localhost:<proxy_port> name.
  hostnames: boolean
  proxy_port: number
  // Set once the first-run welcome has been completed or skipped.
  onboarded: boolean
  port_base: number
  startup_timeout_ms: number
  scan_depth: number
  scan_ignore: string[]
  theme: ThemeName
}

export type ScanResult = {
  path: string
  name: string
  scripts: Record<string, string>
  suggested_command?: string | null
  suggested_script?: string | null
  package_manager?: string | null
  package_root?: string | null
  framework: Framework
  has_docker_compose: boolean
}

export type ScanState = {
  id: string
  status: 'running' | 'done' | 'stopped'
  projects: ScanResult[]
  created_at: string
}

export type ProcessInstance = {
  pid: number
  port?: number | null
  command?: string | null
  source: ProcessSource
  cwd?: string | null
  reason?: 'assigned-port' | 'startup-conflict'
}

export type UsedPort = {
  port: number
  project_id?: string | null
  project_name?: string | null
  project_path?: string | null
  source: ProcessSource
  pid?: number | null
  command?: string | null
}

// A server listening on this Mac, whoever started it.
export type RunningServer = {
  // Identifies this exact process or container; what /api/running/stop takes.
  key: string
  kind: 'process' | 'docker'
  pid: number | null
  ports: number[]
  // The repository (or folder) it runs from.
  project: string | null
  path: string | null
  // The worktree's name, when it runs from one.
  worktree: string | null
  // It runs from a temporary folder, such as an agent's scratchpad.
  scratch: boolean
  // The folder to add to track it; null when it should not be offered.
  track_path: string | null
  command: string
  started_at: string | null
  service_id: string | null
  service_name: string | null
  tracked: boolean
  // Started and watched by Multiprise.
  managed: boolean
  leftover: boolean
  leftover_reason: string | null
}

export type MemoryPressure = 'normal' | 'warning' | 'critical'

export type MachineUsage = {
  // Percent of the whole machine; null until there are two readings to compare.
  cpu: number | null
  cores: number
  memory_used: number
  memory_total: number
  // How hard macOS is working to find memory, which says more than how much is in use.
  memory_pressure: MemoryPressure | null
  swap_used: number
}

// cpu is a percent of the whole machine, memory is in bytes.
export type ResourceUse = { cpu: number; memory: number }

export type ServiceUsage = ResourceUse & {
  service_id: string
  name: string
  project: string
  project_path: string
}

// A server Multiprise did not start.
export type ServerUsage = ResourceUse & { server: RunningServer }

// A Compose project, or a lone container, that is not tracked.
export type ContainerUsage = ResourceUse & {
  key: string
  name: string
  path: string | null
  service_id: string | null
  containers: number
}

// Everything else on the machine: an app with all its helper processes, a script with what it
// started, a program, or a part of macOS.
export type AppUsage = ResourceUse & {
  key: string
  kind: 'app' | 'script' | 'program' | 'system'
  name: string
  // What a script runs, or how many processes an app has.
  detail: string | null
  // The app bundle, or the folder a script runs in.
  path: string | null
  processes: number
}

export type UsageReport = {
  machine: MachineUsage
  multiprise: ResourceUse
  services: ServiceUsage[]
  servers: ServerUsage[]
  containers: ContainerUsage[]
  // The heaviest of everything else, by memory and by CPU; empty until first measured.
  apps: AppUsage[]
}

// How a running service's memory has moved since it started (see system/memory.ts).
// 'warming-up' until there is enough to judge: dev servers grow on their own at first.
export type MemoryTrend = {
  service_id: string
  name: string
  project: string
  project_path: string
  started_at: string
  status: 'warming-up' | 'steady' | 'growing'
  // Bytes: now, when first measured, and the most it reached.
  current: number
  first: number
  peak: number
  // Bytes per hour over the last stretch measured; null while warming up.
  growth_per_hour: number | null
  // How long it has been measured, which can be shorter than it has run.
  measured_ms: number
  // Evenly spaced readings for a small chart, oldest first.
  points: number[]
}

// A service that has been quiet for hours: no output and next to no CPU.
export type IdleServer = {
  service_id: string
  name: string
  project: string
  project_path: string
  started_at: string
  quiet_since: string
}

// A tracked worktree that has most likely served its purpose.
export type StaleWorktree = {
  root: string
  name: string
  // The repository it belongs to.
  project: string
  branch: string | null
  reason: 'missing' | 'merged' | 'inactive'
  detail: string
  last_commit_at: string | null
  service_ids: string[]
}

export type DockerLeftovers = {
  // Docker is installed and its engine answered.
  available: boolean
  containers: Array<{ id: string; name: string; image: string; project: string | null; status: string }>
  // Volumes no container uses any more; removing one deletes its data.
  volumes: Array<{ name: string; project: string | null }>
  images: Array<{ id: string; size: string; created: string }>
}

export type CleanupReport = {
  memory: MemoryTrend[]
  idle: IdleServer[]
  worktrees: StaleWorktree[]
  // Servers whose terminal, agent or folder is gone.
  leftovers: RunningServer[]
  docker: DockerLeftovers
}

// Folders a project can rebuild (dependencies, build output, caches), which git ignores.
export type DiskFolder = { path: string; relative: string; bytes: number }

export type ProjectDiskUse = {
  root: string
  name: string
  bytes: number
  folders: DiskFolder[]
  // When one of its services last ran, as far as Multiprise knows.
  last_run_at: string | null
  running: boolean
}

export type DiskReport = {
  projects: ProjectDiskUse[]
  measured_at: string | null
  measuring: boolean
}

// Whether Claude Code is set up to run dev servers through Multiprise.
export type AgentStatus = {
  installed: boolean
  connected: boolean
  instructions: boolean
  instructions_path: string
}

export type DiscoveredService = {
  name: string
  path: string
  cwd: string
  command: string
  script?: string | null
  command_source: CommandSource
  role: ServiceRole
  kind: ProjectKind
  source: 'package.json' | 'Cargo.toml' | 'compose'
  package_manager?: string | null
  install_root?: string | null
  framework: Framework
  scripts: Record<string, string>
}

export type ServicePreview = {
  name: string
  role: ServiceRole
  cwd: string
  start: string
  source: DiscoveredService['source']
  framework: Framework
}

export type ProjectInspectResult = {
  path: string
  name: string
  has_services: boolean
  error?: string | null
  services?: ServicePreview[]
}

export type StartProjectPayload = {
  command?: string
  port?: number
  env?: Record<string, string>
  role?: ServiceRole
  force_auto_port?: boolean
}

export type AllocatePortsPayload = {
  // Service ids; each gets its previous port when still free, otherwise a new one.
  services?: string[]
}

export type UpdateProjectPayload = {
  links?: string[]
  name?: string
  command?: string | null
  command_source?: CommandSource
  stop_command?: string | null
  port?: number | null
}

export type CreateProjectPayload = {
  path: string
  name?: string
  command?: string
  stop_command?: string
  kind?: ProjectKind
}

export type ProcessKillPayload = {
  pid?: number
  port?: number
}

export type ScanRequestPayload = {
  roots: string[]
}

// Pushed over /api/events.
export type AppEvent =
  // `replace` updates the service's last line in place (its repeat counter grew).
  | { type: 'log'; id: string; entry: LogLine; replace: boolean }
  | { type: 'logs-cleared'; id: string }
  | { type: 'status'; id: string; status: ProcessStatus }
  | { type: 'projects' }

// A service variable as the environment editor sees it: secret values are never sent back.
export type EnvVariable = { key: string; value: string | null; secret: boolean }

export type DetectedVariable = {
  key: string
  // The value the example file shows (usually a placeholder).
  example: string
  // Whether a .env file sets it; its value is never read back to the app.
  in_env_file: boolean
}

export type EnvFileStatus = {
  // The example file found, relative to the service folder.
  example: string | null
  has_env: boolean
  // Variables the example declares that neither an env file nor Multiprise provides.
  missing: string[]
  // Every variable the example declares, in its order.
  variables: DetectedVariable[]
}

// GET and PUT /api/projects/:id/environment.
export type EnvironmentResponse = {
  variables: EnvVariable[]
  links: string[]
  env_file: EnvFileStatus
}

// GET /api/hostnames.
export type HostnameInfo = {
  enabled: boolean
  port: number | null
  error: string | null
  // Service id to its stable URL.
  urls: Record<string, string>
}
