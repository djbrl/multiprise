import readline from 'node:readline'
import { ApiError, connect, type MultipriseClient } from './client'
import {
  formatLogLine,
  getLogs,
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
    description: 'Read the most recent output (stdout and stderr) of a service, for example to see why it failed or to find an error after a request.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { ...serviceArgument, description: 'The service: its name, "project/service", its id, or its folder path.' },
        lines: { type: 'integer', minimum: 1, maximum: 2000, default: 100, description: 'How many recent lines to return.' },
        stream: { type: 'string', enum: ['all', 'stdout', 'stderr'], default: 'all' }
      },
      required: ['service']
    },
    annotations: { readOnlyHint: true },
    run: async (client, args) => {
      const chosen = await service(client, args.service)
      const lines = Math.min(2000, Math.max(1, Number(args.lines) || 100))
      let logs = await getLogs(client, chosen, lines)
      if (args.stream === 'stdout' || args.stream === 'stderr') logs = logs.filter((entry) => entry.stream === args.stream)
      const header = `${qualifiedName(chosen)} is ${chosen.phase}${chosen.url ? ` at ${chosen.url}` : ''}.`
      if (!logs.length) return `${header} No output yet.`
      return `${header}\n\n${logs.map((entry) => `${entry.stream === 'stderr' ? '[stderr] ' : ''}${formatLogLine(entry)}`).join('\n')}`
    }
  },
  {
    name: 'get_url',
    description: 'Get the local URL of a running service. Fails when the service is not ready; start it with start_service first.',
    inputSchema: { type: 'object', properties: { service: { ...serviceArgument, description: 'The service: its name, "project/service", its id, or its folder path.' } }, required: ['service'] },
    annotations: { readOnlyHint: true },
    run: async (client, args) => {
      const chosen = await service(client, args.service)
      if (!chosen.url) {
        throw new ToolError(`${qualifiedName(chosen)} is ${chosen.phase}${chosen.error && chosen.phase === 'failed' ? `: ${chosen.error}` : ''}. Start it with start_service.`)
      }
      return chosen.url
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
            'Use tail_logs to read a service\'s output.'
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
