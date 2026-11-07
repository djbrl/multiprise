#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { execFile } from 'node:child_process'
import { agentStatus, connectAgents, disconnectAgents } from '../agents'
import type { AgentStatus, EnvironmentResponse, LogLine, ProcessInstance, RunningServer, UsageReport, UsedPort } from '../types'
import { connect, NotRunningError, type MultipriseClient } from './client'
import { runMcpServer } from './mcp'
import {
  addFolders,
  chooseRunningServers,
  dependencyNames,
  getEnvironment,
  getSettings,
  inspectFolders,
  killProcess,
  openFolder,
  parseAssignments,
  parseSettings,
  prepareService,
  processesOf,
  removeTargets,
  renameService,
  runningServerName,
  runningServers,
  serviceDetails,
  usageReport,
  setCommand,
  setDependencies,
  setPort,
  setVariables,
  stopRunningServer,
  targetsToStart,
  unsetVariables,
  updateSettings,
  usedPorts
} from './operations'
import {
  formatLogLine,
  getMergedLogs,
  listProjects,
  qualifiedName,
  resolveCurrentProject,
  resolveService,
  resolveTarget,
  restartTargets,
  startTargets,
  stopTargets,
  UsageError,
  type Project,
  type Service,
  type ServiceLogLine,
  type StartResult,
  type StopResult,
  type Target
} from './services'

const readVersion = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf-8')).version ?? 'unknown'
  } catch (err) {
    return 'unknown'
  }
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code: string) => (text: string) => useColor ? `\u001b[${code}m${text}\u001b[0m` : text
const dim = paint('2')
const bold = paint('1')
const green = paint('32')
const yellow = paint('33')
const red = paint('31')

const PHASE_STYLE: Record<string, (text: string) => string> = { ready: green, starting: yellow, failed: red, stopped: dim }
const PHASE_ICON: Record<string, string> = { ready: '●', starting: '◐', failed: '✕', stopped: '○' }

const tildify = (value: string) => value.startsWith(os.homedir() + path.sep) ? `~${value.slice(os.homedir().length)}` : value
const status = (message: string) => process.stderr.write(`${dim(message)}\n`)
const printJson = (value: unknown) => console.log(JSON.stringify(value, null, 2))

// ---- Arguments ---------------------------------------------------------------------------

// Options that take a value; every other option is a switch.
const VALUE_OPTIONS: Record<string, string> = {
  '-n': 'lines', '--lines': 'lines', '--grep': 'grep', '--stream': 'stream', '--pid': 'pid', '--port': 'port'
}
const SWITCHES: Record<string, string> = {
  '--json': 'json', '-f': 'follow', '--follow': 'follow', '-y': 'yes', '--yes': 'yes', '--secret': 'secret',
  '--auto': 'auto', '--clear': 'clear', '--dry-run': 'dryRun', '--leftovers': 'leftovers', '-h': 'help', '--help': 'help', '-v': 'version', '--version': 'version'
}

type Args = {
  command: string | undefined
  // Positional arguments after the command; everything after `--` is kept as is.
  names: string[]
  rest: string[]
  options: Record<string, string | true>
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: undefined, names: [], rest: [], options: {} }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      args.rest = argv.slice(index + 1)
      break
    }
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    if (VALUE_OPTIONS[flag]) {
      const value = inline ?? argv[++index]
      if (value === undefined) throw new UsageError(`${flag} needs a value.`)
      args.options[VALUE_OPTIONS[flag]] = value
    } else if (SWITCHES[flag] && inline === undefined) {
      args.options[SWITCHES[flag]] = true
    } else if (arg.startsWith('-') && arg !== '-' && !/^-\d/.test(arg)) {
      throw new UsageError(`Unknown option ${arg}. Run \`multiprise help\`.`)
    } else if (args.command === undefined) {
      args.command = arg
    } else {
      args.names.push(arg)
    }
  }
  return args
}

function positiveInteger(value: string | true | undefined, name: string, fallback: number) {
  if (value === undefined) return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new UsageError(`${name} needs a positive whole number.`)
  return number
}

// ---- Output ------------------------------------------------------------------------------

function printProjects(projects: Project[]) {
  if (!projects.length) {
    console.log('No projects yet. Add one with `multiprise add <folder>`.')
    return
  }
  for (const project of projects) {
    console.log(`${bold(project.name)}  ${dim(tildify(project.path))}`)
    const width = Math.max(...project.services.map((service) => service.name.length))
    for (const service of project.services) {
      const style = PHASE_STYLE[service.phase] ?? dim
      const location = service.url
        ? `${service.url}${service.host_url ? `  ${dim(service.host_url)}` : ''}`
        : service.phase === 'failed' && service.error ? red(service.error.split('\n')[0]) : ''
      console.log(`  ${style(PHASE_ICON[service.phase] ?? '○')} ${service.name.padEnd(width)}  ${dim(service.role.padEnd(8))}  ${style(service.phase.padEnd(8))}  ${location}`.trimEnd())
    }
  }
}

function printResults(results: Array<StartResult | StopResult>, json: boolean) {
  if (json) {
    printJson(results)
    return
  }
  for (const result of results) {
    const name = qualifiedName(result.service)
    const stable = result.service.host_url ? `  ${dim(result.service.host_url)}` : ''
    switch (result.outcome) {
      case 'started':
        console.log(`${green('●')} ${name}  ${result.service.url ?? 'started'}${stable}`)
        break
      case 'already-running':
        console.log(`${green('●')} ${name}  ${result.service.url ?? 'running'}${stable} ${dim('(already running)')}`)
        break
      case 'stopped':
        console.log(`${dim('○')} ${name}  stopped`)
        break
      case 'not-running':
        console.log(`${dim('○')} ${name}  ${dim('not running')}`)
        break
      default:
        console.log(`${red('✕')} ${name}  ${red(result.error ?? result.outcome)}`)
        if ('recent_logs' in result) for (const line of result.recent_logs ?? []) console.log(dim(`    ${line}`))
    }
  }
}

const failed = (results: Array<StartResult | StopResult>) =>
  results.some((result) => result.outcome === 'failed' || result.outcome === 'skipped')

function printEnvironment(service: Service, environment: EnvironmentResponse, dependsOn: string[]) {
  console.log(bold(`${qualifiedName(service)} environment`))
  if (!environment.variables.length) console.log(dim('  No variables set in Multiprise.'))
  const width = Math.max(0, ...environment.variables.map((variable) => variable.key.length))
  for (const variable of environment.variables) {
    console.log(`  ${variable.key.padEnd(width)}  ${variable.secret ? dim('(secret, stored in the Keychain)') : variable.value}`)
  }
  const file = environment.env_file
  if (file.example) {
    const unset = file.variables.filter((variable) => !variable.in_env_file && !environment.variables.some((entry) => entry.key === variable.key))
    console.log(`\n  ${dim(`${file.example}${file.has_env ? ' (with a .env file)' : ' (no .env file)'}`)}`)
    if (unset.length) console.log(`  ${yellow('Not set:')} ${unset.map((variable) => variable.key).join(', ')}`)
    else console.log(`  ${dim('Every variable it declares is set.')}`)
  }
  console.log(`\n  ${dim('Starts first:')} ${dependsOn.length ? dependsOn.join(', ') : dim('nothing')}`)
}

function printInstances(service: Service, instances: ProcessInstance[]) {
  if (!instances.length) {
    console.log(`${qualifiedName(service)}: no process holds its port.`)
    return
  }
  for (const instance of instances) {
    const who = instance.source === 'managed' ? 'started by Multiprise' : instance.source === 'docker' ? 'Docker' : instance.reason === 'startup-conflict' ? 'another copy (blocked its start)' : 'another process on its port'
    console.log(`${instance.port ? `:${instance.port}` : '—'}  PID ${instance.pid || '—'}  ${who}${instance.command ? `  ${dim(instance.command)}` : ''}`)
  }
}

function printPorts(ports: UsedPort[]) {
  if (!ports.length) {
    console.log('No tracked service holds a port.')
    return
  }
  for (const entry of ports) {
    console.log(`:${String(entry.port).padEnd(6)} ${(entry.project_name ?? '').padEnd(16)} ${entry.source.padEnd(8)} ${entry.pid ? `PID ${entry.pid}` : ''}`.trimEnd())
  }
}

function formatAge(startedAt: string | null) {
  if (!startedAt) return '—'
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 60000))
  if (minutes < 60) return `${minutes} min`
  if (minutes < 60 * 48) return `${Math.floor(minutes / 60)} h`
  return `${Math.floor(minutes / (60 * 24))} days`
}

function printRunning(servers: RunningServer[]) {
  if (!servers.length) {
    console.log('No dev servers are running.')
    return
  }
  const ports = servers.map((server) => server.ports.map((port) => `:${port}`).join(' '))
  const names = servers.map(runningServerName)
  const portWidth = Math.max(...ports.map((text) => text.length))
  const nameWidth = Math.max(...names.map((text) => text.length))
  servers.forEach((server, index) => {
    const icon = server.leftover ? yellow('!') : server.managed ? green('●') : dim('○')
    console.log(`${icon} ${ports[index].padEnd(portWidth)}  ${names[index].padEnd(nameWidth)}  ${formatAge(server.started_at).padEnd(8)}  ${dim(server.command)}`)
    if (server.leftover_reason) console.log(`  ${yellow(server.leftover_reason)}`)
  })
  const leftovers = servers.filter((server) => server.leftover).length
  if (leftovers) console.log(dim(`\n${leftovers} leftover${leftovers === 1 ? '' : 's'}. \`multiprise running stop --leftovers\` stops ${leftovers === 1 ? 'it' : 'them'}.`))
}

const formatBytes = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`

function printUsage(report: UsageReport) {
  const { machine } = report
  const pressure = machine.memory_pressure ?? 'unknown'
  console.log(`CPU     ${machine.cpu === null ? 'measuring' : `${Math.round(machine.cpu)}%`} of ${machine.cores} cores`)
  console.log(`Memory  ${formatBytes(machine.memory_used)} of ${formatBytes(machine.memory_total)}, pressure ${pressure === 'normal' ? pressure : yellow(pressure)}, ${formatBytes(machine.swap_used)} swap`)
  const rows = [
    ...report.services.map((service) => ({ ...service, name: service.name === service.project ? service.name : `${service.project} / ${service.name}`, note: '' })),
    ...report.servers.map(({ server, cpu, memory }) => ({ name: runningServerName(server), cpu, memory, note: server.leftover ? 'leftover' : 'outside' })),
    ...report.containers.map(({ name, cpu, memory }) => ({ name, cpu, memory, note: 'docker' })),
    { name: 'Multiprise', ...report.multiprise, note: 'this app' }
  ].sort((a, b) => b.memory - a.memory)
  const nameWidth = Math.max(...rows.map((row) => row.name.length))
  console.log()
  for (const row of rows) {
    console.log(`${formatBytes(row.memory).padStart(8)}  ${`${row.cpu.toFixed(1)}%`.padStart(6)}  ${row.name.padEnd(nameWidth)}  ${row.note === 'leftover' ? yellow(row.note) : dim(row.note)}`.trimEnd())
  }
  if (!report.apps.length) return
  console.log(`\n${dim('Everything else')}`)
  const width = process.stdout.columns || 100
  for (const app of report.apps) {
    const line = `${formatBytes(app.memory).padStart(8)}  ${`${app.cpu.toFixed(1)}%`.padStart(6)}  ${app.name}`
    const detail = app.detail ? `  ${app.detail}` : ''
    console.log(`${line}${dim(detail.slice(0, Math.max(0, width - line.length)))}`)
  }
}

function printAgents(status: AgentStatus) {
  if (!status.installed) {
    console.log('Claude Code is not installed, or `claude` is not on the PATH.')
    return
  }
  const row = (on: boolean, text: string) => console.log(`${on ? green('●') : dim('○')} ${text}`)
  row(status.connected, `MCP server ${status.connected ? 'registered with Claude Code for every project' : 'not registered'}`)
  row(status.instructions, `Instructions ${status.instructions ? 'in' : 'not in'} ${tildify(status.instructions_path)}`)
  if (!status.connected || !status.instructions) console.log(dim('\n`multiprise agents connect` sets up both.'))
}

const printLogLine = (entry: LogLine | ServiceLogLine, prefix = false) => {
  // Every line comes from the same project, so the service's own name is enough.
  const label = prefix && 'service' in entry ? `${dim((entry.service.split('/').pop() ?? '').padEnd(10))} ` : ''
  process[entry.stream === 'stderr' ? 'stderr' : 'stdout'].write(`${label}${formatLogLine(entry)}\n`)
}

// ---- Shared steps ------------------------------------------------------------------------

async function targetsFor(client: MultipriseClient, names: string[]): Promise<Target[]> {
  const projects = await listProjects(client)
  return names.length ? names.map((name) => resolveTarget(projects, name)) : [resolveCurrentProject(projects)]
}

async function oneService(client: MultipriseClient, name: string | undefined) {
  return resolveService(await listProjects(client), name)
}

// Logs read a service, or a whole project's services interleaved.
async function logTarget(client: MultipriseClient, name: string | undefined): Promise<Service[]> {
  const projects = await listProjects(client)
  if (name) return resolveTarget(projects, name).services
  try {
    return [resolveService(projects, undefined)]
  } catch (err) {
    return resolveCurrentProject(projects).services
  }
}

function logFilter(args: Args) {
  const stream = args.options.stream
  if (stream !== undefined && stream !== 'stdout' && stream !== 'stderr') throw new UsageError('--stream is stdout or stderr.')
  const grep = typeof args.options.grep === 'string' ? args.options.grep.toLowerCase() : null
  return (entry: LogLine) => (!stream || entry.stream === stream) && (!grep || entry.line.toLowerCase().includes(grep))
}

async function followLogs(client: MultipriseClient, services: Service[], lines: number, keep: (entry: LogLine) => boolean) {
  const byId = new Map(services.map((service) => [service.id, qualifiedName(service)]))
  const prefix = services.length > 1
  // Subscribe before reading the backlog so no line falls between the two; sequence
  // numbers only grow, so anything already printed is recognised and skipped.
  let lastSeq = -1
  let buffered: ServiceLogLine[] | null = []
  const show = (entry: ServiceLogLine) => {
    if (entry.seq <= lastSeq) return
    lastSeq = entry.seq
    if (keep(entry)) printLogLine(entry, prefix)
  }
  await new Promise<void>((_resolve, reject) => {
    client.events((event) => {
      if (event.type === 'projects' || !byId.has(event.id)) return
      if (event.type === 'logs-cleared' && !buffered) {
        status(`— ${byId.get(event.id)} restarted —`)
      } else if (event.type === 'log' && !event.replace) {
        const entry = { ...event.entry, service: byId.get(event.id)! }
        if (buffered) buffered.push(entry)
        else show(entry)
      }
    }, () => reject(new NotRunningError('Multiprise closed the log stream.')))
      .then(async () => {
        for (const entry of [...await getMergedLogs(client, services, lines), ...buffered!]) show(entry)
        buffered = null
      })
      .catch(reject)
  })
}

function openUrl(url: string) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  return new Promise<void>((resolve, reject) => execFile(opener, [url], (err) => err ? reject(err) : resolve()))
}

async function requireUrl(client: MultipriseClient, name: string | undefined) {
  const service = await oneService(client, name)
  if (!service.url) {
    const reason = service.phase === 'failed' && service.error ? `failed: ${service.error.split('\n')[0]}` : service.phase
    throw new UsageError(`${qualifiedName(service)} is ${reason}. Start it with \`multiprise up ${qualifiedName(service)}\`.`)
  }
  return service
}

async function confirm(question: string, args: Args) {
  if (args.options.yes) return true
  if (!process.stdin.isTTY) throw new UsageError(`${question} Pass --yes to confirm.`)
  const prompt = readline.createInterface({ input: process.stdin, output: process.stderr })
  const answer = await new Promise<string>((resolve) => prompt.question(`${question} [y/N] `, resolve))
  prompt.close()
  return /^y(es)?$/i.test(answer.trim())
}

// The service a project-level command acts on: the one at the project's root, else the first.
function representative(target: Target) {
  return target.services.find((service) => service.path === target.project.path) ?? target.services[0]
}

// ---- Commands ----------------------------------------------------------------------------

type Context = { client: MultipriseClient; args: Args; json: boolean }

type Command = {
  names: string[]
  usage: string
  // A shorter usage for the command list, when the full one is long.
  short?: string
  summary: string
  group: 'Services' | 'Projects' | 'Configuration' | 'Other'
  // Works without the app, so it never opens it.
  offline?: boolean
  // Longer help for `multiprise help <command>`.
  details?: string
  run: (context: Context) => Promise<number>
}

const COMMANDS: Command[] = [
  {
    names: ['ls', 'list', 'status'],
    usage: 'ls [name…]',
    summary: 'List projects and services with their status and URL',
    group: 'Services',
    run: async ({ client, args, json }) => {
      let projects = await listProjects(client)
      if (args.names.length) {
        const chosen = args.names.map((name) => resolveTarget(projects, name).project)
        projects = projects.filter((project) => chosen.includes(project))
      }
      if (json) printJson(projects)
      else printProjects(projects)
      return 0
    }
  },
  {
    names: ['up', 'start'],
    usage: 'up [name…]',
    summary: 'Start services and wait until they are ready',
    group: 'Services',
    details: 'A project starts its supporting services, then backends, then frontends once a backend is ready.\n' +
      'Services listed with `deps` start first. Services already running are left alone.\n' +
      'A folder nothing tracks yet is tracked first; a git worktree counts as its own project.\n' +
      'If a service fails, the output says why and how its logs ended (with --json too).',
    run: async ({ client, args, json }) => {
      const results = await startTargets(client, await targetsToStart(client, args.names, json ? undefined : status), json ? undefined : status)
      printResults(results, json)
      return failed(results) ? 1 : 0
    }
  },
  {
    names: ['down', 'stop'],
    usage: 'down [name…]',
    summary: 'Stop services and every process they spawned',
    group: 'Services',
    run: async ({ client, args, json }) => {
      const results = await stopTargets(client, await targetsFor(client, args.names), json ? undefined : status)
      printResults(results, json)
      return failed(results) ? 1 : 0
    }
  },
  {
    names: ['restart'],
    usage: 'restart [name…]',
    summary: 'Stop, then start services again',
    group: 'Services',
    run: async ({ client, args, json }) => {
      const { stopped, started } = await restartTargets(client, await targetsFor(client, args.names), json ? undefined : status)
      printResults(started.length ? started : stopped, json)
      return failed(stopped) || failed(started) ? 1 : 0
    }
  },
  {
    names: ['logs'],
    usage: 'logs [name] [-f] [-n N] [--grep TEXT] [--stream stdout|stderr]',
    short: 'logs [name] [-f] [--grep TEXT]',
    summary: 'Print recent output of a service, or a whole project interleaved',
    group: 'Services',
    details: '-f keeps following new lines; -n sets how many recent lines (default 100).\n' +
      '--grep keeps lines containing TEXT (case-insensitive); --stream keeps one stream.',
    run: async ({ client, args, json }) => {
      if (args.names.length > 1) throw new UsageError('logs takes one service or project.')
      const services = await logTarget(client, args.names[0])
      const lines = positiveInteger(args.options.lines, '--lines', 100)
      const keep = logFilter(args)
      if (args.options.follow) {
        if (json) throw new UsageError('--json cannot be combined with --follow; use `multiprise events`.')
        await followLogs(client, services, lines, keep)
        return 0
      }
      const entries = (await getMergedLogs(client, services, lines)).filter(keep)
      if (json) printJson(entries)
      else entries.forEach((entry) => printLogLine(entry, services.length > 1))
      return 0
    }
  },
  {
    names: ['url'],
    usage: 'url [service]',
    summary: 'Print a running service\'s URL',
    group: 'Services',
    run: async ({ client, args, json }) => {
      if (args.names.length > 1) throw new UsageError('url takes one service.')
      const service = await requireUrl(client, args.names[0])
      console.log(json ? JSON.stringify({ service: qualifiedName(service), url: service.url, host_url: service.host_url, port: service.port }) : service.url)
      return 0
    }
  },
  {
    names: ['open'],
    usage: 'open [service]',
    summary: 'Open a running service in the default browser',
    group: 'Services',
    run: async ({ client, args }) => {
      if (args.names.length > 1) throw new UsageError('open takes one service.')
      await openUrl((await requireUrl(client, args.names[0])).url!)
      return 0
    }
  },
  {
    names: ['info', 'show'],
    usage: 'info [service]',
    summary: 'Everything about one service: status, command, port, error, variables',
    group: 'Services',
    run: async ({ client, args, json }) => {
      if (args.names.length > 1) throw new UsageError('info takes one service.')
      const details = await serviceDetails(client, await oneService(client, args.names[0]))
      if (json) {
        printJson(details)
        return 0
      }
      const style = PHASE_STYLE[details.phase] ?? dim
      const rows: Array<[string, string | null | undefined]> = [
        ['Status', style(details.phase) + (details.pid ? dim(`  PID ${details.pid}`) : '')],
        ['URL', details.url ? `${details.url}${details.host_url ? `  ${dim(details.host_url)}` : ''}` : details.host_url],
        ['Port', details.port ? String(details.port) : null],
        ['Command', details.command ? `${details.command}  ${dim(details.command_source === 'user' ? '(set by you)' : '(detected)')}` : null],
        ['Role', details.role],
        ['Kind', details.kind === 'docker_compose' ? 'Docker Compose' : details.framework ?? 'command'],
        ['Folder', tildify(details.path)],
        ['Id', details.id],
        ['Starts first', details.depends_on.length ? details.depends_on.join(', ') : null],
        ['Variables', details.variables.length ? details.variables.map((variable) => variable.key + (variable.secret ? ' (secret)' : '')).join(', ') : null],
        ['Error', details.phase === 'failed' ? details.error : null]
      ]
      console.log(bold(details.name))
      for (const [label, value] of rows) if (value) console.log(`  ${dim(label.padEnd(13))}${value}`)
      return 0
    }
  },
  {
    names: ['ps'],
    usage: 'ps [service]',
    summary: 'Processes holding a service\'s port, including ones Multiprise did not start',
    group: 'Services',
    run: async ({ client, args, json }) => {
      const service = await oneService(client, args.names[0])
      const instances = await processesOf(client, service)
      if (json) printJson(instances)
      else printInstances(service, instances)
      return 0
    }
  },
  {
    names: ['kill'],
    usage: 'kill <service> [--pid N | --port N]',
    short: 'kill <service> [--pid N]',
    summary: 'Stop another process that holds a service\'s port or blocks its start',
    group: 'Services',
    details: 'Only processes on the service\'s port, or another copy of it that blocked its start, can be\n' +
      'stopped this way (see `ps`). Services Multiprise started are stopped with `down`.',
    run: async ({ client, args, json }) => {
      if (!args.names[0]) throw new UsageError('Name the service whose port to free.')
      const service = await oneService(client, args.names[0])
      const pid = args.options.pid === undefined ? undefined : positiveInteger(args.options.pid, '--pid', 0)
      const port = args.options.port === undefined ? undefined : positiveInteger(args.options.port, '--port', 0)
      const result = await killProcess(client, service, { pid, port })
      if (json) printJson(result)
      else console.log(`Stopped PID ${result.pid}.`)
      return 0
    }
  },
  {
    names: ['ports'],
    usage: 'ports',
    summary: 'Ports held by tracked services, and by whom',
    group: 'Services',
    run: async ({ client, json }) => {
      const ports = await usedPorts(client)
      if (json) printJson(ports)
      else printPorts(ports)
      return 0
    }
  },
  {
    names: ['usage'],
    usage: 'usage',
    short: 'usage',
    summary: 'This Mac\'s CPU and memory, and how much each dev server takes',
    group: 'Services',
    details: 'CPU is a share of the whole machine, so 100% is every core busy. Memory is what Activity Monitor\n' +
      'calls footprint, which includes what has been compressed or swapped out. Pressure says how hard\n' +
      'macOS is working to find memory.',
    run: async ({ client, json }) => {
      const report = await usageReport(client)
      if (json) printJson(report)
      else printUsage(report)
      return 0
    }
  },
  {
    names: ['running'],
    usage: 'running [--leftovers] | running stop <port…> | running stop --leftovers [--yes]',
    short: 'running [stop <port…>]',
    summary: 'Every dev server on this Mac, whoever started it; stop one or all leftovers',
    group: 'Services',
    details: 'Lists servers started by terminals and coding agents as well as by Multiprise, with their\n' +
      'project, worktree and age. Desktop apps and system services are left out.\n' +
      'A leftover has lost the terminal or agent that started it, or its folder; it is a good guess,\n' +
      'not a certainty. Stopping asks for confirmation; pass --yes when running without a terminal.',
    run: async ({ client, args, json }) => {
      const [action, ...rest] = args.names
      const servers = await runningServers(client)
      if (!action) {
        const shown = args.options.leftovers ? servers.filter((server) => server.leftover) : servers
        if (json) printJson(shown)
        else printRunning(shown)
        return 0
      }
      if (action !== 'stop') throw new UsageError(`Unknown running action "${action}"; use stop.`)
      const ports = rest.map((port) => positiveInteger(port, 'A port', 0))
      if (!ports.length && !args.options.leftovers) throw new UsageError('Name the ports to stop, or pass --leftovers.')
      const chosen = chooseRunningServers(servers, ports, !!args.options.leftovers)
      if (!chosen.length) {
        if (json) printJson({ stopped: [] })
        else console.log('There are no leftovers.')
        return 0
      }
      const describe = (server: RunningServer) => `${runningServerName(server)} (${server.ports.map((port) => `:${port}`).join(' ')})`
      if (!await confirm(`Stop ${chosen.map(describe).join(', ')}?`, args)) return 1
      const stopped: string[] = []
      let code = 0
      for (const server of chosen) {
        try {
          await stopRunningServer(client, server)
          stopped.push(describe(server))
          if (!json) console.log(`${dim('○')} ${describe(server)}  stopped`)
        } catch (err) {
          code = 1
          if (!json) console.log(`${red('✕')} ${describe(server)}  ${red(err instanceof Error ? err.message : String(err))}`)
        }
      }
      if (json) printJson({ stopped })
      return code
    }
  },
  {
    names: ['prepare'],
    usage: 'prepare <service> install|build',
    summary: 'Install a stopped service\'s dependencies, or run its build',
    group: 'Services',
    run: async ({ client, args, json }) => {
      const [name, step] = args.names
      if (!name || (step !== 'install' && step !== 'build')) throw new UsageError('Usage: multiprise prepare <service> install|build')
      const service = await oneService(client, name)
      if (!json) status(`${step === 'install' ? 'Installing dependencies of' : 'Building'} ${qualifiedName(service)}…`)
      await prepareService(client, service, step)
      if (json) printJson({ service: qualifiedName(service), step, ok: true })
      else console.log(`${green('●')} ${qualifiedName(service)}  ${step === 'install' ? 'dependencies installed' : 'built'}`)
      return 0
    }
  },
  {
    names: ['add'],
    usage: 'add <folder…> [--dry-run]',
    summary: 'Track project folders; --dry-run only shows the services that would be found',
    group: 'Projects',
    details: 'Add the top folder of each project. Multiprise finds its services (package.json scripts,\n' +
      'Cargo, Docker Compose) and their start commands. Hidden folders and git worktrees are skipped.',
    run: async ({ client, args, json }) => {
      const folders = args.names.length ? args.names : ['.']
      if (args.options.dryRun) {
        const previews = await inspectFolders(client, folders)
        if (json) printJson(previews)
        else for (const preview of previews) {
          console.log(`${bold(preview.name)}  ${dim(tildify(preview.path))}`)
          if (!preview.has_services) console.log(`  ${yellow(preview.error ?? 'No services found')}`)
          for (const found of preview.services ?? []) console.log(`  ${found.name.padEnd(14)} ${dim(found.role.padEnd(8))} ${found.start}`)
        }
        return previews.every((preview) => preview.has_services) ? 0 : 1
      }
      const results = await addFolders(client, folders)
      if (json) printJson(results)
      else for (const result of results) {
        console.log(result.added
          ? `${green('●')} ${tildify(result.path)}  ${result.services.join(', ')}`
          : `${red('✕')} ${tildify(result.path)}  ${red(result.error ?? 'not added')}`)
      }
      return results.every((result) => result.added) ? 0 : 1
    }
  },
  {
    names: ['remove', 'rm', 'untrack'],
    usage: 'remove <name…> [--yes]',
    summary: 'Stop tracking a project or service (the folder itself is not touched)',
    group: 'Projects',
    details: 'Stops its services and forgets their settings, variables, secrets and logs.\n' +
      'Asks for confirmation; pass --yes when running without a terminal.',
    run: async ({ client, args, json }) => {
      if (!args.names.length) throw new UsageError('Name the projects or services to stop tracking.')
      const targets = await targetsFor(client, args.names)
      const names = targets.flatMap((target) => target.whole ? [`${target.project.name} (${target.services.length} services)`] : target.services.map(qualifiedName))
      if (!await confirm(`Stop tracking ${names.join(', ')}?`, args)) return 1
      const removed = await removeTargets(client, targets)
      if (json) printJson({ removed })
      else console.log(`Stopped tracking ${removed.join(', ')}.`)
      return 0
    }
  },
  {
    names: ['rename'],
    usage: 'rename <service> <new name>',
    summary: 'Rename a service',
    group: 'Projects',
    run: async ({ client, args, json }) => {
      const [name, ...words] = args.names
      if (!name || !words.length) throw new UsageError('Usage: multiprise rename <service> <new name>')
      const view = await renameService(client, await oneService(client, name), words.join(' '))
      if (json) printJson({ id: view.project.id, name: view.project.name })
      else console.log(`Renamed to ${view.project.name}.`)
      return 0
    }
  },
  {
    names: ['edit'],
    usage: 'edit [name]',
    summary: 'Open a service or project in VS Code',
    group: 'Projects',
    run: async ({ client, args }) => {
      const projects = await listProjects(client)
      const target = args.names[0] ? resolveTarget(projects, args.names[0]) : resolveCurrentProject(projects)
      await openFolder(client, representative(target), 'vscode')
      return 0
    }
  },
  {
    names: ['reveal'],
    usage: 'reveal [name]',
    summary: 'Show a project\'s folder in Finder',
    group: 'Projects',
    run: async ({ client, args }) => {
      const projects = await listProjects(client)
      const target = args.names[0] ? resolveTarget(projects, args.names[0]) : resolveCurrentProject(projects)
      await openFolder(client, representative(target), 'finder')
      return 0
    }
  },
  {
    names: ['command', 'cmd'],
    usage: 'command <service> [-- <command…>] [--auto]',
    short: 'command <service> [-- <cmd…>]',
    summary: 'Show, set, or reset (--auto) the command a service starts with',
    group: 'Configuration',
    details: 'Put the command after `--` so its own options are not read as Multiprise\'s:\n' +
      '  multiprise command web -- pnpm dev --host\n' +
      'A command you set is kept until --auto restores the detected one.',
    run: async ({ client, args, json }) => {
      if (!args.names[0]) throw new UsageError('Name the service.')
      const service = await oneService(client, args.names[0])
      const words = [...args.names.slice(1), ...args.rest]
      let result: { command: string | null; source: string }
      if (args.options.auto) result = await setCommand(client, service, null)
      else if (words.length) result = await setCommand(client, service, words.join(' '))
      else result = { command: service.command, source: (await serviceDetails(client, service)).command_source }
      if (json) printJson({ service: qualifiedName(service), ...result })
      else console.log(`${result.command ?? dim('(none)')}  ${dim(result.source === 'user' ? '(set by you)' : '(detected)')}`)
      return 0
    }
  },
  {
    names: ['port'],
    usage: 'port <service> [<port> | --clear]',
    summary: 'Show or set the port a service asks for next time it starts',
    group: 'Configuration',
    details: 'With automatic ports on, Multiprise still moves it when the port is taken.',
    run: async ({ client, args, json }) => {
      if (!args.names[0]) throw new UsageError('Name the service.')
      const service = await oneService(client, args.names[0])
      let port = service.port
      if (args.options.clear) port = await setPort(client, service, null)
      else if (args.names[1]) port = await setPort(client, service, Number(args.names[1]))
      if (json) printJson({ service: qualifiedName(service), port })
      else console.log(port ? String(port) : dim('(none; one is assigned when it starts)'))
      return 0
    }
  },
  {
    names: ['env'],
    usage: 'env <service> [set KEY=VALUE… [--secret] | unset KEY…]',
    short: 'env <service> [set|unset …]',
    summary: 'Show or change the variables a service starts with',
    group: 'Configuration',
    details: 'Values may point at other services: API_URL={{services.api.url}} (also .port and .host_url).\n' +
      '--secret keeps the values encrypted with the macOS Keychain; they are never printed.\n' +
      'Changes apply the next time the service starts (`multiprise restart <service>`).',
    run: async ({ client, args, json }) => {
      const [name, action, ...pairs] = args.names
      if (!name) throw new UsageError('Name the service.')
      const service = await oneService(client, name)
      let environment: EnvironmentResponse
      if (!action) environment = await getEnvironment(client, service)
      else if (action === 'set') {
        if (!pairs.length) throw new UsageError('Usage: multiprise env <service> set KEY=VALUE…')
        environment = await setVariables(client, service, parseAssignments(pairs), !!args.options.secret)
      } else if (action === 'unset') {
        if (!pairs.length) throw new UsageError('Usage: multiprise env <service> unset KEY…')
        environment = await unsetVariables(client, service, pairs)
      } else throw new UsageError(`Unknown env action "${action}"; use set or unset.`)
      if (json) printJson(environment)
      else printEnvironment(service, environment, await dependencyNames(client, environment.links))
      return 0
    }
  },
  {
    names: ['deps', 'links'],
    usage: 'deps <service> [set|add|remove <service…> | clear]',
    short: 'deps <service> [add|remove …]',
    summary: 'Show or change the services that start before this one',
    group: 'Configuration',
    details: 'A service\'s dependencies start first when it starts, and it can reference them in its\n' +
      'variables, e.g. `multiprise deps web add api` then `multiprise env web set API_URL={{services.api.url}}`.',
    run: async ({ client, args, json }) => {
      const [name, action, ...others] = args.names
      if (!name) throw new UsageError('Name the service.')
      const projects = await listProjects(client)
      const service = resolveService(projects, name)
      let links = (await getEnvironment(client, service)).links
      if (action) {
        const ids = others.map((other) => resolveService(projects, other).id)
        if (action === 'set') links = ids
        else if (action === 'add') links = [...new Set([...links, ...ids])]
        else if (action === 'remove') links = links.filter((id) => !ids.includes(id))
        else if (action === 'clear') links = []
        else throw new UsageError(`Unknown deps action "${action}"; use set, add, remove or clear.`)
        if (action !== 'clear' && !ids.length) throw new UsageError(`Name the services to ${action}.`)
        links = await setDependencies(client, service, links)
      }
      const names = await dependencyNames(client, links, projects)
      if (json) printJson({ service: qualifiedName(service), depends_on: names, ids: links })
      else console.log(names.length ? names.join('\n') : dim(`${qualifiedName(service)} starts on its own.`))
      return 0
    }
  },
  {
    names: ['settings', 'config'],
    usage: 'settings [set key=value…]',
    summary: 'Show or change Multiprise\'s settings',
    group: 'Configuration',
    details: 'Switches take on/off; scan_ignore takes a comma-separated list. For example:\n' +
      '  multiprise settings set auto_restart=off startup_timeout_ms=30000',
    run: async ({ client, args, json }) => {
      const [action, ...pairs] = args.names
      let settings = await getSettings(client)
      if (action === 'set') {
        if (!pairs.length) throw new UsageError('Usage: multiprise settings set key=value…')
        const assignments = pairs.map((pair) => {
          const equals = pair.indexOf('=')
          if (equals <= 0) throw new UsageError(`"${pair}" is not key=value.`)
          return { key: pair.slice(0, equals).trim(), value: pair.slice(equals + 1).trim() }
        })
        settings = await updateSettings(client, parseSettings(settings, assignments))
      } else if (action) throw new UsageError(`Unknown settings action "${action}"; use set.`)
      if (json) printJson(settings)
      else {
        const { onboarded: _onboarded, ...shown } = settings
        const width = Math.max(...Object.keys(shown).map((key) => key.length))
        for (const [key, value] of Object.entries(shown)) {
          const text = typeof value === 'boolean' ? (value ? 'on' : 'off') : Array.isArray(value) ? value.join(', ') : String(value)
          console.log(`${key.padEnd(width)}  ${text}`)
        }
      }
      return 0
    }
  },
  {
    names: ['agents'],
    usage: 'agents [connect | disconnect]',
    summary: 'Show, set up or remove Claude Code\'s use of Multiprise',
    group: 'Other',
    offline: true,
    details: 'connect registers the MCP server for every project (claude mcp add --scope user) and adds a\n' +
      'short block to ~/.claude/CLAUDE.md telling sessions to run dev servers through Multiprise.\n' +
      'disconnect removes both, and leaves the rest of that file as it was.',
    run: async ({ args, json }) => {
      const [action] = args.names
      if (action && action !== 'connect' && action !== 'disconnect') throw new UsageError(`Unknown agents action "${action}"; use connect or disconnect.`)
      const result = action === 'connect' ? await connectAgents() : action === 'disconnect' ? await disconnectAgents() : await agentStatus()
      if (json) printJson(result)
      else printAgents(result)
      return 0
    }
  },
  {
    names: ['events'],
    usage: 'events',
    summary: 'Stream status changes and log lines as JSON, one event per line',
    group: 'Other',
    run: async ({ client }) => {
      await new Promise<void>((_resolve, reject) => {
        client.events((event) => console.log(JSON.stringify(event)), () => reject(new NotRunningError('Multiprise closed the event stream.')))
          .catch(reject)
      })
      return 0
    }
  },
  {
    names: ['api'],
    usage: 'api <METHOD> <path> [json]',
    summary: 'Call the app\'s local API directly (for anything without a command)',
    group: 'Other',
    details: 'For example: multiprise api GET /api/projects\n' +
      '             multiprise api PATCH /api/settings \'{"notifications": false}\'',
    run: async ({ client, args }) => {
      const [method, route, body] = args.names
      if (!method || !route?.startsWith('/api/')) throw new UsageError('Usage: multiprise api <METHOD> /api/… [json]')
      let payload: unknown
      if (body !== undefined) {
        try {
          payload = JSON.parse(body)
        } catch (err) {
          throw new UsageError('The body must be JSON.')
        }
      }
      printJson(await client.request(method.toUpperCase(), route, payload))
      return 0
    }
  }
]

const HELP_FOOTER = `A name is a project, a service, "project/service", a service id or a folder path.
Without one, commands use the project or service containing the current folder.

Options:
  --json         Machine-readable output (every command that prints data)
  -h, --help     Show this help, or \`multiprise help <command>\` for one command
  -v, --version  Show the version`

function helpText() {
  const lines = ['Usage: multiprise <command> [options]']
  const usage = (command: Command) => command.short ?? command.usage
  const width = Math.max(...COMMANDS.map((command) => usage(command).length)) + 2
  for (const group of ['Services', 'Projects', 'Configuration', 'Other'] as const) {
    lines.push('', `${group}:`)
    for (const command of COMMANDS.filter((entry) => entry.group === group)) {
      lines.push(`  ${usage(command).padEnd(width)}${command.summary}`)
    }
    if (group === 'Other') lines.push(`  ${'mcp'.padEnd(width)}Run the MCP server for coding agents (stdio)`)
  }
  lines.push('', HELP_FOOTER)
  return lines.join('\n')
}

function commandHelp(name: string) {
  const command = COMMANDS.find((entry) => entry.names.includes(name))
  if (!command) throw new UsageError(`Unknown command "${name}". Run \`multiprise help\`.`)
  const aliases = command.names.length > 1 ? `\nAlso: ${command.names.slice(1).join(', ')}` : ''
  return `Usage: multiprise ${command.usage}\n\n${command.summary}.${command.details ? `\n\n${command.details}` : ''}${aliases}`
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (args.options.version || args.command === 'version') {
    console.log(readVersion())
    return 0
  }
  if (args.command === 'help' || (args.options.help && !args.command)) {
    console.log(args.names[0] ? commandHelp(args.names[0]) : helpText())
    return 0
  }
  if (!args.command) {
    console.log(helpText())
    return 2
  }
  if (args.options.help) {
    console.log(commandHelp(args.command))
    return 0
  }
  if (args.command === 'mcp') {
    await runMcpServer(readVersion())
    return 0
  }
  const command = COMMANDS.find((entry) => entry.names.includes(args.command!))
  if (!command) throw new UsageError(`Unknown command "${args.command}". Run \`multiprise help\`.`)
  // An offline command does not use the client.
  const client = command.offline ? null as unknown as MultipriseClient : await connect({ launch: true, onStatus: status })
  return command.run({ client, args, json: !!args.options.json })
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${red('multiprise:')} ${message}\n`)
    process.exitCode = err instanceof UsageError ? 2 : 1
  })
