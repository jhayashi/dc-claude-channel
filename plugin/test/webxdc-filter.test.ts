import { describe, test, expect, beforeEach } from "bun:test";
import {
  filterUpdatesByOwner,
  clearTrustedSenderAddrs,
  seedTrustedSenderAddr,
  _clearAllTrustedSenderAddrsForTesting,
  type FilterContext,
} from "../webxdc-filter";
import type { WebXDCUpdate } from "../dc-client";

// Helper to build a WebXDCUpdate
function update(serial: number, payload: unknown): WebXDCUpdate {
  return { serial, payload };
}

// Helper to build a FilterContext with defaults. Defaults to a group-style
// chat (>2 contacts) so the TOFU path is exercised; tests that need
// the 1:1 fast path override `chatContactCount: 2`.
function ctx(overrides: Partial<FilterContext> = {}): FilterContext {
  return {
    owner: 42,
    chatId: 100,
    msgId: 200,
    appId: "test-app",
    chatContactCount: 5,
    logf: () => {},
    ...overrides,
  };
}

// Hashes representative of dc-core ≥ 2.48 selfAddr — 64-char hex.
const OWNER_HASH = "a6d2dc069c906422cb0934ce2a1059e21c02521ddbb159ef664a6ae69e3d98ef";
const STRANGER_HASH = "f9bc7e2d8421e85311a7635dc18b46ac57e9034d6e8c2ba1d00f5b27cb6f4e90";

beforeEach(() => {
  _clearAllTrustedSenderAddrsForTesting();
});

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

  test("group chat first update: TOFU seeds + accepts", async () => {
    // The whole point of #47's fix — first update in a fresh group
    // chat MUST be accepted (and the cache seeded), since we can't
    // reverse-lookup the hash to verify it's the owner.
    const updates = [
      update(1, { type: "response", senderAddr: OWNER_HASH }),
    ];
    const result = await filterUpdatesByOwner(updates, ctx());
    expect(result).toEqual(updates);
  });

  test("group chat subsequent update with cached hash: accepted", async () => {
    // Seed the cache as if a prior update had landed.
    await filterUpdatesByOwner(
      [update(1, { type: "response", senderAddr: OWNER_HASH })],
      ctx(),
    );
    const next = [update(2, { type: "comments", senderAddr: OWNER_HASH })];
    const result = await filterUpdatesByOwner(next, ctx());
    expect(result).toEqual(next);
  });

  test("group chat subsequent update with mismatched hash: rejected", async () => {
    // Seed first, then a different hash arrives — must be rejected.
    seedTrustedSenderAddr(100, OWNER_HASH);
    const updates = [
      update(1, { type: "response", senderAddr: STRANGER_HASH }),
    ];
    const result = await filterUpdatesByOwner(updates, ctx());
    expect(result).toEqual([]);
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

  test("clearTrustedSenderAddrs allows re-seeding", async () => {
    seedTrustedSenderAddr(100, OWNER_HASH);
    // A different hash is rejected while seeded.
    const before = await filterUpdatesByOwner(
      [update(1, { type: "response", senderAddr: STRANGER_HASH })],
      ctx(),
    );
    expect(before).toEqual([]);
    // After clearing, the next update re-seeds — even if it's the
    // stranger's hash. (Documented TOFU race; clearing is owner-driven
    // via unpair, so re-seeding fresh is the intended behaviour.)
    clearTrustedSenderAddrs(100);
    const reseed = [update(2, { type: "response", senderAddr: STRANGER_HASH })];
    const after = await filterUpdatesByOwner(reseed, ctx());
    expect(after).toEqual(reseed);
  });

  test("mixed updates in a single batch: first seeds, second matches, third mismatches", async () => {
    const ownerFirst = update(1, { type: "response", senderAddr: OWNER_HASH });
    const ownerAgain = update(2, { type: "response", senderAddr: OWNER_HASH });
    const stranger = update(3, { type: "response", senderAddr: STRANGER_HASH });

    const result = await filterUpdatesByOwner(
      [ownerFirst, ownerAgain, stranger],
      ctx(),
    );
    expect(result).toEqual([ownerFirst, ownerAgain]);
  });

  test("rejections are logged with chat/msg/app details", async () => {
    seedTrustedSenderAddr(100, OWNER_HASH);
    const logs: string[] = [];
    const updates = [
      update(1, { type: "response", senderAddr: STRANGER_HASH }),
      update(2, { type: "response" }),
    ];
    await filterUpdatesByOwner(updates, ctx({
      owner: 42,
      chatId: 100,
      msgId: 200,
      appId: "test-app",
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

  test("seeding is logged with chat/msg/app details", async () => {
    const logs: string[] = [];
    await filterUpdatesByOwner(
      [update(1, { type: "response", senderAddr: OWNER_HASH })],
      ctx({
        logf: (fmt, ...args) => {
          let msg = fmt;
          for (const a of args) msg = msg.replace(/%[sdv]/, String(a));
          logs.push(msg);
        },
      }),
    );
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("TOFU-seeded");
    expect(logs[0]).toContain("100");
    expect(logs[0]).toContain("test-app");
  });

  test("empty updates array returns empty", async () => {
    const result = await filterUpdatesByOwner([], ctx({ owner: 42 }));
    expect(result).toEqual([]);
  });

  test("empty updates array with no owner returns empty", async () => {
    const result = await filterUpdatesByOwner([], ctx({ owner: null }));
    expect(result).toEqual([]);
  });

  test("1:1 chat fast path: senderAddr trusted unconditionally even when hashed", async () => {
    // dc-core ≥ 2.48 returns webxdc selfAddr as a 64-char hash. In a
    // 1:1 chat we trust it because the only non-bot member IS the
    // owner — no TOFU needed.
    const updates = [
      update(1, { type: "response", senderAddr: OWNER_HASH }),
    ];
    const result = await filterUpdatesByOwner(updates, ctx({
      owner: 42,
      chatContactCount: 2, // bot + 1 user = 1:1
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

  test("1:1 chat fast path: does NOT seed the group-chat TOFU cache", async () => {
    // 1:1 fast path is independent of the TOFU mechanism. Anything
    // that flows through it shouldn't poison the cache for the chat
    // (which would matter only if the contact count later climbs > 2,
    // e.g., the owner adds a friend to the chat — the TOFU cache
    // should start fresh in that case).
    await filterUpdatesByOwner(
      [update(1, { type: "response", senderAddr: STRANGER_HASH })],
      ctx({ chatContactCount: 2 }),
    );
    // Now the chat goes group-shaped; first update should seed.
    const groupUpdate = [update(2, { type: "response", senderAddr: OWNER_HASH })];
    const result = await filterUpdatesByOwner(groupUpdate, ctx({ chatContactCount: 5 }));
    expect(result).toEqual(groupUpdate);
  });

  test("two distinct chats keep independent TOFU caches", async () => {
    // Seeding chat A does not affect chat B.
    await filterUpdatesByOwner(
      [update(1, { type: "response", senderAddr: OWNER_HASH })],
      ctx({ chatId: 100 }),
    );
    // Different chat, different sender — must be accepted as a fresh seed.
    const differentChat = [update(2, { type: "response", senderAddr: STRANGER_HASH })];
    const result = await filterUpdatesByOwner(differentChat, ctx({ chatId: 200 }));
    expect(result).toEqual(differentChat);
  });
});
