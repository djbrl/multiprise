import { defineConfig } from '@playwright/test'

// Drives the Electron app itself; `npm run test:e2e` builds the renderer first.
export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  // One app at a time: each run owns a menu bar icon and the hostname proxy port.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  outputDir: '../test-results'
})
