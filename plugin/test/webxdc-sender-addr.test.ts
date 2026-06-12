/**
 * Verify that all WebXDC HTML apps include senderAddr in every sendUpdate call.
 *
 * This is a security requirement: the server uses senderAddr to verify
 * that WebXDC responses come from the chat owner. Apps missing senderAddr
 * will have their updates rejected in owned chats.
 *
 * The check works by counting sendUpdate calls vs senderAddr references.
 * Each sendUpdate must include senderAddr either inline in the payload
 * or in a variable that's passed to sendUpdate.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WEBXDC_DIR = join(import.meta.dir, "..", "webxdc");

function checkSenderAddr(filePath: string): void {
  const content = readFileSync(filePath, "utf-8");

  // Count sendUpdate calls (these are user-to-server updates)
  const sendUpdateCalls = content.match(/\.sendUpdate\s*\(/g);
  if (!sendUpdateCalls) return; // no sendUpdate calls — nothing to check

  // Count senderAddr references (should be at least one per sendUpdate)
  const senderAddrRefs = content.match(/senderAddr/g);
  const sendCount = sendUpdateCalls.length;
  const addrCount = senderAddrRefs?.length ?? 0;

  // Each sendUpdate needs a corresponding senderAddr
  expect(addrCount).toBeGreaterThanOrEqual(sendCount);
}

describe("WebXDC senderAddr requirement", () => {
  const htmlFiles = readdirSync(WEBXDC_DIR).filter(f => f.endsWith(".html"));

  for (const file of htmlFiles) {
    test(`${file} has senderAddr for every sendUpdate`, () => {
      checkSenderAddr(join(WEBXDC_DIR, file));
    });
  }
});
