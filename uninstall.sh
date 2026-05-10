#!/bin/bash
# Removes the Pugs Sync Agent launchd jobs. Leaves the source code in place
# so it can be re-installed later.

set -e
LAUNCH_DIR="$HOME/Library/LaunchAgents"

for kind in scanner sender; do
  dst="$LAUNCH_DIR/com.pugs.syncagent.$kind.plist"
  if [ -f "$dst" ]; then
    launchctl unload "$dst" 2>/dev/null || true
    rm "$dst"
    echo "✓ removed com.pugs.syncagent.$kind"
  fi
done

echo "Done. Source code at $(cd "$(dirname "$0")" && pwd) is untouched."
echo "You can also revoke Full Disk Access for node in System Settings if you want."
