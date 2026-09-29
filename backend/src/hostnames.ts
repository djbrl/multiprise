import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { getProcessStatus } from './processes'
import { projectRoleFallback } from './roles'
import { type AppState } from './state'
import { type Project } from './types'

// A local reverse proxy that gives every service a stable name, e.g.
// http://web.shop.localhost:7331, whatever port it currently holds. Browsers and most
// tools resolve *.localhost to the loopback addresses without any DNS setup.

export const DEFAULT_PROXY_PORT = 7331
const LISTEN_HOSTS = ['127.0.0.1', '::1']

const slug = (value: string) =>
  value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'app'

// Host label (the part before .localhost) → service. A service named like its project
// gets the project's name; a project's own name also leads to its frontend (or backend).
export function hostRoutes(projects: Project[]): Map<string, Project> {
  const byRoot = new Map<string, Project[]>()
  for (const project of [...projects].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const root = project.root_path ?? project.path
    if (!byRoot.has(root)) byRoot.set(root, [])
    byRoot.get(root)!.push(project)
  }

  const routes = new Map<string, Project>()
  const unique = (label: string) => {
    let candidate = label
    for (let index = 2; routes.has(candidate); index += 1) candidate = `${label}-${index}`
    return candidate
  }
  for (const [root, services] of byRoot) {
    const projectLabel = unique(slug(path.basename(root)))
    const labels = new Set<string>()
    for (const service of services) {
      const serviceSlug = slug(service.name)
      let label = serviceSlug === projectLabel ? projectLabel : `${serviceSlug}.${projectLabel}`
      for (let index = 2; labels.has(label); index += 1) label = `${serviceSlug}-${index}.${projectLabel}`
      labels.add(label)
      routes.set(label, service)
    }
    if (!routes.has(projectLabel)) {
      const byRole = (role: string) => services.find((service) => service.kind !== 'docker_compose' && projectRoleFallback(service) === role)
      const primary = byRole('frontend') ?? byRole('backend') ?? services[0]
      if (primary) routes.set(projectLabel, primary)
    }
  }
  return routes
}

// The stable URL of each service, keyed by id; a service reachable by several names gets its own.
export function hostUrls(projects: Project[], port: number): Record<string, string> {
  const urls: Record<string, string> = {}
  for (const [label, project] of hostRoutes(projects)) {
    if (!urls[project.id] || label.includes('.')) urls[project.id] = `http://${label}.localhost${port === 80 ? '' : `:${port}`}`
  }
  return urls
}

const hostnameOf = (hostHeader: string | undefined) => {
  const host = (hostHeader ?? '').toLowerCase()
  return (host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '')).replace(/\.$/, '')
}

function labelOf(hostHeader: string | undefined) {
  const host = hostnameOf(hostHeader)
  return host.endsWith('.localhost') ? host.slice(0, -'.localhost'.length) : null
}

// Anything else is a foreign name pointed at this machine (DNS rebinding), not a browser tab of ours.
const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

const escapeHtml = (value: string) => value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!)

function page(res: http.ServerResponse, status: number, title: string, body: string) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#252529}code{background:#f1f1f3;padding:.1em .3em;border-radius:4px}li{margin:.2em 0}</style>
<h1 style="font-size:1.3rem">${escapeHtml(title)}</h1>${body}`)
}

function isUp(project: Project) {
  if (project.kind === 'docker_compose') return !!project.docker_running && !!project.port
  return getProcessStatus(project.id).running && !!project.port
}

// Remembers which loopback address a port answers on (servers may bind only one of them).
const preferredHost = new Map<number, string>()

function connectTo(port: number) {
  return new Promise<net.Socket>((resolve, reject) => {
    const hosts = [preferredHost.get(port), ...LISTEN_HOSTS].filter((host, index, all): host is string => !!host && all.indexOf(host) === index)
    const attempt = (index: number) => {
      const socket = net.connect({ host: hosts[index], port })
      socket.once('connect', () => {
        socket.removeAllListeners('error')
        preferredHost.set(port, hosts[index])
        resolve(socket)
      })
      socket.once('error', (err) => {
        socket.destroy()
        if (index + 1 < hosts.length) attempt(index + 1)
        else reject(err)
      })
    }
    attempt(0)
  })
}

// Connection-level headers describe the upstream connection, not the browser's.
const HOP_BY_HOP = new Set(['connection', 'keep-alive'])
function withoutHopByHop(rawHeaders: string[]) {
  const kept: string[] = []
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (!HOP_BY_HOP.has(rawHeaders[index].toLowerCase())) kept.push(rawHeaders[index], rawHeaders[index + 1])
  }
  return kept
}

export type HostnameProxy = {
  port: number
  close: () => Promise<void>
}

export async function startHostnameProxy(state: AppState, port: number): Promise<HostnameProxy> {
  const route = (hostHeader: string | undefined) => {
    const label = labelOf(hostHeader)
    return label === null ? { label: null, project: undefined } : { label, project: hostRoutes(state.projects).get(label) }
  }
  let listeningPort = port

  const listing = () => {
    const urls = hostUrls(state.projects, listeningPort)
    const items = state.projects
      .filter((project) => urls[project.id])
      .map((project) => `<li><a href="${urls[project.id]}">${escapeHtml(urls[project.id])}</a>${isUp(project) ? '' : ' <small>(stopped)</small>'}</li>`)
    return items.length ? `<ul>${items.join('')}</ul>` : '<p>No services yet. Add a project in Multiprise.</p>'
  }

  const forwardedHeaders = (req: http.IncomingMessage, connection?: string) => ({
    ...req.headers,
    ...(connection ? { connection } : {}),
    'x-forwarded-host': req.headers.host ?? '',
    'x-forwarded-proto': 'http',
    'x-forwarded-for': req.socket.remoteAddress ?? ''
  })

  const server = http.createServer((req, res) => {
    const { label, project } = route(req.headers.host)
    if (label === null && !LOCAL_NAMES.has(hostnameOf(req.headers.host))) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      return res.end('Forbidden host')
    }
    if (!project) {
      const title = label ? `No service is called ${label}.localhost` : 'Multiprise hostnames'
      return page(res, label ? 404 : 200, title, `<p>Services managed by Multiprise:</p>${listing()}`)
    }
    if (!isUp(project)) {
      return page(res, 502, `${project.name} is not running`,
        `<p>Start it in Multiprise, or run <code>multiprise up ${escapeHtml(project.id)}</code>, then reload this page.</p>`)
    }
    const targetPort = project.port!
    connectTo(targetPort).then((socket) => {
      // One upstream connection per request (no agent), closed after the response.
      const upstream = http.request({
        createConnection: () => socket,
        method: req.method,
        path: req.url,
        headers: forwardedHeaders(req, 'close')
      }, (response) => {
        res.writeHead(response.statusCode ?? 502, response.statusMessage, withoutHopByHop(response.rawHeaders))
        response.pipe(res)
      })
      upstream.on('error', () => {
        preferredHost.delete(targetPort)
        if (!res.headersSent) page(res, 502, `${project.name} did not answer`, '<p>The service closed the connection. Check its logs in Multiprise.</p>')
        else res.destroy()
      })
      req.pipe(upstream)
    }, () => {
      page(res, 502, `${project.name} is not accepting connections`, `<p>Nothing answered on port ${targetPort}. Check its logs in Multiprise.</p>`)
    })
  })

  // WebSockets (hot reload, live updates) are tunnelled as raw connections. The HTTP
  // server stops tracking upgraded sockets, so they are tracked here to close on shutdown.
  const tunnels = new Set<net.Socket>()
  const track = (socket: net.Socket) => {
    tunnels.add(socket)
    socket.once('close', () => tunnels.delete(socket))
  }
  server.on('upgrade', (req, clientSocket: net.Socket, head: Buffer) => {
    const { project } = route(req.headers.host)
    if (!project || !isUp(project)) {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
      return
    }
    connectTo(project.port!).then((upstream) => {
      const headers = forwardedHeaders(req)
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
      for (const [name, value] of Object.entries(headers)) {
        for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) lines.push(`${name}: ${item}`)
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) upstream.write(head)
      track(clientSocket)
      track(upstream)
      upstream.pipe(clientSocket).pipe(upstream)
      for (const [socket, other] of [[upstream, clientSocket], [clientSocket, upstream]]) {
        socket.on('error', () => other.destroy())
        socket.on('close', () => other.destroy())
      }
    }, () => clientSocket.destroy())
  })
  server.on('clientError', (_err, socket) => socket.destroy())

  // *.localhost may resolve to either loopback address, so both are served; the second
  // listener binds the port the first one got.
  const servers: http.Server[] = []
  for (const host of LISTEN_HOSTS) {
    const listener = servers.length ? http.createServer() : server
    if (servers.length) {
      listener.on('request', (req, res) => server.emit('request', req, res))
      listener.on('upgrade', (req, socket, head) => server.emit('upgrade', req, socket, head))
      listener.on('clientError', (_err, socket) => socket.destroy())
    }
    try {
      await new Promise<void>((resolve, reject) => {
        listener.once('error', reject)
        listener.listen(listeningPort, host, () => {
          listener.off('error', reject)
          resolve()
        })
      })
      const address = listener.address()
      if (address && typeof address === 'object') listeningPort = address.port
      servers.push(listener)
    } catch (err) {
      // IPv6 may be disabled; IPv4 is required.
      if (host === LISTEN_HOSTS[0]) throw err
    }
  }

  return {
    port: listeningPort,
    close: () => {
      for (const socket of tunnels) socket.destroy()
      return Promise.all(servers.map((listener) => new Promise<void>((resolve) => {
        listener.close(() => resolve())
        listener.closeAllConnections?.()
      }))).then(() => undefined)
    }
  }
}
