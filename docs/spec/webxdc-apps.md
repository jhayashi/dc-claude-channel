# WebXDC Apps + Familiar Runtime

## Feature: WebXDC apps + Familiar runtime

### Intended behavior

dc-claude-channel provides a plugin system for WebXDC apps — interactive cards sent to Delta Chat chats — plus a lightweight Familiar runtime for building server-side interactive apps at runtime.

**Per-app user experience:**
- User triggers an MCP tool (e.g., `dc_send_file`, `dc_send_slides`, `dc_familiar_create`).
- App sends a `.xdc` file to the chat; Delta Chat renders it as a tappable card.
- User taps the card or interacts with it (fills form, clicks button, leaves comment).
- WebXDC update arrives at the server via Delta Chat's update-streaming API.
- Server verifies the update came from the chat owner (owner verification).
- If valid, the update is dispatched to the app's `onWebXDCUpdate` handler.
- Handler processes the update (e.g., file-reviewer logs comments; familiar runs handler JS in sandbox).
- Handler may call `sendUpdate()` to push new payloads back to the app.
- User sees live updates on the card in real time.

**Auto-upgrade protocol:** When the server builds a new `.xdc` with a higher `APP_VERSION`, the old app detects the version mismatch via update payload inspection, sends a `version_mismatch` signal, and the server rebuilds and re-sends the app to the chat. The user swipes back to the chat and taps the updated card.

**Familiar apps (runtime-authored interactive logic):**
- Claude authors a short JS handler string (e.g., for a counter, poll, or stateful workflow).
- Handler runs in a restricted eval sandbox; can access `ctx.state` (persistent state), `ctx.sendUpdate()` (push to app), `ctx.requestLLM()` (call the LLM).
- No Node/Bun/Deno globals; standard JS builtins (JSON, Math, Date, etc.) available.
- User review/approval gates execution (primary security model).

### State machine / transitions

**Per-app session lifecycle:**

1. **Created:** Tool calls (e.g., `dc_send_file`, `dc_familiar_create`) build a `.xdc` file and send it to a chat.
   - Permissions app: on first request to a chat, build and send `.xdc` (msgId stored in `permissionsSessions` map).
   - File reviewer: on first file to a chat, build and send `.xdc` (msgId stored in `activeViewers` map).
   - Agent setup: on first `dc_open_agent_settings` call, build and send `.xdc` (msgId stored in `agent-setup-sessions.json` on disk).
   - Familiar: each `dc_familiar_create` generates a unique `appId`, builds `.xdc`, sends to chat; instance registered in `byAppId` + `byMsgId` maps.

2. **Registered:** App msgId is registered in `webxdcAppRegistry` (msgId → {app, chatId}) for event-driven dispatch.

3. **Updates flowing:** WebXDC updates arrive via Delta Chat; server calls `app.onWebXDCUpdate(msgId, filteredUpdates, ctx)`.
   - Serial tracking (`webxdcLastSerial` map) prevents replaying old updates after restart.
   - Per-msgId handler chaining (`webxdcHandlerChain` map) serializes concurrent updates on the same app.

4. **Version mismatch detected:** App sends `{type: 'version_mismatch', appVersion, serverVersion, senderAddr}`.
   - Server unregisters old msgId from registry.
   - Server rebuilds `.xdc` with fresh code from disk.
   - Server clears old session state (e.g., permissions session, file-reviewer lastUpdate).
   - Server sends new `.xdc` to the chat.
   - Server re-registers new msgId in registry.
   - User swipes back to chat and taps updated card; updates now flow to new msgId.

5. **Cleared:** On chat unpair/deletion or explicit app delete:
   - Permissions: delete entry in `permissionsSessions`.
   - File reviewer: delete entry in `activeViewers`.
   - Agent setup: delete entry in `agent-setup-sessions.json`.
   - Familiar: call `deleteInstance(appId)` (both maps) + `deletePersistedInstance()` if persistent.
   - Always: unregister msgId from `webxdcAppRegistry`.

**Familiar app lifecycle (ephemeral vs persistent):**

- **Ephemeral:** `persistent: false` (default). Instance lives in `byAppId` + `byMsgId` maps in-memory only. On server restart, instance is gone.
- **Persistent:** `persistent: true`. Instance is written to `~/.claude/channels/deltachat/familiars/{appId}.json` after each state mutation. On server startup, `loadPersistedInstances()` reads all `.json` files and re-registers them.
- **Lifecycle events:**
  - Created: `dc_familiar_create` → build XDC → send to chat → register instance.
  - Updated: `dc_familiar_update` → send payload to app → handler runs → state mutated.
  - Deleted: `dc_familiar_delete` → unregister → delete persisted file.
  - Reloaded on restart: server startup → `loadPersistedInstances()` → re-register all ephemeral+persistent instances in maps.

### Persisted state

**Prebuilt cache:**
- Location: `plugin/webxdc-prebuilt/` directory.
- Naming: `{html-filename}-v{version}.xdc`
  - Example: `file-reviewer.html` at version 1.5 → `file-reviewer-v1.5.xdc`.
- Lookup: `xdc-builder.ts` checks `prebuiltDir/{id}-v{version}.xdc` before building.
- Bypass: Set `DC_SKIP_PREBUILT=1` environment variable to always build fresh.
- Content: `.xdc` is a ZIP containing `index.html` (versioned), `manifest.toml` (name appended with `v{version}`), `icon.png` (optional).

**Familiar persistence directory schema:**
- Base: `~/.claude/channels/deltachat/familiars/`.
- Per-instance: `{appId}.json` (one file per app instance).
- Format: JSON with fields `appId`, `chatId`, `msgId`, `title`, `html`, `handler`, `state`, `persistent`, `createdAt`.
- Write atomicity: Writes use `.tmp.{pid}.{uuid}` temp file, then atomic `rename` to avoid corruption on concurrent writes.
- Load: On server startup, iterate files, parse JSON, validate required fields, skip invalid files.

**Per-app session msgId tracking:**
- **In-memory (`webxdcAppRegistry`):** `msgId → {app, chatId}` map used for event dispatch. Seeded at startup from persisted session files and re-seeded on version-mismatch upgrade.
- **On disk (app-specific):**
  - Agent setup: `~/.claude/channels/deltachat/agent-setup-sessions.json` — array of `{msgId, sourceChatId, lastSerial?}`.
  - Permissions: In-memory only (`permissionsSessions` map); no persistence.
  - File reviewer: In-memory only (`activeViewers` map); no persistence.
  - Familiar: Persisted via each instance's `.json` file (msgId field in instance record).

### Observable surface

**Tools registered by each app:**

1. **Permissions app** (`permissionsApp`):
   - `dc_test_permission`: Test-only tool to simulate permission request.
   - No production tool; permissions are triggered by dispatcher's internal MCP hooks.

2. **File reviewer app** (`fileReviewerApp`):
   - `dc_send_file(chat_id, title, content?, file_path?, language?)` — auth: `ctx.isAllowed(chat_id)`.
   - `dc_send_slides(chat_id, title, content)` — thin alias that calls `dc_send_file` internally; viewer auto-detects Marp format.

3. **Agent setup app** (`agentSetupApp`):
   - `dc_open_agent_settings(chat_id)`
   - `dc_open_agent_settings_no_resume(chat_id)`
   - `dc_agent_action(chat_id, action, payload)`

4. **Familiar app** (`familiarApp`):
   - `dc_familiar_create(chat_id, title, html, handler, initial_state?, persistent?)`
   - `dc_familiar_update(chat_id, app_id, payload)`
   - `dc_familiar_list(chat_id)`
   - `dc_familiar_delete(chat_id, app_id)`

**WebXDC payload schemas:**

All payloads must include `senderAddr: window.webxdc.selfAddr` (validated at server-side owner-verification filter; updates missing it are silently dropped in owned chats).

*Common fields:*
```
{
  payload: {
    senderAddr: string          // REQUIRED in owned chats
    [type: string]              // App-specific type (e.g., 'response', 'comments', 'request')
    [version?: number]          // Optional; compared against APP_VERSION for auto-upgrade
    ...rest
  },
  summary: string               // User-visible one-liner shown in chat
  info?: string                 // Tappable notification text
  href?: string                 // URL path within the app
}
```

*Permission prompt payload:*
```
{type: 'request', version, requestId, toolName, description, inputPreview}
{type: 'response', requestId, granted, senderAddr, senderName?}
{type: 'version_mismatch', appVersion, serverVersion, senderAddr}
{type: 'open_agent_settings', senderAddr, senderName?}
```

*File reviewer payload:*
```
{type: undefined, title, content, language?, version, startLine?}  // File/doc tab
{type: 'comments', fileTitle?, language?, comments: [{line?, paragraph?, slide?, context?, comment?}]}
{type: 'close_tab', title?, docIndex?}
{type: 'version_mismatch', appVersion, serverVersion, senderAddr}
```

*Familiar payload (user-authored):*
```
Handler receives (update, ctx):
  update = {senderAddr, ...user-defined fields}
  ctx = {state: {}, sendUpdate, requestLLM, appId, chatId}
Handler calls ctx.sendUpdate({senderAddr: window.webxdc.selfAddr, ...payload})
```

**Auto-upgrade handshake messages:**

1. App detects mismatch (APP_VERSION in HTML vs. version in incoming payload):
   ```javascript
   window.webxdc.sendUpdate({
     payload: {type: 'version_mismatch', appVersion: 1.2, serverVersion: 1.3, senderAddr: window.webxdc.selfAddr},
     summary: 'Update requested'
   }, 'Version mismatch')
   ```

2. Server detects mismatch in `onWebXDCUpdate`:
   - Unregister old msgId.
   - Build fresh `.xdc` from disk.
   - Send to chat → gets new msgId.
   - Re-register new msgId.

3. User swipes back to chat, taps the new card, updates flow to the new msgId.

**Marp detection rules (`marp-detect.ts`):**

Content is marked as slides if either:
1. **Frontmatter:** File starts with `---\n`, has `marp: true` (or `marp: yes`) in YAML block, then `---\n` again.
2. **No-frontmatter syntax:** File starts with `---\n`, contains 2+ `---\n`-delimited sections, and no frontmatter YAML.

**Permission verification (`webxdc-filter.ts`):**

Updates are filtered in `filterUpdatesByOwner()` based on:
- **No owner (legacy unpaired chat):** All updates pass through unfiltered.
- **1:1 chat (contact count ≤ 2):** Any update with a `senderAddr` passes (only the owner can send updates in 1:1).
- **Group chat:** Verify `senderAddr` via `lookupContactByAddr(senderAddr)` (strict match) OR TOFU-cached addr.
  - On strict match: add addr to TOFU cache.
  - On cache hit: allow update.
  - On no match: log rejection and drop update.
- **Missing `senderAddr` in owned chat:** Update is silently dropped.

### Primary source files

| File | Purpose |
|------|---------|
| `plugin/webxdc-app.ts` | Base interface for all WebXDC apps (tools, handlers, lifecycle) |
| `plugin/apps/permissions-app.ts` | Permission prompt card logic; manages request/response flow for tool calls |
| `plugin/webxdc/permission-prompt.html` | Permission card UI; displays tool details, Allow/Deny buttons; includes `APP_VERSION` |
| `plugin/apps/file-reviewer-app.ts` | File viewer app; dispatches `dc_send_file` and `dc_send_slides` tools; handles comments + inline editing |
| `plugin/webxdc/file-reviewer.html` | File/markdown renderer with inline comments, tab bar, Marp slide detection |
| `plugin/webxdc/file-reviewer.template.html` | Alternative template used in build process |
| `plugin/file-reviewer.ts` | Session tracker for file-reviewer (msgId per chat, lastUpdate cache) |
| `plugin/marp-detect.ts` | Detects Marp slide format |
| `plugin/apps/agent-setup-app.ts` | Agent picker/creator card; all screens (home, create, edit, delete, paired_list, etc.) |
| `plugin/webxdc/agent-setup.html` | Agent setup UI (glyph icons, model picker, tool selector, trusted-agent toggle) |
| `plugin/familiar-runtime.ts` | Sandbox, registry, persistence for Familiar apps |
| `plugin/apps/familiar-app.ts` | WebXDC app wrapper for Familiar runtime |
| `plugin/xdc-builder.ts` | Shared `.xdc` ZIP builder; prebuilt cache lookup; APP_VERSION extraction |
| `plugin/permissions.ts` | Permissions `.xdc` builder (thin wrapper around xdc-builder) |
| `plugin/webxdc-filter.ts` | Owner verification for WebXDC updates (senderAddr validation) |
| `plugin/server.ts` | Central event loop; WebXDC update polling and per-msgId dispatch |

### Audit notes

**Owner-verification holes:**

1. **Owned chat without `senderAddr` in payload:** Filter silently drops update (correct). Familiar HTML generated by `dc_familiar_create` must validate `senderAddr` presence before send; test in `familiar-runtime.test.ts` `validateHtmlSenderAddr` catches missing refs at creation time. Known limitation: false positive if `senderAddr` appears in a comment or after a `)` in a string literal.

2. **1:1 chat contact-count edge case:** Filter assumes contact count ≤ 2 → 1:1. But contact count includes the bot self; a freshly-created 1:1 might have count = 1 (self only, user not yet fetched). Filter would fall through to strict lookup, which may fail if dc-core returns anonymized selfAddr hashes (see issue #47). **Risk:** Updates from owner in a just-created 1:1 chat might be incorrectly rejected on strict check, then accepted on TOFU.

3. **TOFU cache without expiry:** Once a `senderAddr` is cached in a group chat, it's trusted forever — no expiry or re-verification. **Risk:** If a group member is removed but their addr is cached, and they rejoin, they could impersonate themselves via the cached addr. Mitigation: `clearTrustedSenderAddrs(chatId)` is called on chat unpair; not called on member removal (would require event).

**`senderAddr`-missing updates:**

4. **File-reviewer `close_tab`:** Does not include `senderAddr`. Accepted as-is because it has no side effects (just clears in-memory lastUpdate). **But:** If an attacker spoofs a `close_tab`, they can cause a legitimate file to be forgotten before version-mismatch upgrade (user would lose the document). Mitigation: Validate `senderAddr` in `close_tab` handler. Currently not done.

5. **Familiar handler output:** When handler calls `ctx.sendUpdate(payload)`, the handler author is responsible for including `senderAddr: window.webxdc.selfAddr` in the HTML. Validation via `validateHtmlSenderAddr()` at creation time, but false positives possible.

**Auto-upgrade loops:**

6. **Race on version_mismatch build:** Two instances of the handler both see `version_mismatch`, both call the upgrade path. Both unregister old msgId and rebuild. Second rebuild might re-send before first's new msgId is registered, causing the second update to arrive at an unregistered msgId. Guard: file-reviewer-app has `if (fileReviewer.getViewer(ownerChatId) !== msgId) return`. Permissions app lacks this check.

7. **`APP_VERSION` not monotonic:** If server reads HTML twice and gets different `APP_VERSION` (e.g., during deployment, file changes on disk mid-request), the version field in manifest may not match the version extracted from HTML. Unlikely in practice. **Mitigation:** Single read + cache.

**Session-map leaks:**

8. **Permissions sessions not cleared on chat unpair:** `permissionsSessions` map lives module-scoped; no cleanup on `cleanup.ts` event. Low-risk but non-zero. Mitigation: call `permissionsSessions.delete(chatId)` on unpair.

9. **File-reviewer `activeViewers` not cleared on chat unpair:** Same issue. Mitigated by `if (ownerChatId === null) return` check, so orphaned msgIds are silently ignored.

10. **Familiar instances cleaned on chat cleanup:** `cleanupFamiliarForChat(chatId)` is called in server.ts, which removes instances from maps + deletes persisted files. Correct.

**Familiar sandbox escape surface:**

11. **Function constructor via prototype chain:** Handler can call `({}).constructor.constructor('return globalThis')()` to break out of shadowed globals. Defence-in-depth; primary gate is user review. **Not a bug:** Documented in familiar-runtime.ts module comment.

12. **`import()` keyword not shadowed:** Handler cannot use `import()` (dynamic import) because it's a keyword and can't be a parameter name. Code checks for regex `/\bimport\s*\(/`. Correct.

13. **`setTimeout`/`setInterval` shadowed:** Handler cannot schedule delayed code. Correct.

**Payload size limits:**

14. File-reviewer and familiar both enforce 120 KB max payload size (`120_000` bytes). Files larger than this are split into chunks via binary search on line counts. Each chunk is sent as a separate update (separate tab). Metadata overhead (~500 bytes) is reserved. Chunks are recombined by the viewer.

**Replay-safety bugs in `setUpdateListener(fn, 0)`:**

15. Permission-prompt.html registers with `setUpdateListener(fn, 0)`, triggering synchronous replay of every update that has ever arrived for this msgId. In practice, each chat has a SINGLE permissions msgId (reused), so stale-replay is rare. Leak vector: if the same chat somehow sends a new msgId, replay could show stale requests. **Mitigation:** `sendPermissionRequest()` reuses the existing msgId via `permissionsSessions` map.

---

**Key invariants:**
- Every `sendUpdate` payload in owned chats MUST include `senderAddr`.
- Every WebXDC app msgId must be registered in `webxdcAppRegistry` before updates are dispatched.
- File-reviewer viewer msgId per chat must be consistent (not double-sent).
- Familiar persistent instances must be valid JSON with required fields (`appId`, `chatId`, `msgId`, `handler`, `html`).
- No in-app state should depend on msgId < app's last registered msgId (prevents replay-after-reregister bugs).
