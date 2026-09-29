#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { LogLine } from '../types'
import { connect, NotRunningError, type MultipriseClient } from './client'
import { runMcpServer } from './mcp'
import {
  formatLogLine,
  getLogs,
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
  type StartResult,
  type StopResult,
  type Target
} from './services'

const HELP = `Usage: multiprise <command> [options]

Commands:
  ls                          List projects and services with their status and URL
  up [name…]                  Start services and wait until they are ready
  down [name…]                Stop services and every process they spawned
  restart [name…]             Stop, then start services again
  logs [service] [-f] [-n N]  Print a service's recent output; -f keeps following it
  url [service]               Print a running service's URL
  open [service]              Open a running service in the browser
  mcp                         Run the MCP server for coding agents (stdio)

A name is a project, a service, "project/service", a service id or a folder path.
Without one, commands use the project or service containing the current folder.

Options:
  --json         Machine-readable output (ls, up, down, restart, url)
  -h, --help     Show this help
  -v, --version  Show the version`

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

type Options = { json: boolean; follow: boolean; lines: number; names: string[] }

function parseArgs(args: string[]): { command: string | undefined; options: Options } {
  const options: Options = { json: false, follow: false, lines: 100, names: [] }
  let command: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--json') options.json = true
    else if (arg === '-f' || arg === '--follow') options.follow = true
    else if (arg === '-n' || arg === '--lines') {
      const value = Number(args[++index])
      if (!Number.isInteger(value) || value < 1) throw new UsageError(`${arg} needs a positive number of lines.`)
      options.lines = value
    } else if (arg === '-h' || arg === '--help') command = 'help'
    else if (arg === '-v' || arg === '--version') command = 'version'
    else if (arg.startsWith('-') && arg !== '-') throw new UsageError(`Unknown option ${arg}. Run \`multiprise --help\`.`)
    else if (command === undefined) command = arg
    else options.names.push(arg)
  }
  return { command, options }
}

function printProjects(projects: Project[]) {
  if (!projects.length) {
    console.log('No projects yet. Add one in the Multiprise app.')
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
    console.log(JSON.stringify(results, null, 2))
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
    }
  }
}

const failed = (results: Array<StartResult | StopResult>) =>
  results.some((result) => result.outcome === 'failed' || result.outcome === 'skipped')

async function targetsFor(client: MultipriseClient, names: string[]): Promise<Target[]> {
  const projects = await listProjects(client)
  return names.length ? names.map((name) => resolveTarget(projects, name)) : [resolveCurrentProject(projects)]
}

const printLogLine = (entry: LogLine) =>
  process[entry.stream === 'stderr' ? 'stderr' : 'stdout'].write(`${formatLogLine(entry)}\n`)

async function followLogs(client: MultipriseClient, service: Service, lines: number) {
  // Subscribe before reading the backlog so no line falls between the two; sequence
  // numbers only grow, so anything already printed is recognised and skipped.
  let lastSeq = -1
  let buffered: LogLine[] | null = []
  await new Promise<void>((_resolve, reject) => {
    client.events((event) => {
      if (event.type === 'projects' || event.id !== service.id) return
      if (event.type === 'logs-cleared' && !buffered) {
        status(`— ${qualifiedName(service)} restarted —`)
      } else if (event.type === 'log' && !event.replace) {
        if (buffered) buffered.push(event.entry)
        else if (event.entry.seq > lastSeq) {
          lastSeq = event.entry.seq
          printLogLine(event.entry)
        }
      }
    }, () => reject(new NotRunningError('Multiprise closed the log stream.')))
      .then(async () => {
        for (const entry of [...await getLogs(client, service, lines), ...buffered!]) {
          if (entry.seq <= lastSeq) continue
          lastSeq = entry.seq
          printLogLine(entry)
        }
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
  const service = resolveService(await listProjects(client), name)
  if (!service.url) {
    const reason = service.phase === 'failed' && service.error ? `failed: ${service.error.split('\n')[0]}` : service.phase
    throw new UsageError(`${qualifiedName(service)} is ${reason}. Start it with \`multiprise up ${qualifiedName(service)}\`.`)
  }
  return service
}

async function main(): Promise<number> {
  const { command, options } = parseArgs(process.argv.slice(2))
  if (!command || command === 'help') {
    console.log(HELP)
    return command ? 0 : 2
  }
  if (command === 'version') {
    console.log(readVersion())
    return 0
  }
  if (command === 'mcp') {
    await runMcpServer(readVersion())
    return 0
  }

  const known = ['ls', 'list', 'status', 'up', 'start', 'down', 'stop', 'restart', 'logs', 'url', 'open']
  if (!known.includes(command)) throw new UsageError(`Unknown command "${command}". Run \`multiprise --help\`.`)
  const client = await connect({ launch: true, onStatus: status })
  const progress = options.json ? undefined : status

  switch (command) {
    case 'ls':
    case 'list':
    case 'status': {
      let projects = await listProjects(client)
      if (options.names.length) {
        const chosen = options.names.map((name) => resolveTarget(projects, name).project)
        projects = projects.filter((project) => chosen.includes(project))
      }
      if (options.json) console.log(JSON.stringify(projects, null, 2))
      else printProjects(projects)
      return 0
    }
    case 'up':
    case 'start': {
      const results = await startTargets(client, await targetsFor(client, options.names), progress)
      printResults(results, options.json)
      return failed(results) ? 1 : 0
    }
    case 'down':
    case 'stop': {
      const results = await stopTargets(client, await targetsFor(client, options.names), progress)
      printResults(results, options.json)
      return failed(results) ? 1 : 0
    }
    case 'restart': {
      const { stopped, started } = await restartTargets(client, await targetsFor(client, options.names), progress)
      const results = started.length ? started : stopped
      printResults(results, options.json)
      return failed(stopped) || failed(started) ? 1 : 0
    }
    case 'logs': {
      if (options.names.length > 1) throw new UsageError('logs takes one service.')
      const service = resolveService(await listProjects(client), options.names[0])
      if (options.follow) {
        await followLogs(client, service, options.lines)
      } else {
        for (const entry of await getLogs(client, service, options.lines)) printLogLine(entry)
      }
      return 0
    }
    case 'url': {
      if (options.names.length > 1) throw new UsageError('url takes one service.')
      const service = await requireUrl(client, options.names[0])
      console.log(options.json ? JSON.stringify({ service: qualifiedName(service), url: service.url, port: service.port }) : service.url)
      return 0
    }
    case 'open': {
      if (options.names.length > 1) throw new UsageError('open takes one service.')
      const service = await requireUrl(client, options.names[0])
      await openUrl(service.url!)
      return 0
    }
  }
  return 0
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
