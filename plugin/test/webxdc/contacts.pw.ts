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

// #120: the card never said which agent's roles it was showing — the
// server now includes managedAgentName in the contacts_loaded payload
// and the card renders it as a "Roles for <name>" subtitle.
test("contacts_loaded with managedAgentName renders the 'Roles for <name>' subtitle", async () => {
  const h: HarnessHandle = await createHarness(xdc());
  await h.push({ type: 'init', senderAddr: 'server' });
  await h.push({
    type: 'contacts_loaded', senderAddr: 'server',
    contacts: [{ contactId: 11, displayName: 'Alice', role: null, chatmailAddress: 'a@x', isBot: false }],
    managedAgentId: 'dc-developer', managedAgentName: 'DC Developer',
  });
  await h.page.waitForSelector('#contacts-subtitle.visible', { state: 'visible', timeout: 3000 });
  const text = await h.page.locator('#contacts-subtitle').textContent();
  expect(text).toBe('Roles for DC Developer');
  await h.close();
});

// #120: onRoleAssigned used to silently re-render the list with no
// explicit signal — the card now shows a "Role saved" banner.
test("role_assigned shows the 'Role saved' banner", async () => {
  const h: HarnessHandle = await createHarness(xdc());
  await h.push({ type: 'init', senderAddr: 'server' });
  await h.push({
    type: 'contacts_loaded', senderAddr: 'server',
    contacts: [{ contactId: 11, displayName: 'Alice', role: null, chatmailAddress: 'a@x', isBot: false }],
  });
  await h.page.waitForSelector('text=Alice', { state: 'visible', timeout: 3000 });
  await h.push({
    type: 'role_assigned', senderAddr: 'server',
    contact: { kind: 'human', contactId: 11, displayName: 'Alice', firstPairedAt: new Date().toISOString(), role: 'family-member', capabilities: ['chat', 'low_stakes_*'], chatmailAddress: 'a@x' },
  });
  await h.page.waitForSelector('#saved-banner.visible', { state: 'visible', timeout: 3000 });
  const text = await h.page.locator('#saved-banner').textContent();
  expect(text).toBe('Role saved — Alice is now Family Member.');
  await h.close();
});

// #123: assign_role used to have zero timeouts — a silent server left the
// "Assigning role" progress modal spinning forever. Verifies the 15s
// timeout fires, hides the modal, re-enables Save, and shows the inline
// error — and that a LATE role_assigned reply after the timeout doesn't
// throw (assignTimeout is cleared defensively in both success/err paths).
test("assign timeout fires when the server never responds", async () => {
  const h: HarnessHandle = await createHarness(xdc());
  await h.page.evaluate(() => {
    // Speed up the 15s timeout for the test by monkey-patching setTimeout
    // just for the assign-timeout call (identified by its 15000 delay).
    const orig = window.setTimeout;
    (window as any).setTimeout = (fn: TimerHandler, delay?: number, ...rest: unknown[]) => {
      if (delay === 15000) return orig(fn as any, 50, ...rest);
      return orig(fn as any, delay as any, ...rest);
    };
  });
  await h.push({ type: 'init', senderAddr: 'server' });
  await h.push({
    type: 'contacts_loaded', senderAddr: 'server',
    contacts: [{ contactId: 11, displayName: 'Alice', role: null, chatmailAddress: 'a@x', isBot: false }],
  });
  await h.page.waitForSelector('text=Alice', { state: 'visible', timeout: 3000 });
  await h.page.click('.contact-row');
  await h.page.waitForSelector('.role-option-row', { state: 'visible', timeout: 3000 });
  await h.page.locator('.role-option-row').first().click(); // pick the first role option
  await h.page.click('#role-save-btn');
  await h.page.waitForSelector('#assign-progress-modal.visible', { state: 'visible', timeout: 2000 });
  // After the (sped-up) timeout: modal hides, Save re-enables, inline error shows.
  await h.page.waitForSelector('#role-assign-err.visible', { state: 'visible', timeout: 2000 });
  await expect(h.page.locator('#assign-progress-modal')).not.toHaveClass(/visible/);
  const errText = await h.page.locator('#role-assign-err').textContent();
  expect(errText).toContain('The server did not respond');
  const disabled = await h.page.locator('#role-save-btn').isDisabled();
  expect(disabled).toBe(false);
  await h.close();
});
