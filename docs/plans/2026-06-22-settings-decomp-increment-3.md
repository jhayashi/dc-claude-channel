# Settings Decomposition — Increment 3 (create-agent + group-created native moment) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Peel the guided agent-creation flow (catalog → leaf select → mash-up → pattern → review/config) out of the agent-setup monolith into a standalone `create-agent` card, and add the marquee native moment: when a new group is created with Claude and no agent is bound, Claude proactively offers to set one up.

**Architecture:** A new `create-agent` WebXDC card (HTML + `apps/create-app.ts` + `create.ts` build module) reuses the increment-1/2 patterns, opened by `dc_open_create_card({ seedLeaf? })`. **Decision (confirmed): the coach interview stays a chat conversation.** The card owns only the webXDC screens (catalog/wall/mash-up/pattern/review/form) and the `build-agent`/`create` actions; on `build-agent` it calls the existing, dispatcher-entangled `handleBuildAgent` which starts the chat-coach in `coachSessions` — that machinery (`coachSessions`, `handleBuildAgent`, `graduateAgent`, the `advanceCoach` routing in `server.ts`) is NOT moved. The group-created native moment extends increment 2's `MemberAddedToGroup` system-message handler. The monolith's create screens + `build-agent`/`create` dispatch branches are then removed (the `start-default`/`start-reuse`/`rebind` branches stay — they belong to increment 4).

**Tech Stack:** TypeScript/Bun, `@deltachat/jsonrpc-client` 2.53, `xdc-builder`, WebXDCApp interface, Playwright webXDC harness.

**Spec:** `docs/superpowers/specs/2026-06-19-settings-app-decomposition-design.md` (local). Epic #109. Builds on increments 1–2 (the `dc_open_*_card` Rail-2 pattern in `apps/teleport-app.ts`/`apps/contacts-app.ts`; the `MemberAddedToGroup` hook + `dispatcher/member-added-offer.ts` from increment 2).

## Global Constraints

- **Coach stays a chat conversation.** Do NOT move `coachSessions`, `handleBuildAgent`, `graduateAgent`, `startCoach`/`advanceCoach`/`isCoachDone`, or the `advanceCoach` routing in `server.ts` (~lines 2418–2493). The card calls `handleBuildAgent` and the existing flow takes over in chat. Keep those exported from `apps/agent-setup-app.ts` so both `server.ts` and `create-app.ts` import them.
- **No new §6 control command in this increment for the card's own webXDC handlers BEYOND what already exists.** `build-agent`/`create` create a NEW agent/chat for the owner; they are owner-initiated creation, not a control action on an existing bound agent. Gate them with the same `isControlCommandAuthorized` pattern (solo → act; multi-human → needs-confirmation) for consistency and safety, reusing `access/webxdc-control-auth.ts`. (Creation in a multi-human group should require owner confirmation just like teleport/contacts.)
- **`dc_open_create_card`** takes `chat_id` (REQUIRED, the chat to open it in) and optional `seedLeaf` (a leaf id to pre-select, for the NL "I want a sleep coach" path). `requiresCapability: 'infrastructure'`.
- **Catalog init:** the card needs the leaf catalog. The init payload carries `leaves` (`loadAllLeaves()` shaped via `buildL2Summary`) + `symmetricCombines` + `seedLeaf`, exactly as the monolith's `sendInit` does today (see `apps/agent-setup-app.ts:418-445`).
- **WebXDC HTML** carries `var APP_VERSION = 1.00;`; late-init `#shell`; every `sendUpdate` includes `senderAddr: window.webxdc.selfAddr`. Prebuilt committed; `bun run build:xdcs` (use `DC_SKIP_PREBUILT=1` to force a rebuild after an HTML edit that doesn't bump the version).
- **Restart:** server/app/handler changes need a `bun server.ts` restart; cards auto-upgrade.
- **Tests:** unit `bun test <file>`; harness `cd plugin/test/webxdc && bunx playwright test <file>`; full run via `plugin/scripts/run-tests.sh` + `--status`.

---

## Phase A — Group-created native moment

### Task 1: Offer to set up an agent when Claude joins an agentless group

**Files:**
- Modify: `plugin/dispatcher/member-added-offer.ts` (add a second pure helper)
- Modify: `plugin/server.ts` (`handleSystemMessage` `MemberAddedToGroup` branch — add the agent-setup offer)
- Test: `plugin/test/member-added-offer.test.ts` (extend)

**Interfaces:**
- Produces: `shouldOfferAgentSetup(args: { botWasAdded: boolean; chatHasAgent: boolean }): { offer: boolean; reason: string }` — pure. Offer when the bot was just added to a chat with no agent bound.

- [ ] **Step 1: Write the failing test** (append to `plugin/test/member-added-offer.test.ts`)

```typescript
import { shouldOfferAgentSetup } from '../dispatcher/member-added-offer.js'

test('offers agent setup when the bot is added to an agentless chat', () => {
  expect(shouldOfferAgentSetup({ botWasAdded: true, chatHasAgent: false }).offer).toBe(true)
})
test('does not offer agent setup when an agent is already bound', () => {
  expect(shouldOfferAgentSetup({ botWasAdded: true, chatHasAgent: true }).offer).toBe(false)
})
test('does not offer agent setup when the bot was not the added member', () => {
  expect(shouldOfferAgentSetup({ botWasAdded: false, chatHasAgent: false }).offer).toBe(false)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd plugin && bun test test/member-added-offer.test.ts`
Expected: FAIL — `shouldOfferAgentSetup` not exported.

- [ ] **Step 3: Implement the helper** (append to `plugin/dispatcher/member-added-offer.ts`)

```typescript
/**
 * Decide whether to proactively offer to SET UP AN AGENT for a chat — the
 * marquee group-created native moment. Pure: server.ts gathers whether the
 * bot was the just-added member and whether the chat already has an agent.
 */
export function shouldOfferAgentSetup(args: {
  botWasAdded: boolean
  chatHasAgent: boolean
}): { offer: boolean; reason: string } {
  if (!args.botWasAdded) return { offer: false, reason: 'bot-not-added' }
  if (args.chatHasAgent) return { offer: false, reason: 'agent-already-bound' }
  return { offer: true, reason: 'bot-joined-agentless-group' }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd plugin && bun test test/member-added-offer.test.ts`
Expected: PASS (all member-added-offer tests).

- [ ] **Step 5: Wire into `server.ts`'s `MemberAddedToGroup` branch**

In the existing `MemberAddedToGroup` branch (added in increment 2, ~server.ts:2025), ALSO compute the agent-setup offer. Determine `botWasAdded`: the bot was the member just added — detect via the added member being `CONTACT_SELF` (id 1). Since the `Message` type doesn't expose the added id directly, use: `botWasAdded = !bindings.getBinding(msg.chatId)?.agentId` is insufficient; instead check whether the chat currently includes the bot and has no agent AND this is the first system message for it. Pragmatic reliable signal: `botWasAdded = (await client.getChatContacts(msg.chatId)).includes(1)` AND the message indicates self-addition — but to keep it robust and avoid false positives, gate on `chatHasAgent = bindings.getBinding(msg.chatId)?.agentId != null`. Compute:

```typescript
const binding = bindings.getBinding(msg.chatId)
const chatHasAgent = binding?.agentId != null
// The bot-added case: a fresh group with the bot present but no agent bound.
const members = await client.getChatContacts(msg.chatId)
const botWasAdded = members.includes(1) && !chatHasAgent
const setupDecision = shouldOfferAgentSetup({ botWasAdded, chatHasAgent })
if (setupDecision.offer) {
  const prompt =
    `[system] You were just added to a new group chat that has no agent set up yet. ` +
    `Briefly offer to set up a specialist agent for this chat (or use one of the owner's existing agents), ` +
    `and mention they can say "set up an agent" or describe what they need (e.g. "I want a sleep coach"). ` +
    `Do not create anything yourself; wait for the owner.`
  ctx.dispatchAndCollect?.(msg.chatId, prompt)?.catch((err) =>
    logf('agent-setup-offer: dispatch failed chat=%d: %v', msg.chatId, err))
}
```

Keep it inside the existing try/catch (best-effort, never throws). Ensure the agent-setup offer and the increment-2 permissions offer don't BOTH fire for the same event: the permissions offer requires `isAgentChat` (an agent IS bound) while the setup offer requires no agent bound — they're mutually exclusive by construction. Verify that in the wiring.

- [ ] **Step 6: Commit**

```bash
git add plugin/dispatcher/member-added-offer.ts plugin/server.ts plugin/test/member-added-offer.test.ts
git commit -m "feat(native-moment): offer to set up an agent when Claude joins an agentless group (#109)"
```

---

## Phase B — The create-agent card

### Task 2: `create-agent.html` card + build module + prebuilt

**Files:**
- Create: `plugin/webxdc/create-agent.html`, `plugin/webxdc/create-agent-manifest.toml`, `plugin/webxdc/create-agent-icon.png`
- Create: `plugin/create-agent.ts` (build module — copy `contacts.ts`/`teleport.ts`)
- Modify: `plugin/scripts/build-all-xdcs.ts` (register `buildCreateAgentXDC`)
- Test: `plugin/test/webxdc/create-agent.pw.ts`

**Interfaces:**
- Produces: `buildCreateAgentXDC()` / `getCreateAgentVersion()` from `plugin/create-agent.ts`.
- Protocol (preserve verbatim from the monolith so the ported handlers stay drop-in): server→card `{type:'init', leaves, l2Summary, combines, seedLeaf, availableModels, defaultModel, ...availableToolsPayload}`, `chat-ready`, `chat-failed`; card→server `{type:'build-agent', leafIds, pattern, senderAddr}`, `{type:'create', config, skipPermissions, memoryBoost, archetype, icon, allowedBuiltinTools, allowedMcpServers, senderAddr}`.

- [ ] **Step 1: Write the failing harness test**

```typescript
// plugin/test/webxdc/create-agent.pw.ts
import { test, expect } from "@playwright/test";
import { readdirSync } from "node:fs"; import { join, dirname } from "node:path"; import { fileURLToPath } from "node:url";
import { createHarness, type HarnessHandle } from "./harness.js";
const PREBUILT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "webxdc-prebuilt");
const xdc = () => { const m = readdirSync(PREBUILT).filter(n => n.startsWith("create-agent-v") && n.endsWith(".xdc")).sort(); return join(PREBUILT, m[m.length-1]); };

test("renders shell with no init", async () => {
  const h: HarnessHandle = await createHarness(xdc());
  const errs: string[] = []; h.page.on("pageerror", e => errs.push(String(e)));
  await h.page.waitForSelector('#shell', { state: 'visible', timeout: 4000 });
  await h.close(); expect(errs).toEqual([]);
});

test("init renders the catalog and a seeded leaf is preselected", async () => {
  const h: HarnessHandle = await createHarness(xdc());
  await h.push({ type: 'init', senderAddr: 'server', seedLeaf: 'sleep-coach',
    leaves: [{ id: 'sleep-coach', name: 'Sleep coach', l2: 'Health', path: [], parameter: '', liability: '', pitch: 'Helps you sleep', combinesWith: [] }],
    l2Summary: [{ l2: 'Health', count: 1 }], availableModels: [], defaultModel: null,
    availableBuiltinTools: [], availableMcpServers: [], connectedMcpServers: [] });
  await h.page.waitForSelector('text=Sleep coach', { state: 'visible', timeout: 3000 });
  await h.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd plugin/test/webxdc && bunx playwright test create-agent.pw.ts --reporter=line`
Expected: FAIL — `create-agent-v*.xdc` not found.

- [ ] **Step 3: Write the card + build module**

Port the **`new-chat-mode`** (reduced — only the create path; drop the reuse/default segments, which are increment 4), **`wall-screen`** (the leaf catalog browse + L2 grouping + mash-up chip selection + obvious-lead handling), **`step2`** and **`step3`** (the create form: name, system prompt, model picker, tool picker, skip-permissions, memory-boost, archetype/icon, pattern picker, live badge preview, review) screen markup + ALL their client JS (catalog rendering, leaf selection/combine, `build-agent` and `create` senders, `chat-ready`/`chat-failed` listeners, the GLYPHS/badge-preview logic) out of `plugin/webxdc/agent-setup.html` into `plugin/webxdc/create-agent.html`. Reframe as a standalone card:
- `<div id="shell">` rendered on `DOMContentLoaded`.
- `setUpdateListener(fn, 0)`; on `{type:'init', ...}` populate the catalog from `leaves`/`l2Summary`, the model/tool pickers from the payload, and if `seedLeaf` is present **pre-select that leaf** and open the wall at it.
- `var APP_VERSION = 1.00;`; every `sendUpdate` includes `senderAddr: window.webxdc.selfAddr`.
- The card needs the same GLYPHS injection the agent-setup card uses for badge previews — `create-agent.ts` must mirror `agent-setup.ts`'s `buildInjectedHtml` (glyph + icon-data-uri markers). Copy that injection (it is NOT the plain static pattern; create-agent renders live badge previews like the monolith).

Create `create-agent.ts` (mirror `agent-setup.ts`: `htmlOverride: buildInjectedHtml` with the GLYPH + ICON markers, NOT the plain `contacts.ts` static pattern). Create `create-agent-manifest.toml` (`name = "New Agent"`), `create-agent-icon.png` (`cp plugin/webxdc/agent-setup-icon.png plugin/webxdc/create-agent-icon.png`). Register `buildCreateAgentXDC` in `scripts/build-all-xdcs.ts`.

- [ ] **Step 4: Build + run the harness test**

Run: `cd plugin && bun run build:xdcs` → `built …/create-agent-v1.xdc`.
Run: `cd plugin/test/webxdc && bunx playwright test create-agent.pw.ts --reporter=line` → PASS.

- [ ] **Step 5: Commit**

```bash
git add plugin/webxdc/create-agent.html plugin/webxdc/create-agent-manifest.toml plugin/webxdc/create-agent-icon.png plugin/create-agent.ts plugin/scripts/build-all-xdcs.ts plugin/test/webxdc/create-agent.pw.ts plugin/webxdc-prebuilt/create-agent-v1.xdc
git commit -m "feat(create): create-agent card + build module + harness test (#109)"
```

### Task 3: `apps/create-app.ts` + `dc_open_create_card` tool

**Files:**
- Create: `plugin/apps/create-app.ts`
- Modify: `plugin/apps.ts` (register `createApp`); `plugin/server.ts` (`setControlAuthDeps` wiring for create-app)
- Test: `plugin/test/create-app.test.ts`

**Interfaces:**
- Consumes: `handleBuildAgent` (stays exported from `agent-setup-app.ts`), the form-`create` logic (extract the body of the monolith's `create` branch ~:1678 into an exported `handleCreateAgent(ctx, msgId, sourceChatId, payload, auth)` in `agent-setup-app.ts` so both the monolith-removal and the new app call one function), `isControlCommandAuthorized`, `loadAllLeaves`/`symmetricCombines`/`buildL2Summary`, `buildCreateAgentXDC`/`getCreateAgentVersion`, `models.MODELS`, `availableToolsPayload`.
- Produces: `createApp: WebXDCApp` (`id: 'create-agent'`) with tool `dc_open_create_card({ chat_id, seedLeaf? })`.

- [ ] **Step 1: Write the failing test**

```typescript
// plugin/test/create-app.test.ts
import { test, expect } from 'bun:test'
import { createApp } from '../apps/create-app.js'
test('exposes dc_open_create_card with required chat_id + optional seedLeaf', () => {
  const t = createApp.tools().find(x => x.name === 'dc_open_create_card')
  expect(t).toBeTruthy()
  expect(t!.inputSchema.required).toContain('chat_id')
  expect(t!.inputSchema.properties).toHaveProperty('seedLeaf')
})
test('dc_open_create_card refuses missing chat_id', async () => {
  const res = await createApp.callTool('dc_open_create_card', {}, {} as any)
  expect(res?.isError).toBe(true)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd plugin && bun test test/create-app.test.ts`
Expected: FAIL — `../apps/create-app.js` not found.

- [ ] **Step 3: Implement `create-app.ts`**

Mirror `apps/contacts-app.ts`/`apps/teleport-app.ts`: module-level `createSessions: Map<msgId,chatId>`, `setControlAuthDeps`/`_controlAuthDeps`, an `onWebXDCUpdate` that builds `auth = () => isControlCommandAuthorized(chatId, _controlAuthDeps)` and dispatches:
- `build-agent` → gate on `auth()`; if ok, call `handleBuildAgent(ctx, chatId, payload.leafIds, payload.pattern, resolveOwner)` (the chat-coach takes over). On thrown error, send `{type:'chat-failed', error, senderAddr:'server'}`; on success send `{type:'chat-ready', chatId, senderAddr:'server'}`. (Match the monolith's existing build-agent branch behavior.)
- `create` → gate on `auth()`; if ok, call the extracted `handleCreateAgent(...)`.
Add the `dc_open_create_card({ chat_id, seedLeaf? })` tool: validate `chat_id` (else isError), `buildCreateAgentXDC()`, `sendWebXDC`, store session, `registerWebXDCMsg`, then send the init update carrying `leaves`/`l2Summary`/`combines`/`seedLeaf`/`availableModels`/`defaultModel`/`availableToolsPayload(ctx)` (mirror `sendInit` in `agent-setup-app.ts:418-450`; reuse those helpers). Register `createApp` in `apps.ts`; wire `setControlAuthDeps` in `server.ts main()`.

Before this task: extract the monolith `create` branch body (~:1678) into `export async function handleCreateAgent(ctx, msgId, sourceChatId, payload, auth)` in `agent-setup-app.ts`, gated by `auth` (same pattern as `handleAssignRole`). Leave the monolith branch calling it (until Task 4 removes the branch).

- [ ] **Step 4: Run the test**

Run: `cd plugin && bun test test/create-app.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugin/apps/create-app.ts plugin/apps.ts plugin/server.ts plugin/apps/agent-setup-app.ts plugin/test/create-app.test.ts
git commit -m "feat(create): create-app with build-agent/create handlers + dc_open_create_card (#109)"
```

---

## Phase C — Peel create out of the monolith

### Task 4: Remove the create screens from agent-setup

**Files:**
- Modify: `plugin/apps/agent-setup-app.ts` (delete the `build-agent` + `create` dispatch branches; KEEP `handleBuildAgent`, `handleCreateAgent`, `coachSessions`, `graduateAgent`, `sendInit`'s catalog helpers — they're shared/needed)
- Modify: `plugin/webxdc/agent-setup.html` (delete `new-chat-mode`, `wall-screen`, `step2`, `step3` screens + their entry points + client JS; KEEP `reuse-picker`, `manage`, contacts-free `step0`; bump `APP_VERSION` 2.19 → 2.20)
- Modify: tests asserting the old monolith create screens/branches

- [ ] **Step 1: Delete the `build-agent` and `create` dispatch branches** from `agent-setup-app.ts`'s `onWebXDCUpdate`. KEEP the exported functions `handleBuildAgent`/`handleCreateAgent` (now called only by `create-app.ts`) and ALL coach/graduate machinery. Do NOT touch `start-default-chat`/`start-reuse-chat`/`rebind-chat` (increment 4).
- [ ] **Step 2: Delete the screens** from `agent-setup.html` — `new-chat-mode`, `wall-screen`, `step2`, `step3` markup + their `show(...)` entry points + the home button that started "create new" + the catalog/build-agent/create client JS. Leave `reuse-picker`/`manage`/`step0` intact. Bump `APP_VERSION` 2.19 → 2.20.
- [ ] **Step 3: Rebuild + full detached suite**

Run: `cd plugin && bun run build:xdcs`
Run: `cd plugin && ./scripts/run-tests.sh` then poll `--status` until done. Expected 0 fail. Update any test asserting the removed monolith create screens/branches (e.g. structural guards, the `agent-creation-e2e.test.ts` if it drove the monolith webXDC path — it calls `handleBuildAgent` directly per the function's doc comment, so it should still pass; verify).

- [ ] **Step 4: Commit**

```bash
git add plugin/apps/agent-setup-app.ts plugin/webxdc/agent-setup.html plugin/webxdc-prebuilt/agent-setup-v2.20.xdc plugin/test
git commit -m "refactor(agent-setup): remove create screens (peeled to create-agent card) (#109)"
```

---

## Done criteria

- `bun run build:xdcs` produces `create-agent-v1.xdc` and bumped `agent-setup-v2.20.xdc`.
- `member-added-offer`, `create-app`, `create-agent.pw` tests pass; full detached suite 0 fail.
- After restart: creating a new group with Claude (no agent) triggers a proactive "set up an agent?" offer; "set up a specialist" / `dc_open_create_card` opens the card; selecting leaves + Build hands off to the chat-coach which interviews and graduates the agent (unchanged behavior); the form `create` path works; the monolith no longer shows the create/wall screens.

## Scope notes

- **The coach interview, `coachSessions`, `handleBuildAgent`, `graduateAgent`, and the `advanceCoach` routing in `server.ts` are NOT moved** — they stay dispatcher-side; the card only triggers them. This is the deliberate boundary that keeps the delicate chat-state-machine untouched.
- `start-default-chat`/`start-reuse-chat`/`rebind-chat` (pick-existing/swap) stay in the monolith — they're increment 4 (agent-manage).
- Creation is gated by §6 (`isControlCommandAuthorized`) for consistency: solo → act; multi-human group → needs-confirmation (owner confirms in chat). Layer-1 cosmetic view still deferred.
- The catalog init payload reuses the monolith's existing `loadAllLeaves`/`buildL2Summary`/`symmetricCombines`/`availableToolsPayload` helpers — do not reimplement.
- **Known limitation (Task 1):** "bot was just added" is detected heuristically (agentless group with the bot present), since the `Message` type doesn't cleanly expose the added contact id. This shares the re-fire/dedup limitation already tracked in #117 (a later member-add to a still-agentless group could re-offer). Acceptable for this pass; fold the dedup into #117's cleanup.
