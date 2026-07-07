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
  await h.push({ type: 'teleport_out_list', chats: [{ chatId: 42, chatName: 'Health', agentName: 'Coach', isLive: true, jobCount: 0, isCurrent: true }], senderAddr: 'server' });
  await h.page.waitForSelector('text=Health', { state: 'visible', timeout: 3000 });
  await h.close();
});

test("resume_attach_ok shows the success modal and leaves Attach disabled (duplicate-attach guard)", async () => {
  const h: HarnessHandle = await createHarness(xdc());
  await h.push({ type: 'init', view: 'here', senderAddr: 'server' });

  // The card emits a resume_list_request on entering the "here" view; reply
  // with one candidate session.
  await h.push({
    type: 'resume_list', requestId: 1, senderAddr: 'server',
    candidates: [{ sessionId: 'abc123', cwd: '/home/joe/proj', mtimeMs: Date.now(), sessionName: 'Fix the bug', messageCount: 12 }],
  });
  await h.page.waitForSelector('.resume-row', { state: 'visible', timeout: 3000 });

  // Select the row, then tap Attach — this is what increments the client's
  // attachRequestId, so the server's requestId:1 below has to line up with it.
  await h.page.click('.resume-row');
  await h.page.click('#resume-attach');

  await h.push({
    type: 'resume_attach_ok', requestId: 1, senderAddr: 'server',
    sessionId: 'abc123', chatId: 99, chatName: 'Fix the bug',
  });

  // Success modal, non-error variant.
  await h.page.waitForSelector('text=Session resumed', { state: 'visible', timeout: 3000 });
  await expect(h.page.locator('#modal')).not.toHaveClass(/error-variant/);

  // Duplicate-attach guard: Attach stays disabled (no re-enable with the
  // same row still selected — a second tap used to mint a duplicate chat),
  // and the attached row is visibly marked and inert.
  await expect(h.page.locator('#resume-attach')).toBeDisabled({ timeout: 3000 });
  await expect(h.page.locator('.resume-row')).toBeDisabled({ timeout: 3000 });
  await expect(h.page.locator('.resume-row')).toContainText('attached');

  await h.close();
});
