import fs from 'node:fs'
import path from 'node:path'
import { dataDir } from '../store'
import { type LogLine } from '../types'

// A single run rolls over into the previous-run file past this size.
const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024
// How much of the latest run is read back after Multiprise restarts.
const RESTORE_BYTES = 256 * 1024
const LINE_PATTERN = /^(\S+) (stdout|stderr) (.*)$/

const logDir = () => path.join(dataDir(), 'logs')

type LogFile = { stream: fs.WriteStream; bytes: number }

const files = new Map<string, LogFile>()

const fileName = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_')

export const currentLogPath = (id: string) => path.join(logDir(), `${fileName(id)}.log`)
export const previousLogPath = (id: string) => path.join(logDir(), `${fileName(id)}.previous.log`)

function open(id: string): LogFile | null {
  try {
    fs.mkdirSync(logDir(), { recursive: true })
    const file = currentLogPath(id)
    const bytes = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0
    const stream = fs.createWriteStream(file, { flags: 'a' })
    const handle = { stream, bytes }
    stream.on('error', (err) => {
      console.error(`[multiprise] cannot write service log ${file}:`, err)
      if (files.get(id) === handle) files.delete(id)
    })
    files.set(id, handle)
    return handle
  } catch (err) {
    console.error('[multiprise] cannot open service log:', err)
    return null
  }
}

function close(id: string) {
  files.get(id)?.stream.end()
  files.delete(id)
}

// Each launch starts a fresh file and keeps the run before it, so the logs of a crash survive a relaunch.
export function startLogRun(id: string) {
  close(id)
  try {
    fs.renameSync(currentLogPath(id), previousLogPath(id))
  } catch (err) {
    // No earlier run.
  }
}

export function writeLogLine(id: string, entry: Pick<LogLine, 'timestamp' | 'stream' | 'line'>) {
  // One entry per file line keeps the file readable back after a restart.
  const text = `${entry.timestamp} ${entry.stream} ${entry.line.replace(/\r?\n/g, ' ')}\n`
  let handle = files.get(id) ?? open(id)
  if (handle && handle.bytes + text.length > MAX_LOG_FILE_BYTES) {
    startLogRun(id)
    handle = open(id)
  }
  if (!handle) return
  handle.stream.write(text)
  handle.bytes += Buffer.byteLength(text)
}

export function readLogTail(id: string): Array<Pick<LogLine, 'timestamp' | 'stream' | 'line'>> {
  let raw: string
  try {
    const file = currentLogPath(id)
    const size = fs.statSync(file).size
    const start = Math.max(0, size - RESTORE_BYTES)
    const buffer = Buffer.alloc(size - start)
    const fd = fs.openSync(file, 'r')
    try {
      fs.readSync(fd, buffer, 0, buffer.length, start)
    } finally {
      fs.closeSync(fd)
    }
    raw = buffer.toString('utf8')
    // Reading from the middle of the file starts on a partial line.
    if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1)
  } catch (err) {
    return []
  }
  const entries: Array<Pick<LogLine, 'timestamp' | 'stream' | 'line'>> = []
  for (const line of raw.split('\n')) {
    const match = line.match(LINE_PATTERN)
    if (match) entries.push({ timestamp: match[1], stream: match[2] as LogLine['stream'], line: match[3] })
  }
  return entries
}

export function deleteLogFiles(id: string) {
  close(id)
  fs.rmSync(currentLogPath(id), { force: true })
  fs.rmSync(previousLogPath(id), { force: true })
}
