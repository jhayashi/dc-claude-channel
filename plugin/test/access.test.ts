import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as access from "../access";

// Use a temp directory so tests don't touch the real allowlist.
const testDir = mkdtempSync(join(tmpdir(), "dc-access-test-"));

beforeAll(() => {
  // Point the access module at the temp directory.
  access.setApprovedDir(testDir);
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

const TEST_IDS = [900001, 900002, 900003, 900004, 900005];

describe("access control", () => {
  test("startPairing returns a 5-letter code", () => {
    const code = access.startPairing(TEST_IDS[0], 100);
    expect(code).toMatch(/^[a-z]{5}$/);
  });

  test("isPendingPair finds the pending code", () => {
    const code = access.startPairing(TEST_IDS[0], 100);
    const result = access.isPendingPair(code);
    expect(result).not.toBeNull();
    expect(result!.chatId).toBe(TEST_IDS[0]);
  });

  test("completePairing approves the chat and returns chatId", () => {
    const code = access.startPairing(TEST_IDS[1], 101);
    const chatId = access.completePairing(code);
    expect(chatId).toBe(TEST_IDS[1]);
  });

  test("isAllowed returns true after pairing", () => {
    expect(access.isAllowed(TEST_IDS[1])).toBe(true);
  });

  test("removeChat removes from allowlist", () => {
    expect(access.isAllowed(TEST_IDS[1])).toBe(true);
    access.removeChat(TEST_IDS[1]);
    expect(access.isAllowed(TEST_IDS[1])).toBe(false);
  });

  test("completePairing rejects unknown code", () => {
    expect(() => access.completePairing("zzzzz")).toThrow(/unknown or expired/);
  });

  test("startPairing returns same code for same chatId", () => {
    const code1 = access.startPairing(TEST_IDS[2], 102);
    const code2 = access.startPairing(TEST_IDS[2], 102);
    expect(code1).toBe(code2);
  });

  test("completePairing stores owner contact ID", () => {
    const code = access.startPairing(800001, 42);
    access.completePairing(code);
    expect(access.getOwner(800001)).toBe(42);
    access.removeChat(800001);
  });

  test("getOwner returns null for legacy (empty) approved files", () => {
    access.addChat(800002);
    expect(access.getOwner(800002)).toBeNull();
    access.removeChat(800002);
  });

  test("max 3 pending pairings enforced", () => {
    // Clear any pending pairings from earlier tests by completing them.
    try { access.completePairing(access.startPairing(TEST_IDS[0], 100)); } catch {}
    try { access.completePairing(access.startPairing(TEST_IDS[2], 102)); } catch {}

    // Now create exactly 3 pending pairings with fresh IDs.
    const freshIds = [990001, 990002, 990003, 990004];
    access.startPairing(freshIds[0], 200);
    access.startPairing(freshIds[1], 201);
    access.startPairing(freshIds[2], 202);
    // The 4th should throw.
    expect(() => access.startPairing(freshIds[3], 203)).toThrow(/too many pending/);
    // Clean up
    for (const id of freshIds) access.removeChat(id);
  });
});
