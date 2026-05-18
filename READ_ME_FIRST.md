# Hi Connor — install this in 2 minutes via Claude Cowork

Charlie built this little background service so all your iMessages automatically flow into your Pugs Sales pipeline dashboard. You don't need to do anything technical — your Claude desktop assistant will handle the install for you.

## 3 steps

### 1. Open Claude Cowork

Open the Claude desktop app and start a **new session**.

### 2. Drag this zip into the chat

You don't need to extract it — just drag the `pugs-sync-agent.zip` file straight into Claude.

### 3. Paste this exact message and hit send:

```
Hey Claude — Charlie sent me this Pugs Sync Agent. Please unzip it, then follow the instructions in CLAUDE_INSTRUCTIONS.md inside the zip. Walk me through getting it installed on my Mac. The .env file inside already has the right secret so you don't need to ask me for it.
```

That's it. Claude will:
- Extract the zip to a folder in your Documents
- Check if Node.js is installed (and install it if not)
- Run the installer
- Tell you exactly what to click in System Settings to grant the one permission it needs
- Verify everything works

The whole thing takes about 5 minutes.

## Stuck?

If anything goes sideways or Claude gets confused, text Charlie. He'll know what to do.

## What this does for you (in plain English)

Every 5 minutes, this reads your new iMessages from your Mac and adds them to the same Pugs Sales dashboard that already has your Gmail. So if a client texts you instead of emailing, that message shows up alongside everything else — including the "urgent — needs reply" widget on your pipeline page. No more checking three places for client comms.

Logs live in `~/Documents/pugs-sync-agent/scanner.log` if you ever want to peek.
