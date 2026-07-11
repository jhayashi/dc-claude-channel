/**
 * Help card harness suite (#108): static render, browse navigation,
 * search, and the Try-it → sendToChat contract (the card must draft the
 * phrase as the USER — it never talks to the server).
 */

import { test, expect } from "@playwright/test";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness, type HarnessHandle } from "./harness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PREBUILT_DIR = join(HERE, "..", "..", "webxdc-prebuilt");

function findHelpXdc(): string {
  const match = readdirSync(PREBUILT_DIR).find(
    (n) => n.startsWith("help-") && n.endsWith(".xdc"),
  );
  if (!match) throw new Error("help-*.xdc not found in webxdc-prebuilt/");
  return join(PREBUILT_DIR, match);
}

test.describe("help card", () => {
  let h: HarnessHandle | null = null;

  test.afterEach(async () => {
    await h?.close();
    h = null;
  });

  test("renders 8 topic tiles with no init and no page errors", async () => {
    const errors: string[] = [];
    h = await createHarness(findHelpXdc());
    h.page.on("pageerror", (e) => errors.push(String(e)));
    await h.page.waitForSelector(".tile");
    const tiles = await h.page.locator(".tile").count();
    expect(tiles).toBe(8);
    // static card: content must be present without any pushed update
    const teaser = await h.page.locator(".t-teaser").first().textContent();
    expect(teaser?.length ?? 0).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test("browse: topic tap → journey accordion expands with chips and body", async () => {
    h = await createHarness(findHelpXdc());
    await h.page.click('[data-topic="managing"]');
    await h.page.waitForSelector(".j-head");
    // open the rename journey
    await h.page.click('#j-rename .j-head');
    await h.page.waitForSelector("#j-rename.open .j-text");
    const body = await h.page.textContent("#j-rename .j-text");
    expect(body).toContain("Renames the agent");
    const chip = await h.page.textContent("#j-rename .chip.active");
    expect(chip).toContain("rename yourself to Atlas");
    // back returns home
    await h.page.click("#back");
    await h.page.waitForSelector(".tile");
  });

  test("search filters across phrases and shows topic badges", async () => {
    h = await createHarness(findHelpXdc());
    await h.page.fill("#search", "teleport");
    await h.page.waitForSelector(".j-head");
    const heads = await h.page.locator(".journey").count();
    expect(heads).toBeGreaterThanOrEqual(1);
    const badge = await h.page.locator(".result-badge").first().textContent();
    expect(badge).toContain("Moving sessions");
    // clearing restores the home tiles
    await h.page.fill("#search", "");
    await h.page.waitForSelector(".tile");
  });

  test("search miss shows the friendly empty state", async () => {
    h = await createHarness(findHelpXdc());
    await h.page.fill("#search", "zzzznotathing");
    await h.page.waitForSelector(".empty");
    const empty = await h.page.textContent(".empty");
    expect(empty).toContain("ask me in the chat");
  });

  test("Try-it drafts the ACTIVE chip via sendToChat (user-voice contract)", async () => {
    h = await createHarness(findHelpXdc());
    await h.page.click('[data-topic="managing"]');
    await h.page.click('#j-model-switch .j-head');
    await h.page.waitForSelector('#j-model-switch.open');
    // switch the active chip to the second phrase, then try it
    await h.page.click('#j-model-switch .chip:not(.active)');
    await h.page.click('[data-tryit="model-switch"]');
    const sent = await h.page.evaluate(() => (window as any).__harness.sentToChat);
    expect(sent.length).toBe(1);
    expect(sent[0].text).toBe("use haiku");
  });

  test("slash-command entries exist for the generated Commands topic", async () => {
    h = await createHarness(findHelpXdc());
    await h.page.click('[data-topic="commands"]');
    await h.page.waitForSelector(".j-head");
    const titles = await h.page.locator(".j-head").allTextContents();
    expect(titles.some((t) => t.includes("/effort"))).toBe(true);
    expect(titles.some((t) => t.includes("/stop"))).toBe(true);
  });
});
