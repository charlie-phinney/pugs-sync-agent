/**
 * Pugs Sync Agent — Outbound Sender
 *
 * Tiny HTTP listener on 127.0.0.1:SENDER_PORT. The cloud app POSTs send
 * requests here; we then trigger AppleScript to send via Messages.app.
 *
 * Auth: x-pugs-sync-secret header must match .env value. Listens on
 * localhost only — never expose this externally.
 *
 * To send a message:
 *   POST /send
 *   { "to": "+14155550100" | "user@example.com", "text": "Hello", "service": "iMessage" | "SMS" }
 */

const path = require('path')
const { execFile } = require('child_process')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const express = require('express')

const PORT   = parseInt(process.env.SENDER_PORT || '7890', 10)
const SECRET = process.env.PUGS_SYNC_SECRET

if (!SECRET) {
  console.error('Missing PUGS_SYNC_SECRET in .env')
  process.exit(2)
}

const app = express()
app.use(express.json({ limit: '32kb' }))

// Require localhost connection AND matching secret. Defense in depth.
app.use((req, res, next) => {
  const remote = req.socket.remoteAddress
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
    return res.status(403).json({ error: 'localhost only' })
  }
  const got = req.header('x-pugs-sync-secret')
  if (!got || got !== SECRET) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  next()
})

app.get('/health', (_req, res) => res.json({ ok: true, port: PORT }))

app.post('/send', (req, res) => {
  const { to, text, service } = req.body || {}
  if (!to || !text) return res.status(400).json({ error: 'to and text required' })
  if (typeof to !== 'string' || typeof text !== 'string') {
    return res.status(400).json({ error: 'to/text must be strings' })
  }
  // Sanitize for AppleScript string interpolation
  const safeTo   = to.replace(/[\\"]/g, '\\$&')
  const safeText = text.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n')
  const svc = service === 'SMS' ? 'SMS' : 'iMessage'

  // AppleScript: target the iMessage or SMS service, get the buddy, send.
  const script = `
    tell application "Messages"
      set targetService to 1st service whose service type = ${svc}
      set targetBuddy to buddy "${safeTo}" of targetService
      send "${safeText}" to targetBuddy
    end tell
  `

  execFile('osascript', ['-e', script], { timeout: 15000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('osascript failed:', stderr || err.message)
      return res.status(500).json({ error: 'send failed', detail: (stderr || err.message).slice(0, 400) })
    }
    res.json({ ok: true, to, service: svc })
  })
})

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Pugs sender listening on http://127.0.0.1:${PORT}`)
})
