import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const API_TOKEN_HEADER = 'x-multiprise-token'

// The running app advertises its API here so the CLI and MCP server can reach it.
export const DISCOVERY_FILE = 'api.json'

export type DiscoveryInfo = {
  url: string
  token: string
  pid: number
}

// Where the packaged app keeps its data (main.cjs sets MULTIPRISE_DATA_DIR to this).
export function packagedDataDir() {
  const home = os.homedir()
  const appData = process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support')
    : process.platform === 'win32'
      ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
      : process.env.XDG_CONFIG_HOME || path.join(home, '.config')
  return path.join(appData, 'Multiprise', 'data')
}

export async function writeDiscoveryFile(dir: string, info: DiscoveryInfo) {
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, DISCOVERY_FILE)
  const temporary = `${file}.${process.pid}.tmp`
  // The token grants full control over the user's services, so only the user may read it.
  await fs.writeFile(temporary, JSON.stringify(info, null, 2), { mode: 0o600 })
  await fs.rename(temporary, file)
}

// Leaves the file alone when another instance has advertised itself since.
export async function removeDiscoveryFile(dir: string, pid = process.pid) {
  const file = path.join(dir, DISCOVERY_FILE)
  const current = await readDiscoveryFile(dir)
  if (current && current.pid !== pid) return
  await fs.rm(file, { force: true })
}

export async function readDiscoveryFile(dir: string): Promise<DiscoveryInfo | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, DISCOVERY_FILE), 'utf-8'))
    if (typeof parsed?.url !== 'string' || typeof parsed?.token !== 'string' || typeof parsed?.pid !== 'number') {
      return null
    }
    return { url: parsed.url, token: parsed.token, pid: parsed.pid }
  } catch (err) {
    return null
  }
}
