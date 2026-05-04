import { describe, test, expect } from "bun:test";
import { filterUpdatesByOwner, type FilterContext } from "../webxdc-filter";
import type { WebXDCUpdate } from "../dc-client";

function update(serial: number, payload: unknown): WebXDCUpdate {
  return { serial, payload };
}

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
const HASH_A = "a6d2dc069c906422cb0934ce2a1059e21c02521ddbb159ef664a6ae69e3d98ef";
const HASH_B = "f9bc7e2d8421e85311a7635dc18b46ac57e9034d6e8c2ba1d00f5b27cb6f4e90";

describe("filterUpdatesByOwner", () => {
  test("no owner (legacy unpaired chat): all updates pass through unfiltered", async () => {
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

  test("owner set + valid senderAddr: passes through (any chat shape)", async () => {
    const updates = [update(1, { type: "response", senderAddr: HASH_A })];
    const result = await filterUpdatesByOwner(updates, ctx());
    expect(result).toEqual(updates);
  });

  test("owner set + missing senderAddr: rejected (malformed payload guard)", async () => {
    const updates = [update(1, { type: "response" })];
    const result = await filterUpdatesByOwner(updates, ctx());
    expect(result).toEqual([]);
  });

  test("owner set + null payload: rejected", async () => {
    const updates = [update(1, null)];
    const result = await filterUpdatesByOwner(updates, ctx());
    expect(result).toEqual([]);
  });

  test("regression for #bug-from-chat-14: a second device's distinct senderAddr still passes", async () => {
    // Pre-fix this test would fail: chat-scoped TOFU rejected the
    // second hash. With TOFU dropped, both pass.
    const first = [update(1, { type: "ping", senderAddr: HASH_A })];
    const second = [update(2, { type: "ping", senderAddr: HASH_B })];
    expect(await filterUpdatesByOwner(first, ctx())).toEqual(first);
    expect(await filterUpdatesByOwner(second, ctx())).toEqual(second);
  });

  test("mixed batch: valid updates pass, malformed get dropped", async () => {
    const a = update(1, { type: "ping", senderAddr: HASH_A });
    const b = update(2, { type: "ping" });               // missing senderAddr
    const c = update(3, { type: "ping", senderAddr: HASH_B });
    const result = await filterUpdatesByOwner([a, b, c], ctx());
    expect(result).toEqual([a, c]);
  });

  test("rejection logged with chat/msg/app details", async () => {
    const logs: string[] = [];
    await filterUpdatesByOwner(
      [update(1, { type: "ping" })],
      ctx({
        logf: (fmt, ...args) => {
          let msg = fmt;
          for (const a of args) msg = msg.replace(/%[sdv]/, String(a));
          logs.push(msg);
        },
      }),
    );
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("without senderAddr");
    expect(logs[0]).toContain("100");
    expect(logs[0]).toContain("test-app");
  });

  test("empty updates array returns empty (owner set)", async () => {
    expect(await filterUpdatesByOwner([], ctx())).toEqual([]);
  });

  test("empty updates array returns empty (no owner)", async () => {
    expect(await filterUpdatesByOwner([], ctx({ owner: null }))).toEqual([]);
  });
});
