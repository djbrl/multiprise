import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

// A new user adds a project, launches it, sees it ready and its logs, then stops it.
// The app runs from source with a throwaway profile, so nothing touches real data.

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// The tests share one app and build on each other's state.
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
let workDir: string
let projectDir: string

const SERVER = `const http = require('http')
const port = Number(process.env.PORT)
http.createServer((req, res) => res.end('hello from e2e')).listen(port, () => console.log('e2e server listening on ' + port))
`

async function mainWindow(electronApp: ElectronApplication) {
  // The splash and the loading page are data: URLs; the interface is the built renderer.
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const window = electronApp.windows().find((candidate) => /renderer\/dist\/index\.html$/.test(candidate.url()))
    if (window) return window
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`The main window never loaded the interface (windows: ${electronApp.windows().map((w) => w.url()).join(', ')})`)
}

test.beforeAll(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'multiprise-e2e-'))
  projectDir = path.join(workDir, 'e2e-shop')
  await fs.mkdir(projectDir)
  await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'e2e-shop', private: true, scripts: { dev: 'node server.js' } }, null, 2))
  await fs.writeFile(path.join(projectDir, 'server.js'), SERVER)

  const env = { ...process.env }
  for (const key of ['VITE_DEV_SERVER_URL', 'ELECTRON_RUN_AS_NODE', 'PORT', 'BACKEND_PORT', 'FRONTEND_PORT']) delete env[key]
  // Run from source, the app would otherwise keep its projects in backend/data.
  env.MULTIPRISE_DATA_DIR = path.join(workDir, 'data')
  app = await electron.launch({
    cwd: appDir,
    args: [appDir, `--user-data-dir=${path.join(workDir, 'profile')}`],
    env
  })
  page = await mainWindow(app)
  // The backend picks folders with a native dialog, which a test cannot click through.
  // An evaluate sent while the main process is still booting can be dropped, so retry once.
  const stubPicker = () => app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog
  }, projectDir)
  await stubPicker().catch(stubPicker)
})

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && page) {
    await page.screenshot({ path: testInfo.outputPath('failure.png') }).catch(() => {})
  }
})

test.afterAll(async () => {
  await app?.close()
  await fs.rm(workDir, { recursive: true, force: true })
})

test('first run: add a project, launch it, read its logs and stop it', async () => {
  await test.step('onboarding adds the project', async () => {
    await expect(page.getByRole('heading', { name: 'Welcome to Multiprise' })).toBeVisible()
    await page.getByRole('button', { name: 'Get started' }).click()
    await page.getByRole('button', { name: /Choose folders/ }).click()
    await expect(page.getByText('npm run dev')).toBeVisible()
    await page.getByRole('button', { name: 'Add 1 project · 1 service' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Open Multiprise' }).click()
    await expect(page.getByRole('heading', { name: 'Projects 1' })).toBeVisible()
    const settings = JSON.parse(await fs.readFile(path.join(workDir, 'data', 'settings.json'), 'utf8'))
    expect(settings.onboarded).toBe(true)
  })

  const allProjects = page.getByRole('heading', { name: /^Projects/ }).locator('..')
  const serverRow = page.getByRole('region', { name: 'Servers on this Mac' }).locator('div.items-center', { hasText: 'e2e-shop' })

  await test.step('launch makes it ready and reachable', async () => {
    await allProjects.getByRole('button', { name: 'Launch' }).click()
    await expect(allProjects.getByText('1 of 1 running')).toBeVisible()
    await expect(page.getByRole('heading', { name: /^Running \d+$/ })).toBeVisible()
    const port = await serverRow.getByRole('button', { name: /^:\d+$/ }).textContent()
    const response = await fetch(`http://localhost:${port!.trim().slice(1)}`)
    expect(await response.text()).toBe('hello from e2e')
  })

  await test.step('the project page shows its logs', async () => {
    await allProjects.getByRole('button', { name: /e2e-shop/ }).click()
    await expect(page.getByText('1 of 1 ready')).toBeVisible()
    await expect(page.getByText(/e2e server listening on \d+/)).toBeVisible()
    await page.getByTitle('Home').click()
  })

  await test.step('stop frees it', async () => {
    await allProjects.getByRole('button', { name: 'Stop' }).click()
    await expect(allProjects.getByText('1 service')).toBeVisible()
    await expect(serverRow).toHaveCount(0)
  })
})

test('settings and the command palette open', async () => {
  await page.keyboard.press('Meta+,')
  await expect(page.getByText('Port assignment')).toBeVisible()
  await page.keyboard.press('Meta+k')
  await page.keyboard.type('e2e-shop')
  await page.keyboard.press('Enter')
  await expect(page.getByText(/e2e server listening on \d+/)).toBeVisible()
})

// Only ever acts on the server it starts: Home also lists whatever else runs on this machine.
test('a server started outside the app shows on Home, and can be stopped there', async () => {
  const folder = path.join(workDir, 'outside-demo')
  await fs.mkdir(folder)
  const server = spawn(process.execPath, ['-e', `require('http').createServer((q,r)=>r.end('outside')).listen(0,'127.0.0.1')`], { cwd: folder, stdio: 'ignore' })
  const exited = new Promise((resolve) => server.once('exit', resolve))
  try {
    await expect.poll(async () => {
      await page.keyboard.press('Meta+,')
      await page.getByTitle('Home').click()
      return page.getByRole('region', { name: 'Servers on this Mac' }).getByText('outside-demo').count()
    }, { timeout: 15_000 }).toBe(1)

    const row = page.getByRole('region', { name: 'Servers on this Mac' }).locator('div.items-center', { hasText: 'outside-demo' })
    await expect(row.getByText('temporary folder')).toBeVisible()
    // Something is still attached to it, so stopping takes a second click.
    await row.getByRole('button', { name: 'Stop' }).click()
    expect(server.exitCode).toBeNull()
    await row.getByRole('button', { name: 'Stop it?' }).click()
    await exited
    await expect(row).toHaveCount(0)
  } finally {
    server.kill('SIGKILL')
  }
})

// Only ever acts on the server it starts.
test('Activity shows the machine and what a server takes, and can stop it', async () => {
  const folder = path.join(workDir, 'activity-demo')
  await fs.mkdir(folder)
  const server = spawn(process.execPath, ['-e', `require('http').createServer((q,r)=>r.end('activity')).listen(0,'127.0.0.1')`], { cwd: folder, stdio: 'ignore' })
  const exited = new Promise((resolve) => server.once('exit', resolve))
  try {
    await page.getByRole('button', { name: /^Activity\./ }).click()
    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'CPU' }).getByText(/\d+%$/).first()).toBeVisible()
    await expect(page.getByRole('region', { name: 'Memory' }).getByText(/\d GB/).first()).toBeVisible()

    const table = page.getByRole('region', { name: 'What is using it' })
    const row = table.locator('div.grid', { hasText: 'activity-demo' })
    await expect(row).toHaveCount(1, { timeout: 15_000 })
    await expect(row.getByText(/\d+ MB/)).toBeVisible()
    await expect(table.locator('div.grid', { hasText: 'this app' }).getByText(/\d+ MB/)).toBeVisible()

    // The rest of the Mac, apps and macOS itself, with the server not listed twice.
    const rest = page.getByRole('region', { name: 'Everything else' })
    await expect(rest.locator('div.grid', { hasText: 'macOS' }).first()).toBeVisible()
    await expect(rest.locator('div.grid', { hasText: 'activity-demo' })).toHaveCount(0)
    await rest.getByRole('button', { name: 'CPU' }).click()
    await expect(rest.getByRole('button', { name: 'CPU' })).toHaveAttribute('aria-pressed', 'true')

    // Something is still attached to it, so stopping takes a second click.
    await row.hover()
    await row.getByRole('button', { name: 'Stop' }).click()
    expect(server.exitCode).toBeNull()
    await row.getByRole('button', { name: 'Stop it?' }).click()
    await exited
    await expect(row).toHaveCount(0)
  } finally {
    server.kill('SIGKILL')
  }
})
