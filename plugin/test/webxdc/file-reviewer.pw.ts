/**
 * File-reviewer DOM + long-press comment roundtrip.
 *
 * Drives the highest-fidelity tier-1 test we can build without a real
 * dispatcher: send a file payload, assert the markdown renders, long-press
 * a block to open the comment card, type a comment, tap Send, and assert
 * the outbound {type: 'comments', ...} update carries the right shape.
 */

import { test, expect } from "@playwright/test";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness, type HarnessHandle } from "./harness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PREBUILT_DIR = join(HERE, "..", "..", "webxdc-prebuilt");

function findFileReviewerXdc(): string {
  const match = readdirSync(PREBUILT_DIR).find((n) =>
    n.startsWith("file-reviewer") && n.endsWith(".xdc")
  );
  if (!match) throw new Error("file-reviewer*.xdc not found in webxdc-prebuilt/");
  return join(PREBUILT_DIR, match);
}

test.describe("file-reviewer smoke", () => {
  let h: HarnessHandle | null = null;

  test.afterEach(async () => {
    await h?.close();
    h = null;
  });

  test("renders markdown, accepts a long-press comment, and sends it", async () => {
    h = await createHarness(findFileReviewerXdc());
    const appVersion = await h.getAppVersion();

    await h.push({
      type: "file",
      title: "Smoke",
      content: "# Hello world\n\nThis is one paragraph.\n",
      version: appVersion,
    });

    // Wait for markdown blocks to mount.
    await h.page.waitForSelector('[data-paragraph="1"]');

    const h1Text = await h.page.textContent("h1");
    expect(h1Text).toBe("Hello world");

    const paraText = await h.page.textContent('[data-paragraph="1"]');
    expect(paraText?.trim()).toBe("This is one paragraph.");

    // Long-press: fire mousedown (button 0) and wait past the 500 ms
    // timer in attachLongPress() without releasing. The handler ignores
    // mouseup that never arrives.
    await h.clearOutbound();
    await h.page.locator('[data-paragraph="1"]').dispatchEvent("mousedown", { button: 0 });
    await h.page.waitForSelector("#comment-card", { state: "visible", timeout: 2_000 });

    // Type the comment and save it.
    await h.page.fill("#comment-text", "looks good");
    await h.page.click("#card-save");

    // Bar send button should become visible once there is ≥1 comment.
    await h.page.waitForSelector("#bar-send", { state: "visible", timeout: 2_000 });
    await h.page.click("#bar-send");

    // Poll outbound for the comments update.
    const deadline = Date.now() + 3_000;
    let saw: any = null;
    while (Date.now() < deadline) {
      const out = await h.outbound();
      saw = out.find(
        (e: any) => e.update && e.update.payload && e.update.payload.type === "comments",
      );
      if (saw) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(saw, "no comments update was sent").toBeTruthy();
    expect(saw.update.payload.fileTitle).toBe("Smoke");
    expect(saw.update.payload.senderAddr).toBe("test@test.local");
    expect(Array.isArray(saw.update.payload.comments)).toBe(true);
    expect(saw.update.payload.comments).toHaveLength(1);
    const entry = saw.update.payload.comments[0];
    expect(entry.comment).toBe("looks good");
    // Markdown → paragraph anchor, not line.
    expect(typeof entry.paragraph).toBe("number");
    expect(entry.line).toBeUndefined();
  });
});
