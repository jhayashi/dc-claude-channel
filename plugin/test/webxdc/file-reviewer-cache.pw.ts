/**
 * #113: cached open — resume-from-serial + localStorage state survive a
 * reload, so a reopen doesn't require replaying the full update history.
 */

import { test, expect } from "@playwright/test";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness, type HarnessHandle } from "./harness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PREBUILT_DIR = join(HERE, "..", "..", "webxdc-prebuilt");

function findFileReviewerXdc(): string {
  const matches = readdirSync(PREBUILT_DIR)
    .filter((n) => n.startsWith("file-reviewer") && n.endsWith(".xdc"))
    .sort();
  const match = matches[matches.length - 1];
  if (!match) throw new Error("file-reviewer*.xdc not found in webxdc-prebuilt/");
  return join(PREBUILT_DIR, match);
}

test.describe("file-reviewer cached open (#113)", () => {
  let h: HarnessHandle | null = null;

  test.afterEach(async () => {
    await h?.close();
    h = null;
  });

  test("a reload renders cached docs and resumes the listener past their serials", async () => {
    h = await createHarness(findFileReviewerXdc());
    const appVersion = await h.getAppVersion();

    await h.push({ title: "Doc One", content: "# Doc One\n\nx\n", fileId: "doc-1", version: appVersion });
    await h.page.waitForSelector("h1");
    await h.push({ title: "Doc Two", content: "# Doc Two\n\ny\n", fileId: "doc-2", version: appVersion });
    await h.page.waitForSelector("text=Doc Two");

    const lastSerial = await h.page.evaluate(() => (window as any).__harness.getSerial());

    // Give the debounced persist time to flush before we reload.
    await h.page.waitForTimeout(700);

    await h.page.reload({ waitUntil: "load" });

    // No new pushes after reload — if docs render, they came from cache, not replay.
    const titles = await h.page.evaluate(() =>
      (window as any).documents.map((d: any) => d.fileId),
    );
    expect(titles.sort()).toEqual(["doc-1", "doc-2"]);

    const resumedAt = await h.page.evaluate(() => (window as any).__harness.getListenerSerial());
    expect(resumedAt).toBe(lastSerial);
  });

  test("a missing cache falls back to a full replay from serial 0", async () => {
    h = await createHarness(findFileReviewerXdc());
    const resumedAt = await h.page.evaluate(() => (window as any).__harness.getListenerSerial());
    expect(resumedAt).toBe(0);
  });

  test("redelivering an already-applied update does not duplicate the doc", async () => {
    h = await createHarness(findFileReviewerXdc());
    const appVersion = await h.getAppVersion();
    const docPayload = { title: "Report A", content: "# Report A\n\nx\n", fileId: "file-A", version: appVersion };

    await h.push(docPayload);
    await h.page.waitForSelector("h1");
    // Simulate a crash-before-persist: the same update is redelivered
    // verbatim on next boot (the persisted lastSerial hadn't advanced yet).
    await h.push(docPayload);

    const matching = await h.page.evaluate(() =>
      (window as any).documents.filter((d: any) => d.fileId === "file-A"),
    );
    expect(matching.length).toBe(1);
  });
});
