/**
 * Pugs Sync Agent — Contacts exporter (called from scan.js once/day)
 *
 * Reads Connor's Mac Contacts (AddressBook SQLite) and POSTs (name, phone)
 * and (name, email) pairs to pugs-sales so phone-only drafts in the people
 * table get named.
 *
 * Enrichment-only on the server side: the pugs-sales endpoint MUST NOT
 * create new people rows from contacts — only update existing ones. If
 * Connor saves someone in Contacts but has no iMessage / email history
 * with them, they don't become a CRM contact. Keeps the platform tight
 * to Connor's actual conversations.
 *
 * Address book schema (macOS 13+):
 *   ZABCDRECORD          — one row per contact; ZFIRSTNAME, ZLASTNAME, ZORGANIZATION
 *   ZABCDPHONENUMBER     — ZOWNER -> ZABCDRECORD.Z_PK; ZFULLNUMBER
 *   ZABCDEMAILADDRESS    — ZOWNER -> ZABCDRECORD.Z_PK; ZADDRESS
 *
 * macOS keeps multiple "sources" — iCloud, local, exchange — each with its
 * own AddressBook-v22.abcddb. We enumerate all of them and union the rows.
 */

const fs   = require('fs')
const os   = require('os')
const path = require('path')
const Database = require('better-sqlite3')

const SOURCES_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'AddressBook', 'Sources')

function findAddressBooks() {
  if (!fs.existsSync(SOURCES_DIR)) return []
  const dbs = []
  for (const sourceUuid of fs.readdirSync(SOURCES_DIR)) {
    const candidate = path.join(SOURCES_DIR, sourceUuid, 'AddressBook-v22.abcddb')
    if (fs.existsSync(candidate)) dbs.push(candidate)
  }
  return dbs
}

function snapshot(srcPath) {
  const dest = path.join(os.tmpdir(), `pugs-ab-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  fs.copyFileSync(srcPath, dest)
  return dest
}

function buildName(first, last, org) {
  const fn = (first || '').trim()
  const ln = (last  || '').trim()
  const combined = [fn, ln].filter(Boolean).join(' ').trim()
  if (combined) return combined
  return (org || '').trim() || ''
}

function extractFromDb(dbPath) {
  const out = { phones: [], emails: [] }
  let db
  try {
    db = new Database(dbPath, { readonly: true })

    const phoneRows = db.prepare(`
      SELECT
        r.ZFIRSTNAME    AS first,
        r.ZLASTNAME     AS last,
        r.ZORGANIZATION AS org,
        p.ZFULLNUMBER   AS phone
      FROM ZABCDRECORD r
      JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
      WHERE p.ZFULLNUMBER IS NOT NULL
    `).all()
    for (const row of phoneRows) {
      const name = buildName(row.first, row.last, row.org)
      if (!name) continue
      out.phones.push({ name, phone: row.phone })
    }

    const emailRows = db.prepare(`
      SELECT
        r.ZFIRSTNAME    AS first,
        r.ZLASTNAME     AS last,
        r.ZORGANIZATION AS org,
        e.ZADDRESS      AS email
      FROM ZABCDRECORD r
      JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK
      WHERE e.ZADDRESS IS NOT NULL
    `).all()
    for (const row of emailRows) {
      const name = buildName(row.first, row.last, row.org)
      if (!name) continue
      out.emails.push({ name, email: row.email })
    }
  } finally {
    if (db) db.close()
  }
  return out
}

/**
 * Sync Mac contacts to pugs-sales. Returns counts. Throws on hard errors.
 *
 * @param {object} opts
 * @param {string} opts.webhookBase - https://pugs-sales.vercel.app (no path)
 * @param {string} opts.secret      - PUGS_SYNC_SECRET
 */
async function syncContacts({ webhookBase, secret }) {
  const books = findAddressBooks()
  if (!books.length) {
    return { ok: true, skipped: 'no_address_books_found' }
  }

  const phoneMap = new Map()
  const emailMap = new Map()
  const snapshots = []
  try {
    for (const src of books) {
      const snap = snapshot(src)
      snapshots.push(snap)
      const { phones, emails } = extractFromDb(snap)

      for (const { name, phone } of phones) {
        const digits = (phone || '').replace(/\D/g, '').slice(-10)
        if (digits.length !== 10) continue
        if (!phoneMap.has(digits)) phoneMap.set(digits, { name, phone })
      }
      for (const { name, email } of emails) {
        const lower = (email || '').trim().toLowerCase()
        if (!lower.includes('@')) continue
        if (!emailMap.has(lower)) emailMap.set(lower, { name, email: lower })
      }
    }

    const payload = {
      phones: [...phoneMap.values()],
      emails: [...emailMap.values()],
    }

    const resp = await fetch(`${webhookBase}/api/sync/contacts`, {
      method:  'POST',
      headers: {
        'Content-Type':       'application/json',
        'x-pugs-sync-secret': secret,
      },
      body: JSON.stringify(payload),
    })
    const text = await resp.text()
    if (!resp.ok) {
      throw new Error(`contacts webhook failed ${resp.status}: ${text.slice(0, 500)}`)
    }
    return {
      ok: true,
      sent: { phones: payload.phones.length, emails: payload.emails.length },
      server: (() => { try { return JSON.parse(text) } catch { return text.slice(0, 200) } })(),
    }
  } finally {
    for (const s of snapshots) {
      try { fs.unlinkSync(s) } catch {}
    }
  }
}

module.exports = { syncContacts }
