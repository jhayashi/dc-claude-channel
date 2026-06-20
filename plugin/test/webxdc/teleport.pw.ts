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
