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

export type ThemeName = 'light' | 'dark'

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
