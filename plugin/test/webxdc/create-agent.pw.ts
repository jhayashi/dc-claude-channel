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
