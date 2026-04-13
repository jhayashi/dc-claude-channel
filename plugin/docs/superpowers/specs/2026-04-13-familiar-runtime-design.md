# Familiar Runtime + WebXDC Builder Skill — Design Spec

**GitHub issue:** #35
**Date:** 2026-04-13
**Status:** Draft

---

## Goal

Add a **Familiar runtime** to dc-claude-channel that lets dynamically-built WebXDC apps use Claude as a live backend — without plugin source changes or restarts. Bundle a **`webxdc-builder` skill** that teaches subagents how to build both static and Familiar-powered WebXDC apps on behalf of users in chat.

## Motivation

Today, every WebXDC app in dc-claude-channel is a bundled TypeScript module implementing the `WebXDCApp` interface. Adding a new app requires writing code, registering it in `apps.ts`, and restarting the dispatcher. Users can't ask their agent to build custom apps.

The Familiar pattern changes this: Claude generates both the client-side HTML and the server-side handler at runtime. The handler runs in a sandboxed eval, connected to the app via the existing WebXDC update mechanism. Because Claude is on the server side (connected to the internet, capable of reasoning, able to maintain state), Familiar apps can do things normal peer-to-peer WebXDC apps can't.

---

## Taxonomy

WebXDC apps built through this system come in two flavors:

- **Static apps** — self-contained HTML. No server component. Claude builds the `.xdc` and sends it via `dc_send_webxdc`. Examples: calculator, solitaire, guest info card, simple polls.
- **Familiar apps** — WebXDC apps with a Claude backend. The app sends updates to Claude; Claude processes them (deterministic logic, LLM calls, or both) and pushes results back. Examples: trivia game where Claude hosts, email triage dashboard, fantasy sports league, D&D campaign.

Both flavors can be:
- **Single-user** or **multi-user** (multi-user apps distinguish players via `senderAddr`)
- **Ephemeral** (lost on dispatcher restart) or **persistent** (state + handler saved to disk)

---

## Familiar Runtime Architecture

### Overview

The Familiar runtime is a single `WebXDCApp` registered in `apps.ts` that acts as a **meta-host** for all dynamically-created Familiar apps. It maintains an in-memory registry of active app instances, routes WebXDC updates to the correct handler, and optionally persists app definitions + state to disk.

### Components and Files

| File | Responsibility |
|------|----------------|
| `plugin/familiar-runtime.ts` | Core runtime: eval sandbox, handler registry, state management, persistence I/O |
| `plugin/apps/familiar-app.ts` | `WebXDCApp` wrapper: tool definitions, `callTool()` dispatch, `onWebXDCUpdate()` routing, startup reload of persistent apps |
| `plugin/webxdc/familiar-manifest.toml` | Manifest for Familiar `.xdc` apps (`name = "👾 Familiar"`) |
| `plugin/webxdc/familiar-icon.png` | Default icon for Familiar `.xdc` apps (square, 256x256) |
| `plugin/skills/webxdc-builder/SKILL.md` | Skill file teaching subagents how to build WebXDC apps |
| `plugin/test/familiar-runtime.test.ts` | Unit tests for the runtime (sandbox, state, persistence) |
| `plugin/test/familiar-app.test.ts` | Integration tests for the app wrapper (tools, update routing) |

### Handler Execution Model — Eval Sandbox

When Claude creates a Familiar app, it provides a handler function as a JavaScript string. The runtime wraps this in a restricted scope and evals it.

**Example handler** (rock-paper-scissors):

```javascript
function handler(update, ctx) {
  if (update.type === 'move') {
    const choices = ['rock', 'paper', 'scissors'];
    const aiChoice = choices[Math.floor(Math.random() * 3)];
    const wins = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
    const result = update.choice === aiChoice ? 'draw'
      : wins[update.choice] === aiChoice ? 'win' : 'lose';
    ctx.state.scores = ctx.state.scores || {};
    ctx.state.scores[update.player] = (ctx.state.scores[update.player] || 0) + (result === 'win' ? 1 : 0);
    ctx.sendUpdate({
      type: 'result',
      playerChoice: update.choice,
      aiChoice,
      result,
      scores: ctx.state.scores
    });
  }
}
```

**Sandbox API exposed to handler code:**

| API | Type | Description |
|-----|------|-------------|
| `ctx.state` | `object` | Mutable state object persisted per-app instance. Survives across updates. Serialized to disk for persistent apps. |
| `ctx.sendUpdate(payload)` | `(payload: object) => void` | Push an update back to the WebXDC app. The runtime auto-wraps in `{payload: ...}` for the WebXDC protocol. |
| `ctx.requestLLM(prompt)` | `(prompt: string) => Promise<string>` | Forward a prompt to the chat's subagent and return the text response. For LLM-powered logic (content generation, classification, natural language responses). |
| `ctx.appId` | `string` | Unique ID of this app instance. |
| `ctx.chatId` | `number` | Chat this app lives in. |

**Blocked globals:** The eval wrapper explicitly shadows `require`, `import`, `fetch`, `process`, `globalThis`, `Bun`, `Deno`, `__dirname`, `__filename`, `fs`, `child_process`, `net`, `http`, `https`, `os`, `path`, `crypto` — setting them all to `undefined` in the closure scope. The handler has access to standard JS builtins (Math, JSON, String, Array, Object, Date, Map, Set, RegExp, parseInt, etc.) and the `ctx` API — nothing else.

**Timeout:** Each handler invocation is wrapped in a timeout (default 5 seconds for synchronous handlers, 30 seconds for handlers that call `requestLLM`). If the handler exceeds the timeout, the invocation is aborted and an error is logged. This prevents a buggy handler from blocking the dispatcher event loop.

**Error handling:** If a handler throws, the error is logged and the update is dropped. The app continues running — a single bad update doesn't kill the app. The error message is not sent back to the WebXDC (to avoid leaking internal state), but is available in the debug log.

### App Instance Lifecycle

```
dc_familiar_create called
  → Runtime generates a unique appId (nanoid, 8 chars)
  → HTML is built into a .xdc via xdc-builder (or inline zip if no manifest)
  → .xdc is sent to the chat via DCClient.sendWebXDC()
  → Handler string is eval'd and cached
  → msgId is registered with server.ts for update dispatch
  → If persistent: definition + state written to disk
  → Tool returns { appId, msgId }

WebXDC update arrives (user taps a button in the app)
  → server.ts routes to familiarApp.onWebXDCUpdate()
  → familiarApp looks up the app instance by msgId
  → Handler is invoked with (update.payload, ctx)
  → Handler calls ctx.sendUpdate() / ctx.requestLLM() as needed
  → If persistent: state is written to disk after handler completes

dc_familiar_update called (server-initiated push)
  → Runtime looks up the app instance by appId
  → Sends update directly to the WebXDC via DCClient.sendWebXDCUpdate()

dc_familiar_delete called
  → Runtime unregisters the msgId
  → Removes app instance from memory
  → If persistent: deletes the JSON file from disk

Dispatcher restart
  → familiarApp.start() scans ~/.claude/channels/deltachat/familiars/
  → Reloads persistent app definitions
  → Re-evals handlers, restores state
  → Re-registers msgIds for update dispatch
```

### Persistence Format

Persistent Familiar apps are stored as JSON files:

```
~/.claude/channels/deltachat/familiars/<chatId>-<appId>.json
```

```json
{
  "appId": "abc12345",
  "chatId": 42,
  "msgId": 5678,
  "title": "Trivia Night",
  "html": "<!DOCTYPE html>...",
  "handler": "function handler(update, ctx) { ... }",
  "state": { "scores": {}, "currentQuestion": 3 },
  "createdAt": "2026-04-13T10:00:00.000Z"
}
```

The `html` field stores the full HTML source so the app can be rebuilt (e.g., after a WebXDC version mismatch or for debugging). State is written after every handler invocation for persistence — this is acceptable because handler invocations are driven by user actions (not high-frequency).

### Building the .xdc

Familiar apps use the existing `xdc-builder.ts` infrastructure with one adaptation: the HTML is provided as a string (not read from a file on disk). The builder:

1. Writes the HTML to a temp file
2. Uses the shared `familiar-manifest.toml` and `familiar-icon.png`
3. Injects `var APP_VERSION = 1.00;` into the HTML if not present (Familiar apps don't need the auto-upgrade protocol since they're created fresh each time, but the builder requires it)
4. Zips and returns the `.xdc` path

Alternatively, the Familiar app builder can bypass `xdc-builder.ts` and zip directly using `fflate` (matching the existing pattern) since it doesn't need version tracking or auto-upgrade.

---

## MCP Tools

The Familiar runtime registers four tools:

### `dc_familiar_create`

Create and send a Familiar app to a chat.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `chat_id` | string | yes | Target chat ID |
| `title` | string | yes | App title (shown in manifest) |
| `html` | string | yes | Complete HTML source for the WebXDC app |
| `handler` | string | yes | JavaScript handler function as a string. Must define a `handler(update, ctx)` function. |
| `initial_state` | string | no | JSON string for initial `ctx.state`. Defaults to `{}`. |
| `persistent` | boolean | no | Whether to persist to disk. Defaults to `false`. |

Returns: `{ appId, msgId }` on success.

### `dc_familiar_update`

Push a server-initiated update to a running Familiar app.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `chat_id` | string | yes | Chat ID (for authorization) |
| `app_id` | string | yes | App instance ID |
| `payload` | string | yes | JSON string payload to send to the WebXDC |

### `dc_familiar_list`

List active Familiar apps in a chat.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `chat_id` | string | yes | Chat ID |

Returns: array of `{ appId, title, persistent, createdAt }`.

### `dc_familiar_delete`

Remove a Familiar app and its persisted state.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `chat_id` | string | yes | Chat ID (for authorization) |
| `app_id` | string | yes | App instance ID |

---

## WebXDC Builder Skill

### Location

```
plugin/skills/webxdc-builder/SKILL.md
```

### Frontmatter

```yaml
---
name: webxdc-builder
description: Build WebXDC apps for Delta Chat — static HTML apps or Familiar apps with a Claude backend. Use when a user asks to build an app, game, tool, dashboard, or interactive experience.
user-invocable: false
allowed-tools:
  - mcp__dc__dc_send_webxdc
  - mcp__dc__dc_familiar_create
  - mcp__dc__dc_familiar_update
  - mcp__dc__dc_familiar_list
  - mcp__dc__dc_familiar_delete
  - mcp__dc__reply
---
```

The skill is **not user-invocable** — it's referenced in the Familiar runtime's `instructions` field so subagents discover it organically when users ask for apps. It could also be invoked programmatically by other skills.

### Content Structure

The skill document covers:

1. **Decision tree** — when to build static vs Familiar, single vs multi-user, ephemeral vs persistent
2. **WebXDC constraints checklist** — all rules every WebXDC HTML must follow:
   - No external resources (CDN, fetch, external URLs)
   - Include `<script src="webxdc.js"></script>` (injected by messenger)
   - Use `window.webxdc.setUpdateListener(fn, 0)` for receiving data
   - Use `window.webxdc.sendUpdate({payload: {...}}, 'desc')` for sending data
   - Include `senderAddr: window.webxdc.selfAddr` in every payload
   - Replay safety: handler must be idempotent (updates replay from 0 on every open)
   - Use `textContent` not `innerHTML` for user data (XSS prevention)
   - All CSS/JS must be inline (single HTML file)
3. **Static app flow** — generate HTML → send via `dc_send_webxdc`
4. **Familiar app flow** — generate HTML + handler → send via `dc_familiar_create`
5. **Handler patterns** with complete examples:
   - **Pure deterministic** — game logic, state machines, scoring (sync handler, no `requestLLM`)
   - **Pure LLM** — forward all updates to Claude for processing (async handler, always calls `requestLLM`)
   - **Hybrid** — deterministic fast path + LLM fallback (e.g., score immediately, generate commentary via LLM)
   - **Multi-user** — using `update.senderAddr` to distinguish players, manage turns, enforce permissions
6. **Multi-user patterns** — how WebXDC updates work in group chats (everyone sees all updates, use senderAddr for per-player logic, private state via filtered updates)
7. **Integration with dc_schedule** — setting up recurring pushes for persistent apps (daily digest, score updates after games, etc.)

---

## Channel Instructions

The Familiar runtime's `instructions` field (appended to the subagent's system prompt) tells the subagent about the capability:

```
You can build custom WebXDC apps for users. There are two types:
- Static apps: self-contained HTML sent via dc_send_webxdc. For simple tools, games, and displays.
- Familiar apps: WebXDC apps with a Claude backend via dc_familiar_create. You provide HTML (the UI) and a handler function (server-side JS). The handler receives user interactions and can maintain state, send updates back, or call requestLLM() for AI-powered responses.

When a user asks you to build an app, game, tool, dashboard, or interactive experience, assess whether it needs a server component (Familiar) or is self-contained (static), then build and send it.
```

---

## Distribution — `.familiar.yaml`

Familiar apps are portable. A complete app definition fits in a single YAML file:

```yaml
# email-triage.familiar.yaml
name: Email Triage
description: Prioritize and summarize your inbox
persistent: true
initialState:
  categories: [urgent, interesting, low-priority]
  dismissed: []
html: |
  <!DOCTYPE html>
  <html>
  <head><script src="webxdc.js"></script></head>
  <body><!-- app UI --></body>
  </html>
handler: |
  function handler(update, ctx) {
    if (update.type === 'dismiss') {
      ctx.state.dismissed.push(update.emailId);
      ctx.sendUpdate({ type: 'state', dismissed: ctx.state.dismissed });
    }
    if (update.type === 'summarize') {
      var summary = ctx.requestLLM('Summarize this email: ' + update.body);
      ctx.sendUpdate({ type: 'summary', emailId: update.emailId, text: summary });
    }
  }
```

### Import flow

The dispatcher intercepts `.familiar.yaml` attachments in paired chats (same pattern as agent YAML import):

1. User sends a `.familiar.yaml` file in a paired chat
2. Dispatcher validates the YAML (required fields: `name`, `html`, `handler`)
3. On success: creates the Familiar app in the chat (calls `dc_familiar_create` internally)
4. On failure: rejects with an error message and forwards the attachment to the subagent

### Community repo

Familiar app recipes can be collected in a GitHub repository organized by category:

```
familiar-apps/
  games/
    trivia.familiar.yaml
    rock-paper-scissors.familiar.yaml
  productivity/
    email-triage.familiar.yaml
    blazemarks.familiar.yaml
  social/
    poll.familiar.yaml
    icebreaker.familiar.yaml
```

Users import by sending the YAML file as an attachment, or Claude can fetch from a URL and create the app directly.

---

## What's NOT in v1

- **No Worker isolation** — handlers eval in-process. The threat model (Claude-authored code in a controlled context) doesn't warrant the complexity. Can migrate to Bun Workers later if untrusted handlers become a requirement.
- **No hot-reload** — to update a Familiar app's handler or HTML, delete and recreate. The WebXDC content is frozen once sent to the chat.
- **No bundled app migration** — existing apps (file reviewer, permissions, agent setup, slides) remain as native `WebXDCApp` implementations. They need deep AppContext access that the sandbox intentionally doesn't provide.
- **No untrusted handler execution** — only Claude-authored handlers run. No mechanism for users to paste arbitrary JS.

---

## Target Validation Apps

These apps validate that the design covers real use cases. They are not part of the v1 implementation but inform the design:

1. **Email triage** (#4) — single-user, LLM-heavy, schedule-driven. Claude reads email via Gmail MCP, classifies importance, generates summaries. The WebXDC shows a prioritized digest with dismiss/respond/snooze actions. Validates: `requestLLM()`, persistent state, `dc_schedule` integration, server-initiated updates.

2. **Blazemarks reader** (#26) — single-user, hybrid, schedule-driven. Claude pulls the user's reading list, summarizes articles, presents them in a Familiar app with actions (mark read, save, get audio summary). Validates: external API integration, `requestLLM()` for summarization, persistent state, `.familiar.yaml` distribution.

4. **D&D / text adventure** — multi-user, LLM gamemaster, async-friendly. Claude is the DM. The WebXDC shows a map, character sheets, inventory. Players submit actions via the app, Claude narrates outcomes. Validates: complex state management, LLM-heavy handler, multi-user turn management, chat + app interaction split.

5. **Fantasy sports** — multi-user, hybrid handlers, long-lived persistent. Players draft, trade, set lineups. Claude pulls real game stats from the web, scores rosters, generates analysis. Validates: multi-user via senderAddr, deterministic scoring + LLM analysis, months-long persistence, scheduled score updates.

---

## Open Questions (Resolved)

**Q: Should we use the existing `xdc-builder.ts` or zip directly?**
A: Zip directly using `fflate`. Familiar apps are created fresh each time (no version tracking needed), and the HTML is provided as a string, not read from a file path. Using `xdc-builder.ts` would require writing to a temp file just to read it back.

**Q: How does `requestLLM` work mechanically?**
A: The Familiar runtime has access to `AppContext`, which provides the chat ID. It dispatches a synthetic message to the chat's subagent (via the same path `dc_schedule` uses for scheduled jobs) and collects the response. The prompt includes context about which Familiar app is asking and what the user did. The subagent's response text is returned to the handler.

**Q: What happens to Familiar apps when a subagent is evicted/restarted?**
A: Nothing — Familiar apps are hosted by the dispatcher, not the subagent. The handler runs in the dispatcher process. `requestLLM` may need to cold-spawn the subagent, but that's the same cost as any scheduled job firing.
