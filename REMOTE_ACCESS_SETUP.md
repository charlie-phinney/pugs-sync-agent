# Remote-Access Setup (one-time, ~10 min)

Hey Connor — this is a one-time setup so Charlie can fix the sync agent
remotely the next time it breaks, instead of pinging you. After this is
done, you should never have to touch the agent again.

You'll do three things: install Tailscale, enable Remote Login (SSH), and
paste Charlie's SSH public key into your authorized_keys file. All three
are revocable any time.

---

## 1. Install Tailscale (~3 min)

Tailscale gives the Mac a stable hostname that works across any network
(home Wi-Fi, hotspot, office) — Charlie can reach it without needing
your local IP or any port forwarding.

```bash
brew install --cask tailscale
```

Then open Tailscale.app and sign in with the account Charlie shares with you.

If you don't have Homebrew, install from https://tailscale.com/download/mac
instead and sign in via the menu-bar app.

Confirm it's running:
```bash
tailscale status --self
```
You should see your machine with a `100.x.x.x` IP and a hostname.

---

## 2. Enable Remote Login (SSH) (~30 sec)

This lets Charlie SSH into the Mac to run the recovery script. Two ways
— pick either:

**Option A (Terminal, instant):**
```bash
sudo systemsetup -setremotelogin on
```
Will prompt for your password.

**Option B (GUI):** System Settings → General → Sharing → toggle on
"Remote Login." Restrict to your user only.

---

## 3. Add Charlie's SSH key (~1 min)

Charlie will paste his public key in your Slack/chat — looks like:
```
ssh-ed25519 AAAAC3Nz... charlie@laptop
```

Add it to your authorized_keys (replace the part in quotes with the actual
key Charlie sends):

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo "PASTE-CHARLIES-PUBKEY-HERE" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

---

## 4. Verify (Charlie does this from his machine)

```bash
ssh connor@connor-mac.tailnet.ts.net "echo hello && date"
```

If that prints, you're done. Charlie can now run
`bash ~/pugs-sync-agent/panic-restart.sh` from his terminal whenever
the agent dies. You'll never get a "hey the iMessage thing is down again"
ping from him.

---

## Revoke any time

- Sign out of Tailscale via the menu-bar app, or `tailscale logout`
- Turn off Remote Login: `sudo systemsetup -setremotelogin off`
- Remove Charlie's key: edit `~/.ssh/authorized_keys` and delete the line

---

## Why this is OK

- **Tailscale** is a private mesh VPN. Only devices on the tailnet can
  reach the Mac — not the public internet. You can see/kick devices any
  time via the Tailscale admin panel.
- **Remote Login** is restricted to your user account. Charlie's SSH key
  only authenticates as your user — same access he'd have if he sat at
  the keyboard.
- **No services run with elevated privileges** beyond what's already there.
  The agent is still your user's launchd job.
