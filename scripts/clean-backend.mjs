import { rm } from 'node:fs/promises'

await rm(new URL('../backend/dist', import.meta.url), { recursive: true, force: true })
