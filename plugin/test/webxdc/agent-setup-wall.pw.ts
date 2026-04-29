/**
 * Wall navigation smoke (Phase 6 subset of Task 6.4).
 *
 * Drives the agent-setup card through the new "build a new agent" wall
 * that landed in Phase 6: 26 specialty tiles → drill-in → leaf detail.
 * Uses a synthetic 3-leaf catalog (2 L2s, 1 with a parameter) so the
 * tests pin the rendered shape without piggybacking on the live 155-leaf
 * catalog content. The four mash-up tests (build pill, pair-chip
 * toggle, cap warn, review-sync) live in 6.4b after Phase 7 ships.
 */

import { test, expect } from "@playwright/test";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness, type HarnessHandle } from "./harness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PREBUILT_DIR = join(HERE, "..", "..", "webxdc-prebuilt");

function findAgentSetupXdc(): string {
  // Pick the highest-versioned agent-setup-vX.YZ.xdc — `bun run build:xdcs`
  // writes the current source version, but older prebuilts may still be
  // present in the dir. Lexicographic sort happens to match version order
  // since all prefixes match `agent-setup-v` and the major is single-digit.
  const matches = readdirSync(PREBUILT_DIR)
    .filter((n) => n.startsWith("agent-setup-v") && n.endsWith(".xdc"))
    .sort();
  if (matches.length === 0) {
    throw new Error("agent-setup-v*.xdc not found in webxdc-prebuilt/");
  }
  return join(PREBUILT_DIR, matches[matches.length - 1]);
}

// Synthetic 3-leaf catalog. Two L2s under "Expert" path, one with a
// parameter, one without. Matches the shape Task 6.1 added to the init
// payload (id, path, l2, name, parameter, liability, pitch, combinesWith).
const SYNTHETIC_LEAVES = [
  {
    id: "sleep-coach",
    path: "Expert",
    l2: "Health, wellness, caregiving",
    name: "Sleep coach",
    parameter: null,
    liability: "medical",
    pitch: "Diagnoses your sleep with you and tracks results.",
    combinesWith: ["stress-management-coach"],
  },
  {
    id: "stress-management-coach",
    path: "Expert",
    l2: "Health, wellness, caregiving",
    name: "Stress-management coach",
    parameter: null,
    liability: "mental-health",
    pitch: "Helps you manage stress with practices that fit.",
    combinesWith: ["sleep-coach"],
  },
  {
    id: "tutor",
    path: "Expert",
    l2: "Education",
    name: "Tutor",
    parameter: "subject",
    liability: null,
    pitch: "Teaches a subject from where you actually are.",
    combinesWith: [],
  },
];

const SYNTHETIC_L2_SUMMARY = [
  {
    path: "Expert",
    l2: "Health, wellness, caregiving",
    count: 2,
    sample: ["Sleep coach", "Stress-management coach"],
  },
  { path: "Expert", l2: "Education", count: 1, sample: ["Tutor"] },
];

// Build an init payload that drives the card into wall mode. The card's
// init handler tolerates missing optional fields (existingAgents,
// templates, etc.) — we provide empty defaults to keep state consistent.
function buildInit(overrides: Record<string, unknown> = {}) {
  return {
    type: "init",
    newAgentFlow: {
      enabled: true,
      leaves: SYNTHETIC_LEAVES,
      l2Summary: SYNTHETIC_L2_SUMMARY,
    },
    existingAgents: [],
    templates: [],
    availableModels: [],
    defaultModel: null,
    availableBuiltinTools: [],
    availableMcpServers: [],
    connectedMcpServers: [],
    pairedDevices: [],
    ownerEmail: "test@example.com",
    ...overrides,
  };
}

async function openWall(h: HarnessHandle, init: unknown = buildInit()) {
  const appVersion = await h.getAppVersion();
  // Match the app's own version so the version-mismatch path doesn't fire.
  await h.push({ ...(init as object), version: appVersion });
  // Wait for step0 (home) to render so the click target is mountable.
  await h.page.waitForSelector('button.home-action:has-text("Start a new chat")', {
    state: "visible",
    timeout: 5_000,
  });
  await h.page.click('button.home-action:has-text("Start a new chat")');
  await h.page.waitForSelector("#wall-screen", { state: "visible", timeout: 2_000 });
  // Grid renders synchronously inside renderWall(); wait for the first tile.
  await h.page.waitForSelector(".wall-tile", { timeout: 2_000 });
}

test.describe("agent-setup wall navigation (Phase 6)", () => {
  let h: HarnessHandle | null = null;

  test.afterEach(async () => {
    await h?.close();
    h = null;
  });

  test("renders 2 specialty tiles for synthetic catalog with correct counts", async () => {
    h = await createHarness(findAgentSetupXdc());
    await openWall(h);

    const tiles = h.page.locator(".wall-tile");
    await expect(tiles).toHaveCount(2);

    // Sum of per-tile counts must equal total leaves (3).
    const counts = await tiles.locator(".wall-tile-count").allTextContents();
    const total = counts.reduce((s, c) => s + parseInt(c.trim(), 10), 0);
    expect(total).toBe(3);
  });

  test('search "sleep" surfaces Sleep coach in results', async () => {
    h = await createHarness(findAgentSetupXdc());
    await openWall(h);

    await h.page.fill("#wall-search", "sleep");
    // onWallSearch runs on input, no debounce — wait for results to appear.
    await h.page.waitForSelector("#wall-results .leaf-row", { timeout: 2_000 });

    const rows = h.page.locator("#wall-results .leaf-row");
    await expect(rows.filter({ hasText: "Sleep coach" })).toHaveCount(1);
  });

  test("tapping a tile shows L2 leaf list and Back returns to wall", async () => {
    h = await createHarness(findAgentSetupXdc());
    await openWall(h);

    await h.page.click('.wall-tile:has-text("Health, wellness, caregiving")');
    await h.page.waitForSelector("#wall-l2 .L2-list", { timeout: 2_000 });

    const l2Rows = h.page.locator("#wall-l2 .L2-list .leaf-row");
    await expect(l2Rows).toHaveCount(2); // Sleep coach + Stress-management coach
    await expect(l2Rows.first()).toBeVisible();

    await h.page.click("#wall-l2 .back-bar");
    await h.page.waitForSelector(".wall-grid", { state: "visible", timeout: 2_000 });
    // After back-to-wall, renderWall() calls hideAll([...,'wall-l2',...])
    // which sets display:none on the container; the inner .L2-list markup
    // stays attached but is no longer visible to the user.
    await expect(h.page.locator("#wall-l2 .L2-list")).toBeHidden();
  });

  test("tapping a leaf row shows the detail card with pitch + parameter", async () => {
    h = await createHarness(findAgentSetupXdc());
    await openWall(h);

    // Drill into Education to land on the parameterized "Tutor" leaf.
    await h.page.click('.wall-tile:has-text("Education")');
    await h.page.waitForSelector("#wall-l2 .L2-list", { timeout: 2_000 });
    await h.page.click('#wall-l2 .leaf-row:has-text("Tutor")');

    await h.page.waitForSelector(".leaf-detail", { state: "visible", timeout: 2_000 });
    await expect(h.page.locator(".leaf-detail h3")).toHaveText("Tutor");
    await expect(h.page.locator(".leaf-detail .pitch")).toContainText(
      "Teaches a subject",
    );
    await expect(h.page.locator(".leaf-detail .meta")).toContainText(
      "Asks you about:",
    );
    await expect(h.page.locator(".leaf-detail .meta")).toContainText("subject");

    // Build-now button must be reachable for Phase 7's mash-up tests.
    await expect(
      h.page.locator('.leaf-detail [data-action="build-now"]'),
    ).toBeVisible();
  });

  test("XSS safety: malicious chars in leaf id/l2 do not execute", async () => {
    const evil = '"><script>window.__HACKED=true</script>';
    h = await createHarness(findAgentSetupXdc());

    await openWall(
      h,
      buildInit({
        newAgentFlow: {
          enabled: true,
          leaves: [
            {
              id: "evil-leaf",
              path: "Expert",
              l2: evil,
              name: "Evil",
              parameter: null,
              liability: null,
              pitch: "Should not execute",
              combinesWith: [],
            },
          ],
          l2Summary: [{ path: "Expert", l2: evil, count: 1, sample: ["Evil"] }],
        },
      }),
    );

    // The injected <script> must NOT have executed. window.__HACKED is the
    // canary — its presence as `true` would mean escapeHtml leaked the
    // payload into the DOM as live markup.
    const hacked = await h.page.evaluate(() => (window as any).__HACKED);
    expect(hacked).toBeUndefined();

    // Tile still renders — the malicious string is escaped, not dropped.
    await expect(h.page.locator(".wall-tile")).toHaveCount(1);
  });
});
