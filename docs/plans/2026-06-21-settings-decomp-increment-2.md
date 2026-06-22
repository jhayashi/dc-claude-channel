# Settings Decomposition — Increment 2 (contacts-roles + native moments) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Peel the contacts/role-picker out of the agent-setup monolith into a standalone `contacts-roles` card (gated by the §6 auth helper), and add the first native-moment offer — Claude proactively asks "who can use this agent?" when an unpermissioned person joins an agent chat.

**Architecture:** A new `contacts-roles` WebXDC card (HTML + `apps/contacts-app.ts` + `contacts.ts` build module) reuses the increment-1 patterns: opened by a new `dc_open_contacts_card` Rail-2 tool, its one state-changing command (`assign_role`) gated through `isControlCommandAuthorized` (which `handleAssignRole` does NOT currently do — it only logs the sender). The native moment hooks DC's `MemberAddedToGroup` system message in `server.ts`'s existing `handleSystemMessage`, injecting a prompt via `dispatchAndCollect` when an unpermissioned human joins an agent chat. Finally the contacts/role-picker screens are removed from the monolith.

**Tech Stack:** TypeScript/Bun, `@deltachat/jsonrpc-client` 2.53, `xdc-builder`, WebXDCApp interface, Playwright webXDC harness.

**Spec:** `docs/superpowers/specs/2026-06-19-settings-app-decomposition-design.md` (local). Epic #109. Builds directly on increment 1 (v1.4.15): `isControlCommandAuthorized` (`access/webxdc-control-auth.ts`), the Rail-2 tool/build/app/prebuilt pattern (see `apps/teleport-app.ts`, `teleport.ts`).

## Global Constraints

- **§6 authorization:** the card's state-changing command (`assign_role`) MUST gate on `isControlCommandAuthorized(chatId, deps)` — authorize on message `fromId` + membership, never webXDC `senderAddr` (spoofable; #110). Solo chat → act; multi-human group → `needs-confirmation`. Read-only `list_contacts` is NOT gated.
- **Role vocabulary (verbatim, from `access/capability-bundles.ts`):** `subscriber`, `trusted-agent`, `family-member`, `untrusted-agent`, `guest`, `no-permissions`. The card's role picker must offer exactly these.
- **Picker scope:** the contacts universe is members of chats bound to the **managed agent** (`bindings.listBindings().filter(b => b.agentId === managedAgentId)`), excluding contact ids ≤ 9 and the bot's own address — exactly as `handleListContacts` does today. Do not widen it.
- **Native moment = injected prompt, not a hardcoded card send.** `dispatchAndCollect` lets Claude phrase the offer and decide; suppress it when the new member is already permissioned.
- **WebXDC HTML** carries `var APP_VERSION = 1.00;`; late-init `#shell`; every `sendUpdate` includes `senderAddr: window.webxdc.selfAddr`. Prebuilt committed; regenerate via `bun run build:xdcs` (use `DC_SKIP_PREBUILT=1` to force a rebuild after an HTML edit that doesn't bump the version).
- **Restart:** `server.ts`/app-registration/handler changes need a `bun server.ts` restart; cards auto-upgrade.
- **Tests:** unit `cd plugin && bun test <file>`; harness `cd plugin/test/webxdc && bunx playwright test <file>`; full run via `plugin/scripts/run-tests.sh` + `--status` (detached, avoids the foreground-OOM artifact).

---

## Phase A — Gate the contacts control command (§6)

### Task 1: Route `handleAssignRole` through `isControlCommandAuthorized`

**Files:**
- Modify: `plugin/apps/agent-setup-app.ts` (`handleAssignRole`, ~:1109-1150) — add the gate. (This handler moves to `contacts-app.ts` in Task 3; gate it here first so the behavior change is reviewed in isolation, then the move is a pure relocation.)
- Test: `plugin/test/agent-setup-app.test.ts` (or the contacts test file) — assert refusal when unauthorized.

**Interfaces:**
- Consumes: `isControlCommandAuthorized(chatId, deps)` + `ControlAuthDeps` from `access/webxdc-control-auth.js`; the production deps are already built in `server.ts` (`setControlAuthDeps`, increment 1) — expose them to the handler the same way `teleport-app` receives them (a module-level `setControlAuthDeps` / injected `auth` callback). For this task, add an `auth` parameter to `handleAssignRole` so it is unit-testable, mirroring `handleTeleportOutCommit`.
- Produces: `handleAssignRole(ctx, msgId, sourceChatId, contactId, role, senderAddr, auth)` — new trailing `auth` param.

- [ ] **Step 1: Write the failing test**

```typescript
// plugin/test/contacts-auth.test.ts
import { test, expect } from 'bun:test'
import { handleAssignRole } from '../apps/agent-setup-app.js'

test('assign_role refused when not authorized → emits role_assign_err, no write', async () => {
  const sent: any[] = []
  let wrote = false
  const ctx: any = {
    client: { sendWebXDCUpdate: async (_m: number, u: string) => { sent.push(JSON.parse(u).payload) }, getContact: async () => ({}), lookupContactByAddr: async () => null },
    logf: () => {},
  }
  // Spy: if setContactRole were called, wrote=true — but auth refuses first.
  const auth = async () => ({ ok: false, reason: 'needs-confirmation' as const })
  await handleAssignRole(ctx, 99, 42, 11, 'subscriber', 'hash', auth)
  expect(sent.some(p => p.type === 'role_assign_err')).toBe(true)
  expect(sent.some(p => p.type === 'role_assigned')).toBe(false)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd plugin && bun test test/contacts-auth.test.ts`
Expected: FAIL — `handleAssignRole` has no `auth` param / doesn't emit `role_assign_err`.

- [ ] **Step 3: Add the gate**

In `handleAssignRole` (`apps/agent-setup-app.ts`), add the `auth` param and gate at the top, before `setContactRole`:

```typescript
export async function handleAssignRole(
  ctx: AppContext,
  msgId: number,
  sourceChatId: number,
  contactId: number | null,
  role: string | null,
  senderAddr: string | null,
  auth: () => Promise<{ ok: true } | { ok: false; reason: 'no-owner' | 'needs-confirmation' }>,
): Promise<void> {
  if (!contactId || !role) return
  const authResult = await auth()
  if (!authResult.ok) {
    const message = authResult.reason === 'needs-confirmation'
      ? "Setting permissions in a group has to come from you directly — say it in our chat, or open this from your 1:1 with me."
      : 'No owner found for this chat.'
    await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
      payload: { type: 'role_assign_err', contactId, message, senderAddr: 'server' },
    })).catch(() => {})
    return
  }
  // ... existing body unchanged (managedAgentId, setContactRole, logRoleAssignment, role_assigned emit) ...
}
```

Update the existing call site in the `assign_role` dispatch (`agent-setup-app.ts` ~:1896) to pass an `auth` callback bound to the chat (built from the injected control-auth deps, same wiring as teleport-app). The card must handle a new `role_assign_err` payload (Task 2 adds the UI).

- [ ] **Step 4: Run to verify it passes**

Run: `cd plugin && bun test test/contacts-auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugin/apps/agent-setup-app.ts plugin/test/contacts-auth.test.ts
git commit -m "feat(contacts): gate assign_role through §6 isControlCommandAuthorized (#109)"
```

---

## Phase B — The contacts-roles card

### Task 2: `contacts.html` card + build module + prebuilt

**Files:**
- Create: `plugin/webxdc/contacts.html`, `plugin/webxdc/contacts-manifest.toml`, `plugin/webxdc/contacts-icon.png`
- Create: `plugin/contacts.ts` (build module — copy `teleport.ts`, swap names)
- Modify: `plugin/scripts/build-all-xdcs.ts` (register `buildContactsXDC`)
- Test: `plugin/test/webxdc/contacts.pw.ts`

**Interfaces:**
- Produces: `buildContactsXDC()` / `getContactsVersion()` from `plugin/contacts.ts`.
- Protocol (preserve verbatim so Task 3's ported handlers are drop-in): card→server `{type:'list_contacts', senderAddr}`, `{type:'assign_role', contactId, role, senderAddr}`; server→card `{type:'init'}`, `{type:'contacts_loaded', contacts}`, `{type:'role_assigned', contact}`, `{type:'role_assign_err', contactId, message}` (new — render inline on the role picker).

- [ ] **Step 1: Write the failing harness test**

```typescript
// plugin/test/webxdc/contacts.pw.ts
import { test, expect } from "@playwright/test";
import { readdirSync } from "node:fs"; import { join, dirname } from "node:path"; import { fileURLToPath } from "node:url";
import { createHarness, type HarnessHandle } from "./harness.js";
const PREBUILT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "webxdc-prebuilt");
const xdc = () => { const m = readdirSync(PREBUILT).filter(n => n.startsWith("contacts-v") && n.endsWith(".xdc")).sort(); return join(PREBUILT, m[m.length-1]); };

test("renders shell with no init", async () => {
  const h: HarnessHandle = await createHarness(xdc());
  const errs: string[] = []; h.page.on("pageerror", e => errs.push(String(e)));
  await h.page.waitForSelector('#shell', { state: 'visible', timeout: 4000 });
  await h.close(); expect(errs).toEqual([]);
});

test("renders a contact row from contacts_loaded", async () => {
  const h: HarnessHandle = await createHarness(xdc());
  await h.push({ type: 'init', senderAddr: 'server' });
  await h.push({ type: 'contacts_loaded', senderAddr: 'server', contacts: [{ contactId: 11, displayName: 'Alice', role: null, chatmailAddress: 'a@x', isBot: false }] });
  await h.page.waitForSelector('text=Alice', { state: 'visible', timeout: 3000 });
  await h.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd plugin/test/webxdc && bunx playwright test contacts.pw.ts --reporter=line`
Expected: FAIL — `contacts-v*.xdc` not found.

- [ ] **Step 3: Write the card + build module**

Port the **contacts** and **role-picker** screens (markup + their `list_contacts`/`assign_role` senders and `contacts_loaded`/`role_assigned` listeners) from `plugin/webxdc/agent-setup.html` (around `show('contacts')` :1499 and the role-picker :3700-3770) into `plugin/webxdc/contacts.html`, reframed as a standalone card: a `<div id="shell">` rendered on `DOMContentLoaded`; `setUpdateListener(fn, 0)`; on `{type:'init'}` send `{type:'list_contacts', senderAddr: window.webxdc.selfAddr}` and show the contacts list; tapping a contact opens the role picker offering exactly the six roles; Save sends `{type:'assign_role', contactId, role, senderAddr: window.webxdc.selfAddr}`. Handle the new `role_assign_err` by showing its `message` inline on the role picker (don't close it). `var APP_VERSION = 1.00;`. Create `contacts-manifest.toml` (`name = "Contacts & Roles"`), `contacts-icon.png` (`cp plugin/webxdc/agent-setup-icon.png plugin/webxdc/contacts-icon.png`), and `plugin/contacts.ts` (copy `teleport.ts`, swap `teleport`→`contacts`). Register `buildContactsXDC` in `scripts/build-all-xdcs.ts` (`{ id: 'contacts', build: buildContactsXDC }`).

- [ ] **Step 4: Build + run the harness test**

Run: `cd plugin && bun run build:xdcs` → `built …/contacts-v1.xdc`.
Run: `cd plugin/test/webxdc && bunx playwright test contacts.pw.ts --reporter=line` → PASS.

- [ ] **Step 5: Commit**

```bash
git add plugin/webxdc/contacts.html plugin/webxdc/contacts-manifest.toml plugin/webxdc/contacts-icon.png plugin/contacts.ts plugin/scripts/build-all-xdcs.ts plugin/test/webxdc/contacts.pw.ts plugin/webxdc-prebuilt/contacts-v1.xdc
git commit -m "feat(contacts): contacts-roles card + build module + harness test (#109)"
```

### Task 3: `apps/contacts-app.ts` + `dc_open_contacts_card` tool

**Files:**
- Create: `plugin/apps/contacts-app.ts`
- Modify: `plugin/apps.ts` (register `contactsApp`); `plugin/server.ts` (the tool is on the app; ensure `setControlAuthDeps`-style wiring reaches it)
- Test: `plugin/test/contacts-app.test.ts`

**Interfaces:**
- Consumes: `handleListContacts` (move from `agent-setup-app.ts:1047`), the gated `handleAssignRole` (Task 1), `isControlCommandAuthorized`, `buildContactsXDC`/`getContactsVersion`.
- Produces: `contactsApp: WebXDCApp` (`id: 'contacts'`) with tool `dc_open_contacts_card({ chat_id })` (`chat_id` REQUIRED, like `dc_open_teleport_card`; `requiresCapability: 'infrastructure'`).

- [ ] **Step 1: Write the failing test**

```typescript
// plugin/test/contacts-app.test.ts
import { test, expect } from 'bun:test'
import { contactsApp } from '../apps/contacts-app.js'
test('exposes dc_open_contacts_card with required chat_id', () => {
  const t = contactsApp.tools().find(x => x.name === 'dc_open_contacts_card')
  expect(t).toBeTruthy()
  expect(t!.inputSchema.required).toContain('chat_id')
})
test('dc_open_contacts_card refuses missing chat_id', async () => {
  const res = await contactsApp.callTool('dc_open_contacts_card', {}, {} as any)
  expect(res?.isError).toBe(true)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd plugin && bun test test/contacts-app.test.ts`
Expected: FAIL — `../apps/contacts-app.js` not found.

- [ ] **Step 3: Implement `contacts-app.ts`**

Mirror `apps/teleport-app.ts`: module-level `contactsSessions: Map<number,number>`, `setControlAuthDeps`, an `onWebXDCUpdate` dispatching `list_contacts` → `handleListContacts(ctx, msgId, chatId)` (read-only, no gate) and `assign_role` → the gated `handleAssignRole(ctx, msgId, chatId, contactId, role, senderAddr, auth)` where `auth = () => isControlCommandAuthorized(chatId, _controlAuthDeps)`. Add the `dc_open_contacts_card` tool (copy teleport's `callTool`: require `chat_id`, build+send the card via `buildContactsXDC`, `registerWebXDCMsg`, send `{type:'init'}`). MOVE `handleListContacts` from `agent-setup-app.ts` into `contacts-app.ts` (or a shared `contacts-core.ts` if `agent-setup-app.ts` still needs it before Task 5 — it does, until the peel; export from the new module and import back, like teleport-core). Register `contactsApp` in `apps.ts`. In `server.ts`, call `contactsApp`-side `setControlAuthDeps` from `main()` alongside teleport's.

- [ ] **Step 4: Run the test**

Run: `cd plugin && bun test test/contacts-app.test.ts test/contacts-auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugin/apps/contacts-app.ts plugin/apps.ts plugin/server.ts plugin/test/contacts-app.test.ts
git commit -m "feat(contacts): contacts-app with gated handlers + dc_open_contacts_card (#109)"
```

---

## Phase C — Native moment: offer permissions on member-added

### Task 4: `MemberAddedToGroup` → proactive permissions offer

**Files:**
- Create: `plugin/dispatcher/member-added-offer.ts` (pure decision helper)
- Modify: `plugin/server.ts` (`handleSystemMessage` — add the `MemberAddedToGroup` branch)
- Test: `plugin/test/member-added-offer.test.ts`

**Interfaces:**
- Produces: `shouldOfferPermissions(args): { offer: boolean; reason: string }` where `args = { isAgentChat: boolean; newMemberPermissioned: boolean; newMemberIsBotSelf: boolean }`. Pure — no I/O — so it's unit-testable; `server.ts` gathers the inputs and calls it.

- [ ] **Step 1: Write the failing test**

```typescript
// plugin/test/member-added-offer.test.ts
import { test, expect } from 'bun:test'
import { shouldOfferPermissions } from '../dispatcher/member-added-offer.js'
test('offers when an unpermissioned human joins an agent chat', () => {
  expect(shouldOfferPermissions({ isAgentChat: true, newMemberPermissioned: false, newMemberIsBotSelf: false }).offer).toBe(true)
})
test('does not offer for an already-permissioned member', () => {
  expect(shouldOfferPermissions({ isAgentChat: true, newMemberPermissioned: true, newMemberIsBotSelf: false }).offer).toBe(false)
})
test('does not offer when the bot itself is added', () => {
  expect(shouldOfferPermissions({ isAgentChat: true, newMemberPermissioned: false, newMemberIsBotSelf: true }).offer).toBe(false)
})
test('does not offer in a non-agent chat', () => {
  expect(shouldOfferPermissions({ isAgentChat: false, newMemberPermissioned: false, newMemberIsBotSelf: false }).offer).toBe(false)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd plugin && bun test test/member-added-offer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

```typescript
// plugin/dispatcher/member-added-offer.ts
/**
 * Decide whether to proactively offer to set a newly-added member's
 * permissions (settings-decomposition native moment). Pure — server.ts
 * gathers the booleans (is this an agent chat? is the new member already
 * permissioned? is the new member the bot itself?) and acts on the result.
 */
export function shouldOfferPermissions(args: {
  isAgentChat: boolean
  newMemberPermissioned: boolean
  newMemberIsBotSelf: boolean
}): { offer: boolean; reason: string } {
  if (!args.isAgentChat) return { offer: false, reason: 'not-an-agent-chat' }
  if (args.newMemberIsBotSelf) return { offer: false, reason: 'bot-self' }
  if (args.newMemberPermissioned) return { offer: false, reason: 'already-permissioned' }
  return { offer: true, reason: 'unpermissioned-human-joined' }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd plugin && bun test test/member-added-offer.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `handleSystemMessage`**

In `server.ts`'s `handleSystemMessage`, add a branch for `msg.systemMessageType === 'MemberAddedToGroup'`. Gather inputs: `isAgentChat` = `access.isAllowed(msg.chatId) && bindings.getBinding(msg.chatId)?.agentId != null`; resolve the added contact (the system message's actor/added id — use `msg.fromId` is the adder; the added member is in the new membership — diff `getChatContacts` against the bound agent's permissioned set), `newMemberPermissioned` via `access.isContactPermissioned(agentId, newId)`, `newMemberIsBotSelf` = `newId === 1`. If `shouldOfferPermissions(...).offer`, inject a prompt via `dispatchAndCollect`:

```typescript
const prompt = `[system] A new person (contact ${newId}) just joined this agent chat and isn't permissioned yet. Briefly offer to set what they can do with this agent — full access, limited, or chat-only — and tell the owner they can also open the contacts card by saying "manage permissions". Do not assign any role yourself; wait for the owner.`
ctx.dispatchAndCollect?.(msg.chatId, prompt).catch(err => logf('member-added-offer: dispatch failed chat=%d: %v', msg.chatId, err))
```

Guard with try/catch; the offer is best-effort and must never block message handling.

- [ ] **Step 6: Commit**

```bash
git add plugin/dispatcher/member-added-offer.ts plugin/server.ts plugin/test/member-added-offer.test.ts
git commit -m "feat(native-moment): offer permissions when an unpermissioned human joins an agent chat (#109)"
```

---

## Phase D — Peel contacts out of the monolith

### Task 5: Remove contacts/role-picker from agent-setup

**Files:**
- Modify: `plugin/apps/agent-setup-app.ts` (delete `handleListContacts` body if fully moved; delete the `list_contacts`/`assign_role` dispatch branches; keep imports clean)
- Modify: `plugin/webxdc/agent-setup.html` (delete the `contacts` + `role-picker` screens + their nav entry points; bump `APP_VERSION` 2.18 → 2.19)
- Modify: tests asserting the old monolith contacts behavior

- [ ] **Step 1: Delete the moved handlers + dispatch branches** from `agent-setup-app.ts` (the `list_contacts` and `assign_role` blocks now live in `contacts-app.ts`). Keep `handleAssignRole`/`handleListContacts` only if re-exported from the new module; otherwise remove.
- [ ] **Step 2: Delete the screens** from `agent-setup.html` — `contacts` + `role-picker` markup, their `show('contacts')`/`show('role-picker')` entry points, and the button(s) that opened them. Bump `APP_VERSION` 2.18 → 2.19.
- [ ] **Step 3: Rebuild + full detached suite**

Run: `cd plugin && bun run build:xdcs`
Run: `cd plugin && ./scripts/run-tests.sh` then poll `--status` until done. Expected 0 fail. Update any test that asserted the old monolith contacts screens.

- [ ] **Step 4: Commit**

```bash
git add plugin/apps/agent-setup-app.ts plugin/webxdc/agent-setup.html plugin/webxdc-prebuilt/agent-setup-v2.19.xdc plugin/test
git commit -m "refactor(agent-setup): remove contacts/role-picker screens (peeled to contacts card) (#109)"
```

---

## Done criteria

- `bun run build:xdcs` produces `contacts-v1.xdc` and bumped `agent-setup-v2.19.xdc`.
- `contacts-auth`, `contacts-app`, `member-added-offer`, `contacts.pw` tests pass; full detached suite 0 fail.
- After restart: "manage permissions" / `dc_open_contacts_card` opens the contacts card; assigning a role works in a solo chat and is refused (`role_assign_err`) in a multi-human group without owner confirmation; adding an unpermissioned human to an agent chat triggers a proactive permissions offer.
- The monolith no longer shows contacts/role-picker screens.

## Scope notes

- Task ordering: do **1 → 2 → 3 → 4 → 5**. Task 1 gates `handleAssignRole` in place (reviewable in isolation); Task 3 moves it. Tasks 2/3 are the card (build module + HTML are mutually build-dependent like teleport — treat as one unit if a subagent prefers).
- The §6 Layer-1 cosmetic "not permissioned" view stays deferred (same reason as increment 1 — can't determine viewer-is-owner client-side; the backend gate from Task 1 is the real protection).
- Native moment uses `MemberAddedToGroup` system messages (reliable, no snapshot diff). The group-created moment for `create-agent` is increment 3.
