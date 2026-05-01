import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as access from "../access/index.js";

const testRoot = mkdtempSync(join(tmpdir(), "dc-principals-test-"));
const principalsDir = join(testRoot, "principals");
const approvedDir = join(testRoot, "approved");

beforeEach(() => {
  // Clean slate before each test.
  rmSync(principalsDir, { recursive: true, force: true });
  rmSync(approvedDir, { recursive: true, force: true });
  access.setPrincipalsDir(principalsDir);
  access.setApprovedDir(approvedDir);
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("principals — write/read/list", () => {
  test("loadHuman returns null for missing record", () => {
    expect(access.loadHuman(42)).toBeNull();
  });

  test("writeHuman + loadHuman round-trips", () => {
    const p: access.HumanPrincipal = {
      kind: "human",
      contactId: 42,
      displayName: "Alice",
      firstPairedAt: "2026-04-25T12:00:00.000Z",
    };
    access.writeHuman(p);
    expect(access.loadHuman(42)).toEqual(p);
  });

  test("writeHuman creates the humans/ subdir on first write", () => {
    access.writeHuman({
      kind: "human",
      contactId: 1,
      firstPairedAt: "2026-04-25T12:00:00.000Z",
    });
    expect(readdirSync(join(principalsDir, "humans"))).toContain("1.json");
  });

  test("writeHuman is atomic (no leftover .tmp files on success)", () => {
    access.writeHuman({
      kind: "human",
      contactId: 1,
      firstPairedAt: "2026-04-25T12:00:00.000Z",
    });
    const files = readdirSync(join(principalsDir, "humans"));
    expect(files.every((f) => !f.includes(".tmp."))).toBe(true);
  });

  test("loadHuman tolerates a corrupted JSON file", () => {
    mkdirSync(join(principalsDir, "humans"), { recursive: true });
    writeFileSync(join(principalsDir, "humans", "99.json"), "{ not json");
    expect(access.loadHuman(99)).toBeNull();
  });

  test("loadHuman rejects records with the wrong kind", () => {
    mkdirSync(join(principalsDir, "humans"), { recursive: true });
    writeFileSync(
      join(principalsDir, "humans", "99.json"),
      JSON.stringify({ kind: "agent", contactId: 99, firstPairedAt: "2026-01-01T00:00:00Z" }),
    );
    expect(access.loadHuman(99)).toBeNull();
  });

  test("listHumans returns empty when dir is missing", () => {
    expect(access.listHumans()).toEqual([]);
  });

  test("listHumans returns records sorted by firstPairedAt", () => {
    access.writeHuman({ kind: "human", contactId: 3, firstPairedAt: "2026-04-25T12:00:00.000Z" });
    access.writeHuman({ kind: "human", contactId: 1, firstPairedAt: "2026-04-23T12:00:00.000Z" });
    access.writeHuman({ kind: "human", contactId: 2, firstPairedAt: "2026-04-24T12:00:00.000Z" });
    const ids = access.listHumans().map((p) => p.contactId);
    expect(ids).toEqual([1, 2, 3]);
  });

  test("listHumans skips files that aren't .json", () => {
    mkdirSync(join(principalsDir, "humans"), { recursive: true });
    writeFileSync(join(principalsDir, "humans", "README.txt"), "hi");
    writeFileSync(join(principalsDir, "humans", "stray"), "");
    access.writeHuman({ kind: "human", contactId: 1, firstPairedAt: "2026-04-25T12:00:00.000Z" });
    expect(access.listHumans().map((p) => p.contactId)).toEqual([1]);
  });

  test("removeHuman deletes the record", () => {
    access.writeHuman({ kind: "human", contactId: 7, firstPairedAt: "2026-04-25T12:00:00.000Z" });
    expect(access.loadHuman(7)).not.toBeNull();
    access.removeHuman(7);
    expect(access.loadHuman(7)).toBeNull();
  });

  test("removeHuman is silent on missing files", () => {
    expect(() => access.removeHuman(9999)).not.toThrow();
  });
});

describe("principals — recordHumanPair", () => {
  test("creates a fresh record when none exists", () => {
    const before = Date.now();
    const p = access.recordHumanPair(50, "Alice");
    const after = Date.now();
    expect(p.contactId).toBe(50);
    expect(p.displayName).toBe("Alice");
    const ts = Date.parse(p.firstPairedAt);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  test("preserves firstPairedAt across re-pairs", async () => {
    const first = access.recordHumanPair(50, "Alice");
    await new Promise((r) => setTimeout(r, 5));
    const second = access.recordHumanPair(50, "Alice 2");
    expect(second.firstPairedAt).toBe(first.firstPairedAt);
    expect(second.displayName).toBe("Alice 2");
  });

  test("preserves displayName when re-pair omits one", () => {
    access.recordHumanPair(50, "Alice");
    const second = access.recordHumanPair(50);
    expect(second.displayName).toBe("Alice");
  });
});

describe("principals — backfillFromAllowlist", () => {
  test("writes principal records for each existing owner", () => {
    access.addChat(1001, 50);
    access.addChat(1002, 50); // same owner
    access.addChat(1003, 60);
    const written = access.backfillFromAllowlist();
    expect(written).toBe(2);
    expect(access.loadHuman(50)).not.toBeNull();
    expect(access.loadHuman(60)).not.toBeNull();
  });

  test("is idempotent (skips existing records)", () => {
    access.addChat(1001, 50);
    expect(access.backfillFromAllowlist()).toBe(1);
    expect(access.backfillFromAllowlist()).toBe(0);
  });

  test("ignores legacy chats without an owner", () => {
    access.addChat(1001); // no owner
    access.addChat(1002, 60);
    const written = access.backfillFromAllowlist();
    expect(written).toBe(1);
    expect(access.loadHuman(60)).not.toBeNull();
    expect(access.listHumans()).toHaveLength(1);
  });

  test("handles an empty allowlist", () => {
    expect(access.backfillFromAllowlist()).toBe(0);
    expect(access.listHumans()).toEqual([]);
  });
});

describe("principals — chatsFor", () => {
  test("returns owned chats for a human principal", () => {
    access.addChat(1001, 50);
    access.addChat(1002, 50);
    access.addChat(1003, 60);
    access.recordHumanPair(50);
    const human = access.loadHuman(50)!;
    expect(access.chatsFor(human)).toEqual([1001, 1002]);
  });

  test("returns empty for a human with no chats", () => {
    access.recordHumanPair(99);
    const human = access.loadHuman(99)!;
    expect(access.chatsFor(human)).toEqual([]);
  });

  test("returns empty for an agent (Phase 3)", () => {
    const agent: access.AgentPrincipal = {
      kind: "agent",
      agentId: "research-agent",
      displayName: "Research",
      teamId: null,
      dispatcherBinding: "main",
    };
    expect(access.chatsFor(agent)).toEqual([]);
  });
});

describe("principals — isContactApproved (#66 Option A)", () => {
  test("returns false when neither principal nor allowlist entry exists", () => {
    expect(access.isContactApproved(42)).toBe(false);
  });

  test("returns true when a principal record exists, even with no chats", () => {
    // The whole point of #66: contact identity is the trust boundary,
    // independent of whether they currently own any approved chat.
    access.recordHumanPair(42, "Joe");
    expect(access.isContactApproved(42)).toBe(true);
    // Sanity: no chat is owned by 42 yet.
    expect(access.chatsForOwner(42)).toEqual([]);
  });

  test("returns true via the legacy allowlist fallback (pre-Phase-2 install)", () => {
    // A pre-Phase-2 install has chat-allowlist entries but no principal
    // records yet (backfill hasn't run). We must still recognise them.
    access.addChat(7, 42);
    expect(access.loadHuman(42)).toBeNull();
    expect(access.isContactApproved(42)).toBe(true);
  });

  test("returns false after removeHuman + cleanup (full unpair)", () => {
    access.recordHumanPair(42);
    access.addChat(7, 42);
    expect(access.isContactApproved(42)).toBe(true);
    access.removeChat(7);
    access.removeHuman(42);
    expect(access.isContactApproved(42)).toBe(false);
  });

  test("returns true with principal-only state if removeChat happened but principal stayed", () => {
    // The intermediate state during a per-contact unpair: chats are
    // wiped first via cleanupChatState, then removeHuman runs at the
    // end. Between the two, isContactApproved still reads true — that
    // window is fine because no message routing happens during it.
    access.recordHumanPair(42);
    access.addChat(7, 42);
    access.removeChat(7);
    expect(access.isContactApproved(42)).toBe(true);
  });

  test("two contacts are independent", () => {
    access.recordHumanPair(42);
    access.addChat(8, 99);
    expect(access.isContactApproved(42)).toBe(true);
    expect(access.isContactApproved(99)).toBe(true);
    access.removeHuman(42);
    expect(access.isContactApproved(42)).toBe(false);
    expect(access.isContactApproved(99)).toBe(true);
  });
});
