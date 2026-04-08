import { describe, test, expect } from "bun:test";
import { filterUpdatesByOwner, type FilterContext } from "../webxdc-filter";
import type { WebXDCUpdate } from "../dc-client";

// Helper to build a WebXDCUpdate
function update(serial: number, payload: unknown): WebXDCUpdate {
  return { serial, payload };
}

// Helper to build a FilterContext with defaults. Defaults to a group-style
// chat (>2 contacts) so the strict check is exercised; tests that need
// the 1:1 fast path override `chatContactCount: 2`.
function ctx(overrides: Partial<FilterContext> = {}): FilterContext {
  return {
    owner: 42,
    chatId: 100,
    msgId: 200,
    appId: "test-app",
    chatContactCount: 5,
    lookupContactByAddr: async () => 42, // resolves to owner by default
    logf: () => {},
    ...overrides,
  };
}

describe("filterUpdatesByOwner", () => {
  test("no owner (legacy chat): all updates pass through unfiltered", async () => {
    const updates = [
      update(1, { type: "response", data: "hello" }),
      update(2, { type: "comments", data: "world" }),
    ];
    const result = await filterUpdatesByOwner(updates, ctx({ owner: null }));
    expect(result).toEqual(updates);
  });

  test("no owner: updates without senderAddr still pass through", async () => {
    const updates = [update(1, { type: "response" })];
    const result = await filterUpdatesByOwner(updates, ctx({ owner: null }));
    expect(result).toEqual(updates);
  });

  test("owner set + valid senderAddr matching owner: update forwarded", async () => {
    const updates = [
      update(1, { type: "response", senderAddr: "owner@example.com" }),
    ];
    const result = await filterUpdatesByOwner(updates, ctx({
      owner: 42,
      lookupContactByAddr: async (addr) => addr === "owner@example.com" ? 42 : null,
    }));
    expect(result).toEqual(updates);
  });

  test("owner set + missing senderAddr: update rejected", async () => {
    const updates = [update(1, { type: "response" })];
    const result = await filterUpdatesByOwner(updates, ctx({ owner: 42 }));
    expect(result).toEqual([]);
  });

  test("owner set + null payload: update rejected", async () => {
    const updates = [update(1, null)];
    const result = await filterUpdatesByOwner(updates, ctx({ owner: 42 }));
    expect(result).toEqual([]);
  });

  test("owner set + senderAddr from non-owner: update rejected", async () => {
    const updates = [
      update(1, { type: "response", senderAddr: "stranger@example.com" }),
    ];
    const result = await filterUpdatesByOwner(updates, ctx({
      owner: 42,
      lookupContactByAddr: async () => 99, // stranger's contact ID
    }));
    expect(result).toEqual([]);
  });

  test("owner set + senderAddr resolves to null (unknown contact): update rejected", async () => {
    const updates = [
      update(1, { type: "response", senderAddr: "unknown@example.com" }),
    ];
    const result = await filterUpdatesByOwner(updates, ctx({
      owner: 42,
      lookupContactByAddr: async () => null,
    }));
    expect(result).toEqual([]);
  });

  test("mixed updates: only owner updates forwarded", async () => {
    const ownerUpdate = update(1, { type: "response", senderAddr: "owner@example.com" });
    const strangerUpdate = update(2, { type: "response", senderAddr: "stranger@example.com" });
    const noAddrUpdate = update(3, { type: "version_mismatch" });

    const result = await filterUpdatesByOwner(
      [ownerUpdate, strangerUpdate, noAddrUpdate],
      ctx({
        owner: 42,
        lookupContactByAddr: async (addr) => addr === "owner@example.com" ? 42 : 99,
      }),
    );
    expect(result).toEqual([ownerUpdate]);
  });

  test("rejections are logged with chat/msg/app details", async () => {
    const logs: string[] = [];
    const updates = [
      update(1, { type: "response", senderAddr: "stranger@example.com" }),
      update(2, { type: "response" }),
    ];
    await filterUpdatesByOwner(updates, ctx({
      owner: 42,
      chatId: 100,
      msgId: 200,
      appId: "test-app",
      lookupContactByAddr: async () => 99,
      logf: (fmt, ...args) => {
        let msg = fmt;
        for (const a of args) msg = msg.replace(/%[sdv]/, String(a));
        logs.push(msg);
      },
    }));
    expect(logs.length).toBe(2);
    expect(logs[0]).toContain("non-owner");
    expect(logs[0]).toContain("100");
    expect(logs[1]).toContain("without senderAddr");
  });

  test("empty updates array returns empty", async () => {
    const result = await filterUpdatesByOwner([], ctx({ owner: 42 }));
    expect(result).toEqual([]);
  });

  test("empty updates array with no owner returns empty", async () => {
    const result = await filterUpdatesByOwner([], ctx({ owner: null }));
    expect(result).toEqual([]);
  });

  test("1:1 chat fast path: senderAddr trusted unconditionally even when contact lookup fails", async () => {
    // dc-core ≥ 2.48 returns webxdc selfAddr as a 64-char hash that
    // lookupContactByAddr can't resolve. In a 1:1 chat we accept it
    // because the only non-bot member IS the owner.
    const updates = [
      update(1, { type: "response", senderAddr: "a6d2dc069c906422cb0934ce2a1059e21c02521ddbb159ef664a6ae69e3d98ef" }),
    ];
    const result = await filterUpdatesByOwner(updates, ctx({
      owner: 42,
      chatContactCount: 2, // bot + 1 user = 1:1
      lookupContactByAddr: async () => null,
    }));
    expect(result).toEqual(updates);
  });

  test("1:1 chat fast path: still rejects updates without senderAddr", async () => {
    const updates = [update(1, { type: "response" })];
    const result = await filterUpdatesByOwner(updates, ctx({
      owner: 42,
      chatContactCount: 2,
    }));
    expect(result).toEqual([]);
  });
});
