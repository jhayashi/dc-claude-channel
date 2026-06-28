/**
 * Mode-picker smoke (Phase 12).
 *
 * Drives the agent-setup card through the new "Start a new chat"
 * intermediate screen that landed in Phase 12: two cards (default
 * agent, reuse a saved agent) and the reuse-confirmation modal with
 * its idle / processing / error states. The "build a custom agent"
 * card was removed when the create flow was peeled to the standalone
 * create-agent card (epic #109).
 *
 * Synthetic init payload — two saved agents (one trust-on with a
 * stripes pattern so the picker exercise covers the post-1.2 pattern-
 * aware client-side preview path).
 */

import { test, expect } from "@playwright/test";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness, type HarnessHandle } from "./harness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PREBUILT_DIR = join(HERE, "..", "..", "webxdc-prebuilt");

function findAgentSetupXdc(): string {
  const matches = readdirSync(PREBUILT_DIR)
    .filter((n) => n.startsWith("agent-setup-v") && n.endsWith(".xdc"))
    .sort();
  if (matches.length === 0) {
    throw new Error("agent-setup-v*.xdc not found in webxdc-prebuilt/");
  }
  return join(PREBUILT_DIR, matches[matches.length - 1]);
}

const SAMPLE_AGENTS = [
  {
    id: "sleep-coach-agent",
    name: "Sleep coach",
    model: "claude-sonnet-4-6",
    archetype: "role",
    icon: "",
    glyph: "user-round",
    pattern: "stripes",  // trust-on patterned bg
    tier: "sonnet",
    isTrusted: true,
    iconDataUri: "",  // forces client-side fallback so the test exercises renderPreviewSvg
    bindingCount: 2,
    isCurrentAgent: false,
    isUndeletable: false,
  },
  {
    id: "tutor-agent",
    name: "Math tutor",
    model: "claude-haiku-4-5-20251001",
    archetype: "role",
    icon: "",
    glyph: "user-round",
    pattern: "checker",
    tier: "haiku",
    isTrusted: false,
    iconDataUri: "",
    bindingCount: 0,
    isCurrentAgent: false,
    isUndeletable: false,
  },
];

function buildInit(overrides: Record<string, unknown> = {}) {
  return {
    type: "init",
    newAgentFlow: { enabled: true, leaves: [], l2Summary: [] },
    existingAgents: SAMPLE_AGENTS,
    templates: [],
    availableModels: [],
    defaultModel: null,
    availableBuiltinTools: [],
    availableMcpServers: [],
    connectedMcpServers: [],
    ownerEmail: "test@example.com",
    ...overrides,
  };
}

async function openModePicker(h: HarnessHandle, init: unknown = buildInit()) {
  const appVersion = await h.getAppVersion();
  await h.push({ ...(init as object), version: appVersion });
  await h.page.waitForSelector('button.home-action:has-text("Start a new chat")', {
    state: "visible",
    timeout: 5_000,
  });
  await h.page.click('button.home-action:has-text("Start a new chat")');
  await h.page.waitForSelector("#new-chat-mode", { state: "visible", timeout: 2_000 });
}

test.describe("agent-setup mode picker (Phase 12)", () => {
  let h: HarnessHandle | null = null;

  test.afterEach(async () => {
    await h?.close();
    h = null;
  });

  test("intermediate screen shows two cards with the right labels", async () => {
    h = await createHarness(findAgentSetupXdc());
    await openModePicker(h);

    // Two .home-action buttons visible inside #new-chat-mode. The
    // "Build with agent assist" card was removed when the create flow
    // was peeled out to the standalone create-agent card (epic #109).
    const cardLabels = await h.page.$$eval(
      "#new-chat-mode .home-action .home-action-label",
      (els) => els.map((el) => (el.textContent ?? "").trim()),
    );
    expect(cardLabels).toEqual([
      "Default agent",
      "Reuse a saved agent",
    ]);
  });

  test("reuse picker renders rows with pattern-correct badges", async () => {
    h = await createHarness(findAgentSetupXdc());
    await openModePicker(h);
    await h.page.click('#new-chat-mode button.home-action:has-text("Reuse a saved agent")');
    await h.page.waitForSelector("#reuse-picker", { state: "visible", timeout: 2_000 });
    await h.page.waitForSelector("#reuse-list .agent-row", { timeout: 2_000 });

    // Two rows for the two synthetic agents. Sort: bound first, so
    // Sleep coach (bindingCount=2) comes before Math tutor (bindingCount=0).
    const names = await h.page.$$eval(
      "#reuse-list .agent-row .name",
      (els) => els.map((el) => (el.textContent ?? "").trim()),
    );
    expect(names).toEqual(["Sleep coach", "Math tutor"]);

    // The first row's avatar SVG should contain the stripes pattern
    // (4 horizontal rects of width 256). A trust-on agent without a
    // server-rendered iconDataUri falls back to renderPreviewSvg —
    // which now respects the pattern field per the v1.2.0 fix.
    const firstAvatarSvg = await h.page.$eval(
      "#reuse-list .agent-row:first-child .avatar svg",
      (el) => el.outerHTML,
    );
    expect(firstAvatarSvg).toContain('width="256" height="64"');

    // The second row (Math tutor, trust=false) collapses to a solid
    // background — no patterned rects beyond the single 256x256 fill.
    const secondAvatarSvg = await h.page.$eval(
      "#reuse-list .agent-row:nth-child(2) .avatar svg",
      (el) => el.outerHTML,
    );
    expect(secondAvatarSvg).toContain('width="256" height="256"');
    expect(secondAvatarSvg).not.toContain('width="256" height="64"');
  });

  test("confirmation modal cycles idle → processing → error → retry", async () => {
    h = await createHarness(findAgentSetupXdc());
    await openModePicker(h);
    await h.page.click('#new-chat-mode button.home-action:has-text("Reuse a saved agent")');
    await h.page.waitForSelector("#reuse-list .agent-row", { timeout: 2_000 });

    // Tap the first row → confirmation modal opens in idle state.
    await h.page.click("#reuse-list .agent-row:first-child");
    await h.page.waitForSelector("#reuse-confirm-modal.visible", { timeout: 2_000 });

    const heading = await h.page.$eval("#reuse-confirm-heading", (el) => el.textContent);
    expect(heading).toContain("Sleep coach");

    // Idle: buttons visible, processing hidden.
    await expect(h.page.locator("#reuse-confirm-buttons")).toBeVisible();
    await expect(h.page.locator("#reuse-confirm-processing")).toBeHidden();

    // Tap Start chat → processing state (buttons hidden, spinner shown).
    await h.page.click("#reuse-confirm-ok");
    await expect(h.page.locator("#reuse-confirm-buttons")).toBeHidden();
    await expect(h.page.locator("#reuse-confirm-processing")).toBeVisible();

    // The card sent start-reuse-chat over webxdc.sendUpdate. Drain the
    // outbound queue and confirm the agentId made it.
    const out = await h.outbound();
    const lastReuse = out
      .map((o) => (o.update as { payload?: { type?: string; agentId?: string } })?.payload)
      .filter((p) => p?.type === "start-reuse-chat")
      .pop();
    expect(lastReuse?.agentId).toBe("sleep-coach-agent");

    // Inject a chat-failed update from the "server" → modal flips to
    // error state with the message in the sub-line and Retry button.
    const appVersion = await h.getAppVersion();
    await h.push({
      type: "chat-failed",
      error: "Group create returned 500.",
      version: appVersion,
    });
    await h.page.waitForSelector("#reuse-confirm-buttons", { state: "visible", timeout: 2_000 });
    const sub = await h.page.$eval("#reuse-confirm-sub", (el) => el.textContent);
    expect(sub).toContain("Group create returned 500");
    const okText = await h.page.$eval("#reuse-confirm-ok", (el) => el.textContent);
    expect(okText).toBe("Retry");

    // Retry → back to processing, resends start-reuse-chat for the same agent.
    await h.clearOutbound();
    await h.page.click("#reuse-confirm-ok");
    await expect(h.page.locator("#reuse-confirm-processing")).toBeVisible();
    const retryOut = await h.outbound();
    const retryReuse = retryOut
      .map((o) => (o.update as { payload?: { type?: string; agentId?: string } })?.payload)
      .filter((p) => p?.type === "start-reuse-chat")
      .pop();
    expect(retryReuse?.agentId).toBe("sleep-coach-agent");
  });
});
