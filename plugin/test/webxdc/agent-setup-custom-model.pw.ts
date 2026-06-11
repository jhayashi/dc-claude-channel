/**
 * Custom model ID picker smoke (v1.4.11).
 *
 * Drives the agent-setup create form's model segmented control through
 * the new "Other…" path: typing a custom model ID, seeing the live-
 * preview switch to the Zinc-grey unknown palette, submitting, and
 * verifying the outbound `create` update carries the typed ID
 * verbatim — not the manifest's default.
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

// Minimal init payload — three manifest tiers so the picker shows the
// three known segments + "Other…" sentinel.
function buildInit() {
  return {
    type: "init",
    newAgentFlow: { enabled: true, leaves: [], l2Summary: [] },
    // Need at least one existingAgent so the "Manage agents" home button
    // isn't disabled (its disabled state is gated on existingAgents.length).
    existingAgents: [
      {
        id: "placeholder-agent",
        name: "Placeholder",
        model: "claude-sonnet-4-6",
        archetype: "role",
        icon: "",
        glyph: "user-round",
        pattern: "checker",
        tier: "sonnet",
        isTrusted: false,
        iconDataUri: "",
        bindingCount: 0,
        isCurrentAgent: false,
        isUndeletable: false,
      },
    ],
    templates: [],
    availableModels: [
      { id: "claude-opus-4-7", label: "Opus 4.7", tier: "opus" },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6", tier: "sonnet" },
      { id: "claude-haiku-4-5", label: "Haiku 4.5", tier: "haiku" },
    ],
    defaultModel: "claude-sonnet-4-6",
    availableBuiltinTools: [],
    availableMcpServers: [],
    connectedMcpServers: [],
    ownerEmail: "test@example.com",
  };
}

async function openCreateForm(h: HarnessHandle) {
  const appVersion = await h.getAppVersion();
  await h.push({ ...buildInit(), version: appVersion });
  // Home → Manage → "+ Create new agent" lands on step2 (the simple
  // create form, which is what our custom-model-id picker lives in).
  await h.page.waitForSelector('button.home-action:has-text("Manage agents")', {
    state: "visible",
    timeout: 5_000,
  });
  await h.page.click('button.home-action:has-text("Manage agents")');
  await h.page.waitForSelector("#manage-create-btn", { state: "visible", timeout: 2_000 });
  await h.page.click("#manage-create-btn");
  await h.page.waitForSelector("#step2", { state: "visible", timeout: 2_000 });
}

test.describe("custom model ID picker (v1.4.11)", () => {
  let h: HarnessHandle | null = null;

  test.afterEach(async () => {
    await h?.close();
    h = null;
  });

  test('"Other…" button reveals the text input row; selecting Sonnet hides it again', async () => {
    h = await createHarness(findAgentSetupXdc());
    await openCreateForm(h);

    // Other button exists with data-tier="__other__".
    const otherBtn = h.page.locator('#create-model-seg button[data-tier="__other__"]');
    await expect(otherBtn).toBeVisible();

    // Row starts hidden.
    await expect(h.page.locator("#create-custom-model-row")).toBeHidden();

    // Click Other → row visible.
    await otherBtn.click();
    await expect(h.page.locator("#create-custom-model-row")).toBeVisible();

    // Click Sonnet → row hidden again.
    await h.page.click('#create-model-seg button[data-tier="sonnet"]');
    await expect(h.page.locator("#create-custom-model-row")).toBeHidden();
  });

  test("save with empty custom ID does NOT emit a create update (blocked + focus)", async () => {
    h = await createHarness(findAgentSetupXdc());
    await openCreateForm(h);

    await h.page.fill("#name", "fabletest");
    await h.page.click('#create-model-seg button[data-tier="__other__"]');
    // Leave #create-custom-model-id empty.
    await h.clearOutbound();
    await h.page.click("#create-btn");

    // Quiescence — give the click handler a beat to run.
    await h.page.waitForTimeout(150);

    const updates = await h.outbound();
    const createUpdate = updates.find(
      (u) => (u.update as { payload?: { type?: string } }).payload?.type === "create",
    );
    expect(createUpdate).toBeUndefined();

    // Custom input received focus so the user sees what to fill in.
    const focusedId = await h.page.evaluate(() => document.activeElement?.id ?? null);
    expect(focusedId).toBe("create-custom-model-id");
  });

  test("save with custom ID emits a create update carrying the typed ID verbatim", async () => {
    h = await createHarness(findAgentSetupXdc());
    await openCreateForm(h);

    await h.page.fill("#name", "fabletest");
    await h.page.click('#create-model-seg button[data-tier="__other__"]');
    await h.page.fill("#create-custom-model-id", "claude-fable-1-0");
    await h.clearOutbound();
    await h.page.click("#create-btn");

    // Wait until the create update lands. Shim exposes the outbound
    // array at window.__harness.outbound (see test/webxdc/shim.js).
    await h.page.waitForFunction(
      () => {
        // @ts-expect-error window.__harness is the shim handle
        return (window.__harness?.outbound ?? []).some(
          (o: { update: { payload?: { type?: string } } }) =>
            o.update.payload?.type === "create",
        );
      },
      { timeout: 2_000 },
    );

    const updates = await h.outbound();
    const createUpdate = updates.find(
      (u) => (u.update as { payload?: { type?: string } }).payload?.type === "create",
    );
    expect(createUpdate).toBeDefined();
    // The create payload is shaped as { type, config: { name, model, ... }, ... }
    // — see create() in webxdc/agent-setup.html. We want the model field
    // inside config to carry the verbatim ID the user typed.
    const payload = (createUpdate!.update as { payload: { config: { model: string } } }).payload;
    expect(payload.config.model).toBe("claude-fable-1-0");
  });
});
