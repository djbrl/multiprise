import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { type AgentStatus } from './types'

// Connecting Claude Code: registers the MCP server for every project, and adds a short block
// to the global CLAUDE.md telling sessions to run dev servers through Multiprise. Both are
// done only when asked, and disconnecting removes exactly what was added.

const execFileAsync = promisify(execFile)

const SERVER_NAME = 'multiprise'
const LINKED_CLI = '/usr/local/bin/multiprise'
const BLOCK_START = '<!-- multiprise:start (added by `multiprise agents connect`; `multiprise agents disconnect` removes it) -->'
const BLOCK_END = '<!-- multiprise:end -->'

const INSTRUCTIONS = `## Local dev servers

Multiprise runs this Mac's dev servers. Use it rather than starting them yourself:

- To start a project or worktree's servers, run \`multiprise up\` in its folder (or call the \`start_service\` MCP tool with the folder's path) instead of \`npm run dev\` and the like. It tracks new folders, gives each service a free port, waits until it is ready, and returns the URL, or the failure with its logs.
- Check \`multiprise ls\` (\`list_services\`) first and reuse a server that is already running.
- Read output with \`multiprise logs\` (\`tail_logs\`).
- Stop what you started when you are done, with \`multiprise down\`.
- \`multiprise running\` lists every server on this Mac, including ones Multiprise did not start. Only stop one you started or that the user asked you to.

If Multiprise cannot run something, start it the usual way and say so.`

const configFile = () => path.join(os.homedir(), '.claude.json')
const instructionsFile = () => path.join(os.homedir(), '.claude', 'CLAUDE.md')

// The packaged app has the wrapper script; a source checkout runs the built CLI with node.
function serverCommand(): string[] {
  if (fs.existsSync(LINKED_CLI)) return [LINKED_CLI, 'mcp']
  const bundled = path.join((process as { resourcesPath?: string }).resourcesPath ?? '', 'bin', 'multiprise')
  if (fs.existsSync(bundled)) return [bundled, 'mcp']
  return ['node', path.join(__dirname, 'cli', 'index.js'), 'mcp']
}

// An app opened from Finder may not have the shell's PATH, so the usual install places count too.
async function findClaude() {
  const home = os.homedir()
  for (const candidate of ['claude', `${home}/.local/bin/claude`, `${home}/.claude/local/claude`, '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    try {
      await execFileAsync(candidate, ['--version'], { timeout: 10000 })
      return candidate
    } catch (err) {
      // Not this one.
    }
  }
  return null
}

// Read directly: `claude mcp get` and `list` start every server to check its health.
function registeredCommand(): string[] | null {
  try {
    const entry = JSON.parse(fs.readFileSync(configFile(), 'utf8')).mcpServers?.[SERVER_NAME]
    return entry ? [entry.command, ...(entry.args ?? [])] : null
  } catch (err) {
    return null
  }
}

function readInstructions() {
  try {
    return fs.readFileSync(instructionsFile(), 'utf8')
  } catch (err) {
    return ''
  }
}

export const hasInstructionBlock = (text: string) => text.includes(BLOCK_START) && text.includes(BLOCK_END)

// Adds the block, or refreshes it in place, leaving everything else as it was.
export function withInstructionBlock(text: string) {
  const block = `${BLOCK_START}\n${INSTRUCTIONS}\n${BLOCK_END}`
  if (hasInstructionBlock(text)) return `${text.slice(0, text.indexOf(BLOCK_START))}${block}${text.slice(text.indexOf(BLOCK_END) + BLOCK_END.length)}`
  return text.trim() ? `${text.replace(/\s*$/, '')}\n\n${block}\n` : `${block}\n`
}

export function withoutInstructionBlock(text: string) {
  if (!hasInstructionBlock(text)) return text
  const before = text.slice(0, text.indexOf(BLOCK_START)).replace(/\s*$/, '')
  const after = text.slice(text.indexOf(BLOCK_END) + BLOCK_END.length).replace(/^\s*/, '')
  return [before, after].filter(Boolean).join('\n\n') + (before || after ? '\n' : '')
}

// Follows a symlink (dotfile managers link CLAUDE.md), and never leaves a half-written file.
function writeInstructions(text: string) {
  const file = instructionsFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const target = fs.existsSync(file) ? fs.realpathSync(file) : file
  const temporary = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temporary, text)
  fs.renameSync(temporary, target)
}

export async function agentStatus(): Promise<AgentStatus> {
  return {
    installed: !!await findClaude(),
    connected: !!registeredCommand(),
    instructions: hasInstructionBlock(readInstructions()),
    instructions_path: instructionsFile()
  }
}

export async function connectAgents(): Promise<AgentStatus> {
  const claude = await findClaude()
  if (!claude) throw new Error('Claude Code is not installed, or `claude` is not on the PATH.')
  const command = serverCommand()
  const registered = registeredCommand()
  if (registered?.join(' ') !== command.join(' ')) {
    if (registered) await execFileAsync(claude, ['mcp', 'remove', '--scope', 'user', SERVER_NAME], { timeout: 20000 })
    await execFileAsync(claude, ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', ...command], { timeout: 20000 })
  }
  const text = readInstructions()
  const updated = withInstructionBlock(text)
  if (updated !== text) writeInstructions(updated)
  return agentStatus()
}

export async function disconnectAgents(): Promise<AgentStatus> {
  const claude = registeredCommand() ? await findClaude() : null
  if (claude) await execFileAsync(claude, ['mcp', 'remove', '--scope', 'user', SERVER_NAME], { timeout: 20000 })
  const text = readInstructions()
  const updated = withoutInstructionBlock(text)
  if (updated !== text) writeInstructions(updated)
  return agentStatus()
}
