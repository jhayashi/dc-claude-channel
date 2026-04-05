# dc-claude-channel

Delta Chat channel plugin for Claude Code (TypeScript/Bun). Matches the official Telegram/Discord plugin architecture.

## Development

```bash
cd plugin && bun install && bun test
```

## Testing the channel (research preview)

```bash
claude --plugin-dir /path/to/dc-claude-channel/plugin --dangerously-load-development-channels plugin:deltachat@inline
```

Prerequisites:
- `~/.claude/plugins/installed_plugins.json` must have `"deltachat@inline"` entry
- Do NOT add to `enabledPlugins` in settings.json (causes account lock contention)
- No project-level `.mcp.json` defining deltachat (creates duplicate server)
- `--plugin-dir` registers plugins with marketplace name `inline` internally.
- Plugin must be in `installed_plugins.json` (as `deltachat@inline`) for the channel flag to accept it.
- `/mcp` should show `plugin:deltachat:deltachat` not plain `deltachat` under Project MCPs.

## Key Gotchas

- `deltachat-rpc-server` uses file locking — only one process per account database. Multiple sessions = lock contention.
- WebXDC status updates must wrap data as `{payload: {...}}` — the applet receives `update.payload`.
- WebXDC icons must be square — Delta Chat crops non-square to a square thumbnail.
- Channel permission protocol only supports `allow`/`deny` — no "always allow" option.
- Plugin source lives in `plugin/` subdirectory (not repo root) to prevent `.mcp.json` from being auto-loaded as a project MCP.
- **Version bump required:** When modifying `permission-prompt.html`, bump `APP_VERSION` in the HTML (e.g., 1.00 → 1.01). The builder reads the HTML fresh from disk and parses the version automatically — no need to update `permissions.ts`. Old apps auto-upgrade by detecting version mismatch. No server restart needed.

## Architecture

- `plugin/server.ts` — MCP server entry point (core tools, channel pump, generic app wiring)
- `plugin/webxdc-app.ts` — `WebXDCApp` interface that all apps implement
- `plugin/apps.ts` — App registry (explicit imports, no auto-discovery)
- `plugin/apps/` — App implementations:
  - `markdown-viewer-app.ts` — File reviewer: rendered markdown + syntax-highlighted source + inline commenting (1 tool, event-driven updates)
  - `permissions-app.ts` — Permission prompt via WebXDC (notification handler + polling)
- `plugin/dc-client.ts` — Wraps `@deltachat/jsonrpc-client` + `@deltachat/stdio-rpc-server`
- `plugin/access.ts` — File-based allowlist + pairing codes (~/.claude/channels/deltachat/approved/)
- `plugin/tutorial.ts` — Onboarding tutorial state machine
- `plugin/webxdc-filter.ts` — Centralized owner verification for WebXDC updates
- State dir: `~/.claude/channels/deltachat/` (.env, dc-data/, approved/, debug.log)

## Building a WebXDC App

To add a new WebXDC app to this channel plugin, create two files and add one import.

### 1. Create the WebXDC HTML app

Put your app HTML in `plugin/webxdc/your-app.html`. This is a self-contained HTML file that runs inside the WebXDC sandbox.

Key constraints:
- Include `<script src="webxdc.js"></script>` — the messenger injects this at runtime. Do NOT bundle a copy.
- All assets must be self-contained (no CDN imports, no `fetch()`, no external URLs).
- Use `window.webxdc.setUpdateListener(fn, 0)` to receive data from the server.
- Use `window.webxdc.sendUpdate({payload: {...}}, 'description')` to send data back.
- **Owner verification (REQUIRED):** Every `sendUpdate` payload MUST include `senderAddr: window.webxdc.selfAddr`. The server uses this to verify the update came from the chat owner. Updates without `senderAddr` are rejected in owned chats. A test enforces this — see `test/webxdc-sender-addr.test.ts`.
- Updates replay from serial 0 on every app open — your handler must be idempotent.
- Use `textContent` (not innerHTML) for user-supplied data to prevent XSS.
- `localStorage` is not reliably persistent across sessions. Use `sendUpdate` for durable state.

### 2. Create the XDC builder module

Create `plugin/your-app.ts` that reads the HTML at import time and exports a build function:

```typescript
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const APP_HTML = readFileSync(join(import.meta.dir, 'webxdc', 'your-app.html'))
const ICON_PNG = readFileSync(join(import.meta.dir, 'webxdc', 'your-app-icon.png'))
const MANIFEST_TOML = 'name = "Your App"\n'

export async function buildYourAppXDC(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'claude-dc-yourapp-'))
  const xdcPath = join(dir, 'your-app.xdc')
  const contentDir = join(dir, 'content')
  mkdirSync(contentDir)
  writeFileSync(join(contentDir, 'index.html'), APP_HTML)
  writeFileSync(join(contentDir, 'manifest.toml'), MANIFEST_TOML)
  writeFileSync(join(contentDir, 'icon.png'), ICON_PNG)
  const result = Bun.spawnSync([
    'zip', '-j', xdcPath,
    join(contentDir, 'index.html'),
    join(contentDir, 'manifest.toml'),
    join(contentDir, 'icon.png'),
  ])
  if (result.exitCode !== 0) throw new Error(`zip failed: ${result.stderr.toString()}`)
  return xdcPath
}
```

Icon must be square (128x128 to 512x512 px). Do NOT bundle `webxdc.js` in the ZIP.

### Pure-HTML apps (no server component)

If your app is one-way (no custom tools, no `onWebXDCUpdate` handler), you don't need steps 3-4. Just build the `.xdc` and send it with the core `dc_send_webxdc` tool. No registration in `apps.ts`, no server restart. This is the fastest path for prototyping — iterate on the HTML, rebuild the `.xdc`, and send it.

Steps 3-4 are only needed when your app requires server-side tools or needs to receive user responses via `onWebXDCUpdate`.

### 3. Create the app wrapper

Create `plugin/apps/your-app-app.ts` implementing the `WebXDCApp` interface:

```typescript
import type { WebXDCApp, ToolDef, ToolResult, AppContext } from '../webxdc-app.js'
import * as yourApp from '../your-app.js'

// Session tracking (reuse app per chat instead of sending a new one each time)
const sessions = new Map<number, { msgId: number; lastSerial: number }>()

export const yourAppApp: WebXDCApp = {
  id: 'your-app',

  // Optional: channel instructions appended to Claude's system prompt.
  // Use this to tell Claude when and how to use your app's tools.
  instructions: 'When the user asks for X, call dc_your_tool with ...',

  tools(): ToolDef[] {
    return [{
      name: 'dc_your_tool',
      description: 'Does something useful',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Chat ID' },
          data: { type: 'string', description: 'Data to send' },
        },
        required: ['chat_id', 'data'],
      },
    }]
  },

  async callTool(name: string, args: Record<string, unknown>, ctx: AppContext): Promise<ToolResult | null> {
    if (name !== 'dc_your_tool') return null

    const chatId = Number(args.chat_id as string)
    if (!chatId || !ctx.isAllowed(chatId)) {
      return { content: [{ type: 'text', text: 'invalid or unauthorized chat' }], isError: true }
    }

    // Build payload — always wrap in {payload: {...}}
    const update = JSON.stringify({ payload: { type: 'init', data: args.data } })

    let session = sessions.get(chatId)
    if (session) {
      // Reuse existing app
      await ctx.client.sendWebXDCUpdate(session.msgId, update)
    } else {
      // Send new app
      const xdcPath = await yourApp.buildYourAppXDC()
      const msgId = await ctx.client.sendWebXDC(chatId, xdcPath)
      await ctx.client.sendWebXDCUpdate(msgId, update)
      session = { msgId, lastSerial: 0 }
      sessions.set(chatId, session)
      // Clean up temp file
      const { unlinkSync } = await import('node:fs')
      try { unlinkSync(xdcPath) } catch {}
    }

    return { content: [{ type: 'text', text: 'App sent.' }] }
  },

  // Optional: handle user responses from the WebXDC app.
  // Updates are pre-filtered by server.ts — only owner-verified updates arrive here.
  // Do NOT call getWebXDCUpdates yourself; use the provided updates array.
  async onWebXDCUpdate(msgId: number, updates: WebXDCUpdate[], ctx: AppContext): Promise<void> {
    for (const u of updates) {
      const payload = u.payload as { type?: string } | null
      if (!payload) continue
      ctx.logf('your-app: got update type=%s for msg %d', payload.type, msgId)
    }
  },

  // Optional: register MCP notification handlers (rare — only for system events).
  // registerNotifications?(ctx: AppContext): void { ... }

  // Optional: run on startup (e.g., start a scheduler).
  // start?(ctx: AppContext): void { ... }

  // Optional: cleanup on shutdown (e.g., clear intervals).
  // stop?(): void { ... }
}
```

### 4. Register in apps.ts

Add one import and one array entry to `plugin/apps.ts`:

```typescript
import { yourAppApp } from './apps/your-app-app.js'

export const apps: WebXDCApp[] = [
  markdownViewerApp,
  permissionsApp,
  emailTriageApp,
  yourAppApp,  // <-- add here
]
```

That's it. Server.ts handles tool registration, dispatch, polling, and shutdown automatically.

### AppContext reference

Your app receives an `AppContext` with:

| Field | Type | Use |
|-------|------|-----|
| `client` | `DCClient` | `sendWebXDC()`, `sendWebXDCUpdate()`, `send()` |
| `mcp` | `Server` | `mcp.notification()` for emitting channel events |
| `isAllowed` | `(chatId) => bool` | Check access before sending |
| `allowedChats` | `() => number[]` | All approved chat IDs |
| `logf` | `(fmt, ...args) => void` | Debug logging (`%s`, `%d`, `%v` placeholders) |
| `safeName` | `(s) => string` | Sanitize user strings for notification meta |
| `registerWebXDCMsg` | `(msgId, app, chatId) => void` | Register a WebXDC msgId for owner-verified update dispatch |
| `unregisterWebXDCMsg` | `(msgId) => void` | Unregister on session clear |
| `lastActiveChatId` | `() => number \| null` | Chat that most recently sent a message |

### WebXDCApp interface reference

| Method | Required | When called |
|--------|----------|-------------|
| `tools()` | Yes | Once at startup for tool registration |
| `callTool(name, args, ctx)` | Yes | On each MCP tool call (return `null` if not your tool) |
| `onWebXDCUpdate(msgId, updates, ctx)` | No | When owner-verified WebXDC updates arrive (pre-filtered by server.ts) |
| `registerNotifications(ctx)` | No | Once at startup for MCP notification handlers |
| `start(ctx)` | No | Once after MCP connect (schedulers, etc.) |
| `stop()` | No | On shutdown (clear intervals, release resources) |
| `instructions` | No | String appended to Claude's channel system prompt |

### Common patterns

**Reuse vs fresh app:** Reusing one WebXDC app per chat (via `sendWebXDCUpdate`) avoids cluttering the chat with duplicate app cards. But the user must scroll up to find it. Use `info`/`href` fields on updates to create tappable notification messages that open the app.

**Payload wrapping:** Always send `{payload: {...}}` — the app receives `update.payload`. Sending a bare object delivers `undefined`.

**Replay safety:** `setUpdateListener(fn, 0)` replays all updates from the beginning on every app open. Design handlers to reconstruct state from the full replay, not just append.

**Tool name collisions:** Prefix your tool names with `dc_` + your app name to avoid collisions.

**Owner verification (REQUIRED):** Every `sendUpdate` payload MUST include `senderAddr: window.webxdc.selfAddr`. The server reads all WebXDC updates centrally in `server.ts`, verifies `senderAddr` against the chat owner (from `access.getOwner()`), and only forwards owner-verified updates to apps via `onWebXDCUpdate()`. Updates without `senderAddr` or from non-owners are silently rejected. This prevents non-owners in group chats from triggering actions (approving permissions, submitting comments, etc.). A test (`test/webxdc-sender-addr.test.ts`) enforces that every HTML file includes `senderAddr` in all `sendUpdate` calls.

**App versioning and auto-upgrade (REQUIRED):** Once a `.xdc` is sent to a chat, its HTML is frozen — editing the source file has no effect on already-delivered apps. Without auto-upgrade, every HTML change requires the user to restart their terminal session. All WebXDC apps MUST implement the auto-upgrade protocol:
1. Include `var APP_VERSION = <number>` in the HTML (required by `xdc-builder.ts`)
2. Include `version` in every payload sent to the app (read via `getViewerVersion()` or equivalent)
3. In the HTML, check incoming payloads: if `payload.version > APP_VERSION`, send `{type: 'version_mismatch', senderAddr: window.webxdc.selfAddr}` back via `sendUpdate` and show a loading state
4. In your app's `onWebXDCUpdate()`, handle `version_mismatch`: unregister the old msgId, delete the session, rebuild and send a fresh `.xdc`, register the new msgId
5. When you change the HTML, bump `APP_VERSION` in the HTML file (e.g., 1.00 → 1.01) — the builder reads it automatically

This is essential for iterative development via Delta Chat — the user may be on their phone away from the terminal. See `plugin/apps/permissions-app.ts` and `plugin/apps/markdown-viewer-app.ts` for reference implementations.
