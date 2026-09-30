import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
    await expect(page.getByRole('heading', { name: 'All projects · 1' })).toBeVisible()
    const settings = JSON.parse(await fs.readFile(path.join(workDir, 'data', 'settings.json'), 'utf8'))
    expect(settings.onboarded).toBe(true)
  })

  const allProjects = page.getByRole('heading', { name: /^All projects/ }).locator('..')

  await test.step('launch makes it ready and reachable', async () => {
    await allProjects.getByRole('button', { name: 'Launch' }).click()
    await expect(allProjects.getByText('1 of 1 running')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Running now · 1' })).toBeVisible()
    const url = await page.getByRole('button', { name: /^http:\/\/localhost:\d+$/ }).textContent()
    const response = await fetch(url!.trim())
    expect(await response.text()).toBe('hello from e2e')
  })

  await test.step('the project page shows its logs', async () => {
    await allProjects.getByRole('button', { name: /e2e-shop/ }).click()
    await expect(page.getByText('1/1 ready')).toBeVisible()
    await expect(page.getByText(/e2e server listening on \d+/)).toBeVisible()
    await page.getByTitle('Home').click()
  })

  await test.step('stop frees it', async () => {
    await allProjects.getByRole('button', { name: 'Stop' }).click()
    await expect(allProjects.getByText('1 service')).toBeVisible()
    await expect(page.getByRole('heading', { name: /Running now/ })).toHaveCount(0)
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
