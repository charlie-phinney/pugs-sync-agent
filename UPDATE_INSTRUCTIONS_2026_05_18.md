# Claude: replace Connor's existing Pugs Sync Agent install with the new git-backed version

This file is for you (the Claude assistant in Cowork on Connor's Mac), not for Connor directly. You helped him install the original Pugs Sync Agent earlier — this is an update. Walk him through it step-by-step, confirm each step before moving on, friendly tone, assume he's not technical.

## What changed (context for you, you can summarize for Connor as needed)

Last time you installed two launchd services: **scanner** (reads `chat.db` → pushes inbound iMessages to pugs-sales) and **sender** (localhost HTTP listener that uses AppleScript to send iMessages, but wasn't wired up from the cloud yet).

This update adds two more services:

- **poller** — every 5 seconds, pulls Connor's outbound iMessage queue from pugs-sales (`/api/sync/outbound-queue`) and dispatches each due item to the existing local sender. This is what makes the "Send" button on `https://pugs-sales.vercel.app/messages/[person_id]` and `/leads/[id]` actually deliver iMessages. **iMessage-only** — no SMS fallback per the product decision.
- **updater** — every 10 minutes, runs `git pull --ff-only origin/main` and reloads the other three services if anything changed. This is the key change: Connor never has to manually update the agent again. Charlie pushes to `https://github.com/charlie-phinney/pugs-sync-agent` and within 10 min Connor's Mac has the new code.

Also, the agent is now a private GitHub repo at `https://github.com/charlie-phinney/pugs-sync-agent`. Connor's existing install was zip-shipped to him; this update replaces it with a `git clone` so future updates flow automatically.

## Migration plan

Keep the agent at its current path (`~/Documents/pugs-sync-agent/`). Back up the old dir, clone fresh into the same location, copy the existing `.env` and `state.json` over (preserves the `PUGS_SYNC_SECRET` and the last-scanned rowid so the scanner doesn't re-backfill 90 days of history).

**Never print the contents of `.env`** at any point. The `PUGS_SYNC_SECRET` inside it is sensitive — copy the file as a whole, don't open it and read out the value.

---

## Step-by-step

### Step 1 — locate the existing agent

```bash
ls -la ~/Documents/pugs-sync-agent/ 2>/dev/null && echo "FOUND at ~/Documents/pugs-sync-agent"
```

If you see a directory listing including `.env`, `install.sh`, `src/`, etc., good — that's the existing install.

If NOT found there, search common locations:

```bash
for d in ~/pugs-sync-agent ~/Downloads/pugs-sync-agent ~/Desktop/pugs-sync-agent; do
  if [ -d "$d" ]; then echo "FOUND at $d"; ls -la "$d" | head -5; fi
done
```

Stop and ask Connor for the path if you can't find it. Once found, set `OLD_DIR` to that path mentally — you'll need it for subsequent steps. (I'll write `~/Documents/pugs-sync-agent` below assuming that's the path; adjust if different.)

### Step 2 — verify the existing install is still functional

Optional sanity check before we tear it down:

```bash
launchctl list | grep pugs.syncagent
```

You should see two entries (`com.pugs.syncagent.scanner` and `com.pugs.syncagent.sender`). If only one, or none, that's fine — we're replacing them anyway.

Also confirm `.env` exists and is non-empty (don't cat it, just verify size):

```bash
wc -l ~/Documents/pugs-sync-agent/.env
```

Should report a few lines. If it's empty or missing, stop and tell Connor — we can't preserve the secret if there's nothing to copy.

### Step 3 — unload the old launchd services

```bash
cd ~/Documents/pugs-sync-agent
bash uninstall.sh
```

This removes the launchd jobs but leaves the source code on disk. Confirm both services are gone:

```bash
launchctl list | grep pugs.syncagent
```

Should output nothing now.

### Step 4 — back up the old directory

```bash
mv ~/Documents/pugs-sync-agent ~/Documents/pugs-sync-agent.backup-2026-05-18
```

Reassure Connor: "I'm keeping a backup so we can restore if anything goes wrong. We'll delete it at the end after we confirm everything works."

### Step 5 — clone the new repo

```bash
cd ~/Documents
git clone https://github.com/charlie-phinney/pugs-sync-agent.git
```

If git prompts for GitHub credentials: Connor's macOS keychain may already have them from previous git use. If not, he'll need to sign in. The repo is private — only people Charlie has explicitly invited can clone. If access is denied, stop and tell Connor: "I need Charlie to invite your GitHub account as a collaborator on the repo. Text him your GitHub username."

### Step 6 — restore the .env and state.json from the backup

```bash
cp ~/Documents/pugs-sync-agent.backup-2026-05-18/.env       ~/Documents/pugs-sync-agent/.env
cp ~/Documents/pugs-sync-agent.backup-2026-05-18/state.json ~/Documents/pugs-sync-agent/state.json 2>/dev/null || true
```

`.env` carries the `PUGS_SYNC_SECRET`. `state.json` carries `last_rowid` so the scanner picks up where it left off instead of re-backfilling 90 days of messages. The `2>/dev/null || true` handles the rare case where state.json didn't exist (e.g. fresh install).

### Step 7 — install the new 4-service stack

```bash
cd ~/Documents/pugs-sync-agent
bash install.sh
```

The script runs `npm install` (this pulls in `better-sqlite3`, `dotenv`, `express` — same deps as before, no new ones), substitutes the agent path into 4 launchd plists, copies them to `~/Library/LaunchAgents/`, and loads them.

Verify all four services are running:

```bash
launchctl list | grep pugs.syncagent
```

You should see exactly four lines, one each for `scanner`, `sender`, `poller`, `updater`.

### Step 8 — confirm Full Disk Access still works for the scanner

The old install required Full Disk Access on the `node` binary so the scanner could read `~/Library/Messages/chat.db`. Since we're using the same `node` binary (the OS-wide install you set up last time), that permission should still be in place. Verify:

```bash
node ~/Documents/pugs-sync-agent/src/scan.js
```

**Success** looks like `Posting N messages... Webhook OK` or `No new messages` (if his scanner is already up to date).

If you see `chat.db not found` or similar permission error, Full Disk Access was revoked or didn't carry over. Walk Connor through re-granting it (same dance as last time): System Settings → Privacy & Security → Full Disk Access → make sure the toggle for `node` is ON. The `node` path is `$(which node)`.

### Step 9 — confirm the poller and updater are running

Check the new log files (they'll have been created the moment the services loaded):

```bash
tail -n 20 ~/Documents/pugs-sync-agent/poller.log
tail -n 20 ~/Documents/pugs-sync-agent/updater.log
```

`poller.log` should be quiet (no messages in the queue yet) — that's fine. If you see `pugs-sync poller starting · base=https://pugs-sales.vercel.app · interval=5000ms`, it's working.

`updater.log` should show a line like `update.sh: pulled <hash>..<hash>` or be empty if the update tick hasn't fired yet (runs every 10 min and on load).

### Step 10 — confirm with Connor and clean up

Tell Connor:

> "All four services are running. The big change: from now on, when Charlie pushes updates, your Mac picks them up automatically within 10 minutes. You don't need to do anything. The 'Send' button in `pugs-sales.vercel.app/messages` now actually sends iMessages through your Mac. If you ever want to confirm everything's still healthy, the dashboard at `https://pugs-sales.vercel.app/health` shows live status."

If everything looks good, you can offer to remove the backup directory:

```bash
# Only after confirming things work — wait a day or two if you're cautious
rm -rf ~/Documents/pugs-sync-agent.backup-2026-05-18
```

I'd suggest leaving it for a few days as a safety net, then removing.

---

## Troubleshooting cheat sheet

- **`git clone` asks for auth and Connor doesn't have a GitHub account / isn't a collaborator** → escalate to Charlie. He needs to add Connor's GitHub username under repo Settings → Collaborators.
- **`launchctl list | grep pugs.syncagent` shows fewer than 4 services after install.sh** → check `install.sh` output for which kind failed. Most common cause: the plist file is missing or has bad XML. Run `cat ~/Library/LaunchAgents/com.pugs.syncagent.<kind>.plist` to inspect.
- **`poller.log` shows `queue GET 401: Unauthorized`** → `PUGS_SYNC_SECRET` mismatch between Connor's `.env` and Vercel. Don't expose the value — just tell Connor "there's a config mismatch, text Charlie".
- **`updater.log` shows `git fetch failed`** → either the repo URL is wrong (verify `git remote -v` from the agent dir shows `https://github.com/charlie-phinney/pugs-sync-agent.git`) or Connor's keychain needs refreshed GitHub auth. Have him run `gh auth refresh` or sign in to git via the CLI.
- **Anything else** → escalate to Charlie at contact@pugs.media with the relevant log snippet (DON'T paste `.env` contents).

## Boundaries

- **Never print `.env`** at any point. Don't `cat` it, don't paste its contents into chat.
- **Don't run `git reset --hard`** on the agent repo unless explicitly authorized by Charlie. The auto-updater handles version management; manual reset can cause sync issues.
- **Don't add new launchd jobs** beyond the four defined here. If Charlie wants to add something later, he'll commit it to the repo and the updater will install it on the next pull.
- **Escalate to Charlie** (contact@pugs.media) for anything you can't resolve in 2-3 attempts. Don't have Connor debug deep errors.

## Quick reference (after this lands)

- Agent location: `~/Documents/pugs-sync-agent/`
- Repo:         https://github.com/charlie-phinney/pugs-sync-agent
- Pugs Sales:   https://pugs-sales.vercel.app
- Health page:  https://pugs-sales.vercel.app/health (when signed in)
- Logs:         `scanner.log`, `sender.log`, `poller.log`, `updater.log` in the agent dir
- Uninstall:    `bash ~/Documents/pugs-sync-agent/uninstall.sh`
- Charlie:      contact@pugs.media
