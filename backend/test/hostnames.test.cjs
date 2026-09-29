const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

// Never let tests touch the developer's real backend/data directory.
process.env.MULTIPRISE_DATA_DIR = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'multiprise-hostnames-data-'))

const { hostRoutes, hostUrls } = require('../dist/hostnames.js')
const { startServer, stopServer } = require('../dist/index.js')

let created = 0
const service = (root, name, extra = {}) => ({
  id: `${path.basename(root)}-${name}`, name, path: path.join(root, name), root_path: root, tags: [], kind: 'command',
  created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, created++)).toISOString(), ...extra
})

test('services get names from their project folder and service name', () => {
  const projects = [
    service('/code/shop', 'api', { role: 'backend' }),
    service('/code/shop', 'web', { role: 'frontend' }),
    service('/code/shop', 'shop docker', { kind: 'docker_compose' }),
    { ...service('/code/blog', 'blog'), path: '/code/blog' },
    service('/work/app', 'My Web App!'),
    service('/personal/app', 'server', { role: 'backend' })
  ]
  const labels = Object.fromEntries([...hostRoutes(projects)].map(([label, project]) => [label, project.id]))
  assert.deepEqual(labels, {
    'api.shop': 'shop-api',
    'web.shop': 'shop-web',
    'shop-docker.shop': 'shop-shop docker',
    shop: 'shop-web',
    blog: 'blog-blog',
    'my-web-app.app': 'app-My Web App!',
    app: 'app-My Web App!',
    'server.app-2': 'app-server',
    'app-2': 'app-server'
  })
  const urls = hostUrls(projects, 7331)
  assert.equal(urls['shop-web'], 'http://web.shop.localhost:7331', 'a service keeps its own name even when it is the project default')
  assert.equal(urls['blog-blog'], 'http://blog.localhost:7331')
  assert.equal(hostUrls(projects, 80)['blog-blog'], 'http://blog.localhost')
})

function request(port, host, route = '/', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, headers: { host, ...headers } }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

// Echoes what it received; also accepts WebSocket-style upgrades and echoes their data.
const echoServer = (listenHost) => `
  const server = require('http').createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ host: req.headers.host, forwarded: req.headers['x-forwarded-host'], url: req.url }))
  })
  server.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n')
    socket.on('data', (data) => socket.write('echo:' + data))
  })
  server.listen(Number(process.env.PORT), '${listenHost}')`

async function startApi(context, options = {}) {
  process.env.MULTIPRISE_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'multiprise-hostnames-data-'))
  const backend = await startServer({ proxyPort: 0, ...options })
  context.after(() => stopServer(backend))
  const call = async (method, route, body) => {
    const response = await fetch(`${backend.url}${route}`, {
      method,
      headers: { 'x-multiprise-token': backend.token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await response.text()
    return { status: response.status, body: text && text.startsWith('{') ? JSON.parse(text) : text }
  }
  return { backend, call }
}

async function addProject(api, services) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'multiprise-proxy-'))
  for (const [name, source] of Object.entries(services)) {
    await fs.mkdir(path.join(root, name))
    await fs.writeFile(path.join(root, name, 'package.json'), JSON.stringify({ name, scripts: { dev: 'node server.js' } }))
    await fs.writeFile(path.join(root, name, 'server.js'), source)
  }
  const response = await api.call('POST', '/api/projects', { path: root })
  assert.equal(response.status, 200, response.body)
  return Object.fromEntries(response.body.projects.map((view) => [view.project.name, view.project.id]))
}

test('the proxy serves each service at its stable name, including WebSockets and IPv6-only servers', async (context) => {
  const api = await startApi(context)
  const proxyPort = api.backend.hostnames.port
  assert.ok(proxyPort)
  const ids = await addProject(api, { web: echoServer('127.0.0.1'), api: echoServer('::1') })

  const { urls } = (await api.call('GET', '/api/hostnames')).body
  const hostOf = (id) => new URL(urls[id]).host
  assert.match(urls[ids.web], /^http:\/\/web\.multiprise-proxy-[a-z0-9-]+\.localhost:\d+$/)

  // Not started yet: a page explains how to start it.
  const stopped = await request(proxyPort, hostOf(ids.web))
  assert.equal(stopped.status, 502)
  assert.match(stopped.body, /is not running/)

  for (const id of [ids.api, ids.web]) {
    assert.equal((await api.call('POST', `/api/projects/${id}/start`, { role: id === ids.api ? 'backend' : 'frontend' })).status, 200)
  }

  const web = await request(proxyPort, hostOf(ids.web), '/some/path?x=1')
  assert.equal(web.status, 200)
  assert.deepEqual(JSON.parse(web.body), { host: hostOf(ids.web), forwarded: hostOf(ids.web), url: '/some/path?x=1' })
  assert.equal(web.headers.connection, 'keep-alive', 'the upstream connection header is not passed on')

  const ipv6Only = await request(proxyPort, hostOf(ids.api))
  assert.equal(JSON.parse(ipv6Only.body).host, hostOf(ids.api))

  // The project's own name leads to its frontend.
  const projectHost = hostOf(ids.web).replace(/^web\./, '')
  assert.equal(JSON.parse((await request(proxyPort, projectHost)).body).host, projectHost)

  const upgraded = await new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write(`GET /hmr HTTP/1.1\r\nHost: ${hostOf(ids.web)}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`)
    })
    let received = ''
    socket.on('data', (data) => {
      received += data
      if (received.includes('\r\n\r\n') && !received.includes('echo:')) socket.write('ping')
      if (received.includes('echo:ping')) {
        socket.destroy()
        resolve(received)
      }
    })
    socket.on('error', reject)
  })
  assert.match(upgraded, /^HTTP\/1\.1 101/)

  const unknown = await request(proxyPort, 'nothing-here.localhost')
  assert.equal(unknown.status, 404)
  assert.ok(unknown.body.includes(urls[ids.web]), 'the not-found page lists the services')
  assert.equal((await request(proxyPort, 'localhost')).status, 200)
  assert.equal((await request(proxyPort, 'attacker.example')).status, 403)
})

test('a proxy port that is already taken leaves the app running without hostnames', async (context) => {
  const blocker = net.createServer()
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  context.after(() => blocker.close())
  const api = await startApi(context, { proxyPort: blocker.address().port })

  const info = (await api.call('GET', '/api/hostnames')).body
  assert.equal(info.port, null)
  assert.match(info.error, /is not available for service hostnames/)
  assert.deepEqual(info.urls, {})
  assert.equal((await api.call('GET', '/api/projects')).status, 200)
})
