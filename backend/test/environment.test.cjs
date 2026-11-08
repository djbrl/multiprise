const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

// Never let tests touch the developer's real backend/data directory.
process.env.MULTIPRISE_DATA_DIR = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'multiprise-env-data-'))

const { startServer, stopServer } = require('../dist/index.js')
const { setSecretStore } = require('../dist/services/environment.js')

// Outside Electron there is no Keychain-backed storage, so secrets live in memory here.
const stored = new Map()
setSecretStore({
  get: async (id, key) => stored.get(`${id}/${key}`) ?? null,
  set: async (id, key, value) => { stored.set(`${id}/${key}`, value) },
  remove: async (id, key) => {
    for (const name of [...stored.keys()]) if (key ? name === `${id}/${key}` : name.startsWith(`${id}/`)) stored.delete(name)
  }
})

async function startApi(context, dataDir) {
  process.env.MULTIPRISE_DATA_DIR = dataDir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'multiprise-env-data-'))
  const backend = await startServer({ proxyPort: false })
  context.after(() => stopServer(backend))
  const call = async (method, route, body) => {
    const response = await fetch(`${backend.url}${route}`, {
      method,
      headers: { 'x-multiprise-token': backend.token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await response.text()
    let parsed = text
    try { parsed = JSON.parse(text) } catch (err) { /* plain-text error */ }
    return { status: response.status, body: parsed }
  }
  return { backend, call, dataDir: process.env.MULTIPRISE_DATA_DIR }
}

// "shop" with an api and a web service; web answers with the environment it was given.
async function shop(api, extraFiles = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'multiprise-env-shop-'))
  const serve = (body) => `require('http').createServer((q, r) => r.end(${body})).listen(Number(process.env.PORT), '127.0.0.1')`
  for (const name of ['api', 'web']) {
    await fs.mkdir(path.join(root, name))
    await fs.writeFile(path.join(root, name, 'package.json'), JSON.stringify({ name, scripts: { dev: 'node server.js' } }))
  }
  await fs.writeFile(path.join(root, 'api', 'server.js'), serve("JSON.stringify({ FRONTEND_PORT: process.env.FRONTEND_PORT })"))
  await fs.writeFile(path.join(root, 'web', 'server.js'), serve('JSON.stringify({ API_URL: process.env.API_URL, API_PORT_COPY: process.env.API_PORT_COPY, GREETING: process.env.GREETING, TOKEN: process.env.TOKEN, PORT: process.env.PORT })'))
  for (const [file, text] of Object.entries(extraFiles)) await fs.writeFile(path.join(root, file), text)
  const created = await api.call('POST', '/api/projects', { path: root })
  assert.equal(created.status, 200, created.body)
  const ids = Object.fromEntries(created.body.projects.map((view) => [view.project.name, view.project.id]))
  return { root, ids }
}

const view = async (api, id) => (await api.call('GET', '/api/projects')).body.projects.find((entry) => entry.project.id === id)

test('links are validated: no unknown services, no self-links, no loops', async (context) => {
  const api = await startApi(context)
  const { ids } = await shop(api)
  assert.equal((await api.call('PATCH', `/api/projects/${ids.web}`, { links: [ids.api] })).status, 200)
  assert.match((await api.call('PATCH', `/api/projects/${ids.api}`, { links: [ids.web] })).body, /loop: api → web → api/)
  assert.match((await api.call('PATCH', `/api/projects/${ids.api}`, { links: [ids.api] })).body, /cannot depend on itself/)
  assert.match((await api.call('PATCH', `/api/projects/${ids.api}`, { links: ['nope'] })).body, /No service with id nope/)
  assert.equal((await api.call('PATCH', `/api/projects/${ids.web}`, { links: 'api' })).status, 400)
})

test('starting a service starts its dependencies first and passes it their URLs, its variables and secrets', async (context) => {
  const api = await startApi(context)
  const { ids } = await shop(api)
  assert.equal((await api.call('PATCH', `/api/projects/${ids.web}`, { links: [ids.api] })).status, 200)

  const saved = await api.call('PUT', `/api/projects/${ids.web}/environment`, {
    variables: [
      { key: 'API_URL', value: '{{services.api.url}}', secret: false },
      { key: 'API_PORT_COPY', value: '{{ services.api.port }}', secret: false },
      { key: 'GREETING', value: 'hello', secret: false },
      { key: 'TOKEN', value: 's3cret', secret: true }
    ]
  })
  assert.equal(saved.status, 200, saved.body)
  assert.deepEqual(saved.body.variables.find((variable) => variable.key === 'TOKEN'), { key: 'TOKEN', value: null, secret: true })
  assert.doesNotMatch(await fs.readFile(path.join(api.dataDir, 'projects.json'), 'utf8'), /s3cret/)

  // Only web is started; api comes up first because web depends on it.
  const started = await api.call('POST', `/api/projects/${ids.web}/start`, { role: 'frontend' })
  assert.equal(started.status, 200, started.body)
  const apiView = await view(api, ids.api)
  assert.equal(apiView.status.phase, 'ready')
  // Started as a dependency, it still learns its frontend sibling's port, as the Launch button passes it.
  const apiEnv = JSON.parse(await (await fetch(`http://127.0.0.1:${apiView.project.port}`)).text())
  assert.equal(apiEnv.FRONTEND_PORT, String(started.body.project.port))
  const env = JSON.parse(await (await fetch(`http://127.0.0.1:${started.body.project.port}`)).text())
  assert.deepEqual(env, {
    API_URL: `http://localhost:${apiView.project.port}`,
    API_PORT_COPY: String(apiView.project.port),
    GREETING: 'hello',
    TOKEN: 's3cret',
    PORT: String(started.body.project.port)
  })

  // Starting something already running is not an error.
  assert.equal((await api.call('POST', `/api/projects/${ids.api}/start`, {})).status, 200)

  // Keeping a secret without resending it, and removing it.
  await api.call('POST', `/api/projects/${ids.web}/stop`, {})
  const kept = await api.call('PUT', `/api/projects/${ids.web}/environment`, { variables: [{ key: 'TOKEN', secret: true }] })
  assert.deepEqual(kept.body.variables, [{ key: 'TOKEN', value: null, secret: true }])
  assert.equal(stored.get(`${ids.web}/TOKEN`), 's3cret')
  await api.call('PUT', `/api/projects/${ids.web}/environment`, { variables: [] })
  assert.equal(stored.has(`${ids.web}/TOKEN`), false)
})

test('invalid variables are rejected with a reason', async (context) => {
  const api = await startApi(context)
  const { ids } = await shop(api)
  const save = (variables) => api.call('PUT', `/api/projects/${ids.web}/environment`, { variables })
  assert.match((await save([{ key: '1BAD', value: 'x' }])).body, /not a valid variable name/)
  assert.match((await save([{ key: 'PORT', value: '1' }])).body, /PORT is set by Multiprise/)
  assert.match((await save([{ key: 'A', value: '1' }, { key: 'A', value: '2' }])).body, /listed twice/)
  assert.match((await save([{ key: 'NEW_SECRET', secret: true }])).body, /Enter a value for the secret/)

  // A template naming a service that does not exist fails the launch with a clear message.
  assert.equal((await save([{ key: 'API_URL', value: '{{services.billing.url}}' }])).status, 200)
  const started = await api.call('POST', `/api/projects/${ids.web}/start`, { role: 'frontend' })
  assert.equal(started.status, 400)
  assert.match(started.body, /API_URL refers to "billing", which is not a service/)
})

test('a .env.example without a .env is reported, in the editor and in the launch log', async (context) => {
  const api = await startApi(context)
  const { ids } = await shop(api, { '.env.example': 'DATABASE_URL=\nexport STRIPE_KEY=\n# comment\nGREETING=hi\n' })
  await api.call('PUT', `/api/projects/${ids.api}/environment`, { variables: [{ key: 'GREETING', value: 'hello' }] })
  const described = (await api.call('GET', `/api/projects/${ids.api}/environment`)).body
  assert.deepEqual(described.env_file, {
    example: '../.env.example',
    has_env: false,
    missing: ['DATABASE_URL', 'STRIPE_KEY'],
    variables: [
      { key: 'DATABASE_URL', example: '', in_env_file: false },
      { key: 'STRIPE_KEY', example: '', in_env_file: false },
      { key: 'GREETING', example: 'hi', in_env_file: false }
    ]
  })

  assert.equal((await api.call('POST', `/api/projects/${ids.api}/start`, { role: 'backend' })).status, 200)
  const logs = (await api.call('GET', `/api/projects/${ids.api}/logs`)).body.logs.map((entry) => entry.line).join('\n')
  assert.match(logs, /\.env\.example exists but there is no \.env, so these are not set: DATABASE_URL, STRIPE_KEY/)
})

test('variables and links survive a restart, and deleting a service removes links to it and its secrets', async (context) => {
  const first = await startApi(context)
  const { ids } = await shop(first)
  await first.call('PATCH', `/api/projects/${ids.web}`, { links: [ids.api] })
  await first.call('PUT', `/api/projects/${ids.web}/environment`, { variables: [{ key: 'GREETING', value: 'hi' }, { key: 'TOKEN', value: 'x', secret: true }] })
  await first.call('PUT', `/api/projects/${ids.api}/environment`, { variables: [{ key: 'KEY', value: 'y', secret: true }] })
  await stopServer(first.backend)

  const second = await startApi(context, first.dataDir)
  const web = (await second.call('GET', `/api/projects/${ids.web}/environment`)).body
  assert.deepEqual(web.links, [ids.api])
  assert.deepEqual(web.variables.map((variable) => variable.key), ['GREETING', 'TOKEN'])

  assert.equal((await second.call('DELETE', `/api/projects/${ids.api}`)).status, 200)
  assert.deepEqual((await second.call('GET', `/api/projects/${ids.web}/environment`)).body.links, [])
  assert.equal(stored.has(`${ids.api}/KEY`), false)
})

test('detected variables report whether a .env file sets them, never its values', async (context) => {
  const api = await startApi(context)
  const { ids } = await shop(api, {
    '.env.example': 'API_KEY="your key here" # from the dashboard\nexport REGION=eu\nAPI_KEY=duplicate\n',
    '.env': 'API_KEY=real-secret-value\n'
  })
  const described = (await api.call('GET', `/api/projects/${ids.api}/environment`)).body
  assert.deepEqual(described.env_file.variables, [
    { key: 'API_KEY', example: 'your key here', in_env_file: true },
    { key: 'REGION', example: 'eu', in_env_file: false }
  ])
  assert.deepEqual(described.env_file.missing, ['REGION'])
  assert.doesNotMatch(JSON.stringify(described), /real-secret-value/)
})
