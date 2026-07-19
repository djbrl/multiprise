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

export type MultipriseService = {
  name?: string
  cwd?: string
  start?: string
  env?: Record<string, string>
  role?: 'backend' | 'frontend' | 'service'
}

export type MultipriseServicePreview = {
  name: string
  role?: 'backend' | 'frontend' | 'service'
  cwd?: string
  start?: string
}

export type ProjectInspectResult = {
  path: string
  name: string
  has_config: boolean
  error?: string | null
  services?: MultipriseServicePreview[]
}

export type MultipriseConfig = {
  services: MultipriseService[]
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
