// Windows waitlist.
//   POST {email}    -> stores the address (private Vercel Blob store, one blob per address)
//   DELETE {email}  -> removes the address (the "Leave the list" form on privacy.html)
//   GET             -> CSV export, only with "Authorization: Bearer $WAITLIST_ADMIN_KEY"
// Only the address and the time it was added are stored. privacy.html says so to visitors.
//
// Rate limits: a Vercel Firewall rule limits /api/waitlist to 10 requests per IP per 10 minutes
// at the edge (see site/README.md). The limits below repeat it inside the function, per running
// instance, so a missing or disabled rule (or a preview deployment) still has a ceiling.
import { timingSafeEqual } from 'node:crypto'
import { del, list, put } from '@vercel/blob'

const PREFIX = 'waitlist/windows/'
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,188}\.[^\s@]{2,}$/

// The blob name is derived from the address, so joining twice keeps a single entry.
const blobName = (email) => `${PREFIX}${Buffer.from(email).toString('base64url')}.json`
const emailFrom = (pathname) => Buffer.from(pathname.slice(PREFIX.length).replace(/\.json$/, ''), 'base64url').toString()

const WINDOW_MS = 10 * 60 * 1000
const PER_IP = 10          // requests per address per window, the same as the firewall rule
const WRITES_PER_HOUR = 300 // all joins and removals together, so a spread-out flood can't run up the Blob store

const hits = new Map() // ip -> { count, resetAt }
let writes = { count: 0, resetAt: 0 }

const clientIp = (req) => String(req.headers['x-real-ip'] ?? req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || 'unknown'

// Fixed window per IP. Returns the seconds to wait, or 0 when the request may go ahead.
function limited(ip, now = Date.now()) {
  if (hits.size > 5000) for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key)
  const entry = hits.get(ip)
  if (!entry || entry.resetAt <= now) { hits.set(ip, { count: 1, resetAt: now + WINDOW_MS }); return 0 }
  entry.count += 1
  return entry.count > PER_IP ? Math.ceil((entry.resetAt - now) / 1000) : 0
}

function writeAllowed(now = Date.now()) {
  if (writes.resetAt <= now) writes = { count: 0, resetAt: now + 60 * 60 * 1000 }
  writes.count += 1
  return writes.count <= WRITES_PER_HOUR
}

function tooMany(res, seconds) {
  res.setHeader('Retry-After', String(seconds))
  return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' })
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  const wait = limited(clientIp(req))
  if (wait) return tooMany(res, wait)
  if (req.method === 'POST') return change(req, res, 'join')
  if (req.method === 'DELETE') return change(req, res, 'leave')
  if (req.method === 'GET') return exportList(req, res)
  res.setHeader('Allow', 'GET, POST, DELETE')
  return res.status(405).json({ error: 'Method not allowed' })
}

async function change(req, res, action) {
  const body = req.body && typeof req.body === 'object' ? req.body : {}
  // Honeypot: people never see this field, simple bots fill it in.
  if (body.website) return res.status(200).json({ ok: true })

  const email = String(body.email ?? '').trim().toLowerCase()
  if (email.length > 254 || !EMAIL.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' })
  }
  if (!writeAllowed()) return tooMany(res, 600)

  // Leaving answers the same whether or not the address was on the list, so the form can't be
  // used to find out who signed up.
  if (action === 'leave') {
    await del(blobName(email))
    return res.status(200).json({ ok: true })
  }

  await put(blobName(email), JSON.stringify({ email, joinedAt: new Date().toISOString() }), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json'
  })
  return res.status(200).json({ ok: true })
}

function authorized(req) {
  const key = process.env.WAITLIST_ADMIN_KEY ?? ''
  const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  return key.length > 0 && given.length === key.length && timingSafeEqual(Buffer.from(given), Buffer.from(key))
}

// Spreadsheet apps treat cells starting with these characters as formulas.
const csvCell = (value) => /^[=+\-@]/.test(value) ? `'${value}` : value

async function exportList(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' })

  const rows = []
  let cursor
  do {
    const page = await list({ prefix: PREFIX, cursor })
    for (const blob of page.blobs) rows.push([csvCell(emailFrom(blob.pathname)), new Date(blob.uploadedAt).toISOString()])
    cursor = page.hasMore ? page.cursor : undefined
  } while (cursor)

  rows.sort((a, b) => a[1].localeCompare(b[1]))
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  return res.status(200).send(['email,joined_at', ...rows.map((row) => row.join(','))].join('\n') + '\n')
}
