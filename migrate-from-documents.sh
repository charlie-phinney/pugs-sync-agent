#!/bin/bash
# One-shot migration: move the agent OUT of ~/Documents/ (TCC-protected from
# launchd, which silently breaks the auto-updater) into ~/pugs-sync-agent/.
#
# Run ONCE on Connor's Mac:
#   cd ~/Documents/pugs-sync-agent && bash migrate-from-documents.sh
#
# OR, if Connor's local copy is stale and doesn't have this script yet,
# pull it fresh from GitHub:
#   curl -fsSL https://raw.githubusercontent.com/charlie-phinney/pugs-sync-agent/main/migrate-from-documents.sh \
#     | bash
#
# What it does:
#   1. Stops all four launchd services (scanner / sender / poller / updater).
#   2. Moves ~/Documents/pugs-sync-agent → ~/pugs-sync-agent (preserves
#      .env, state.json, logs).
#   3. Re-runs install.sh from the new location, which rewrites every
#      launchd plist with the new __AGENT_ROOT__ + reloads them.
#   4. Leaves a one-line breadcrumb at ~/Documents/pugs-sync-agent.MOVED
#      so anyone clicking around realizes the agent moved.
#
# Idempotent — safe to re-run.

set -u

OLD_ROOT="$HOME/Documents/pugs-sync-agent"
NEW_ROOT="$HOME/pugs-sync-agent"
LAUNCH_DIR="$HOME/Library/LaunchAgents"

log() { echo "$(date -u +%H:%M:%S) migrate: $*"; }

# ── Quick mode detection ─────────────────────────────────────────────────
# If we're already in the new location (re-run after move), just reinstall
# to make sure plists are correct + services are reloaded.
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ "$HERE" = "$NEW_ROOT" ]; then
  log "already at $NEW_ROOT — re-running install to refresh plists"
  bash "$NEW_ROOT/install.sh"
  exit 0
fi

if [ ! -d "$OLD_ROOT" ]; then
  log "no agent at $OLD_ROOT — nothing to migrate"
  log "if you meant to bootstrap a fresh install, clone into ~/pugs-sync-agent and run install.sh"
  exit 0
fi

# ── Safety: refuse if the new path already has files (don't clobber) ─────
if [ -d "$NEW_ROOT" ] && [ -n "$(ls -A "$NEW_ROOT" 2>/dev/null)" ]; then
  log "$NEW_ROOT already exists AND is non-empty"
  log "rename or remove it first, e.g.:"
  log "  mv $NEW_ROOT $NEW_ROOT.bak.$(date +%s)"
  exit 1
fi

# ── 1. Stop everything ───────────────────────────────────────────────────
log "stopping launchd services..."
for kind in scanner sender poller updater; do
  dst="$LAUNCH_DIR/com.pugs.syncagent.$kind.plist"
  if [ -f "$dst" ]; then
    launchctl unload "$dst" 2>/dev/null && log "  unloaded $kind" || log "  $kind already stopped"
  fi
done

# ── 2. Move the directory ────────────────────────────────────────────────
log "moving $OLD_ROOT → $NEW_ROOT"
# Use mv (atomic on same volume — $HOME is one volume on standard macOS).
# If that fails (rare cross-volume case), fall back to cp+rm.
if mv "$OLD_ROOT" "$NEW_ROOT" 2>/dev/null; then
  log "  moved (atomic)"
else
  log "  mv failed, falling back to cp+rm"
  mkdir -p "$NEW_ROOT"
  cp -R "$OLD_ROOT"/. "$NEW_ROOT"/ || { log "cp failed, aborting"; exit 1; }
  rm -rf "$OLD_ROOT"
fi

# ── 3. Breadcrumb at the old path ────────────────────────────────────────
cat > "$OLD_ROOT.MOVED" <<EOF
pugs-sync-agent was moved to $NEW_ROOT on $(date -u +%Y-%m-%dT%H:%M:%SZ).
~/Documents/ is TCC-protected from launchd, which silently broke the auto-updater.
EOF
log "left breadcrumb at $OLD_ROOT.MOVED"

# ── 4. Re-run install from the new path ──────────────────────────────────
log "running install.sh from new location..."
bash "$NEW_ROOT/install.sh"

log "agent now lives at $NEW_ROOT and launchd services are reloaded."

# ── 5. Enable Tailscale SSH (idempotent — for remote recovery) ──────────
# Lets Charlie ssh in via Tailscale to run panic-restart remotely without
# having to bug you next time the agent dies. Bypasses macOS sshd / TCC /
# authorized_keys entirely (those have been broken on Connor's Mac since
# 2026-05-19 — see CONTINUATION_BRIEF.md item #6).
log "ensuring Tailscale SSH is enabled..."
TS_BIN=""
if command -v tailscale >/dev/null 2>&1; then
  TS_BIN="$(command -v tailscale)"
elif [ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]; then
  TS_BIN="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
fi

if [ -n "$TS_BIN" ]; then
  log "  found tailscale at $TS_BIN"
  log "  → 'sudo tailscale set --ssh=true' (you may be prompted for your password)"
  if sudo "$TS_BIN" set --ssh=true 2>/dev/null; then
    log "  Tailscale SSH enabled (no-op if already on)"
  else
    log "  'set' command not supported, falling back to 'up --ssh'"
    sudo "$TS_BIN" up --ssh && log "  Tailscale SSH enabled via 'up'" || log "  WARN: Tailscale SSH enable failed — Charlie can run this manually"
  fi
else
  log "  Tailscale CLI not found — skipping SSH setup"
  log "  (install Tailscale.app from tailscale.com first, then re-run this script)"
fi

log "DONE."
log "verify agent:  launchctl list | grep com.pugs.syncagent"
log "verify ssh:    tailscale status --self  (look for TailscaleSSHEnabled)"
