#!/bin/bash
# Pugs Sync Agent — self-updater.
#
# Runs on Connor's Mac every N minutes via launchd. Pulls latest code
# from the remote, reinstalls deps if needed, and reloads the launchd
# services so the new code is live. No human in the loop.
#
# Safe by design:
#   - `git pull --ff-only` — won't auto-merge over local edits, just
#     bails. If Connor manually edits files, updates pause until those
#     are resolved (intentional).
#   - If `npm install` fails, services are NOT reloaded; the previous
#     version stays running.
#   - .env / state.json / *.log are gitignored; an update never touches
#     Connor's local config or runtime state.
#
# Run by launchd: com.pugs.syncagent.updater.plist (every 600s).
# Logs in updater.log / updater.error.log next to this script.

set -u  # NOT -e — we want to gracefully handle individual step failures

AGENT_ROOT="$(cd "$(dirname "$0")" && pwd)"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
LOG_PREFIX="$(date -u +%Y-%m-%dT%H:%M:%SZ) update.sh:"

cd "$AGENT_ROOT" || { echo "$LOG_PREFIX cannot cd $AGENT_ROOT"; exit 1; }

# Capture the current HEAD before fetch so we can detect a no-op.
OLD_HEAD=$(git rev-parse HEAD 2>/dev/null || echo unknown)

if ! git fetch --quiet 2>&1; then
  echo "$LOG_PREFIX git fetch failed (network? auth?), bailing"
  exit 0
fi

if ! git merge --ff-only origin/main >/dev/null 2>&1; then
  # FF-only fails when there are local commits/edits OR when origin diverged.
  # We don't auto-resolve — Connor or Charlie has to sort it.
  echo "$LOG_PREFIX fast-forward merge failed (local changes or diverged), bailing"
  exit 0
fi

NEW_HEAD=$(git rev-parse HEAD)
if [ "$OLD_HEAD" = "$NEW_HEAD" ]; then
  # No new commits — common case, exit silently.
  exit 0
fi

echo "$LOG_PREFIX pulled $OLD_HEAD..$NEW_HEAD"

# Reinstall deps in case package.json changed. --no-audit --no-fund for speed
# and to avoid noisy logs.
if ! npm install --silent --no-audit --no-fund 2>&1; then
  echo "$LOG_PREFIX npm install failed — NOT reloading services, prior version still running"
  exit 1
fi

# Reload the three runtime services. Updater itself doesn't reload itself
# (launchd will pick up plist changes on the next StartInterval tick).
for kind in scanner sender poller; do
  dst="$LAUNCH_DIR/com.pugs.syncagent.$kind.plist"
  if [ -f "$dst" ]; then
    launchctl unload "$dst" 2>/dev/null
    if ! launchctl load "$dst" 2>&1; then
      echo "$LOG_PREFIX launchctl load $kind failed"
    fi
  fi
done

echo "$LOG_PREFIX services reloaded on $NEW_HEAD"
