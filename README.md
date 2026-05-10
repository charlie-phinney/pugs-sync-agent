# Pugs Sync Agent

A tiny background service that runs on Connor's Mac. It:

1. Reads new **iMessages** from `~/Library/Messages/chat.db` every 5 minutes and pushes them to the Pugs Sales cloud app
2. Listens on `localhost:7890` for outbound message requests from the cloud app and sends iMessages via the Messages app

The cloud app never has direct access to the Mac. Everything flows through this agent.

---

## For Connor (install steps — ~5 min, one time)

You'll get this folder from Charlie. Inside the folder, run:

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

### 2. Set up the config file

Inside the `pugs-sync-agent` folder, copy the example config:

```bash
cd ~/Downloads/pugs-sync-agent   # or wherever Charlie put it
cp .env.example .env
```

Then open `.env` in any text editor (TextEdit works) and replace `replace-me-with-a-long-random-string` with the secret Charlie gives you. Don't share that secret with anyone.

### 3. Run the installer

```bash
bash install.sh
```

You'll see ✓ marks and a summary at the end.

### 4. Grant Full Disk Access

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

### 5. Verify it works

```bash
node src/scan.js
```

You should see something like `Posting N messages... Webhook OK`. From now on, this runs automatically every 5 minutes.

You can close Terminal. The agent will keep running in the background and restart automatically when you reboot.

---

## For Charlie (deployment notes)

- Before handing the folder to Connor, **set `PUGS_SYNC_SECRET` in Vercel** (Project → Settings → Environment Variables) to the same value you put in Connor's `.env`. Without a matching secret on both sides, the webhook returns 401.
- The agent uses `INITIAL_BACKFILL_DAYS=90` on first run to import the last 90 days of iMessages. Bump it higher (e.g. 365) if Connor wants more history.
- Logs are in `scanner.log` / `sender.log` in the agent folder. If something goes sideways, check `scanner.error.log` first.
- If macOS upgrades change the chat.db schema, the SQL query in `src/scan.js` may need to be updated. Apple has been stable here for years but it's not contractual.

## Outbound iMessage from the cloud app

To send an iMessage from a Vercel cron / API route on Connor's behalf, the cloud app would need a path to reach Connor's Mac (which is behind NAT). Options:

- **Reverse-tunnel** (recommended): run `cloudflared tunnel` on Connor's Mac, exposing port 7890 as a private hostname. The cloud app POSTs to that hostname with the shared secret.
- **Polling**: cloud app stores outbound queue in Supabase; the agent polls every 30s, pulls pending sends, executes via AppleScript, marks done.

For v1, polling is the simpler path and doesn't require Cloudflare setup. We can build that next.

## Uninstall

```bash
bash uninstall.sh
```

Removes the launchd jobs. Source code stays in place. To fully remove, just delete the folder.
