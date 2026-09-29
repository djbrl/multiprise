// Windows waitlist.
//   POST {email}  -> stores the address (private Vercel Blob store, one blob per address)
//   GET           -> CSV export, only with "Authorization: Bearer $WAITLIST_ADMIN_KEY"
// Only the address and the time it was added are stored.
import { timingSafeEqual } from 'node:crypto'
import { list, put } from '@vercel/blob'

const PREFIX = 'waitlist/windows/'
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,188}\.[^\s@]{2,}$/

// The blob name is derived from the address, so joining twice keeps a single entry.
const blobName = (email) => `${PREFIX}${Buffer.from(email).toString('base64url')}.json`
const emailFrom = (pathname) => Buffer.from(pathname.slice(PREFIX.length).replace(/\.json$/, ''), 'base64url').toString()

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'POST') return join(req, res)
  if (req.method === 'GET') return exportList(req, res)
  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'Method not allowed' })
}

async function join(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {}
  // Honeypot: people never see this field, simple bots fill it in.
  if (body.website) return res.status(200).json({ ok: true })

  const email = String(body.email ?? '').trim().toLowerCase()
  if (email.length > 254 || !EMAIL.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' })
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
