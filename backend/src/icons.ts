import fs from 'node:fs/promises'
import path from 'node:path'
import { type AppState, persistProjects } from './state'
import { type Project } from './types'

const ICON_EXTENSIONS = new Set(['.ico', '.png', '.svg', '.jpg', '.jpeg'])
const ICON_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache'
])
const MAX_ICON_DEPTH = 4

async function fileExists(filePath: string) {
  try {
    const stat = await fs.stat(filePath)
    return stat.isFile()
  } catch (err) {
    return false
  }
}

export async function findProjectIcon(rootDir: string): Promise<string | null> {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }]
  while (queue.length) {
    const current = queue.shift()
    if (!current) break
    let entries: Array<import('node:fs').Dirent> = []
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true })
    } catch (err) {
      continue
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue
      const lowerName = entry.name.toLowerCase()
      const ext = path.extname(lowerName)
      if (!ICON_EXTENSIONS.has(ext)) continue
      if (
        lowerName.includes('favicon') ||
        lowerName.startsWith('icon') ||
        lowerName.startsWith('logo') ||
        lowerName.startsWith('apple-touch-icon')
      ) {
        return path.join(current.dir, entry.name)
      }
    }

    if (current.depth >= MAX_ICON_DEPTH) continue
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (ICON_IGNORE_DIRS.has(entry.name)) continue
      queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 })
    }
  }
  return null
}

export async function resolveProjectIcon(project: Project, state: AppState): Promise<string | null> {
  if (project.icon_path && (await fileExists(project.icon_path))) {
    return project.icon_path
  }
  const found = await findProjectIcon(project.root_path ?? project.path)
  project.icon_path = found
  await persistProjects(state)
  return found
}
