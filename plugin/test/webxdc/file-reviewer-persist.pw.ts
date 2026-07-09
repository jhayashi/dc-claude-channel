/**
 * #112: "comments sent" state must survive a reload.
 *
 * When the reviewer is reopened, WebXDC replays every update from serial 0
 * in order: first a file's `document` update, then the `comments` update
 * recorded when it was reviewed. The comments update must suppress the file
 * so a already-reviewed file doesn't reappear in the sidebar/view.
 *
 * The app processes replayed and live updates through the same listener, so
 * pushing document-then-comments in one session is a faithful reproduction
 * of the reopen replay.
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

test.describe("file-reviewer sent-state persistence (#112)", () => {
  let h: HarnessHandle | null = null;

  test.afterEach(async () => {
    await h?.close();
    h = null;
  });

  test("a replayed comments update removes the reviewed file", async () => {
    h = await createHarness(findFileReviewerXdc());
    const appVersion = await h.getAppVersion();

    // Reopen replay, step 1: the file document.
    await h.push({
      title: "Report A",
      content: "# Report A\n\nOne paragraph.\n",
      fileId: "file-A",
      version: appVersion,
    });
    await h.page.waitForSelector("h1");
    expect(await h.page.textContent("h1")).toBe("Report A");

    // Reopen replay, step 2: the comments update recorded at review time.
    await h.push({
      type: "comments",
      fileId: "file-A",
      fileTitle: "Report A",
      comments: [{ paragraph: 1, comment: "looks done" }],
    });

    // The reviewed file must be gone: empty state shown, not in documents[].
    await h.page.waitForSelector("#empty", { state: "visible", timeout: 3_000 });
    const stillLoaded = await h.page.evaluate(() =>
      (window as any).documents.some((d: any) => d.fileId === "file-A"),
    );
    expect(stillLoaded).toBe(false);
  });

  test("an unreviewed file stays after a sibling is reviewed", async () => {
    h = await createHarness(findFileReviewerXdc());
    const appVersion = await h.getAppVersion();

    await h.push({ title: "Reviewed", content: "# Reviewed\n\nx\n", fileId: "rev", version: appVersion });
    await h.page.waitForSelector("h1");
    await h.push({ title: "Kept", content: "# Kept\n\ny\n", fileId: "kept", version: appVersion });

    // Only the reviewed file's comments replay.
    await h.push({
      type: "comments",
      fileId: "rev",
      fileTitle: "Reviewed",
      comments: [{ paragraph: 1, comment: "done" }],
    });

    const titles = await h.page.evaluate(() =>
      (window as any).documents.map((d: any) => d.fileId),
    );
    expect(titles).toEqual(["kept"]);
  });
});
