import fs from 'node:fs/promises'
import path from 'node:path'
import * as electron from 'electron'
import { activeHostnamePort, hostUrls } from '../network/hostnames'
import { HttpError } from '../api/http'
import { SECRET_NAME } from '../redact'
import { type AppState } from '../state'
import { dataDir } from '../store'
import { type DetectedVariable, type EnvFileStatus, type EnvVariable, type Project } from '../types'

// Per-service environment: plain variables live in projects.json, secret ones are kept
// encrypted in secrets.json, and values can point at other services with templates.

export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
// Set by Multiprise itself for the port it assigns; overriding it would break the launch.
export const RESERVED_ENV_KEYS = new Set(['PORT'])

export type SecretStore = {
  get: (projectId: string, key: string) => Promise<string | null>
  set: (projectId: string, key: string, value: string) => Promise<void>
  remove: (projectId: string, key?: string) => Promise<void>
}

// Values are encrypted with Electron's safeStorage, whose key is held in the macOS Keychain.
function safeStorageStore(): SecretStore {
  const file = () => path.join(dataDir(), 'secrets.json')
  const safeStorage = (electron as { safeStorage?: typeof import('electron').safeStorage }).safeStorage
  const available = () => !!safeStorage?.isEncryptionAvailable?.()
  const read = async (): Promise<Record<string, Record<string, string>>> => {
    try {
      return JSON.parse(await fs.readFile(file(), 'utf8'))
    } catch (err) {
      return {}
    }
  }
  const write = async (data: Record<string, Record<string, string>>) => {
    await fs.mkdir(dataDir(), { recursive: true })
    const temporary = `${file()}.${process.pid}.tmp`
    await fs.writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 })
    await fs.rename(temporary, file())
  }
  return {
    get: async (projectId, key) => {
      const encrypted = (await read())[projectId]?.[key]
      if (!encrypted || !available()) return null
      return safeStorage!.decryptString(Buffer.from(encrypted, 'base64'))
    },
    set: async (projectId, key, value) => {
      if (!available()) throw new HttpError(400, 'Secret values need the Multiprise app, which stores them with the macOS Keychain.')
      const data = await read()
      data[projectId] = { ...data[projectId], [key]: safeStorage!.encryptString(value).toString('base64') }
      await write(data)
    },
    remove: async (projectId, key) => {
      const data = await read()
      if (!data[projectId]) return
      if (key) delete data[projectId][key]
      if (!key || !Object.keys(data[projectId]).length) delete data[projectId]
      await write(data)
    }
  }
}

let secretStore: SecretStore = safeStorageStore()

// Tests (and anything without Electron) swap in another store.
export function setSecretStore(store: SecretStore) {
  secretStore = store
}

export const secrets = () => secretStore

// Secret values are never sent back; the editor only learns that one is set.
export function describeEnvironment(project: Project): EnvVariable[] {
  const plain = Object.entries(project.env ?? {}).map(([key, value]) => ({ key, value, secret: false }))
  const secret = (project.secret_env ?? []).map((key) => ({ key, value: null, secret: true }))
  return [...plain, ...secret].sort((a, b) => a.key.localeCompare(b.key))
}

// Replaces the service's variables. A secret sent without a value keeps its stored one.
export async function saveEnvironment(project: Project, input: unknown) {
  if (!Array.isArray(input)) throw new HttpError(400, 'Expected a list of variables')
  const env: Record<string, string> = {}
  const secretValues = new Map<string, string | null>()
  for (const item of input as Array<Partial<EnvVariable>>) {
    const key = typeof item?.key === 'string' ? item.key.trim() : ''
    if (!ENV_KEY_PATTERN.test(key)) throw new HttpError(400, `"${key}" is not a valid variable name`)
    if (RESERVED_ENV_KEYS.has(key)) throw new HttpError(400, `${key} is set by Multiprise to the port it assigns`)
    if (key in env || secretValues.has(key)) throw new HttpError(400, `${key} is listed twice`)
    if (item.value !== undefined && item.value !== null && typeof item.value !== 'string') {
      throw new HttpError(400, `The value of ${key} must be text`)
    }
    if (item.secret) {
      if (item.value == null && !project.secret_env?.includes(key)) throw new HttpError(400, `Enter a value for the secret ${key}`)
      secretValues.set(key, item.value ?? null)
    } else {
      env[key] = item.value ?? ''
    }
  }
  for (const [key, value] of secretValues) {
    if (value !== null) await secretStore.set(project.id, key, value)
  }
  for (const key of project.secret_env ?? []) {
    if (!secretValues.has(key)) await secretStore.remove(project.id, key)
  }
  project.env = env
  project.secret_env = [...secretValues.keys()].sort()
}

// `ref` is a service name in the same project, "project/service", or a service id.
function findService(state: AppState, from: Project, ref: string) {
  const root = (project: Project) => project.root_path ?? project.path
  const same = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0
  const byId = state.projects.find((project) => project.id === ref)
  if (byId) return byId
  const slash = ref.indexOf('/')
  if (slash > 0) {
    const [projectName, serviceName] = [ref.slice(0, slash), ref.slice(slash + 1)]
    const match = state.projects.find((project) => same(path.basename(root(project)), projectName) && same(project.name, serviceName))
    if (match) return match
  }
  return state.projects.find((project) => root(project) === root(from) && same(project.name, ref)) ?? null
}

const TEMPLATE = /\{\{\s*services\.(.+?)\.(url|port|host_url)\s*\}\}/g

export function resolveTemplates(state: AppState, project: Project, key: string, value: string) {
  return value.replace(TEMPLATE, (_match, ref: string, field: string) => {
    const target = findService(state, project, ref.trim())
    if (!target) throw new HttpError(400, `${key} refers to "${ref}", which is not a service`)
    if (!target.port) throw new HttpError(400, `${key} needs the port of ${target.name}, which has not been assigned one yet; start it first`)
    const url = `http://localhost:${target.port}`
    if (field === 'port') return String(target.port)
    if (field === 'url') return url
    const port = activeHostnamePort()
    return port ? hostUrls(state.projects, port)[target.id] ?? url : url
  })
}

// Everything the service is launched with on top of what Multiprise sets itself.
export async function serviceEnvironment(state: AppState, project: Project) {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(project.env ?? {})) {
    env[key] = resolveTemplates(state, project, key, value)
  }
  for (const key of project.secret_env ?? []) {
    const value = await secretStore.get(project.id, key)
    if (value === null) throw new HttpError(400, `The secret ${key} could not be read; enter it again in the service's environment`)
    env[key] = value
  }
  return env
}


const SECRETS_CACHE_MS = 10000
const secretsCache = new Map<string, { at: number; values: Promise<string[]> }>()

async function readKnownSecrets(project: Project) {
  const values: string[] = []
  for (const key of project.secret_env ?? []) {
    const value = await secretStore.get(project.id, key).catch(() => null)
    if (value) values.push(value)
  }
  for (const [key, value] of Object.entries(project.env ?? {})) {
    if (SECRET_NAME.test(key) && !value.includes('{{')) values.push(value)
  }
  // Most secrets live in the project's own env files rather than in Multiprise.
  for (const folder of new Set([project.path, project.root_path ?? project.path])) {
    for (const name of ENV_FILES) {
      const text = await fs.readFile(path.join(folder, name), 'utf8').catch(() => null)
      if (text === null) continue
      for (const entry of envEntries(text)) {
        if (SECRET_NAME.test(entry.key) && entry.value) values.push(entry.value)
      }
    }
  }
  return [...new Set(values)]
}

// Values to mask in this service's output. Log lines arrive one by one, so briefly cached.
export function knownSecrets(project: Project) {
  const cached = secretsCache.get(project.id)
  if (cached && Date.now() - cached.at < SECRETS_CACHE_MS) return cached.values
  const values = readKnownSecrets(project)
  secretsCache.set(project.id, { at: Date.now(), values })
  return values
}

const EXAMPLE_FILES = ['.env.example', '.env.sample', '.env.template', '.env.dist']
const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local']

// KEY=value lines of an env file; quotes and trailing comments are dropped from values.
function envEntries(text: string) {
  const entries: Array<{ key: string; value: string }> = []
  for (const line of text.split(/\r?\n/)) {
    const match = line.replace(/^\s*export\s+/, '').match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    const quoted = value.match(/^(['"])(.*?)\1(?:\s+#.*)?$/)
    value = quoted ? quoted[2] : value.replace(/\s+#.*$/, '')
    entries.push({ key: match[1], value })
  }
  return entries
}

// A service folder (or its project root) with a .env.example but no .env usually will not start.
export async function envFileStatus(project: Project): Promise<EnvFileStatus> {
  const folders = [...new Set([project.path, project.root_path ?? project.path])]
  for (const folder of folders) {
    for (const name of EXAMPLE_FILES) {
      const example = await fs.readFile(path.join(folder, name), 'utf8').catch(() => null)
      if (example === null) continue
      const inEnvFiles = new Set<string>()
      let hasEnv = false
      for (const envName of ENV_FILES) {
        const text = await fs.readFile(path.join(folder, envName), 'utf8').catch(() => null)
        if (text === null) continue
        hasEnv = true
        envEntries(text).forEach((entry) => inEnvFiles.add(entry.key))
      }
      const configured = new Set<string>([...Object.keys(project.env ?? {}), ...(project.secret_env ?? [])])
      const seen = new Set<string>()
      const variables = envEntries(example)
        .filter((entry) => !seen.has(entry.key) && seen.add(entry.key))
        .map((entry) => ({ key: entry.key, example: entry.value, in_env_file: inEnvFiles.has(entry.key) }))
      return {
        example: path.relative(project.path, path.join(folder, name)) || name,
        has_env: hasEnv,
        missing: variables.filter((variable) => !variable.in_env_file && !configured.has(variable.key)).map((variable) => variable.key),
        variables
      }
    }
  }
  return { example: null, has_env: false, missing: [], variables: [] }
}
