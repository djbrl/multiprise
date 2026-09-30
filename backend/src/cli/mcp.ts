import readline from 'node:readline'
import { ApiError, connect, type MultipriseClient } from './client'
import {
  addFolders,
  dependencyNames,
  getEnvironment,
  getSettings,
  inspectFolders,
  killProcess,
  prepareService,
  processesOf,
  removeTargets,
  renameService,
  serviceDetails,
  setCommand,
  setDependencies,
  setPort,
  setVariables,
  unsetVariables,
  updateSettings,
  usedPorts
} from './operations'
import {
  formatLogLine,
  getMergedLogs,
  listProjects,
  qualifiedName,
  resolveService,
  resolveTarget,
  restartTargets,
  startTargets,
  stopTargets,
  type Service,
  type StartResult,
  type StopResult
} from './services'

// A Model Context Protocol server over stdio (newline-delimited JSON-RPC), so coding
// agents reuse the services Multiprise already runs instead of spawning their own.

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

type JsonRpcId = string | number | null
type JsonRpcMessage = { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: any }

type Tool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
  run: (client: MultipriseClient, args: Record<string, any>) => Promise<unknown>
}

const serviceArgument = {
  type: 'string',
  description: 'A service or project: its name, "project/service", its id, or an absolute folder path. A project means all of its services.'
}

const singleService = { type: 'string', description: 'The service: its name, "project/service", its id, or its folder path.' }

const summarize = (service: Service) => ({
  id: service.id,
  name: qualifiedName(service),
  role: service.role,
  status: service.phase,
  url: service.url,
  // Stable across restarts and port changes; prefer it for links and bookmarks.
  host_url: service.host_url,
  port: service.port,
  path: service.path,
  ...(service.error && service.phase === 'failed' ? { error: service.error } : {})
})

const summarizeResults = (results: Array<StartResult | StopResult>) => results.map((result) => ({
  ...summarize(result.service),
  outcome: result.outcome,
  ...(result.error ? { error: result.error } : {})
}))

async function target(client: MultipriseClient, query: unknown) {
  if (typeof query !== 'string' || !query.trim()) throw new ToolError('Name a service or project.')
  return resolveTarget(await listProjects(client), query.trim())
}

async function service(client: MultipriseClient, query: unknown) {
  if (typeof query !== 'string' || !query.trim()) throw new ToolError('Name a service.')
  return resolveService(await listProjects(client), query.trim())
}

class ToolError extends Error {}

const TOOLS: Tool[] = [
  {
    name: 'list_services',
    description: 'List the projects and services Multiprise manages, with their status (stopped, starting, ready, failed), port and URL. ' +
      'Check this before starting a dev server yourself: if the service is already running, use its URL instead of launching another copy.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Only list this project (name or folder path).' } }
    },
    annotations: { readOnlyHint: true },
    run: async (client, args) => {
      const projects = await listProjects(client)
      const chosen = args.project ? [resolveTarget(projects, String(args.project)).project] : projects
      return chosen.map((project) => ({ project: project.name, path: project.path, services: project.services.map(summarize) }))
    }
  },
  {
    name: 'start_service',
    description: 'Start a service, or every service of a project, and wait until it accepts connections. ' +
      'Multiprise assigns a free port, keeps the previous one when possible, and wires BACKEND_PORT/FRONTEND_PORT between siblings. ' +
      'Services it depends on start first, and services that are already running are left alone. Returns each service\'s URL.',
    inputSchema: { type: 'object', properties: { service: serviceArgument }, required: ['service'] },
    run: async (client, args) => summarizeResults(await startTargets(client, [await target(client, args.service)]))
  },
  {
    name: 'stop_service',
    description: 'Stop a service, or every service of a project, including all the processes it spawned.',
    inputSchema: { type: 'object', properties: { service: serviceArgument }, required: ['service'] },
    annotations: { destructiveHint: true },
    run: async (client, args) => summarizeResults(await stopTargets(client, [await target(client, args.service)]))
  },
  {
    name: 'restart_service',
    description: 'Restart a service, or every service of a project, and wait until it is ready again. Use it after changes a dev server does not hot-reload, such as environment or dependency changes.',
    inputSchema: { type: 'object', properties: { service: serviceArgument }, required: ['service'] },
    annotations: { destructiveHint: true },
    run: async (client, args) => {
      const { stopped, started } = await restartTargets(client, [await target(client, args.service)])
      return started.length ? summarizeResults(started) : summarizeResults(stopped)
    }
  },
  {
    name: 'tail_logs',
    description: 'Read the most recent output (stdout and stderr) of a service, or of every service of a project interleaved, ' +
      'for example to see why it failed or to find an error after a request.',
    inputSchema: {
      type: 'object',
      properties: {
        service: serviceArgument,
        lines: { type: 'integer', minimum: 1, maximum: 2000, default: 100, description: 'How many recent lines to return.' },
        stream: { type: 'string', enum: ['all', 'stdout', 'stderr'], default: 'all' },
        grep: { type: 'string', description: 'Only lines containing this text (case-insensitive).' }
      },
      required: ['service']
    },
    annotations: { readOnlyHint: true },
    run: async (client, args) => {
      const chosen = await target(client, args.service)
      const lines = Math.min(2000, Math.max(1, Number(args.lines) || 100))
      const grep = typeof args.grep === 'string' && args.grep ? args.grep.toLowerCase() : null
      const logs = (await getMergedLogs(client, chosen.services, lines)).filter((entry) =>
        (args.stream !== 'stdout' && args.stream !== 'stderr' || entry.stream === args.stream) && (!grep || entry.line.toLowerCase().includes(grep)))
      const header = chosen.services.map((entry) => `${qualifiedName(entry)} is ${entry.phase}${entry.url ? ` at ${entry.url}` : ''}.`).join('\n')
      if (!logs.length) return `${header}\n\nNo matching output.`
      const prefix = chosen.services.length > 1
      return `${header}\n\n${logs.map((entry) => `${prefix ? `[${entry.service}] ` : ''}${entry.stream === 'stderr' ? '[stderr] ' : ''}${formatLogLine(entry)}`).join('\n')}`
    }
  },
  {
    name: 'get_url',
    description: 'Get the local URL of a running service. Fails when the service is not ready; start it with start_service first.',
    inputSchema: { type: 'object', properties: { service: singleService }, required: ['service'] },
    annotations: { readOnlyHint: true },
    run: async (client, args) => {
      const chosen = await service(client, args.service)
      if (!chosen.url) {
        throw new ToolError(`${qualifiedName(chosen)} is ${chosen.phase}${chosen.error && chosen.phase === 'failed' ? `: ${chosen.error}` : ''}. Start it with start_service.`)
      }
      return chosen.url
    }
  },
  {
    name: 'get_service',
    description: 'Everything about one service: status, URL, port, start command, role, folder, id, last error and failure kind, ' +
      'the services it depends on, its variables (secret values are never shown) and what its .env.example declares.',
    inputSchema: { type: 'object', properties: { service: singleService }, required: ['service'] },
    annotations: { readOnlyHint: true },
    run: async (client, args) => serviceDetails(client, await service(client, args.service))
  },
  {
    name: 'add_project',
    description: 'Track a project folder so Multiprise can run it. It finds the services inside (package.json scripts, Cargo, Docker Compose) ' +
      'and their start commands. Pass dry_run to only see what would be found.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Absolute path of the project\'s top folder.' },
        dry_run: { type: 'boolean', default: false }
      },
      required: ['folder']
    },
    run: async (client, args) => {
      if (typeof args.folder !== 'string' || !args.folder.trim()) throw new ToolError('Give the project folder.')
      if (args.dry_run) return inspectFolders(client, [args.folder])
      const [result] = await addFolders(client, [args.folder])
      if (!result.added) throw new ToolError(result.error ?? 'The folder was not added.')
      return result
    }
  },
  {
    name: 'remove_project',
    description: 'Stop tracking a project or a single service: its services are stopped and their settings, variables, secrets and logs are forgotten. ' +
      'The folder on disk is not touched. Only do this when the user asked for it.',
    inputSchema: { type: 'object', properties: { service: serviceArgument }, required: ['service'] },
    annotations: { destructiveHint: true },
    run: async (client, args) => ({ removed: await removeTargets(client, [await target(client, args.service)]) })
  },
  {
    name: 'configure_service',
    description: 'Change how a service starts: its start command (or reset it to the detected one), its preferred port, or its name. ' +
      'Restart the service for a new command or port to take effect.',
    inputSchema: {
      type: 'object',
      properties: {
        service: singleService,
        command: { type: 'string', description: 'The shell command that starts it, e.g. "pnpm dev --host".' },
        reset_command: { type: 'boolean', description: 'Go back to the command Multiprise detected.' },
        port: { type: ['integer', 'null'], minimum: 1, maximum: 65535, description: 'Preferred port; null lets Multiprise choose.' },
        name: { type: 'string', description: 'A new display name.' }
      },
      required: ['service']
    },
    run: async (client, args) => {
      const chosen = await service(client, args.service)
      if (args.command !== undefined && args.reset_command) throw new ToolError('Give a command or reset_command, not both.')
      if (args.command !== undefined) await setCommand(client, chosen, String(args.command))
      if (args.reset_command) await setCommand(client, chosen, null)
      if (args.port !== undefined) await setPort(client, chosen, args.port === null ? null : Number(args.port))
      if (args.name !== undefined) await renameService(client, chosen, String(args.name))
      return serviceDetails(client, await service(client, chosen.id))
    }
  },
  {
    name: 'set_environment',
    description: 'Set or remove variables a service starts with. Values may reference other services: {{services.api.url}}, ' +
      '{{services.api.port}} or {{services.api.host_url}}. Secret values are stored encrypted with the macOS Keychain and never returned. ' +
      'Takes effect the next time the service starts (use restart_service).',
    inputSchema: {
      type: 'object',
      properties: {
        service: singleService,
        set: { type: 'object', additionalProperties: { type: 'string' }, description: 'Variables to set, as {"KEY": "value"}.' },
        secret: { type: 'boolean', default: false, description: 'Store the variables in `set` as secrets.' },
        unset: { type: 'array', items: { type: 'string' }, description: 'Names of variables to remove.' }
      },
      required: ['service']
    },
    run: async (client, args) => {
      const chosen = await service(client, args.service)
      const assignments = Object.entries((args.set ?? {}) as Record<string, unknown>).map(([key, value]) => ({ key, value: String(value) }))
      if (assignments.length) await setVariables(client, chosen, assignments, !!args.secret)
      if (Array.isArray(args.unset) && args.unset.length) await unsetVariables(client, chosen, args.unset.map(String))
      return getEnvironment(client, chosen)
    }
  },
  {
    name: 'set_dependencies',
    description: 'Set the services that must start before this one (replacing the current list; an empty list removes them). ' +
      'Dependencies start first and can be referenced in its variables.',
    inputSchema: {
      type: 'object',
      properties: {
        service: singleService,
        depends_on: { type: 'array', items: { type: 'string' }, description: 'Services, by name, "project/service" or id.' }
      },
      required: ['service', 'depends_on']
    },
    run: async (client, args) => {
      const projects = await listProjects(client)
      const chosen = resolveService(projects, String(args.service))
      const ids = (Array.isArray(args.depends_on) ? args.depends_on : []).map((name: unknown) => resolveService(projects, String(name)).id)
      return { service: qualifiedName(chosen), depends_on: await dependencyNames(client, await setDependencies(client, chosen, ids), projects) }
    }
  },
  {
    name: 'list_ports',
    description: 'Ports held by tracked services and whether Multiprise, Docker or another process holds them.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    run: async (client) => usedPorts(client)
  },
  {
    name: 'list_processes',
    description: 'Processes on a service\'s port, including other copies Multiprise did not start (a common reason a start fails with "port in use").',
    inputSchema: { type: 'object', properties: { service: singleService }, required: ['service'] },
    annotations: { readOnlyHint: true },
    run: async (client, args) => processesOf(client, await service(client, args.service))
  },
  {
    name: 'kill_process',
    description: 'Stop a process that is not Multiprise\'s but holds a service\'s port or blocked its start (see list_processes). ' +
      'Without pid or port, the process on the service\'s port is stopped.',
    inputSchema: {
      type: 'object',
      properties: { service: singleService, pid: { type: 'integer' }, port: { type: 'integer' } },
      required: ['service']
    },
    annotations: { destructiveHint: true },
    run: async (client, args) => killProcess(client, await service(client, args.service), {
      pid: args.pid === undefined ? undefined : Number(args.pid),
      port: args.port === undefined ? undefined : Number(args.port)
    })
  },
  {
    name: 'prepare_service',
    description: 'Install a stopped service\'s dependencies, or run its build, e.g. after a start failed because they were missing.',
    inputSchema: {
      type: 'object',
      properties: { service: singleService, step: { type: 'string', enum: ['install', 'build'] } },
      required: ['service', 'step']
    },
    run: async (client, args) => {
      if (args.step !== 'install' && args.step !== 'build') throw new ToolError('step is install or build.')
      const chosen = await service(client, args.service)
      await prepareService(client, chosen, args.step)
      return `${qualifiedName(chosen)}: ${args.step === 'install' ? 'dependencies installed' : 'built'}.`
    }
  },
  {
    name: 'get_settings',
    description: 'Multiprise\'s settings: automatic ports, dependency installs, notifications, crash restarts, stable hostnames, startup timeout and discovery.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    run: async (client) => getSettings(client)
  },
  {
    name: 'update_settings',
    description: 'Change some of Multiprise\'s settings (see get_settings for the names and current values). Only change what the user asked for.',
    inputSchema: {
      type: 'object',
      properties: { settings: { type: 'object', description: 'The settings to change, e.g. {"auto_restart": false}.' } },
      required: ['settings']
    },
    run: async (client, args) => {
      const current = await getSettings(client)
      const patch = (args.settings && typeof args.settings === 'object' ? args.settings : {}) as Record<string, unknown>
      const unknown = Object.keys(patch).filter((key) => !(key in current) || key === 'onboarded')
      if (unknown.length) throw new ToolError(`Unknown settings: ${unknown.join(', ')}.`)
      return updateSettings(client, patch)
    }
  }
]

export async function runMcpServer(version: string) {
  let client: MultipriseClient | null = null
  // The app may restart with a new port and token, so reconnect once when a call cannot get through.
  const withClient = async <T>(fn: (client: MultipriseClient) => Promise<T>) => {
    const status = (message: string) => process.stderr.write(`[multiprise] ${message}\n`)
    if (!client) client = await connect({ launch: true, onStatus: status })
    try {
      return await fn(client)
    } catch (err) {
      const unreachable = err instanceof ApiError ? err.status === 401 : Boolean((err as NodeJS.ErrnoException).code)
      if (!unreachable) throw err
      client = await connect({ launch: true, onStatus: status })
      return fn(client)
    }
  }

  const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`)
  const reply = (id: JsonRpcId, result: unknown) => send({ jsonrpc: '2.0', id, result })
  const fail = (id: JsonRpcId, code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } })

  const callTool = async (params: any) => {
    const tool = TOOLS.find((entry) => entry.name === params?.name)
    if (!tool) return null
    try {
      const result = await withClient((connected) => tool.run(connected, params.arguments ?? {}))
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      // Tool failures are results the model can read and act on, not protocol errors.
      return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true }
    }
  }

  const handle = async (message: JsonRpcMessage) => {
    const { id, method, params } = message
    const isRequest = id !== undefined && id !== null
    if (!method) return
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion
        return reply(id!, {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'multiprise', version },
          instructions: 'Multiprise runs the local dev servers of the user\'s projects. Before starting a dev server with a shell command, ' +
            'call list_services: reuse a running service\'s URL, or start it with start_service so it gets a stable, conflict-free port. ' +
            'Use tail_logs to read a service\'s output and get_service for its configuration and last error. ' +
            'add_project, configure_service, set_environment and set_dependencies change how services run; ' +
            'list_processes and kill_process free a port held by a stray process.'
        })
      }
      case 'ping':
        return isRequest ? reply(id!, {}) : undefined
      case 'tools/list':
        return reply(id!, {
          tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) }))
        })
      case 'tools/call': {
        const result = await callTool(params)
        return result ? reply(id!, result) : fail(id!, -32602, `Unknown tool: ${params?.name}`)
      }
      default:
        // Notifications (initialized, cancelled, …) need no answer.
        if (isRequest) fail(id!, -32601, `Method not found: ${method}`)
    }
  }

  const pending = new Set<Promise<void>>()
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  input.on('line', (line) => {
    if (!line.trim()) return
    let parsed: JsonRpcMessage | JsonRpcMessage[]
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      return fail(null, -32700, 'Parse error')
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      const task: Promise<void> = handle(message)
        .then(() => undefined, (err) => {
          if (message.id !== undefined && message.id !== null) fail(message.id, -32603, err instanceof Error ? err.message : String(err))
        })
        .finally(() => pending.delete(task))
      pending.add(task)
    }
  })
  await new Promise<void>((resolve) => input.on('close', () => resolve()))
  await Promise.allSettled([...pending])
}
