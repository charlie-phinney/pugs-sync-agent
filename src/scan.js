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
// PUGS_SCANNER_ID identifies which physical machine is sending. Must match
// one of the values in pugs-sales' ALLOWED_SCANNER_IDS env (comma-separated)
// once that allowlist is active. Empty string = unidentified scanner —
// pugs-sales' scanner-guard will 403 if the allowlist is on.
const SCANNER_ID  = process.env.PUGS_SCANNER_ID || ''
const CHAT_DB     = process.env.CHAT_DB_PATH || path.join(os.homedir(), 'Library', 'Messages', 'chat.db')
const STATE_PATH  = path.join(__dirname, '..', 'state.json')
const BATCH_SIZE  = 200
const INITIAL_BACKFILL_DAYS = parseInt(process.env.INITIAL_BACKFILL_DAYS || '90', 10)
const CONTACTS_SYNC_INTERVAL_MS = 60 * 60 * 1000  // once per hour (was 24h —
// dropped while we get visibility into whether the sync is firing at all)

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
  let newDraftsThisRun = 0  // populated from /api/import/imessage response, used to trigger contacts sync

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
    //
    // chat-context (added 2026-05-21, migration 049): we also pull the
    // chat row's GUID, display_name, and the concatenated participant
    // handles so pugs-sales can give every message a stable thread
    // identity. For 1:1 we hard-code chat_kind='direct' in JS — when we
    // eventually widen to group chats, the CTE goes away and chat_kind
    // is derived from participant count.
    const rows = db.prepare(`
      WITH one_to_one_chats AS (
        SELECT chat_id
        FROM chat_handle_join
        GROUP BY chat_id
        HAVING COUNT(*) = 1
      )
      SELECT
        m.ROWID         AS rowid,
        m.guid          AS guid,
        m.text          AS text,
        m.date          AS date,
        m.is_from_me    AS is_from_me,
        m.service       AS service,
        h.id            AS handle,
        c.guid          AS chat_guid,
        c.display_name  AS chat_display_name,
        (
          SELECT group_concat(h2.id, char(31))
          FROM chat_handle_join chj2
          JOIN handle h2 ON h2.ROWID = chj2.handle_id
          WHERE chj2.chat_id = cmj.chat_id
        )               AS chat_participants_concat
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN one_to_one_chats o2o ON o2o.chat_id = cmj.chat_id
      JOIN chat c ON c.ROWID = cmj.chat_id
      WHERE m.ROWID > ?
        AND m.text IS NOT NULL
        AND m.text != ''
      ORDER BY m.ROWID ASC
      LIMIT ?
    `).all(cutoffRowid, BATCH_SIZE)

    if (!rows.length) {
      // Post empty payload so the server records a heartbeat — otherwise
      // a silent scanner is indistinguishable from a crashed scanner.
      console.log('No new messages — sending heartbeat')
      try {
        await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-pugs-sync-secret': SECRET,
            'x-pugs-scanner-id': SCANNER_ID,
          },
          body: JSON.stringify({ messages: [] }),
        })
      } catch (e) {
        console.error(`Heartbeat failed: ${e.message}`)
      }
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
        chat_id: r.chat_guid || null,
        // Filter is 1:1-only, so kind is always 'direct'. When we widen,
        // derive from participant count instead.
        chat_kind: 'direct',
        chat_name: r.chat_display_name || null,
        // group_concat uses ASCII Unit Separator (0x1F) — won't collide
        // with phone/email content. Returns null when chat has no handles.
        chat_participants: r.chat_participants_concat
          ? r.chat_participants_concat.split('').filter(Boolean)
          : null,
      }))
      .filter(r => r.sent_at && r.handle)

    console.log(`Posting ${payload.length} messages (ROWIDs ${rows[0].rowid}..${rows[rows.length - 1].rowid})`)

    const resp = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-pugs-sync-secret': SECRET,
        'x-pugs-scanner-id': SCANNER_ID,
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

    // Parse new_drafts_created from response so we can immediately enrich
    // names below. If parsing fails, fall back to hourly cadence — the
    // server-side response shape might evolve.
    try { newDraftsThisRun = (JSON.parse(text) || {}).new_drafts_created || 0 } catch {}

    // Only advance state if the POST succeeded
    const lastRowid = rows[rows.length - 1].rowid
    saveState({ ...state, last_rowid: lastRowid, last_run_at: new Date().toISOString() })
    console.log(`Advanced state to ROWID ${lastRowid}`)
  } finally {
    if (db) db.close()
    try { fs.unlinkSync(snapshotPath) } catch {}
  }

  // Contacts enrichment — POST (name, phone) and (name, email) pairs from
  // macOS AddressBook so nameless drafts in pugs-sales get their real names.
  // Server is enrichment-only: never creates new people rows from this payload.
  //
  // Trigger logic:
  //   - If this scan created any new drafts on the server, sync NOW (subject
  //     to a 60s minimum throttle to avoid burst hammering on backlog catchup).
  //   - Otherwise fall back to the hourly cadence (handles renames in Connor's
  //     address book even when no new leads arrive).
  const latestState = loadState()
  const lastContactsAt = latestState.last_contacts_at ? new Date(latestState.last_contacts_at).getTime() : 0
  const sinceLastSync = Date.now() - lastContactsAt
  const NEW_DRAFT_MIN_THROTTLE_MS = 60 * 1000  // 60s
  const shouldRunForNewDrafts = newDraftsThisRun > 0 && sinceLastSync > NEW_DRAFT_MIN_THROTTLE_MS
  const shouldRunForFallback = sinceLastSync > CONTACTS_SYNC_INTERVAL_MS
  if (shouldRunForNewDrafts || shouldRunForFallback) {
    const trigger = shouldRunForNewDrafts ? `${newDraftsThisRun} new draft(s)` : 'hourly fallback'
    console.log(`Contacts sync trigger: ${trigger}`)
    const webhookBase = WEBHOOK_URL.replace(/\/api\/.*$/, '')
    try {
      const res = await syncContacts({ webhookBase, secret: SECRET, scannerId: SCANNER_ID })
      console.log('Contacts sync:', JSON.stringify(res))
      // Only advance the cadence on actual success — keep retrying if the
      // post failed or the AddressBook wasn't readable.
      if (res?.ok) {
        saveState({ ...latestState, last_contacts_at: new Date().toISOString() })
      }
    } catch (e) {
      console.error('Contacts sync failed (non-fatal):', e.message || e)
    }
  }
}

main().catch(e => {
  console.error('Scan failed:', e)
  process.exit(1)
})
