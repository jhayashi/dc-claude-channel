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
    message: "That change has to come from you directly — say it in our chat, or open this from your 1:1 with me.",
  });

  await h.page.waitForSelector('text=say it in our chat', { state: "visible", timeout: 3000 });
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
