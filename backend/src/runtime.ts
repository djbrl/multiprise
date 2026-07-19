import fs from 'node:fs'
import path from 'node:path'

function commandName(command: string) {
  const trimmed = command.trim()
  const match = trimmed.match(/^([^\s;&|]+)/)
  return match?.[1] ?? null
}

export function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env) {
  const executable = commandName(command)
  if (!executable) return null

  if (executable.includes('/') || executable.includes('\\')) {
    try {
      fs.accessSync(executable, fs.constants.X_OK)
      return executable
    } catch (err) {
      return null
    }
  }

  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : ['']
  for (const directory of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${executable}${extension}`)
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
      } catch (err) {
        // Keep searching the effective PATH.
      }
    }
  }
  return null
}

export function assertCommandAvailable(command: string, env: NodeJS.ProcessEnv = process.env) {
  const executable = commandName(command)
  if (!executable || findExecutable(command, env)) return
  throw new Error(`Required runtime "${executable}" was not found. Make sure it is installed and available in your login shell PATH, then restart Multiprise.`)
}
