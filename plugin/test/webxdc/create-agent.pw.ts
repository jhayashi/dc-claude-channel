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

test("created reply clears timeout, re-enables Create button, and shows success modal", async () => {
  const h: HarnessHandle = await createHarness(xdc());
  // Seed an init so the card is fully live.
  await h.push({ type: 'init', senderAddr: 'server', leaves: [], l2Summary: [],
    availableModels: [], defaultModel: null,
    availableBuiltinTools: [], availableMcpServers: [], connectedMcpServers: [] });
  await h.page.waitForSelector('#shell', { state: 'visible', timeout: 4000 });

  // Simulate the dispatcher's success reply for the manual "Build from scratch" path.
  await h.push({ type: 'created', chatId: 42, name: 'Sleep coach', skipChat: false, senderAddr: 'server' });

  // Success modal should appear with the agent-created heading.
  await h.page.waitForSelector('text=Agent created', { state: 'visible', timeout: 3000 });

  // Create button must be re-enabled (disabled=false).
  const createBtn = h.page.locator('#create-btn');
  await expect(createBtn).not.toBeDisabled({ timeout: 3000 });

  await h.close();
});

test("created reply blanks the form and lands on the wall behind the modal (dup guard)", async () => {
  const h: HarnessHandle = await createHarness(xdc());
  await h.push({ type: 'init', senderAddr: 'server', leaves: [], l2Summary: [],
    availableModels: [], defaultModel: null,
    availableBuiltinTools: [], availableMcpServers: [], connectedMcpServers: [] });
  await h.page.waitForSelector('#shell', { state: 'visible', timeout: 4000 });

  // Drill into the manual create form and fill a name.
  await h.page.click('text=Build from scratch');
  await h.page.waitForSelector('#step2.visible', { state: 'visible', timeout: 3000 });
  await h.page.fill('#name', 'Dup risk');

  // Dispatcher confirms the create.
  await h.push({ type: 'created', chatId: 7, name: 'Dup risk', skipChat: false, senderAddr: 'server' });

  // Success modal is up.
  await h.page.waitForSelector('text=Agent created', { state: 'visible', timeout: 3000 });
  // The form is torn down behind the modal (no second-tap re-submit surface).
  await expect(h.page.locator('#step2')).not.toBeVisible({ timeout: 3000 });
  await expect(h.page.locator('#wall-screen')).toBeVisible({ timeout: 3000 });
  // And the filled name was blanked.
  await expect(h.page.locator('#name')).toHaveValue('');

  await h.close();
});

test("chat-ready reply confirms the coach handoff with a terminal success modal", async () => {
  const h: HarnessHandle = await createHarness(xdc());
  await h.push({ type: 'init', senderAddr: 'server', leaves: [], l2Summary: [],
    availableModels: [], defaultModel: null,
    availableBuiltinTools: [], availableMcpServers: [], connectedMcpServers: [] });
  await h.page.waitForSelector('#shell', { state: 'visible', timeout: 4000 });

  // Dispatcher reports the coach's new chat is ready (build-agent path).
  await h.push({ type: 'chat-ready', chatId: 55, senderAddr: 'server' });

  // Terminal confirmation modal points the user at their chat list.
  await h.page.waitForSelector('text=Your new chat is ready', { state: 'visible', timeout: 3000 });
  // We land on the wall root behind it (not deep in a leaf detail).
  await expect(h.page.locator('#wall-screen')).toBeVisible({ timeout: 3000 });

  await h.close();
});

test("create_err reply surfaces the §6 refusal message and re-enables Create", async () => {
  const h: HarnessHandle = await createHarness(xdc());
  await h.push({ type: 'init', senderAddr: 'server', leaves: [], l2Summary: [],
    availableModels: [], defaultModel: null,
    availableBuiltinTools: [], availableMcpServers: [], connectedMcpServers: [] });
  await h.page.waitForSelector('#shell', { state: 'visible', timeout: 4000 });

  // Dispatcher refuses a form-create (multi-human group → needs-confirmation).
  await h.push({ type: 'create_err', senderAddr: 'server',
    message: 'Creating an agent in a group has to come from you directly — send it as a message here (e.g. "create an agent that ..."), or open this card from your 1:1 chat with me.' });

  // The needs-confirmation guidance is shown (not the misleading "no response" timeout).
  await h.page.waitForSelector('text=create an agent that', { state: 'visible', timeout: 3000 });

  // Create button must be re-enabled so the user can retry from the right place.
  const createBtn = h.page.locator('#create-btn');
  await expect(createBtn).not.toBeDisabled({ timeout: 3000 });

  await h.close();
});
