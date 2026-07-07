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

// §6 refusal (e.g. saveEdit/delete/bind/start-*/rebind-chat/open-create
// refused because a webXDC tap can't be authenticated in a multi-human
// group). The server emits ONE generic `action_err` type regardless of
// which action was refused — this runtime-proves the increment-4 handler
// against the rebuilt v1.01 prebuilt (mirrors create-agent.pw.ts's
// `create_err` test).
test("action_err reply surfaces the §6 refusal message", async () => {
  const h: HarnessHandle = await createHarness(xdc());
  await h.push({ ...INIT, version: await h.getAppVersion() });
  await h.page.waitForSelector('#manage-list .agent-row:has-text("Sleep coach")', { state: "visible", timeout: 4000 });

  await h.push({
    type: "action_err", senderAddr: "server",
    message: 'That change has to come from you directly — send it as a message here (e.g. "switch this chat to <agent name>"), or open this card from your 1:1 chat with me.',
  });

  await h.page.waitForSelector('text=send it as a message here', { state: "visible", timeout: 3000 });
  await h.close();
});

test("action_err renders the error-variant modal (non-green icon)", async () => {
  // The §6 refusal is a failure, not a success — it must show the error
  // modal (red heading, ✖ icon, no auto-dismiss countdown), not the green
  // success ✅.
  const h: HarnessHandle = await createHarness(xdc());
  await h.push({ ...INIT, version: await h.getAppVersion() });
  await h.page.waitForSelector('#manage-list .agent-row:has-text("Sleep coach")', { state: "visible", timeout: 4000 });

  await h.push({ type: "action_err", senderAddr: "server", message: "Nope." });

  await h.page.waitForSelector("#modal.visible", { state: "visible", timeout: 3000 });
  await expect(h.page.locator("#modal")).toHaveClass(/error-variant/);
  const icon = await h.page.locator("#modal-icon").textContent();
  expect(icon).not.toContain("✅"); // not the green success check
  // Error modals get a plain "Dismiss" (no "(5)" countdown suffix).
  await expect(h.page.locator("#modal-dismiss")).toHaveText("Dismiss");
  await h.close();
});

test("rebind chat-ready confirms 'Agent switched' over the manage screen", async () => {
  // THE headline fix (#120): a successful rebind used to dump the user on
  // the legacy hub with zero confirmation. Now it lands on the manage list
  // behind a success modal that names the new agent and points back to chat.
  const h: HarnessHandle = await createHarness(xdc());
  await h.push({
    ...INIT, version: await h.getAppVersion(), view: "switch",
    existingAgents: [
      { ...INIT.existingAgents[0], isCurrentAgent: true },
      { id: "tutor-agent", name: "Tutor", model: "claude-sonnet-4-6", pattern: "checker", bindingCount: 0 },
    ],
  });
  await h.page.waitForSelector("#reuse-picker", { state: "visible", timeout: 4000 });
  await h.page.click('#reuse-list .agent-row:has-text("Tutor")');
  await h.page.waitForSelector("#reuse-confirm-modal.visible", { timeout: 3000 });
  await h.page.click("#reuse-confirm-ok");

  // Dispatcher confirms the rebind and ships a refreshed list (Tutor now current).
  await h.push({
    type: "chat-ready", senderAddr: "server", chatId: 7,
    existingAgents: [
      { id: "sleep-coach", name: "Sleep coach", model: "claude-sonnet-4-6", pattern: "checker", bindingCount: 0 },
      { id: "tutor-agent", name: "Tutor", model: "claude-sonnet-4-6", pattern: "checker", bindingCount: 1, isCurrentAgent: true },
    ],
  });

  await h.page.waitForSelector("text=Agent switched", { state: "visible", timeout: 3000 });
  await expect(h.page.locator("#modal-sub")).toContainText("Tutor");
  await expect(h.page.locator("#manage")).toBeVisible();
  await h.close();
});

test("created reply confirms the bound new chat (I-1 fix)", async () => {
  // pickExisting → {type:'bind'} → handleBindAgent creates+binds the chat and
  // replies {type:'created', chatId, name}. The card must confirm it (before
  // this fix it sat in creating=true with no feedback).
  const h: HarnessHandle = await createHarness(xdc());
  await h.push({ ...INIT, version: await h.getAppVersion() });
  await h.page.waitForSelector('#manage-list .agent-row:has-text("Sleep coach")', { state: "visible", timeout: 4000 });

  await h.push({ type: "created", senderAddr: "server", chatId: 42, name: "Sleep coach" });

  await h.page.waitForSelector('text=Chat created', { state: "visible", timeout: 3000 });
  await h.close();
});

test("view:'switch' deep-links to the pick-an-agent (rebind) screen", async () => {
  // "switch this chat's agent" → dc_open_agent_manage_card(view:'switch') →
  // the card lands on the rebind picker instead of the manage list, so the
  // user picks a replacement directly (no manual navigation).
  const h: HarnessHandle = await createHarness(xdc());
  await h.push({
    ...INIT, version: await h.getAppVersion(), view: "switch",
    // mark the current agent so isBound is true (rebind requires a bound chat)
    existingAgents: [{ ...INIT.existingAgents[0], isCurrentAgent: true }],
  });
  // The reuse-picker screen (used for reuse AND rebind) becomes visible.
  await h.page.waitForSelector("#reuse-picker", { state: "visible", timeout: 4000 });
  await h.close();
});

test("rebind confirm: keep-context toggle defaults off and carries keepContext:true when checked", async () => {
  // Rebinding is a full identity swap, so the toggle defaults OFF (fresh
  // session, current behavior). Checking it must flow keepContext:true
  // through to the rebind-chat payload so the new agent resumes instead of
  // starting cold.
  const h: HarnessHandle = await createHarness(xdc());
  await h.push({
    ...INIT, version: await h.getAppVersion(), view: "switch",
    existingAgents: [
      { ...INIT.existingAgents[0], isCurrentAgent: true },
      { id: "tutor-agent", name: "Tutor", model: "claude-sonnet-4-6", pattern: "checker", bindingCount: 0, trusted: true },
    ],
  });
  await h.page.waitForSelector("#reuse-picker", { state: "visible", timeout: 4000 });
  await h.page.click('#reuse-list .agent-row:has-text("Tutor")');

  await h.page.waitForSelector("#reuse-confirm-modal.visible", { timeout: 3000 });
  // Toggle hidden/unchecked by default is the OTHER flows' contract; here it
  // must be visible and unchecked for a rebind confirm.
  const checkbox = h.page.locator("#reuse-confirm-keep-context-cb");
  await expect(checkbox).toBeVisible();
  await expect(checkbox).not.toBeChecked();
  await expect(h.page.locator("#reuse-confirm-sub")).toContainText("fresh conversation");

  await checkbox.check();
  await expect(h.page.locator("#reuse-confirm-sub")).toContainText("everything discussed");

  await h.page.click("#reuse-confirm-ok");
  const out = await h.outbound();
  const rebind = out.find((o: any) => o.update.payload?.type === "rebind-chat");
  expect(rebind?.update.payload.keepContext).toBe(true);
  expect(rebind?.update.payload.agentId).toBe("tutor-agent");

  await h.close();
});
