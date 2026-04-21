import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as access from "../access/index.js";

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

  test("arm-window: not armed by default", () => {
    access.resetArmedState();
    expect(access.isArmed()).toBe(false);
    expect(access.getArmedUntil()).toBeNull();
    expect(access.getArmedGroupChatId()).toBeNull();
  });

  test("arm-window: armPairing sets a 5-minute TTL", () => {
    access.resetArmedState();
    const t0 = 1_000_000_000;
    access.armPairing(null, t0);
    expect(access.isArmed(t0)).toBe(true);
    expect(access.isArmed(t0 + 299_000)).toBe(true);
    expect(access.isArmed(t0 + 301_000)).toBe(false);
    expect(access.getArmedUntil()).toBe(t0 + 300_000);
  });

  test("arm-window: re-arm extends the TTL", () => {
    access.resetArmedState();
    const t0 = 1_000_000_000;
    access.armPairing(null, t0);
    access.armPairing(null, t0 + 120_000); // re-arm 2 min later
    expect(access.getArmedUntil()).toBe(t0 + 120_000 + 300_000);
  });

  test("arm-window: armPairing records the group chat ID", () => {
    access.resetArmedState();
    const t0 = 1_000_000_000;
    access.armPairing(12345, t0);
    expect(access.getArmedGroupChatId()).toBe(12345);
  });

  test("arm-window: re-arm replaces the group chat ID", () => {
    access.resetArmedState();
    const t0 = 1_000_000_000;
    access.armPairing(11111, t0);
    access.armPairing(22222, t0 + 60_000);
    expect(access.getArmedGroupChatId()).toBe(22222);
  });

  test("arm-window: consume returns true when armed and clears state", () => {
    access.resetArmedState();
    const t0 = 1_000_000_000;
    access.armPairing(42, t0);
    expect(access.consumeArmedWindow(t0 + 10_000)).toBe(true);
    expect(access.isArmed(t0 + 10_000)).toBe(false);
    expect(access.getArmedUntil()).toBeNull();
    expect(access.getArmedGroupChatId()).toBeNull();
  });

  test("arm-window: consume returns false when expired and clears state", () => {
    access.resetArmedState();
    const t0 = 1_000_000_000;
    access.armPairing(42, t0);
    expect(access.consumeArmedWindow(t0 + 301_000)).toBe(false);
    expect(access.getArmedUntil()).toBeNull();
    expect(access.getArmedGroupChatId()).toBeNull();
  });

  test("arm-window: consume returns false when never armed", () => {
    access.resetArmedState();
    expect(access.consumeArmedWindow()).toBe(false);
  });

  test("arm-window: first consumer wins", () => {
    access.resetArmedState();
    const t0 = 1_000_000_000;
    access.armPairing(null, t0);
    expect(access.consumeArmedWindow(t0 + 10_000)).toBe(true);
    expect(access.consumeArmedWindow(t0 + 20_000)).toBe(false);
  });

  test("listPaired groups chats by owner and skips legacy (no-owner) entries", () => {
    // Fresh IDs outside the shared test range.
    const c1 = 990101, c2 = 990102, c3 = 990103, c4 = 990104;
    access.addChat(c1, 77);    // owner 77
    access.addChat(c2, 77);    // owner 77 (second chat)
    access.addChat(c3, 88);    // owner 88
    access.addChat(c4);        // legacy: no owner — should be excluded

    const list = access.listPaired();
    const byContact = new Map(list.map((p) => [p.contactId, p]));
    expect(byContact.has(77)).toBe(true);
    expect(byContact.has(88)).toBe(true);
    expect(byContact.get(77)!.chatIds.sort()).toEqual([c1, c2].sort());
    expect(byContact.get(88)!.chatIds).toEqual([c3]);
    expect(list.find((p) => p.chatIds.includes(c4))).toBeUndefined();

    expect(access.chatsForOwner(77).sort()).toEqual([c1, c2].sort());
    expect(access.chatsForOwner(88)).toEqual([c3]);
    expect(access.chatsForOwner(999)).toEqual([]);

    for (const id of [c1, c2, c3, c4]) access.removeChat(id);
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
