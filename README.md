# Pugs Sync Agent

A tiny background service that runs on Connor's Mac. Four launchd services:

1. **scanner** — reads new iMessages from `~/Library/Messages/chat.db` every 5 minutes and pushes them to the Pugs Sales cloud app
2. **sender** — listens on `localhost:7890` for outbound message requests from the local poller and sends iMessages via the Messages app
3. **poller** — every 5s, pulls the outbound iMessage queue from pugs-sales and dispatches each due item to the local sender
4. **updater** — every 10 min, `git pull` from this repo and reloads the other services if there's a new version. **This is how Charlie deploys updates to Connor's Mac without manual intervention.**

The cloud app never has direct access to the Mac. Everything flows through this agent.

---

## For Connor (one-time install — ~5 min)

You'll clone this repo once. After that, the updater keeps everything fresh — you won't need to touch it again unless something breaks.

### 1. Install Node.js if you don't have it

Open Terminal and paste:

```bash
# Check if Node is installed
node --version
```

If you see something like `v18.x.x` or higher, you're good. Skip to step 2.

If you see "command not found":

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node
```

### 2. Clone this repo

Pick a stable location (NOT `~/Downloads` — Mac auto-cleans that). `~/pugs-sync-agent` is the recommended path so the auto-updater can find it consistently.

```bash
cd ~
git clone https://github.com/charlie-phinney/pugs-sync-agent.git
cd pugs-sync-agent
```

(You'll be prompted to sign in to GitHub the first time. The macOS git credential helper saves it, so you only do this once.)

### 3. Set up the config file

```bash
cp .env.example .env
```

Then open `.env` in any text editor (TextEdit works) and replace `replace-me-with-a-long-random-string` with the secret Charlie gives you (`PUGS_SYNC_SECRET`). Don't share that secret with anyone. The `.env` file is gitignored — it stays on your Mac and never gets pushed back.

### 4. Run the installer

```bash
bash install.sh
```

You'll see ✓ marks for four services (scanner, sender, poller, updater) and a summary at the end.

### 5. Grant Full Disk Access

Final step — without this, the agent can't read iMessage history.

1. Open **System Settings** → **Privacy & Security** → **Full Disk Access**
2. Click the **+** button
3. Press **Cmd+Shift+G** and paste the path the installer printed (something like `/usr/local/bin/node` or `/opt/homebrew/bin/node`)
4. Click **Open**
5. Make sure the toggle next to "node" is **ON**

Then in Terminal, reload the scanner so it picks up the new permission:

```bash
launchctl unload ~/Library/LaunchAgents/com.pugs.syncagent.scanner.plist
launchctl load   ~/Library/LaunchAgents/com.pugs.syncagent.scanner.plist
```

### 6. Verify it works

```bash
node src/scan.js
```

You should see something like `Posting N messages... Webhook OK`. From now on, this runs automatically every 5 minutes.

You can close Terminal. The agent will keep running in the background and restart automatically when you reboot.

---

## For Charlie (deployment notes)

### Pushing updates to Connor's Mac

**You don't ship files anymore. Just `git push`.** The updater on Connor's Mac runs every 10 minutes and does:

```
git fetch && git merge --ff-only origin/main
```

If something pulled, it runs `npm install` (in case `package.json` changed) and reloads the scanner / sender / poller services. The updater itself reloads on the next launchd tick. Worst case Connor sees new behavior ~10 min after you push.

If `git pull` fails (e.g. Connor manually edited a file and there's a conflict), the updater bails silently — services keep running on the previous version. Check `updater.error.log` on his Mac to debug. To force-reset his copy, ssh in (or have him run):

```bash
cd ~/pugs-sync-agent
git fetch
git reset --hard origin/main
```

### Other notes

- Before handing the repo URL to Connor, **set `PUGS_SYNC_SECRET` in Vercel** (Project → Settings → Environment Variables) to the same value you put in Connor's `.env`. Without a matching secret on both sides, the webhook returns 401.
- The agent uses `INITIAL_BACKFILL_DAYS=90` on first run to import the last 90 days of iMessages. Bump it higher (e.g. 365) if Connor wants more history.
- Logs are in `scanner.log` / `sender.log` / `poller.log` / `updater.log` in the agent folder.
- If macOS upgrades change the chat.db schema, the SQL query in `src/scan.js` may need to be updated. Apple has been stable here for years but it's not contractual.

## Outbound iMessage from the cloud app

**Built (2026-05-18).** The poller (`src/poll.js`) runs as a third launchd service (`com.pugs.syncagent.poller`). Every 5s it GETs `/api/sync/outbound-queue` from pugs-sales (using `PUGS_SYNC_SECRET`), dispatches each due item to the local sender on `127.0.0.1:7890`, then POSTs `/api/sync/outbound-queue/[id]` to mark sent/failed. iMessage-only (no SMS fallback) per the v1 product decision.

The cloud app's user-facing entry point is `POST /api/messages/send` with `{ person_id, body, send_at? }`. The compose UI lives in `/messages/[person_id]` and `/leads/[id]`.

Why polling instead of a reverse-tunnel: the Mac is behind NAT, the polling architecture means no Cloudflare/ngrok config, no public endpoint on the Mac, and graceful handling of the Mac going offline (queue just waits). The Mac only needs outbound HTTPS, which is always free.

Env vars consumed by `src/poll.js` (all in the agent's `.env`):
- `PUGS_SYNC_WEBHOOK_URL` — existing inbound URL; the poller derives the API origin from this
- `PUGS_SYNC_SECRET`      — existing shared secret
- `SENDER_PORT`           — defaults to 7890
- `POLL_INTERVAL_MS`      — defaults to 5000
- `MAX_ATTEMPTS`          — defaults to 5; rows past this are left for manual review

## Uninstall

```bash
bash uninstall.sh
```

Removes the launchd jobs. Source code stays in place. To fully remove, just delete the folder.
