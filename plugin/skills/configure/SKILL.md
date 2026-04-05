---
name: configure
description: Set up the Delta Chat channel — check bot status and connection. Use when the user asks to set up Delta Chat, check status, or needs the invite link.
user-invocable: true
allowed-tools:
  - mcp__deltachat__dc_status
  - mcp__deltachat__dc_invite_link
  - Read
---

# /deltachat:configure — Delta Chat Channel Setup

Arguments passed: `$ARGUMENTS`

## Dispatch on arguments

### No args — status
Call `dc_status` to show current bot identity and connection status.

### `status`
Same as no args — call `dc_status`.

### `invite`
Call `dc_invite_link` to show the current invite link. Tell the user:
1. Open the link in a browser on the same machine running the terminal.
2. On the web page that loads, tap the triangle icon to reveal the QR code.
3. Scan the QR code from Delta Chat on their phone to add Claude as a verified contact.
