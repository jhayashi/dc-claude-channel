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
1. Open the link on their phone — Delta Chat will offer to add Claude as a contact.
2. Or in Delta Chat: tap the pencil/compose button (bottom right), then tap the QR code icon (triangle) to open the scanner.
