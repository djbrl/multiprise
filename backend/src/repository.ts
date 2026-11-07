import fs from 'node:fs'
import path from 'node:path'

// The git checkout a folder belongs to, read from disk so it costs no process per folder.

export type Repository = {
  // The top of this checkout.
  root: string
  // The top of the main checkout; the same as root unless this is a worktree.
  main: string
  worktree: string | null
}

function readWorktreeMain(gitFile: string, dir: string) {
  const pointer = fs.readFileSync(gitFile, 'utf8')
  // A worktree's .git file points into <main>/.git/worktrees/; a submodule's into .git/modules/.
  const match = pointer.match(/^gitdir:\s*(.+?)[\\/]worktrees[\\/]/m)
  if (!match) return null
  const gitDir = path.resolve(dir, match[1])
  return path.basename(gitDir) === '.git' ? path.dirname(gitDir) : gitDir
}

export function findRepository(folder: string): Repository | null {
  let dir = path.resolve(folder)
  while (true) {
    const git = path.join(dir, '.git')
    try {
      const stats = fs.statSync(git)
      if (stats.isDirectory()) return { root: dir, main: dir, worktree: null }
      const main = readWorktreeMain(git, dir)
      // A submodule stays part of the repository around it, so the walk continues.
      if (main) return { root: dir, main, worktree: path.basename(dir) }
    } catch (err) {
      // No .git here.
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// Whether this folder is the top of a git worktree: its own checkout, even when it sits
// inside the main one (as `.claude/worktrees/<name>` does).
export function isWorktreeRoot(folder: string) {
  const repository = findRepository(folder)
  return !!repository?.worktree && repository.root === path.resolve(folder)
}
