import { timingSafeEqual } from 'node:crypto'
import { type Request, type RequestHandler } from 'express'
import { API_TOKEN_HEADER } from './discovery'

export type ApiSecurityOptions = {
  token?: string | null
  allowedOrigins?: string[]
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])

function tokensMatch(expected: string, provided: unknown) {
  if (typeof provided !== 'string' || provided.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
}

function requestHostname(req: Request) {
  const host = (req.headers.host ?? '').toLowerCase()
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '')
}

export function apiGuard(security: ApiSecurityOptions): RequestHandler {
  const token = security.token ?? null
  const allowedOrigins = new Set(security.allowedOrigins ?? ['null'])
  return (req, res, next) => {
    // Rejecting foreign Host headers blocks DNS-rebinding pages from reaching the API.
    if (!LOOPBACK_HOSTNAMES.has(requestHostname(req))) {
      return res.status(403).send('Forbidden host')
    }
    const origin = req.headers.origin
    if (origin !== undefined) {
      if (!allowedOrigins.has(origin)) return res.status(403).send('Forbidden origin')
      res.header('Access-Control-Allow-Origin', origin)
      res.header('Vary', 'Origin')
      res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
      res.header('Access-Control-Allow-Headers', `Content-Type, ${API_TOKEN_HEADER}`)
    }
    if (req.method === 'OPTIONS') {
      return res.sendStatus(origin !== undefined ? 204 : 403)
    }
    if (token) {
      // Image requests cannot carry headers, so GETs may pass the token as a query parameter.
      const provided = req.get(API_TOKEN_HEADER) ?? (req.method === 'GET' ? req.query.token : undefined)
      if (!tokensMatch(token, provided)) return res.status(401).send('Unauthorized')
    }
    next()
  }
}
