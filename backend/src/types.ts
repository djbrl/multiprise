export type ProjectKind = 'command' | 'docker_compose'

export type ProcessSource = 'managed' | 'docker' | 'external' | 'none'

export type Project = {
  id: string
  name: string
  path: string
  root_path?: string
  tags: string[]
  command?: string | null
  stop_command?: string | null
  port?: number | null
  icon_path?: string | null
  kind: ProjectKind
  role?: 'backend' | 'frontend' | 'service'
  docker_running?: boolean
  docker_started_at?: string | null
  last_exit_code?: number | null
  last_exit_at?: string | null
  created_at: string
}

export type ProcessStatus = {
  running: boolean
  pid?: number | null
  started_at?: string | null
}

export type ProjectView = {
  project: Project
  status: ProcessStatus
}

export type DetectResponse = {
  scripts: Record<string, string>
  suggested_command?: string | null
  package_manager?: string | null
  has_docker_compose: boolean
}

export type LogLine = {
  timestamp: string
  stream: 'stdout' | 'stderr'
  line: string
}

export type Settings = {
  auto_port: boolean
  port_base: number
  scan_depth: number
  scan_ignore: string[]
  theme?: string
}

export type ScanResult = {
  path: string
  name: string
  scripts: Record<string, string>
  suggested_command?: string | null
  package_manager?: string | null
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
  role: 'backend' | 'frontend' | 'service'
  kind: ProjectKind
  source: 'package.json' | 'Cargo.toml' | 'compose'
  package_manager?: string | null
  scripts: Record<string, string>
}

export type ServicePreview = {
  name: string
  role: 'backend' | 'frontend' | 'service'
  cwd: string
  start: string
  source: DiscoveredService['source']
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
  role?: 'backend' | 'frontend' | 'service'
  force_auto_port?: boolean
}

export type AllocatePortsPayload = {
  roles?: Array<'backend' | 'frontend' | 'service'>
}

export type UpdateProjectPayload = {
  name?: string
  command?: string | null
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
