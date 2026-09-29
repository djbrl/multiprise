import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { appendProcessLog, trackPreparation } from './processes'
import { commandForScript, detectProject, type PackageJsonMetadata } from './scanner'
import { assertCommandAvailable } from './runtime'
import { type DetectResponse, type Project } from './types'

type PreparationOptions = {
  id: string
  project: Project
  detection: DetectResponse
  command: string
  autoInstall: boolean
  env?: Record<string, string>
}

async function exists(target: string) {
  return fs.access(target).then(() => true).catch(() => false)
}

async function readPackageJson(dir: string): Promise<PackageJsonMetadata | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as PackageJsonMetadata
  } catch {
    return null
  }
}

function selectedScript(command: string) {
  const match = command.match(/^\s*(?:npm\s+(?:run\s+)?|pnpm\s+(?:run\s+)?|yarn\s+(?:run\s+)?|bun\s+run\s+)([^\s-][^\s]*)/i)
  return match?.[1] ?? null
}

function installCommand(manager: string) {
  if (manager === 'yarn') return 'yarn install'
  if (manager === 'pnpm') return 'pnpm install'
  if (manager === 'bun') return 'bun install'
  return 'npm install'
}

function targetForCommand(command: string, cwd: string) {
  const nodeTarget = command.match(/\bnode\s+((?:\.\/)?(?:dist|build|out)\/[^\s"']+)/i)?.[1]
  if (nodeTarget) return path.resolve(cwd, nodeTarget)
  if (/\bnext\s+start\b/i.test(command)) return path.join(cwd, '.next')
  if (/\bnuxt\s+preview\b|\bnuxi\s+preview\b/i.test(command)) return path.join(cwd, '.output')
  if (/\bvite\s+preview\b/i.test(command)) return path.join(cwd, 'dist')
  return null
}

function pipeLines(id: string, stream: 'stdout' | 'stderr', chunk: string, remainder: string) {
  const parts = `${remainder}${chunk}`.split(/[\r\n]/)
  const next = parts.pop() ?? ''
  for (const line of parts) appendProcessLog(id, stream, line)
  return next
}

async function runPreparationCommand(options: {
  id: string
  command: string
  cwd: string
  env?: Record<string, string>
  label: string
}) {
  const { id, command, cwd, env, label } = options
  appendProcessLog(id, 'stdout', `[prepare] ${label}: ${command}`)
  const processEnv = { ...process.env, ...(env ?? {}) }
  assertCommandAvailable(command, processEnv)

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env: processEnv,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so stopping the service also stops the install/build tree.
      detached: true
    })
    trackPreparation(id, child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data) => { stdout = pipeLines(id, 'stdout', data.toString(), stdout) })
    child.stderr.on('data', (data) => { stderr = pipeLines(id, 'stderr', data.toString(), stderr) })
    child.once('error', reject)
    child.once('close', (code) => {
      if (stdout.trim()) appendProcessLog(id, 'stdout', stdout.trim())
      if (stderr.trim()) appendProcessLog(id, 'stderr', stderr.trim())
      if (code === 0) resolve()
      else reject(new Error(`${label} failed with exit code ${code ?? 'unknown'}.`))
    })
  })
}

export async function prepareService(options: PreparationOptions) {
  const { id, project, detection, command, autoInstall, env } = options
  const packageJson = await readPackageJson(project.path)
  if (!packageJson) return

  const installRoot = detection.package_root ?? project.install_root ?? project.root_path ?? project.path
  const manager = detection.package_manager ?? project.package_manager ?? 'npm'
  const hasDependencies = Object.keys(packageJson.dependencies ?? {}).length > 0 || Object.keys(packageJson.devDependencies ?? {}).length > 0
  const dependenciesInstalled = await exists(path.join(installRoot, 'node_modules'))

  if (hasDependencies && !dependenciesInstalled) {
    if (!autoInstall) {
      throw new Error(`Dependencies are missing at ${installRoot}. Enable automatic dependency installation or install them manually.`)
    }
    await runPreparationCommand({
      id,
      command: installCommand(manager),
      cwd: installRoot,
      env,
      label: 'Installing dependencies'
    })
  }

  const script = selectedScript(command)
  const scriptBody = script ? packageJson.scripts?.[script] : null
  const launchBody = scriptBody ?? command
  const expectedTarget = targetForCommand(launchBody, project.path)
  if (!expectedTarget || await exists(expectedTarget)) return

  if (!packageJson.scripts?.build) {
    throw new Error(`Startup target ${path.relative(project.path, expectedTarget)} is missing and no build script is available.`)
  }

  await runPreparationCommand({
    id,
    command: commandForScript(manager, 'build'),
    cwd: project.path,
    env,
    label: `Building missing startup target ${path.relative(project.path, expectedTarget)}`
  })

  if (!await exists(expectedTarget)) {
    throw new Error(`Build completed, but startup target ${path.relative(project.path, expectedTarget)} is still missing.`)
  }
}

// Run from the app when a start failed for missing dependencies or build output.
export async function runPreparationStep(project: Project, step: 'install' | 'build') {
  const detection = await detectProject(project.path, project.root_path ?? project.path)
  const manager = detection.package_manager ?? project.package_manager ?? 'npm'
  if (step === 'install') {
    const installRoot = detection.package_root ?? project.install_root ?? project.root_path ?? project.path
    await runPreparationCommand({ id: project.id, command: installCommand(manager), cwd: installRoot, label: 'Installing dependencies' })
    return
  }
  const packageJson = await readPackageJson(project.path)
  if (!packageJson?.scripts?.build) throw new Error(`${project.name} has no build script`)
  await runPreparationCommand({ id: project.id, command: commandForScript(manager, 'build'), cwd: project.path, label: 'Building' })
}
