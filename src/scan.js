/**
 * Pugs Sync Agent — Scanner
 *
 * Reads new iMessage rows from ~/Library/Messages/chat.db and POSTs them to
 * the Pugs Sales cloud webhook. Tracks state in ../state.json so we only
 * send messages we haven't sent before.
 *
 * Run by launchd every 5 minutes via com.pugs.syncagent.scanner.plist.
 *
 * Why we copy the DB first: chat.db is locked while Messages.app is open.
 * SQLite supports concurrent readers via WAL, but copying is safer.
 */

const fs   = require('fs')
const os   = require('os')
const path = require('path')
const Database = require('better-sqlite3')
const { syncContacts } = require('./contacts')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const WEBHOOK_URL = process.env.PUGS_SYNC_WEBHOOK_URL
const SECRET      = process.env.PUGS_SYNC_SECRET
const CHAT_DB     = process.env.CHAT_DB_PATH || path.join(os.homedir(), 'Library', 'Messages', 'chat.db')
const STATE_PATH  = path.join(__dirname, '..', 'state.json')
const BATCH_SIZE  = 200
const INITIAL_BACKFILL_DAYS = parseInt(process.env.INITIAL_BACKFILL_DAYS || '90', 10)
const CONTACTS_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000  // once per day

if (!WEBHOOK_URL || !SECRET) {
  console.error('Missing PUGS_SYNC_WEBHOOK_URL or PUGS_SYNC_SECRET in .env')
  process.exit(2)
}

// ───────────────────────────────────────────────────────────────────────
// Helpers

/**
 * Apple Core Data dates are seconds (older macOS) OR nanoseconds (Sierra+)
 * since 2001-01-01 00:00:00 UTC (978307200 unix seconds). Auto-detect.
 */
function appleDateToISO(d) {
  if (d === null || d === undefined) return null
  // Sentinel: nanoseconds since 2001 is > 1e15 in modern macOS
  const ms = d > 1e15 ? (d / 1e6) + 978307200000 : (d * 1000) + 978307200000
  if (!isFinite(ms)) return null
  return new Date(ms).toISOString()
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return { last_rowid: 0 }
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
}

/**
 * Copy chat.db to a temp file we can safely query.
 */
function snapshotDb() {
  const dest = path.join(os.tmpdir(), `pugs-chat-${Date.now()}.db`)
  fs.copyFileSync(CHAT_DB, dest)
  return dest
}

// ───────────────────────────────────────────────────────────────────────
// Main

async function main() {
  if (!fs.existsSync(CHAT_DB)) {
    console.error(`chat.db not found at ${CHAT_DB}`)
    console.error('Have you granted Full Disk Access to the Node binary?')
    process.exit(3)
  }

  const state = loadState()
  let cutoffRowid = state.last_rowid || 0

  // On very first run, derive a cutoff from INITIAL_BACKFILL_DAYS to avoid
  // dumping years of history in one request.
  const snapshotPath = snapshotDb()
  let db
  try {
    db = new Database(snapshotPath, { readonly: true })

    if (cutoffRowid === 0 && INITIAL_BACKFILL_DAYS > 0) {
      const cutoffMs = Date.now() - INITIAL_BACKFILL_DAYS * 86400000
      // Apple nanoseconds since 2001
      const cutoffAppleNs = (cutoffMs - 978307200000) * 1e6
      const row = db.prepare(
        `SELECT ROWID FROM message WHERE date >= ? ORDER BY ROWID ASC LIMIT 1`
      ).get(cutoffAppleNs)
      cutoffRowid = row ? row.ROWID - 1 : 0
      console.log(`First run: starting from ROWID ${cutoffRowid} (${INITIAL_BACKFILL_DAYS}d back)`)
    }

    // 1:1 conversations only. We filter group chats at the source because
    // pugs-sales is Connor's sales CRM — group chats (with friends, family,
    // teammates) are noise that should never reach the platform.
    //
    // Definition of 1:1: the chat this message belongs to has exactly one
    // external participant (chat_handle_join row count = 1). Group chats
    // have 2+ external participants. The user's own identity isn't in the
    // handle table, so 1:1 is genuinely "Connor + one other person."
    //
    // We use a CTE-style subquery so the participant-count check happens
    // once per chat rather than once per row.
    const rows = db.prepare(`
      WITH one_to_one_chats AS (
        SELECT chat_id
        FROM chat_handle_join
        GROUP BY chat_id
        HAVING COUNT(*) = 1
      )
      SELECT
        m.ROWID       AS rowid,
        m.guid        AS guid,
        m.text        AS text,
        m.date        AS date,
        m.is_from_me  AS is_from_me,
        m.service     AS service,
        h.id          AS handle
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN one_to_one_chats o2o ON o2o.chat_id = cmj.chat_id
      WHERE m.ROWID > ?
        AND m.text IS NOT NULL
        AND m.text != ''
      ORDER BY m.ROWID ASC
      LIMIT ?
    `).all(cutoffRowid, BATCH_SIZE)

    if (!rows.length) {
      console.log('No new messages')
      db.close()
      fs.unlinkSync(snapshotPath)
      return
    }

    const payload = rows
      .map(r => ({
        rowid: r.rowid,
        guid: r.guid,
        text: r.text,
        sent_at: appleDateToISO(r.date),
        is_from_me: r.is_from_me ? 1 : 0,
        handle: r.handle,
        service: r.service === 'SMS' ? 'SMS' : 'iMessage',
      }))
      .filter(r => r.sent_at && r.handle)

    console.log(`Posting ${payload.length} messages (ROWIDs ${rows[0].rowid}..${rows[rows.length - 1].rowid})`)

    const resp = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-pugs-sync-secret': SECRET,
      },
      body: JSON.stringify({ messages: payload }),
    })
    const text = await resp.text()
    if (!resp.ok) {
      console.error(`Webhook failed ${resp.status}: ${text.slice(0, 500)}`)
      db.close()
      fs.unlinkSync(snapshotPath)
      process.exit(4)
    }
    console.log(`Webhook OK: ${text.slice(0, 200)}`)

    // Only advance state if the POST succeeded
    const lastRowid = rows[rows.length - 1].rowid
    saveState({ ...state, last_rowid: lastRowid, last_run_at: new Date().toISOString() })
    console.log(`Advanced state to ROWID ${lastRowid}`)
  } finally {
    if (db) db.close()
    try { fs.unlinkSync(snapshotPath) } catch {}
  }

  // Daily contacts enrichment — POST (name, phone) and (name, email) pairs
  // from macOS AddressBook so phone-only drafts in pugs-sales get their
  // real names. Server is enrichment-only: never creates new people rows
  // from this payload.
  const latestState = loadState()
  const lastContactsAt = latestState.last_contacts_at ? new Date(latestState.last_contacts_at).getTime() : 0
  if (Date.now() - lastContactsAt > CONTACTS_SYNC_INTERVAL_MS) {
    const webhookBase = WEBHOOK_URL.replace(/\/api\/.*$/, '')
    try {
      const res = await syncContacts({ webhookBase, secret: SECRET })
      console.log('Contacts sync:', JSON.stringify(res))
      saveState({ ...latestState, last_contacts_at: new Date().toISOString() })
    } catch (e) {
      // Non-fatal — chat.db sync already succeeded, contact sync can retry tomorrow.
      console.error('Contacts sync failed (non-fatal):', e.message || e)
    }
  }
}

main().catch(e => {
  console.error('Scan failed:', e)
  process.exit(1)
})
