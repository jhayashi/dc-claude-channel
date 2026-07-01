# Settings Decomposition — Increment 4 (agent-manage + retire the monolith) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Peel the last agent management screens (show / edit / swap / reuse / delete) out of the `agent-setup` monolith into a standalone `agent-manage` card, then **delete `agent-setup.html` + the `agentSetupApp` WebXDCApp entirely** — completing the decomposition.

**Architecture:** A new `agent-manage` WebXDC card (`webxdc/agent-manage.html` + `apps/agent-manage-app.ts` + `agent-manage.ts` build module) reuses the increment-1/2/3 patterns, opened by `dc_open_agent_manage_card({ chat_id })`. The monolith's remaining dispatch handlers (`editRequest`/`saveEdit`/`delete`/`export`/`bind`/`start-default-chat`/`start-reuse-chat`/`rebind-chat`) are extracted into exported, §6-gated functions in `agent-setup-app.ts` (exactly as increment 3 did with `handleCreateAgent`), then called by `agent-manage-app.ts`. **`agent-setup-app.ts` survives as a shared agent-flow helpers module** (it exports functions `create-app.ts`, `server.ts`, and the coach machinery depend on) — only the `agentSetupApp` card object, `sendInit`, and the `dc_open_agent_settings` tool are removed. Cross-card "**+ Create new agent**" is restored by having `agent-manage` send an `open-create` action that opens the increment-3 create-agent card (a shared `openCreateCard()` extracted from `create-app.ts`). After this increment the monolith is gone and creation/management/teleport/contacts each live in their own card.

**Tech Stack:** TypeScript/Bun, `@deltachat/jsonrpc-client` 2.53, `xdc-builder`, WebXDCApp interface, Playwright webXDC harness.

**Spec:** `docs/superpowers/specs/2026-06-19-settings-app-decomposition-design.md` (local). Epic #109. Builds on increments 1–3 (the `dc_open_*_card` Rail-2 pattern in `apps/teleport-app.ts` / `apps/contacts-app.ts` / `apps/create-app.ts`; §6 `access/webxdc-control-auth.ts`; the DC-tool reconcile migration `agents.migrateAgentDcTools()` which auto-grants the new tool to every agent on boot).

## Global Constraints

- **The coach interview + creation flow are NOT touched.** `coachSessions`, `handleBuildAgent`, `handleCreateAgent`, `graduateAgent`, `graduateRefineSession`, `startCoach`/`advanceCoach`/`startRefineCoach`/`isCoachDone`, and the `advanceCoach` routing in `server.ts` (~lines 2454–2549) stay exactly as they are. They remain exported from `agent-setup-app.ts`.
- **Shared survivors — do NOT delete when retiring the monolith.** These exports of `agent-setup-app.ts` are imported by `create-app.ts` and/or `server.ts` and MUST remain: `handleBuildAgent`, `handleCreateAgent`, `resolveOwnerForChat`, `buildL2Summary`, `availableToolsPayload`, `decorateAgentChat`, `setAgentIcon`, `coachSessions`, `graduateAgent`, `graduateRefineSession`, plus the helpers the extracted handlers need (`createReuseChat`, `rebindChat`, `composeIdentityPreamble`, `composeAgentName`, `resolveAttachAgent`, `buildCreateAgentToolsCsv`, `resolveMemoryBoost`, `parseSessions`, `shouldResendCard`). **`listExistingForPicker` is currently NOT exported (`agent-setup-app.ts:334`) — Task 2 adds `export` to it** since `agent-manage-app`'s init and the reuse/edit handlers consume it.
- **§6 authorization.** Every state-changing agent-manage action (`saveEdit`, `delete`, `bind`, `rebind-chat`, `start-default-chat`, `start-reuse-chat`, `open-create`) MUST gate through `isControlCommandAuthorized(chatId, deps)` (solo → act; multi-human group → needs-confirmation), mirroring `handleAssignRole`/`handleCreateAgent`. Read-only `editRequest` and `export` do not need the gate (they surface data the owner already sees; `export` writes only a `.md` attachment to the owner's own chat — treat as low-stakes, no gate).
- **FLAT init payload.** `agent-manage`'s init carries manage/edit fields at the TOP LEVEL: `{ type:'init', version, existingAgents, availableModels, defaultModel, availableBuiltinTools, availableMcpServers, connectedMcpServers, ownerEmail }`. Do NOT ship the monolith's nested `newAgentFlow` catalog — creation is a separate card now.
- **WebXDC HTML** carries `var APP_VERSION = 1.00;`; the card reveals its first screen only after an init push (no bare DOM render); every `sendUpdate` includes `senderAddr: window.webxdc.selfAddr`. Prebuilt committed; rebuild ONLY the agent-manage target (`DC_SKIP_PREBUILT=1` one-liner in Task 1) to avoid unrelated-XDC rebuild noise.
- **DC-tool reconcile is automatic.** Once `dc_open_agent_manage_card` is registered (Task 3), `agents.migrateAgentDcTools()` grants it to every agent on the next `bun server.ts` boot — no manual tool-list edits. Conversely, removing `dc_open_agent_settings` (Task 4) leaves a harmless dead entry in existing agents' allowlists (a tool that no longer exists is ignored by CC); the reconcile migration never removes entries, so this is expected and benign.
- **Restart:** server/app/handler changes need a `bun server.ts` restart; cards auto-upgrade.
- **Tests:** unit `bun test <file>`; harness `cd plugin/test/webxdc && bunx playwright test <file>`; full run via `plugin/scripts/run-tests.sh` + `--status` (poll; never block the foreground — it gets SIGTERM'd under memory pressure). The `badge-patterns.test.ts` resvg-render timeouts are pre-existing/environmental — ignore them; only non-badge failures count.

---

## Phase A — The agent-manage card

### Task 1: `agent-manage.html` card + build module + prebuilt

**Files:**
- Create: `plugin/webxdc/agent-manage.html`, `plugin/webxdc/agent-manage-manifest.toml`, `plugin/webxdc/agent-manage-icon.png`
- Create: `plugin/agent-manage.ts` (build module — copy `plugin/create-agent.ts`, which uses the GLYPHS + icon injection needed for the edit form's badge preview)
- Modify: `plugin/scripts/build-all-xdcs.ts` (register `buildAgentManageXDC`)
- Test: `plugin/test/webxdc/agent-manage.pw.ts`

**Interfaces:**
- Produces: `buildAgentManageXDC()` / `getAgentManageVersion()` from `plugin/agent-manage.ts`.
- Protocol (preserve verbatim from the monolith so the extracted handlers stay drop-in): server→card `{type:'init', existingAgents, availableModels, defaultModel, availableBuiltinTools, availableMcpServers, connectedMcpServers, ownerEmail}`, `{type:'edit', draft, availableModels, defaultModel, ...toolsPayload}`, `{type:'editComplete', name, existingAgents}`, `{type:'exported'}`, `{type:'chat-ready', chatId}`, `{type:'chat-failed', error}`, `{type:'deleted', existingAgents}`. card→server `{type:'editRequest', agentId}`, `{type:'saveEdit', ...}`, `{type:'delete', agentId}`, `{type:'export', agentId}`, `{type:'bind', ...}`, `{type:'start-default-chat'}`, `{type:'start-reuse-chat', agentId}`, `{type:'rebind-chat', agentId}`, and the NEW `{type:'open-create'}` (replaces the removed `gotoCreate`). All include `senderAddr`.

- [ ] **Step 1: Write the failing harness test**

```typescript
// plugin/test/webxdc/agent-manage.pw.ts
import { test, expect } from "@playwright/test";
import { readdirSync } from "node:fs"; import { join, dirname } from "node:path"; import { fileURLToPath } from "node:url";
import { createHarness, type HarnessHandle } from "./harness.js";
const PREBUILT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "webxdc-prebuilt");
const xdc = () => { const m = readdirSync(PREBUILT).filter(n => n.startsWith("agent-manage-v") && n.endsWith(".xdc")).sort(); return join(PREBUILT, m[m.length-1]); };

const INIT = {
  type: "init", senderAddr: "server", ownerEmail: "me@example.com",
  existingAgents: [
    { id: "sleep-coach", name: "Sleep coach", model: "claude-sonnet-4-6", pattern: "checker", bindingCount: 1, trusted: true },
  ],
  availableModels: [{ id: "claude-sonnet-4-6", label: "Sonnet", tier: "sonnet" }],
  defaultModel: "claude-sonnet-4-6",
  availableBuiltinTools: [{ name: "Bash", description: "Run shell commands" }],
  availableMcpServers: [], connectedMcpServers: [],
};

test("init renders the manage list", async () => {
  const h: HarnessHandle = await createHarness(xdc());
  const errs: string[] = []; h.page.on("pageerror", e => errs.push(String(e)));
  await h.push({ ...INIT, version: await h.getAppVersion() });
  await h.page.waitForSelector('#manage-list .agent-row:has-text("Sleep coach")', { state: "visible", timeout: 4000 });
  await h.close(); expect(errs).toEqual([]);
});

test("'+ Create new agent' emits an open-create action (cross-card handoff)", async () => {
  const h: HarnessHandle = await createHarness(xdc());
  await h.push({ ...INIT, version: await h.getAppVersion() });
  await h.page.waitForSelector("#manage-create-btn", { state: "visible", timeout: 3000 });
  await h.page.click("#manage-create-btn");
  // harness.outbound() returns Array<{ update, descr }>; update is the object
  // passed to webxdc.sendUpdate ({ payload: {...} }).
  const out = await h.outbound();
  expect(out.some((o: any) => o.update.payload?.type === "open-create")).toBe(true);
  await h.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd plugin/test/webxdc && bunx playwright test agent-manage.pw.ts --reporter=line`
Expected: FAIL — `agent-manage-v*.xdc` not found.

- [ ] **Step 3: Write the card + build module**

Port these screens' markup + ALL their client JS out of `plugin/webxdc/agent-setup.html` into `plugin/webxdc/agent-manage.html`:
- **`step0`** (home hub) — keep the "Manage agents" and "Start a new chat" entry actions; DROP any action that pointed at removed screens.
- **`new-chat-mode`** (default / reuse hub — two actions `gotoDefaultAgent`/`gotoReusePicker`).
- **`reuse-picker`** (+ `renderReuseList`, `reuseConfirmOk` with its `reuse`/`rebind`/`default` branches, `setReuseConfirmState`, the confirm modal, and the badge rendering `setBadgeSvg`).
- **`manage`** (`renderManageList`, the agent rows, `editAgent`, `deleteAgent`, `#manage-create-btn`).
- **`step3`** (the EDIT form + `populateEditForm`, `populateEditToolPicker`, `saveEdit`, `backFromStep3`, and the scope-parameterized helpers `refreshLivePreview`/`wireSeg`/`wireCustomModelId`/`syncTrustCardFor`/`wireTrustCardFor`/`syncMemoryCardFor`/`wireMemoryCardFor`/`populateModelDropdowns`).
- **`outdated`** (version-mismatch shell).
- The shared `chat-ready`/`chat-failed`/`edit`/`editComplete`/`exported`/`deleted` update-listener branches and `handleChatReady`/`handleChatFailed`.

Reframe as a standalone card:
- No bare DOM render; on `{type:'init'}` populate `existingAgents` into the manage + reuse lists and the model/tool pickers, then `show('step0')` (mirror the monolith's init listener which ends with `show('step0')`).
- **Replace `gotoCreate`/`gotoCreateFromManage`:** the `#manage-create-btn` handler now does `webxdc.sendUpdate({ payload: { type: 'open-create', senderAddr: webxdc.selfAddr } }, 'Open create card')` (NO local screen). Delete `gotoCreate`, `populateForm`/`populateCreateToolPicker`, `createFormOrigin`, `step2` — none of those exist in the monolith anymore (removed in increment 3), so only the `open-create` sender is new.
- `var APP_VERSION = 1.00;`; every `sendUpdate` includes `senderAddr: window.webxdc.selfAddr`.

Create `plugin/agent-manage.ts` by copying `plugin/create-agent.ts` verbatim and renaming: `HTML_PATH`/`MANIFEST_PATH`/`ICON_PATH` → the `agent-manage-*` files; exported functions `buildAgentManageXDC()` / `getAgentManageVersion()`; keep the GLYPH + ICON marker injection (the edit form renders live badge previews). The HTML must contain `/*__GLYPHS__*/{}` and `/*__ICON_DATA_URI__*/` markers.
Create `plugin/webxdc/agent-manage-manifest.toml` (`name = "Manage Agents"`). Create the icon: `cp plugin/webxdc/agent-setup-icon.png plugin/webxdc/agent-manage-icon.png`.
Register in `plugin/scripts/build-all-xdcs.ts`: import `buildAgentManageXDC`, add `{ id: 'agent-manage', build: buildAgentManageXDC }` to `targets`.

- [ ] **Step 4: Build the prebuilt (agent-manage only) + run the harness test**

Run (from `plugin/`):
```bash
DC_SKIP_PREBUILT=1 bun -e 'import {buildAgentManageXDC} from "./agent-manage.js"; import {copyFileSync,unlinkSync} from "node:fs"; import {join} from "node:path"; const O=join(process.cwd(),"webxdc-prebuilt"); const {xdcPath,version}=await buildAgentManageXDC(); const d=join(O,`agent-manage-v${version}.xdc`); copyFileSync(xdcPath,d); unlinkSync(xdcPath); console.log("built",d,version)'
```
Then: `cd plugin/test/webxdc && bunx playwright test agent-manage.pw.ts --reporter=line` → PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add plugin/webxdc/agent-manage.html plugin/webxdc/agent-manage-manifest.toml plugin/webxdc/agent-manage-icon.png plugin/agent-manage.ts plugin/scripts/build-all-xdcs.ts plugin/test/webxdc/agent-manage.pw.ts plugin/webxdc-prebuilt/agent-manage-v1.xdc
git commit -m "feat(agent-manage): agent-manage card + build module + harness test (#109)"
```

---

## Phase B — Handlers + app + tool

### Task 2: Extract the manage/edit/reuse handlers from the monolith into exported functions

**Files:**
- Modify: `plugin/apps/agent-setup-app.ts` (extract the `onWebXDCUpdate` branches at `:1363`(editRequest) / `:1397`(delete) / `:1468`(export) / `:1531`(saveEdit) / `:1700`(bind) / `:1749`(start-default-chat) / `:1767`(start-reuse-chat) / `:1794`(rebind-chat) into exported functions)
- Test: `plugin/test/agent-manage-handlers.test.ts`

**Interfaces:**
- Produces (all exported from `agent-setup-app.ts`), each takes `auth` as the §6 callback where state-changing:
  - `handleEditRequest(ctx, msgId, sourceChatId, agentId)` — read-only; sends `{type:'edit', draft, ...toolsPayload}`.
  - `handleSaveEdit(ctx, msgId, sourceChatId, payload, auth)` — §6-gated; sends `{type:'editComplete', name, existingAgents}` or `{type:'edit_err', message}`.
  - `handleDeleteAgent(ctx, msgId, sourceChatId, agentId, auth)` — §6-gated; sends `{type:'deleted', existingAgents}` or `{type:'delete_err', message}`.
  - `handleExportAgent(ctx, msgId, sourceChatId, agentId)` — low-stakes; sends `{type:'exported'}` + the `.md` attachment.
  - `handleBindAgent(ctx, msgId, sourceChatId, payload, auth)` — §6-gated.
  - `handleStartDefaultChat(ctx, msgId, sourceChatId, auth)` — §6-gated; `{type:'chat-ready', chatId}`/`{type:'chat-failed', error}`.
  - `handleStartReuseChat(ctx, msgId, sourceChatId, agentId, auth)` — §6-gated; same reply shape.
  - `handleRebindChat(ctx, msgId, sourceChatId, agentId, auth)` — §6-gated; same reply shape.
- Consumes: the existing helpers `createReuseChat`, `rebindChat`, `resolveOwnerForChat`, `listExistingForPicker`, `availableToolsPayload`, `legacyDraftFromAgent` (already in the file). **Add `export` to `listExistingForPicker` (`agent-setup-app.ts:334`)** — Task 3's init and these handlers import it.

**Extraction rule:** move the branch body verbatim into the exported function; where the branch currently reads `session.msgId`/`session.sourceChatId`, the function takes `msgId`/`sourceChatId` params instead. Add the §6 gate at the top of each state-changing function, copied from `handleCreateAgent` (`agent-setup-app.ts:1110-1121`):

```typescript
const authResult = await auth()
if (!authResult.ok) {
  const message = authResult.reason === 'needs-confirmation'
    ? "That change has to come from you directly — say it in our chat, or open this from your 1:1 with me."
    : 'No owner found for this chat.'
  await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
    payload: { type: '<action>_err', message, senderAddr: 'server' },
    summary: '<action> unauthorized',
  })).catch(() => {})
  return
}
```

Leave the monolith's `agentSetupApp.onWebXDCUpdate` branches calling these new functions with an always-ok auth (`async () => ({ ok: true as const })`) until Task 4 deletes the monolith — same interim pattern increment 3 used for `handleCreateAgent`.

- [ ] **Step 1: Write the failing test** (the §6 refusal is the highest-value guard — mirror `create-app.test.ts`'s refusal test)

```typescript
// plugin/test/agent-manage-handlers.test.ts
import { test, expect } from 'bun:test'
import { handleDeleteAgent, handleSaveEdit } from '../apps/agent-setup-app.js'

test('handleDeleteAgent refused by §6 → emits delete_err, no delete', async () => {
  const sent: any[] = []
  const ctx: any = { client: { sendWebXDCUpdate: async (_m: number, u: string) => { sent.push(JSON.parse(u).payload) } }, logf: () => {} }
  const auth = async () => ({ ok: false, reason: 'needs-confirmation' as const })
  await handleDeleteAgent(ctx, 99, 42, 'sleep-coach', auth)
  expect(sent.some(p => p.type === 'delete_err')).toBe(true)
  expect(sent.some(p => p.type === 'deleted')).toBe(false)
})

test('handleSaveEdit refused by §6 → emits edit_err, no editComplete', async () => {
  const sent: any[] = []
  const ctx: any = { client: { sendWebXDCUpdate: async (_m: number, u: string) => { sent.push(JSON.parse(u).payload) } }, logf: () => {} }
  const auth = async () => ({ ok: false, reason: 'needs-confirmation' as const })
  await handleSaveEdit(ctx, 99, 42, { type: 'saveEdit', config: { model: 'claude-sonnet-4-6', name: 'x' }, agentId: 'x' }, auth)
  expect(sent.some(p => p.type === 'edit_err')).toBe(true)
  expect(sent.some(p => p.type === 'editComplete')).toBe(false)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd plugin && bun test test/agent-manage-handlers.test.ts`
Expected: FAIL — `handleDeleteAgent` / `handleSaveEdit` not exported.

- [ ] **Step 3: Extract + gate the handlers**

Extract each branch as described in the extraction rule. Add the §6 gate to the state-changing ones. Rewire the monolith branches to call the new functions with always-ok auth. Preserve the existing reply payload types verbatim (`editComplete`, `deleted`, `exported`, `chat-ready`, `chat-failed`) so the card (Task 1) stays drop-in.

- [ ] **Step 4: Run the test + the monolith regression tests**

Run: `cd plugin && bun test test/agent-manage-handlers.test.ts test/agent-setup-app.test.ts`
Expected: PASS (new refusal tests + existing monolith tests still green — the branches now delegate).

- [ ] **Step 5: Commit**

```bash
git add plugin/apps/agent-setup-app.ts plugin/test/agent-manage-handlers.test.ts
git commit -m "refactor(agent-setup): extract manage/edit/reuse handlers as §6-gated exports (#109)"
```

### Task 3: `apps/agent-manage-app.ts` + `dc_open_agent_manage_card` tool + cross-card open-create

**Files:**
- Create: `plugin/apps/agent-manage-app.ts`
- Modify: `plugin/apps/create-app.ts` (extract `openCreateCard`), `plugin/apps.ts` (register `agentManageApp`), `plugin/server.ts` (wire `setControlAuthDeps` for agent-manage)
- Test: `plugin/test/agent-manage-app.test.ts`

**Interfaces:**
- Consumes: the Task-2 handlers; `buildAgentManageXDC`/`getAgentManageVersion`; `isControlCommandAuthorized`; `listExistingForPicker`, `availableToolsPayload`, `models.MODELS`; and `openCreateCard` (newly extracted from `create-app.ts`).
- Produces: `agentManageApp: WebXDCApp` (`id: 'agent-manage'`) with tool `dc_open_agent_manage_card({ chat_id })` (`requiresCapability: 'infrastructure'`); `setControlAuthDeps(deps)`. From `create-app.ts`: `export async function openCreateCard(ctx: AppContext, chatId: number, seedLeaf: string | null): Promise<number>` (the body of the current `dc_open_create_card` callTool: build + send + register + FLAT init; returns msgId). `createApp.callTool` calls it; `agentManageApp` calls it for the `open-create` action.

- [ ] **Step 1: Write the failing test**

```typescript
// plugin/test/agent-manage-app.test.ts
import { test, expect } from 'bun:test'
import { agentManageApp } from '../apps/agent-manage-app.js'

test('exposes dc_open_agent_manage_card with required chat_id', () => {
  const t = agentManageApp.tools().find(x => x.name === 'dc_open_agent_manage_card')
  expect(t).toBeTruthy()
  expect(t!.inputSchema.required).toContain('chat_id')
})

test('dc_open_agent_manage_card refuses missing chat_id', async () => {
  const res = await agentManageApp.callTool('dc_open_agent_manage_card', {}, {} as any)
  expect(res?.isError).toBe(true)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd plugin && bun test test/agent-manage-app.test.ts`
Expected: FAIL — `../apps/agent-manage-app.js` not found.

- [ ] **Step 3: Extract `openCreateCard` + implement `agent-manage-app.ts`**

In `create-app.ts`, extract the body of `dc_open_create_card`'s `callTool` (build XDC → `sendWebXDC` → `createSessions.set` → `registerWebXDCMsg` → FLAT init `sendWebXDCUpdate`) into `export async function openCreateCard(ctx, chatId, seedLeaf): Promise<number>` returning the msgId; have `callTool` call it.

Create `apps/agent-manage-app.ts` mirroring `apps/create-app.ts`: module-level `manageSessions: Map<msgId,chatId>`, `setControlAuthDeps`/`_controlAuthDeps`, and:
- `dc_open_agent_manage_card({ chat_id })` tool: validate `chat_id` (else `isError`), `buildAgentManageXDC()`, `sendWebXDC`, `manageSessions.set`, `registerWebXDCMsg`, then the FLAT init update: `{ type:'init', version: getAgentManageVersion(), existingAgents: await listExistingForPicker(chatId), availableModels: models.MODELS.map(...), defaultModel: models.DEFAULT_MODEL, ...availableToolsPayload(ctx), ownerEmail: <owner address>, senderAddr:'server' }`. (Do NOT ship `newAgentFlow`.)
- `onWebXDCUpdate`: build `auth = () => isControlCommandAuthorized(chatId, _controlAuthDeps)` (fail-safe refuse when unwired) and dispatch: `editRequest`→`handleEditRequest`; `saveEdit`→`handleSaveEdit(...,auth)`; `delete`→`handleDeleteAgent(...,auth)`; `export`→`handleExportAgent`; `bind`→`handleBindAgent(...,auth)`; `start-default-chat`→`handleStartDefaultChat(...,auth)`; `start-reuse-chat`→`handleStartReuseChat(...,auth)`; `rebind-chat`→`handleRebindChat(...,auth)`; and the NEW `open-create`→ gate on `auth()`, then `await openCreateCard(ctx, chatId, null)` (sends the create-agent card into the same chat).
Register `agentManageApp` in `apps.ts`. In `server.ts main()`, add `import { setControlAuthDeps as setManageControlAuthDeps } from './apps/agent-manage-app.js'` and call `setManageControlAuthDeps(controlAuthDeps)` next to the existing `setCreateControlAuthDeps(controlAuthDeps)`.

- [ ] **Step 4: Run the test**

Run: `cd plugin && bun test test/agent-manage-app.test.ts test/create-app.test.ts`
Expected: PASS (agent-manage tool contract + create-app still green after the `openCreateCard` extraction).

- [ ] **Step 5: Commit**

```bash
git add plugin/apps/agent-manage-app.ts plugin/apps/create-app.ts plugin/apps.ts plugin/server.ts plugin/test/agent-manage-app.test.ts
git commit -m "feat(agent-manage): agent-manage-app + dc_open_agent_manage_card + cross-card open-create (#109)"
```

---

## Phase C — Retire the monolith

### Task 4: Delete `agent-setup.html` + the `agentSetupApp` card; repoint openers

**Files:**
- Modify: `plugin/apps/agent-setup-app.ts` (delete `agentSetupApp` WebXDCApp, `sendInit`, the `dc_open_agent_settings` tool, `summonAgentSettings`; KEEP all shared helpers + extracted handlers)
- Delete: `plugin/webxdc/agent-setup.html`, `plugin/agent-setup.ts`, `plugin/webxdc-prebuilt/agent-setup-v2.2.xdc`, `plugin/webxdc/agent-setup-manifest.toml`, `plugin/webxdc/agent-setup-icon.png`, `plugin/test/webxdc/agent-setup-mode-picker.pw.ts`, `plugin/test/webxdc/agent-setup-edit.pw.ts`
- Modify: `plugin/apps.ts` (drop `agentSetupApp` registration), `plugin/scripts/build-all-xdcs.ts` (drop the `agent-setup` target), `plugin/server.ts` (repoint the `summonAgentSettings` caller at `:1478`), `plugin/nl-intents.ts` + any system-prompt/native-moment copy that says "agent settings" / `dc_open_agent_settings`
- Modify: `plugin/test/agent-setup-app.test.ts` (drop assertions on the deleted card/`sendInit`/`dc_open_agent_settings`; keep the shared-helper + handler tests)

- [ ] **Step 1: Repoint the openers.** Replace `dc_open_agent_settings` with `dc_open_agent_manage_card` everywhere it is referenced as the "open settings" affordance: the `server.ts:1478` `summonAgentSettings(ctx, chatId)` call becomes an agent-manage open (call `agentManageApp` / a small `openManageCard(ctx, chatId)` helper, or inline `dc_open_agent_manage_card`); any `nl-intents.ts` and channel-system-prompt text that names `dc_open_agent_settings` → `dc_open_agent_manage_card`. Grep first: `grep -rn "dc_open_agent_settings\|summonAgentSettings\|agent settings" plugin --include=*.ts` and update every hit.
- [ ] **Step 2: Delete the card.** Remove the `agentSetupApp` object, `sendInit`, `listExistingForPicker`'s callers inside `sendInit` (keep `listExistingForPicker` itself — the Task-3 init + handlers use it), the `dc_open_agent_settings` tool def, and `summonAgentSettings` from `agent-setup-app.ts`. KEEP every shared helper + the Task-2 handlers. Remove `agentSetupApp` from `apps.ts` and the `agent-setup` target from `build-all-xdcs.ts`. Delete the HTML/manifest/icon/build-module/prebuilt and the two `agent-setup-*.pw.ts` harness files (their coverage moved to `agent-manage.pw.ts`).
- [ ] **Step 3: Sanity-grep for danglers.** `grep -rn "agentSetupApp\|agent-setup.html\|buildAgentSetupXDC\|dc_open_agent_settings\|summonAgentSettings\|sendInit\b" plugin --include=*.ts --include=*.json` → expect ZERO live references (comments/CHANGELOG aside). `grep -rn "agent-setup" plugin/apps.ts plugin/scripts/build-all-xdcs.ts` → none.
- [ ] **Step 4: Rebuild prebuilts (agent-manage only) + full detached suite.**

Run: `cd plugin && DC_SKIP_PREBUILT=1 bun -e 'import {buildAgentManageXDC} from "./agent-manage.js"; ... ' ` (the Task-1 one-liner, to refresh if the HTML changed).
Run: `cd plugin && ./scripts/run-tests.sh` then poll `./scripts/run-tests.sh --status` until `DC_TEST_EXIT=`. Expected: 0 non-badge failures. Fix any test that referenced the deleted monolith.

- [ ] **Step 5: Commit**

```bash
git add -A plugin
git commit -m "refactor(agent-setup): retire the monolith — agent-manage card replaces it (#109)"
```

---

## Done criteria

- `bun run build:xdcs` produces `agent-manage-v1.xdc`; `agent-setup-*.xdc` is gone.
- `agent-manage.pw.ts`, `agent-manage-handlers.test.ts`, `agent-manage-app.test.ts` pass; full detached suite has 0 non-badge failures.
- `plugin/webxdc/agent-setup.html` and the `agentSetupApp` WebXDCApp no longer exist; `grep -rn "dc_open_agent_settings\|agentSetupApp" plugin --include=*.ts` is empty.
- `agent-setup-app.ts` still exports the shared helpers + the Task-2 handlers, and `create-app.ts` + `server.ts` + the coach routing still bundle and pass.
- After restart: `dc_open_agent_manage_card` opens the manage card (auto-granted to every agent by the reconcile migration); editing / deleting / reusing / rebinding / start-default work; "+ Create new agent" opens the create-agent card; the coach interview and creation flow are unchanged.

## Scope notes

- **The coach interview, creation flow, and all shared helpers are untouched** — only the monolith's *card* (screens + `sendInit` + `dc_open_agent_settings`) is deleted. `agent-setup-app.ts` becomes a shared agent-flow-helpers module.
- **Optional follow-up (not in this increment):** rename `agent-setup-app.ts` → `agent-flows.ts` for clarity now that it holds no app. Deferred to keep import churn (create-app, server, agent-manage-app, tests) out of the critical path; do it as a standalone `git mv` + import-update PR.
- **§6 for state-changing actions only** (saveEdit/delete/bind/rebind/start-*/open-create). `editRequest`/`export` are read/own-chat-only.
- **Cross-card create** uses a server round-trip (`open-create` → `openCreateCard`) because a webXDC card cannot summon another card client-side.
- **DC-tool reconcile** (built 2026-06-30) auto-grants `dc_open_agent_manage_card` to every agent on boot; no manual allowlist edits. The now-dead `dc_open_agent_settings` entry lingering in agents' allowlists is harmless.
- **Known limitation carried forward:** the layer-1 cosmetic "not permissioned" client-side view is still deferred (can't determine viewer-is-owner client-side); §6 remains the real boundary.
- Fold the deferred increment-3 follow-ups (create-agent custom-model harness test; `badge-patterns` 5000ms timeout bump) and #117 minors in alongside this increment or as separate cleanups.
