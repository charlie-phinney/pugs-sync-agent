# Claude: install the Pugs Sync Agent for Connor

This file is for you (the Claude assistant running in Cowork on Connor's Mac), not for Connor directly. Walk him through the install step-by-step, asking him to confirm each step before moving on. Be friendly and clear — assume he is not technical.

## Who Connor is, what this is, why it matters

Connor Flannery is the founder of Pugs Media (a video production company). His developer Charlie Phinney built a sales CRM at **https://pugs-sales.vercel.app** that already ingests Connor's Gmail, calendar, and Fathom call transcripts. This zip you just received is a tiny local agent that adds **iMessage** to the data sources — so when a client texts Connor, that message shows up in his Pugs Sales pipeline alongside emails.

The agent has two pieces:
- **Scanner** — runs every 5 min via `launchd`. Reads new rows from `~/Library/Messages/chat.db` (Apple's local iMessage database) and POSTs them to `https://pugs-sales.vercel.app/api/import/imessage`.
- **Sender** — a localhost-only HTTP listener on port 7890 that accepts authenticated POSTs from the cloud app and uses AppleScript to send iMessages from Connor's Mac. (Not used yet for v1 — but installed so it's ready when Charlie wires outbound sending.)

Both pieces are already coded. Your job is to get them installed and running, and walk Connor through granting Full Disk Access (the one permission macOS requires to read `chat.db`).

The `.env` file inside the zip is **already filled in** with the correct `PUGS_SYNC_SECRET` (shared secret between the agent and the cloud webhook). Do not ask Connor for it. Do not paste its contents into chat — it's a secret token.

---

## Step-by-step

### Step 1 — clone the repo

Clone into the user's HOME directory (NOT `~/Documents/` — that's TCC-protected from launchd and silently breaks the auto-updater).

```bash
cd ~
git clone https://github.com/charlie-phinney/pugs-sync-agent.git
cd pugs-sync-agent
```

If the folder already exists from a prior install attempt, either remove it first (`rm -rf ~/pugs-sync-agent`) or use the existing one (`cd ~/pugs-sync-agent && git pull --ff-only`).

The `.env` file is gitignored. After clone, copy from the example (`cp .env.example .env`) and fill in `PUGS_SYNC_SECRET` — Charlie shares it out-of-band.

### Step 2 — verify Node.js is installed

```bash
node --version
```

If you see `v18.x.x` or higher, you're good. Move to step 3.

If "command not found", Connor needs Homebrew + Node first. Tell him:

> "Your Mac doesn't have Node.js yet. I'll install it for you — this takes about 5 minutes. Mind if I proceed?"

Then:

```bash
# Install Homebrew if not present
which brew || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
# Install Node
brew install node
```

Homebrew sometimes prints "Next steps:" with PATH instructions. Read what it says and relay relevant parts to Connor.

### Step 3 — run the installer

```bash
cd ~/pugs-sync-agent
bash install.sh
```

The script will:
1. `npm install` the dependencies (better-sqlite3, express, dotenv)
2. Substitute paths into the launchd plist files
3. Copy the plists into `~/Library/LaunchAgents/`
4. Load them with `launchctl load`
5. Print a big multi-line summary at the end

**Important: find the exact Node binary path** in the installer's output. It will look like one of:
- `/opt/homebrew/bin/node` (Apple Silicon Mac with Homebrew)
- `/usr/local/bin/node` (Intel Mac with Homebrew)
- `/usr/bin/node` (rare)

Capture this path. Connor needs it for the next step.

### Step 4 — Full Disk Access

This is the only step Connor has to do himself in the GUI. Walk him through it:

> "Last step — macOS needs me to have Full Disk Access permission so I can read your iMessage history. Here's what to click:
>
> 1. Open **System Settings** (the gear icon in your dock)
> 2. In the left sidebar, click **Privacy & Security**
> 3. Scroll down and click **Full Disk Access**
> 4. Click the **+** button at the bottom of the list
> 5. A file picker opens. Press **Cmd+Shift+G** to open a path field
> 6. Paste this exact path and press Enter: `[INSERT THE NODE PATH FROM STEP 3]`
> 7. Select the `node` file and click **Open**
> 8. Make sure the toggle next to "node" is **ON** (blue)
> 9. Let me know when that's done."

Wait for Connor to confirm he completed it. Don't move on until he says yes.

### Step 5 — reload and verify

After Full Disk Access is granted, the launchd job needs to be reloaded so it inherits the new permission.

```bash
launchctl unload ~/Library/LaunchAgents/com.pugs.syncagent.scanner.plist
launchctl load   ~/Library/LaunchAgents/com.pugs.syncagent.scanner.plist

# Then run a one-off test scan to verify
cd ~/pugs-sync-agent
node src/scan.js
```

**Success looks like:**
```
First run: starting from ROWID 12345 (90d back)
Posting 47 messages (ROWIDs 12346..12392)
Webhook OK: {"ok":true,"inserted":47,...}
Advanced state to ROWID 12392
```

**If you see:**
- `chat.db not found at /Users/connor/Library/Messages/chat.db` — Full Disk Access wasn't granted to the right binary. Run `which node` to verify the path matches what Connor added to System Settings.
- `Webhook failed 401: Unauthorized` — secret mismatch. Tell Connor: "There's a config mismatch on the server side. Text Charlie at contact@pugs.media to verify the PUGS_SYNC_SECRET matches."
- `Webhook failed 500: ...` — something on the cloud side. Capture the error and tell Connor to forward to Charlie.

### Step 6 — confirm and wrap up

Once the scan posts successfully, tell Connor:

> "Done! Your iMessages now flow into Pugs Sales automatically every 5 minutes. It runs in the background — you can close Terminal and the rest of this session. Nothing else for you to do. If you ever want to check on it, logs are at `~/pugs-sync-agent/scanner.log`."

---

## Boundaries — what NOT to do

- **Never print the contents of `.env`** in chat. It contains a secret authentication token.
- **Don't modify the source code** in `src/` unless Connor explicitly asks. Charlie owns the code; changes need to flow through him.
- **Don't uninstall or remove launchd jobs** without confirming with Connor that he wants to.
- **Don't promise iMessage sending works yet.** The outbound sender is installed but not yet wired up from the cloud side — Charlie will turn that on later.
- **Escalate to Charlie** (contact@pugs.media) for anything you can't resolve in 2-3 attempts. Don't have Connor debug deep error messages.

## Quick reference

- Agent location: `~/pugs-sync-agent/`
- Logs: `~/pugs-sync-agent/scanner.log` and `sender.log`
- Cloud dashboard: https://pugs-sales.vercel.app
- Uninstall: `bash ~/pugs-sync-agent/uninstall.sh`
- Charlie's contact: contact@pugs.media
