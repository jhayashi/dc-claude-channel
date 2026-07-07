/**
 * Cross-app auto-upgrade handshake.
 *
 * CLAUDE.md §"App versioning and auto-upgrade (REQUIRED)" mandates every
 * WebXDC app respond to a payload whose `version` field exceeds the
 * app's own `APP_VERSION` with a `version_mismatch` update back. Without
 * this, a bumped HTML can't roll out to already-delivered `.xdc`s on
 * users' phones. This test asserts the handshake on every prebuilt
 * `.xdc` — regression coverage for #42, #23, and every auto-upgrade
 * bug we've shipped historically.
 */

import { test, expect } from "@playwright/test";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness, type HarnessHandle } from "./harness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PREBUILT_DIR = join(HERE, "..", "..", "webxdc-prebuilt");

// Each app gates its version check behind its app-specific "init" payload
// type (so replayed middle-of-session updates with no version field don't
// spuriously trigger the handshake). Map basename prefix → the minimal
// payload that unlocks the version check.
const INIT_PAYLOAD_TYPE: Record<string, string> = {
  // The retired agent-setup monolith's entry is gone (epic #109); its
  // successors each gate on their own 'init'. Without an entry a card's
  // test THROWS ("no init-payload type registered") — these three were
  // silently red from the day each card shipped.
  "agent-manage": "init",
  "create-agent": "init",
  "contacts": "init",
  "permission-prompt": "request",
  "file-reviewer": "file", // file-reviewer has no type gate; anything works
  "teleport": "init",
};

function xdcInitType(xdcBasename: string): string {
  for (const prefix in INIT_PAYLOAD_TYPE) {
    if (xdcBasename.startsWith(prefix)) return INIT_PAYLOAD_TYPE[prefix];
  }
  throw new Error(
    `no init-payload type registered for ${xdcBasename}; add an entry to INIT_PAYLOAD_TYPE`,
  );
}

function discoverXdcs(): string[] {
  return readdirSync(PREBUILT_DIR)
    .filter((n) => n.endsWith(".xdc"))
    .map((n) => join(PREBUILT_DIR, n));
}

for (const xdcPath of discoverXdcs()) {
  const name = xdcPath.split("/").pop();
  test(`${name}: replies version_mismatch when payload.version > APP_VERSION`, async () => {
    let h: HarnessHandle | null = null;
    try {
      h = await createHarness(xdcPath);
      const appVersion = await h.getAppVersion();
      expect(typeof appVersion).toBe("number");
      expect(appVersion).toBeGreaterThan(0);

      await h.clearOutbound();
      await h.push({ version: appVersion + 1, type: xdcInitType(name!) });

      // Poll outbound until the app reacts. 3 s is generous — in
      // practice the listener runs synchronously.
      const deadline = Date.now() + 3_000;
      let saw: any = null;
      while (Date.now() < deadline) {
        const out = await h.outbound();
        saw = out.find(
          (e: any) => e.update && e.update.payload && e.update.payload.type === "version_mismatch",
        );
        if (saw) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(saw, `no version_mismatch update from ${name}`).toBeTruthy();
      expect(saw.update.payload.appVersion).toBe(appVersion);
      expect(saw.update.payload.serverVersion).toBe(appVersion + 1);
      expect(saw.update.payload.senderAddr).toBe("test@test.local");
    } finally {
      await h?.close();
    }
  });
}
