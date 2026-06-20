# Settings Decomposition — Increment 1 (scaffolding + teleport) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the shared decomposition scaffolding (the `fromId`+membership authorization helper and the Rail-2 "cards-as-tools" mechanism) and prove it by peeling the first card — `teleport` — out of the agent-setup monolith.

**Architecture:** A new `webxdc-control-auth.ts` dispatcher helper authorizes high-stakes webXDC control commands on the **only authenticated identity** (message `fromId` + chat membership), never the spoofable webXDC `senderAddr` (see spec §6). A new `dc_open_teleport_card` MCP tool (mirroring `dc_open_agent_settings`) builds+sends the new `teleport` WebXDC card. The card carries the two teleport entry views and its `onWebXDCUpdate` handlers — ported from the monolith and gated through the new auth helper. The monolith's teleport-out/resume-import screens and handlers are then removed.

**Tech Stack:** TypeScript/Bun, `@deltachat/jsonrpc-client` 2.53, the in-repo `xdc-builder`, the WebXDCApp plugin interface, Playwright webXDC harness.

**Spec:** `docs/superpowers/specs/2026-06-19-settings-app-decomposition-design.md` (local). Epic: **#109**. Trust limitation context: **#110**.

## Global Constraints

- **Authorization basis (spec §6):** authorize control commands on message `fromId` + membership, **never** webXDC `senderAddr` (it is app-relayed and spoofable — verified, dc-core 2.53). Solo group (owner + bot, no other human) → act directly; multi-human group → require an owner `fromId` confirmation.
- **WebXDC version field:** every card HTML carries `var APP_VERSION = N.NN;`; bump on any HTML change (builder reads it). New `teleport.html` starts at `1.00`.
- **Square icons**; **prebuilt** committed under `webxdc-prebuilt/`, regenerated via `bun run build:xdcs`.
- **`dc_resume_in_terminal` stays** — it is the pure-NL resume path (server.ts) and is NOT part of the card peel.
- **Restart:** `server.ts` / app-registration / handler changes need a `bun server.ts` restart; card HTML auto-upgrades.
- **Tests:** unit `cd plugin && bun test <file>`; webXDC harness `cd plugin/test/webxdc && bunx playwright test <file>`. Run the detached suite (`plugin/scripts/run-tests.sh` + `--status`) for the full run to avoid the foreground-OOM artifact.

## Scope notes

- **Task ordering / interdependency:** Task 2 creates the build module *and* registers the `dc_open_teleport_card` tool, but the tool body references `teleportApp` (defined in Task 4). Implement in order **1 → 2(build module only) → 3 → 4(app) → 2(tool registration) → 5**, or treat Tasks 2 and 4 as one reviewable unit. The plan calls this out at the tool-registration step. Do not land the tool's `registerWebXDCMsg(msgId, teleportApp, …)` line until `teleportApp` exists (Task 4).
- **§6 Layer-1 "not permissioned" view is deliberately DEFERRED in this increment** (not omitted). Reason: the cosmetic view needs the card to decide "is the viewer the owner?", which requires comparing `window.webxdc.selfAddr` against the owner's hash — and the server **cannot compute the owner's per-device hash** (the same unauthenticated-`senderAddr` problem, spec §6). So a reliable client-side ownership check isn't available yet. Since Layer 1 is explicitly non-security and the **backend `isControlCommandAuthorized` (Task 1) is the real protection** — and teleport is overwhelmingly used in solo groups where the only human is the owner — the card shows controls to all viewers in this increment and relies on the backend gate. Revisit Layer 1 if/when a trustworthy ownership signal exists (tracked under epic #109).

---

## Phase A — Shared scaffolding

### Task 1: `isControlCommandAuthorized` — the §6 authorization helper

**Files:**
- Create: `plugin/access/webxdc-control-auth.ts`
- Test: `plugin/test/webxdc-control-auth.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ControlAuthDeps {
    /** Human contacts in the chat excluding the bot self (CONTACT_SELF=1). */
    humanMemberCount: (chatId: number) => Promise<number>
    /** The chat owner (account holder). */
    owner: (chatId: number) => number | null
    /** The contactId of the most recent message sender for the chat (the _currentDriver), or null. */
    currentDriver: (chatId: number) => number | null
  }
  /** Decide whether a high-stakes webXDC control command may be acted on now. */
  export async function isControlCommandAuthorized(
    chatId: number,
    deps: ControlAuthDeps,
  ): Promise<{ ok: true } | { ok: false; reason: 'no-owner' | 'needs-confirmation' }>
  ```
- Consumed by: Task 5 (teleport handlers), and every future control card.

- [ ] **Step 1: Write the failing tests**

Create `plugin/test/webxdc-control-auth.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test'
import { isControlCommandAuthorized, type ControlAuthDeps } from '../access/webxdc-control-auth.js'

function deps(over: Partial<{ humans: number; owner: number | null; driver: number | null }>): ControlAuthDeps {
  return {
    humanMemberCount: async () => over.humans ?? 1,
    owner: () => (over.owner === undefined ? 7 : over.owner),
    currentDriver: () => (over.driver === undefined ? null : over.driver),
  }
}

describe('isControlCommandAuthorized', () => {
  test('solo group (1 human = owner only) → authorized directly', async () => {
    const r = await isControlCommandAuthorized(42, deps({ humans: 1 }))
    expect(r).toEqual({ ok: true })
  })

  test('no owner → refused', async () => {
    const r = await isControlCommandAuthorized(42, deps({ humans: 1, owner: null }))
    expect(r).toEqual({ ok: false, reason: 'no-owner' })
  })

  test('multi-human group, last message from owner → authorized', async () => {
    const r = await isControlCommandAuthorized(42, deps({ humans: 3, owner: 7, driver: 7 }))
    expect(r).toEqual({ ok: true })
  })

  test('multi-human group, last message NOT from owner → needs confirmation', async () => {
    const r = await isControlCommandAuthorized(42, deps({ humans: 3, owner: 7, driver: 9 }))
    expect(r).toEqual({ ok: false, reason: 'needs-confirmation' })
  })

  test('multi-human group, no recent driver → needs confirmation', async () => {
    const r = await isControlCommandAuthorized(42, deps({ humans: 3, owner: 7, driver: null }))
    expect(r).toEqual({ ok: false, reason: 'needs-confirmation' })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd plugin && bun test test/webxdc-control-auth.test.ts`
Expected: FAIL — module `../access/webxdc-control-auth.js` not found.

- [ ] **Step 3: Implement the helper**

Create `plugin/access/webxdc-control-auth.ts`:

```typescript
/**
 * Authorize high-stakes webXDC *control* commands (teleport-out, role
 * assignment, agent edit/delete, …) on the only authenticated identity DC
 * offers: the message envelope. webXDC `senderAddr` is app-relayed and
 * spoofable (verified, dc-core 2.53 — see spec §6 / GH #110), so it is NEVER
 * the basis for authorization.
 *
 * Model (account-holder-only):
 *  - Solo group (owner + bot, no other human): the owner is the only human who
 *    could have driven the card → act directly. The common D4C case.
 *  - Multi-human group: the webXDC update's author can't be authenticated, so
 *    require that the chat's most recent message came from the owner
 *    (`_currentDriver` === owner) — i.e. an owner `fromId` confirmation. Else
 *    refuse with `needs-confirmation` and the caller asks the owner to confirm
 *    in chat.
 */

export interface ControlAuthDeps {
  humanMemberCount: (chatId: number) => Promise<number>
  owner: (chatId: number) => number | null
  currentDriver: (chatId: number) => number | null
}

export async function isControlCommandAuthorized(
  chatId: number,
  deps: ControlAuthDeps,
): Promise<{ ok: true } | { ok: false; reason: 'no-owner' | 'needs-confirmation' }> {
  const owner = deps.owner(chatId)
  if (owner == null) return { ok: false, reason: 'no-owner' }

  const humans = await deps.humanMemberCount(chatId)
  if (humans <= 1) return { ok: true } // solo group: owner is the only human

  // Multi-human: require an authenticated owner confirmation via the last message.
  if (deps.currentDriver(chatId) === owner) return { ok: true }
  return { ok: false, reason: 'needs-confirmation' }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd plugin && bun test test/webxdc-control-auth.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd /var/home/jhayashi/src/dc-claude-channel
git add plugin/access/webxdc-control-auth.ts plugin/test/webxdc-control-auth.test.ts
git commit -m "feat(access): isControlCommandAuthorized — fromId+membership gate for webXDC control commands (#109)"
```

**Wiring note (consumed in Task 5):** production `ControlAuthDeps` are built in `server.ts` from existing primitives — `humanMemberCount` via `client.getChatContacts(chatId)` filtered to exclude `CONTACT_SELF` (id 1); `owner` via `access.firstPermissionedContact`; `currentDriver` via the existing `_currentDriver` map (`_currentDriver.get(chatId)?.contactId ?? null`).

---

### Task 2: `dc_open_teleport_card` MCP tool + the card build module

**Files:**
- Create: `plugin/teleport.ts` (build module)
- Create: `plugin/webxdc/teleport-manifest.toml`
- Create: `plugin/webxdc/teleport-icon.png` (square)
- Modify: `plugin/scripts/build-all-xdcs.ts` (register `buildTeleportXDC`)
- Modify: `plugin/server.ts` (register the `dc_open_teleport_card` tool)
- Test: `plugin/test/teleport-tool.test.ts`

**Interfaces:**
- Produces: `buildTeleportXDC(): Promise<{ xdcPath: string; version: number }>` and `getTeleportVersion(): number` (from `plugin/teleport.ts`).
- Produces: MCP tool `dc_open_teleport_card({ chat_id?, view?: 'here' | 'to_cli' })` — sends the teleport card into the chat, seeded to the requested entry view (default `to_cli`).

- [ ] **Step 1: Write the failing build-module test**

Create `plugin/test/teleport-tool.test.ts`:

```typescript
import { test, expect } from 'bun:test'
import { getTeleportVersion } from '../teleport.js'

test('teleport build module reports a numeric APP_VERSION from the HTML', () => {
  const v = getTeleportVersion()
  expect(typeof v).toBe('number')
  expect(v).toBeGreaterThanOrEqual(1.0)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd plugin && bun test test/teleport-tool.test.ts`
Expected: FAIL — `../teleport.js` not found (and `teleport.html` not yet created; created in Task 3).

- [ ] **Step 3: Create the build module**

Create `plugin/teleport.ts` (static-ish card; no compile-time injection):

```typescript
/** Teleport WebXDC builder. Mirrors the other thin card build modules. */
import { join } from 'node:path'
import { buildXDC, getAppVersion } from './xdc-builder.js'

const HTML_PATH = join(import.meta.dir, 'webxdc', 'teleport.html')
const MANIFEST_PATH = join(import.meta.dir, 'webxdc', 'teleport-manifest.toml')
const ICON_PATH = join(import.meta.dir, 'webxdc', 'teleport-icon.png')
const PREBUILT_DIR = join(import.meta.dir, 'webxdc-prebuilt')

export function getTeleportVersion(): number {
  return getAppVersion(HTML_PATH)
}

export async function buildTeleportXDC(): Promise<{ xdcPath: string; version: number }> {
  return buildXDC({
    htmlPath: HTML_PATH,
    manifestPath: MANIFEST_PATH,
    iconPath: ICON_PATH,
    prebuiltDir: PREBUILT_DIR,
  })
}
```

Create `plugin/webxdc/teleport-manifest.toml`:

```toml
name = "Teleport"
```

Create the icon: `cp plugin/webxdc/agent-setup-icon.png plugin/webxdc/teleport-icon.png` (valid square placeholder; refine later).

(`teleport.html` is created in Task 3; this test stays red until then — that's fine, it's the same task group.)

- [ ] **Step 4: Register in the prebuilt pipeline**

Modify `plugin/scripts/build-all-xdcs.ts`: add `import { buildTeleportXDC } from '../teleport.js'` with the other imports, and `{ id: 'teleport', build: buildTeleportXDC },` to the `targets` array.

- [ ] **Step 5: Register the MCP tool in `server.ts`**

In the dc-tools object (alongside `dc_open_agent_settings`, ~line 1258 region), add:

```typescript
  dc_open_teleport_card: async (args, callerChatId) => {
    const chatId = typeof args?.chat_id === 'string' ? parseInt(args.chat_id, 10) : callerChatId
    if (!chatId || Number.isNaN(chatId) || !isAllowed(chatId)) {
      return { content: [{ type: 'text' as const, text: 'dc_open_teleport_card: chat not accessible' }], isError: true }
    }
    const view = args?.view === 'here' ? 'here' : 'to_cli'
    const { buildTeleportXDC } = await import('./teleport.js')
    const { xdcPath } = await buildTeleportXDC()
    const msgId = await client.sendWebXDC(chatId, xdcPath)
    try { const { unlinkSync } = await import('node:fs'); unlinkSync(xdcPath) } catch {}
    // Register for owner-verified update routing + seed the entry view.
    ctx.registerWebXDCMsg(msgId, teleportApp, chatId)
    await client.sendWebXDCUpdate(msgId, JSON.stringify({ payload: { type: 'init', view, senderAddr: 'server' }, summary: 'Teleport' }))
    return { content: [{ type: 'text' as const, text: `Teleport card opened in chat ${chatId} (view=${view}).` }] }
  },
```

Add its tool schema to the dc-tools `tools()` list:

```typescript
  { name: 'dc_open_teleport_card', description: 'Open the Teleport card to move a session to the terminal (view "to_cli") or import a terminal session into this chat (view "here").', inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, view: { type: 'string', enum: ['here', 'to_cli'] } } }, requiresCapability: 'real_world_action' },
```

(`teleportApp` comes from Task 4's `apps/teleport-app.js` — see Scope notes: land this `registerWebXDCMsg` line only after Task 4 exists.)

- [ ] **Step 6: Build, run the module test, smoke the tool wiring**

Run: `cd plugin && bun run build:xdcs` → expect `built …/teleport-v1.00.xdc`.
Run: `cd plugin && bun test test/teleport-tool.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add plugin/teleport.ts plugin/webxdc/teleport-manifest.toml plugin/webxdc/teleport-icon.png plugin/scripts/build-all-xdcs.ts plugin/server.ts plugin/test/teleport-tool.test.ts plugin/webxdc-prebuilt/teleport-v1.00.xdc
git commit -m "feat(teleport): build module + dc_open_teleport_card tool (#109)"
```

---

## Phase B — Teleport card

### Task 3: `teleport.html` — the two entry views + late-init shell

**Files:**
- Create: `plugin/webxdc/teleport.html`
- Test: `plugin/test/webxdc/teleport.pw.ts`

**Interfaces (message protocol — preserved verbatim from the monolith so the ported handlers in Task 5 are drop-in):**
- Card → server: `{type:'teleport_out_list_request'}`, `{type:'teleport_out_commit', requestId, chatId, jobDisposition?}`, `{type:'resume_list_request', requestId}`, `{type:'resume_attach', requestId, sessionId}` — every outgoing payload includes `senderAddr: window.webxdc.selfAddr`.
- Server → card: `{type:'init', view}`, `teleport_out_list`, `teleport_out_progress`, `teleport_out_error`, `teleport_out_done`, `resume_list`, `resume_attach_ok`, `resume_attach_err`.

- [ ] **Step 1: Write the failing harness test**

Create `plugin/test/webxdc/teleport.pw.ts` (renders shell with no init; seeds `to_cli` view; lists chats; switches to `here` view):

```typescript
import { test, expect } from "@playwright/test";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness, type HarnessHandle } from "./harness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PREBUILT_DIR = join(HERE, "..", "..", "webxdc-prebuilt");
const xdc = () => { const m = readdirSync(PREBUILT_DIR).filter(n => n.startsWith("teleport-v") && n.endsWith(".xdc")).sort(); return join(PREBUILT_DIR, m[m.length - 1]); };

test("renders late-init shell with no init", async () => {
  const h: HarnessHandle = await createHarness(xdc());
  const errs: string[] = []; h.page.on("pageerror", e => errs.push(String(e)));
  await h.page.waitForSelector('#shell', { state: 'visible', timeout: 4000 });
  await h.close();
  expect(errs).toEqual([]);
});

test("init view=to_cli requests the teleport-out list and renders rows", async () => {
  const h: HarnessHandle = await createHarness(xdc());
  await h.push({ type: 'init', view: 'to_cli', senderAddr: 'server' });
  // The card should emit a teleport_out_list_request; reply with one row.
  await h.push({ type: 'teleport_out_list', rows: [{ chatId: 42, chatName: 'Health', agentName: 'Coach', isLive: true, jobCount: 0, isCurrent: true }], senderAddr: 'server' });
  await h.page.waitForSelector('text=Health', { state: 'visible', timeout: 3000 });
  await h.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd plugin/test/webxdc && bunx playwright test teleport.pw.ts --reporter=line`
Expected: FAIL — `teleport-v*.xdc` not found (HTML not yet written).

- [ ] **Step 3: Write `teleport.html`**

Create `plugin/webxdc/teleport.html`. Port the **teleport-out** and **resume-import** screen markup and their client logic from `plugin/webxdc/agent-setup.html` (the `teleport-out` and `resume-import` screens + their `teleport_out_*` / `resume_*` senders/listeners), into a standalone card with:
- A root `<div id="shell">` rendered immediately on `DOMContentLoaded` (late-init shell — never blank).
- `setUpdateListener(fn, 0)`; on `{type:'init', view}` show the `to_cli` view (and immediately send `{type:'teleport_out_list_request', senderAddr: selfAddr}`) or the `here` view (send `{type:'resume_list_request', requestId, senderAddr: selfAddr}`).
- A toggle to switch between the two views (GUI nav), re-issuing the matching `*_request`.
- The `to_cli` list must **pin the current chat's row at the top** (`isCurrent: true` sorts first), per spec §3.3.
- `var APP_VERSION = 1.00;`
- Every outgoing `sendUpdate` payload includes `senderAddr: window.webxdc.selfAddr` (required by `webxdc-filter.ts` / `familiar-runtime` convention).

(Reproduce the existing screens' markup/handlers; only the framing — single-purpose card, `#shell`, the `init.view` seeding, and the current-row pin — is new.)

- [ ] **Step 4: Build the prebuilt and run the harness test**

Run: `cd plugin && bun run build:xdcs` → `built …/teleport-v1.00.xdc`.
Run: `cd plugin/test/webxdc && bunx playwright test teleport.pw.ts --reporter=line` → PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add plugin/webxdc/teleport.html plugin/test/webxdc/teleport.pw.ts plugin/webxdc-prebuilt/teleport-v1.00.xdc
git commit -m "feat(teleport): teleport.html two-view card + harness test (#109)"
```

---

### Task 4: `apps/teleport-app.ts` — ported handlers, gated by Task 1

**Files:**
- Create: `plugin/apps/teleport-app.ts`
- Modify: `plugin/apps.ts` (register `teleportApp`)
- Modify: `plugin/server.ts` (build `ControlAuthDeps` and pass to the app via `AppContext` or module init)
- Test: `plugin/test/teleport-app.test.ts`

**Interfaces:**
- Consumes: `isControlCommandAuthorized` (Task 1), `buildTeleportOutList` + `TeleportOutChat`/`TeleportOutListCtx` (exported from the monolith `apps/agent-setup-app.ts:217-308` — re-export or move into a shared `teleport-core.ts`; see note), `resume.buildResumeCommand` / `resume.listResumeCandidates`.
- Produces: `teleportApp: WebXDCApp` (`id: 'teleport'`), consumed by Task 2's tool registration and `apps.ts`.

- [ ] **Step 1: Write the failing handler tests**

Create `plugin/test/teleport-app.test.ts`. Assert the authorization wrapper: a `teleport_out_commit` in a **multi-human group with a non-owner driver** is **refused** (emits `teleport_out_error` step `auth`, does NOT call `buildResumeCommand`/`evictChat`); the same in a **solo group** proceeds. Use injected fakes for `ControlAuthDeps` + a spy `client`.

```typescript
import { test, expect } from 'bun:test'
import { handleTeleportOutCommit } from '../apps/teleport-app.js'

function fakes(authOk: boolean) {
  const sent: any[] = []
  const calls = { build: 0, evict: 0 }
  const ctx: any = {
    client: { sendWebXDCUpdate: async (_m: number, u: string) => { sent.push(JSON.parse(u).payload) }, send: async () => {}, getChatName: async () => 'X' },
    subagentCache: { evictChat: async () => { calls.evict++ } },
    scheduleStore: { deleteForChat: () => 0, moveForChat: () => 0 },
    cleanupChatState: async () => {}, logf: () => {},
  }
  const auth = async () => authOk ? { ok: true } as const : { ok: false, reason: 'needs-confirmation' } as const
  return { ctx, sent, calls, auth }
}

test('refuses teleport_out_commit when not authorized → emits auth error, no side effects', async () => {
  const { ctx, sent, calls, auth } = fakes(false)
  await handleTeleportOutCommit(ctx, 99 /*msgId*/, { requestId: 1, chatId: 42 }, auth)
  expect(sent.some(p => p.type === 'teleport_out_error' && p.step === 'auth')).toBe(true)
  expect(calls.evict).toBe(0)
})

test('authorized → passes the gate (no auth error emitted)', async () => {
  const { ctx, sent, auth } = fakes(true)
  await handleTeleportOutCommit(ctx, 99, { requestId: 1, chatId: 42 }, auth)
  // The real assertion: when authorized, the handler does NOT short-circuit
  // with an auth error — it proceeds into the teleport flow.
  expect(sent.some(p => p.type === 'teleport_out_error' && p.step === 'auth')).toBe(false)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd plugin && bun test test/teleport-app.test.ts`
Expected: FAIL — `../apps/teleport-app.js` not found.

- [ ] **Step 3: Implement `apps/teleport-app.ts`**

Move the four handlers from `apps/agent-setup-app.ts` (`resume_list_request` :1552–1572, `teleport_out_commit` :1574–1673, `teleport_out_list_request` :1676–1712, `resume_attach` :1714–1824) into `apps/teleport-app.ts`, wrapped in a `WebXDCApp` with `id: 'teleport'` and an `onWebXDCUpdate` that dispatches by `payload.type`. Export each state-changing handler (e.g. `handleTeleportOutCommit(ctx, msgId, payload, auth)`) so it's unit-testable. **Change vs. the monolith:** at the top of every *state-changing* handler (`teleport_out_commit`, `resume_attach`), call the injected `auth()` (bound to `isControlCommandAuthorized` for the chat) and, if `!ok`, emit the matching `*_error` with `step: 'auth'` + a message ("Confirm in chat: send 'yes, teleport' to authorize." for `needs-confirmation`) and return without side effects. The read-only list handlers (`teleport_out_list_request`, `resume_list_request`) do **not** need the gate. Replace the `agentSetup.getAgentSetupVersion()` calls in the payloads with `getTeleportVersion()` (Task 2). Keep `chatAction: 'none'` on `cleanupChatState` (the SMTP-poison fix — do not change to 'leave').

`buildTeleportOutList` + its types currently live in `agent-setup-app.ts:217-234,280-308` — move them into a new `plugin/teleport-core.ts` and import from both the teleport app and (until Phase C removes it) the monolith, to avoid a circular import.

- [ ] **Step 4: Register the app**

Modify `plugin/apps.ts`: `import { teleportApp } from './apps/teleport-app.js'` and add `teleportApp` to the `apps` array.

In `server.ts`, build the production `ControlAuthDeps` (see Task 1 wiring note) and make them reachable to the teleport handlers (pass via a module-level setter `teleport-app.ts` exposes, or via `AppContext`). The app's `onWebXDCUpdate` binds `auth = () => isControlCommandAuthorized(chatId, controlAuthDeps)`.

- [ ] **Step 5: Run the handler tests**

Run: `cd plugin && bun test test/teleport-app.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add plugin/apps/teleport-app.ts plugin/teleport-core.ts plugin/apps.ts plugin/server.ts plugin/test/teleport-app.test.ts
git commit -m "feat(teleport): teleport-app with fromId+membership-gated handlers (#109)"
```

---

## Phase C — Peel the teleport screens out of the monolith

### Task 5: Remove teleport-out/resume-import from agent-setup

**Files:**
- Modify: `plugin/apps/agent-setup-app.ts` (delete the four moved handlers; keep `buildTeleportOutList` import from `teleport-core.ts` only if still referenced, else drop)
- Modify: `plugin/webxdc/agent-setup.html` (delete the `teleport-out` + `resume-import` screens, their nav entries, and `APP_VERSION` bump)
- Modify: tests referencing the removed monolith teleport behavior

- [ ] **Step 1: Delete the moved handlers** from `apps/agent-setup-app.ts` (the four `payload.type === '…'` blocks now living in `teleport-app.ts`). Remove now-unused imports. Leave `dc_resume_in_terminal` (server.ts) untouched.

- [ ] **Step 2: Delete the screens** from `agent-setup.html` — the `teleport-out` and `resume-import` screen markup + their `show('teleport-out')`/`show('resume-import')` entry points and the home-screen buttons that opened them. Bump `agent-setup.html` `APP_VERSION` (e.g. 2.17 → 2.18).

- [ ] **Step 3: Rebuild prebuilt + run the full suite (detached)**

Run: `cd plugin && bun run build:xdcs`
Run: `cd plugin && ./scripts/run-tests.sh` then poll `./scripts/run-tests.sh --status` until done. Expected: 0 fail. Fix any test that asserted the old monolith teleport screens (update to expect them absent / routed to the card).

- [ ] **Step 4: Commit**

```bash
git add plugin/apps/agent-setup-app.ts plugin/webxdc/agent-setup.html plugin/webxdc-prebuilt/agent-setup-v2.18.xdc plugin/test
git commit -m "refactor(agent-setup): remove teleport screens (peeled to teleport card) (#109)"
```

---

## Done criteria

- `bun run build:xdcs` produces `teleport-v1.00.xdc` and the bumped `agent-setup-v2.18.xdc`.
- `webxdc-control-auth.test.ts`, `teleport-tool.test.ts`, `teleport-app.test.ts`, `teleport.pw.ts` all pass; full detached suite 0 fail.
- After a `bun server.ts` restart: "teleport this session" / `dc_open_teleport_card` opens the teleport card (pinned current row); committing teleport-out in a solo group works; in a multi-human group with a non-owner last-message, the commit is refused with the confirm-in-chat message.
- The monolith no longer shows teleport-out/resume-import screens; `dc_resume_in_terminal` still works.

## Manual smoke test (after restart)

1. Restart the dispatcher.
2. In a solo agent chat, say "teleport this session" → card opens to the to-CLI view, current chat pinned → commit → resume command posts, binding cleared.
3. Open the card's "here" view → import a terminal session → new chat created.
