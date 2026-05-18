#!/bin/bash
# Pugs Sync Agent installer.
# Run this ONCE on Connor's Mac. Creates launchd jobs that run the scanner
# every 5 min and keep the sender alive. After running this, Connor still
# needs to grant Full Disk Access — see the README for the exact clicks.

set -e

AGENT_ROOT="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(which node)"

if [ -z "$NODE_BIN" ]; then
  echo "❌ Node.js not found. Install it first:"
  echo "    brew install node"
  echo "Then re-run this script."
  exit 1
fi

if [ ! -f "$AGENT_ROOT/.env" ]; then
  if [ -f "$AGENT_ROOT/.env.example" ]; then
    echo "❌ No .env file found. Copy .env.example to .env and fill in PUGS_SYNC_SECRET."
    echo "    cp $AGENT_ROOT/.env.example $AGENT_ROOT/.env"
    echo "Then edit it and re-run this script."
    exit 1
  fi
fi

echo "→ Installing npm dependencies..."
cd "$AGENT_ROOT"
npm install --silent

echo "→ Writing launchd plists with paths substituted..."
LAUNCH_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$LAUNCH_DIR"

for kind in scanner sender poller updater; do
  src="$AGENT_ROOT/launchd/com.pugs.syncagent.$kind.plist"
  dst="$LAUNCH_DIR/com.pugs.syncagent.$kind.plist"
  sed -e "s|__NODE_BIN__|$NODE_BIN|g" -e "s|__AGENT_ROOT__|$AGENT_ROOT|g" "$src" > "$dst"

  # Unload first in case we're re-installing
  launchctl unload "$dst" 2>/dev/null || true
  launchctl load "$dst"
  echo "   ✓ loaded com.pugs.syncagent.$kind"
done

cat <<EOF

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✓ Pugs Sync Agent installed.

ONE MORE STEP — Full Disk Access (this Mac needs to read iMessage history):

  1. Open System Settings → Privacy & Security → Full Disk Access
  2. Click + (Add)
  3. Press Cmd+Shift+G and paste:    $NODE_BIN
  4. Click "Open" to add it
  5. Make sure the toggle next to "node" is ON

Then reload the scanner so it can read chat.db with the new permission:

    launchctl unload "$LAUNCH_DIR/com.pugs.syncagent.scanner.plist"
    launchctl load   "$LAUNCH_DIR/com.pugs.syncagent.scanner.plist"

Logs live in:
  $AGENT_ROOT/scanner.log      (inbound chat.db → cloud)
  $AGENT_ROOT/scanner.error.log
  $AGENT_ROOT/sender.log       (localhost:7890 → Messages.app)
  $AGENT_ROOT/sender.error.log
  $AGENT_ROOT/poller.log       (cloud outbound queue → local sender)
  $AGENT_ROOT/poller.error.log
  $AGENT_ROOT/updater.log      (self-updater: git pull + reload services)
  $AGENT_ROOT/updater.error.log

To run a one-off scan right now to verify:
    node "$AGENT_ROOT/src/scan.js"

To uninstall later:
    bash "$AGENT_ROOT/uninstall.sh"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF
