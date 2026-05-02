import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as access from "../access/index.js";

const testRoot = mkdtempSync(join(tmpdir(), "dc-principals-test-"));
const agentsDir = join(testRoot, "agents");
const contactsDir = join(agentsDir, "claude-code", "contacts");
const approvedDir = join(testRoot, "approved");

beforeEach(() => {
  // Clean slate before each test.
  rmSync(agentsDir, { recursive: true, force: true });
  rmSync(approvedDir, { recursive: true, force: true });
  access.setContactsAgentsDir(agentsDir);
  access.setApprovedDir(approvedDir);
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("principals — write/read/list", () => {
  test("loadContact returns null for missing record", () => {
    expect(access.loadContact(access.DEFAULT_AGENT_ID, 42)).toBeNull();
  });

  test("writeContact + loadContact round-trips (v1.3: fills role/capabilities defaults)", () => {
    const p: access.Contact = {
      kind: "human",
      contactId: 42,
      displayName: "Alice",
      firstPairedAt: "2026-04-25T12:00:00.000Z",
    };
    access.writeContact(access.DEFAULT_AGENT_ID, p);
    // loadContact fills role/capabilities defaults at read time for legacy
    // records written without them. Subscriber + wildcard preserves
    // binary-trust behavior on upgrade.
    expect(access.loadContact(access.DEFAULT_AGENT_ID, 42)).toEqual({
      ...p,
      role: "subscriber",
      capabilities: ["*"],
    });
  });

  test("writeContact creates the contacts/ subdir on first write", () => {
    access.writeContact(access.DEFAULT_AGENT_ID, {
      kind: "human",
      contactId: 1,
      firstPairedAt: "2026-04-25T12:00:00.000Z",
    });
    expect(readdirSync(contactsDir)).toContain("1.json");
  });

  test("writeContact is atomic (no leftover .tmp files on success)", () => {
    access.writeContact(access.DEFAULT_AGENT_ID, {
      kind: "human",
      contactId: 1,
      firstPairedAt: "2026-04-25T12:00:00.000Z",
    });
    const files = readdirSync(contactsDir);
    expect(files.every((f) => !f.includes(".tmp."))).toBe(true);
  });

  test("loadContact throws on a corrupted JSON file (capability_lookup_error path)", () => {
    // Per security review T4 / Oliver P2 #1: corrupt records throw so
    // the capability gate distinguishes "we said no" (capability_deny)
    // from "we couldn't decide" (capability_lookup_error). The previous
    // null-return behavior collapsed both reasons to deny.
    mkdirSync(contactsDir, { recursive: true });
    writeFileSync(join(contactsDir, "99.json"), "{ not json");
    expect(() => access.loadContact(access.DEFAULT_AGENT_ID, 99)).toThrow();
  });

  test("loadContact throws on schema-mismatch records (wrong kind)", () => {
    mkdirSync(contactsDir, { recursive: true });
    writeFileSync(
      join(contactsDir, "99.json"),
      JSON.stringify({ kind: "agent", contactId: 99, firstPairedAt: "2026-01-01T00:00:00Z" }),
    );
    expect(() => access.loadContact(access.DEFAULT_AGENT_ID, 99)).toThrow(/schema mismatch/);
  });

  test("listContacts skips corrupt records and continues (does not crash startup)", () => {
    // listContacts is called from hot startup paths
    // (backfillFromAllowlist, hasAnyPermissionedContact). A single bad
    // record must not take down the dispatcher.
    mkdirSync(contactsDir, { recursive: true });
    writeFileSync(join(contactsDir, "1.json"), "{ not json"); // corrupt
    access.writeContact(access.DEFAULT_AGENT_ID, { kind: "human", contactId: 2, firstPairedAt: "2026-04-25T12:00:00.000Z" });
    // Silence the expected stderr noise from the skipped record.
    const origErr = console.error;
    let logged = false;
    console.error = () => { logged = true; };
    try {
      const list = access.listContacts(access.DEFAULT_AGENT_ID);
      expect(list.map((c) => c.contactId)).toEqual([2]);
      expect(logged).toBe(true);
    } finally {
      console.error = origErr;
    }
  });

  test("listContacts returns empty when dir is missing", () => {
    expect(access.listContacts(access.DEFAULT_AGENT_ID)).toEqual([]);
  });

  test("listContacts returns records sorted by firstPairedAt", () => {
    access.writeContact(access.DEFAULT_AGENT_ID, { kind: "human", contactId: 3, firstPairedAt: "2026-04-25T12:00:00.000Z" });
    access.writeContact(access.DEFAULT_AGENT_ID, { kind: "human", contactId: 1, firstPairedAt: "2026-04-23T12:00:00.000Z" });
    access.writeContact(access.DEFAULT_AGENT_ID, { kind: "human", contactId: 2, firstPairedAt: "2026-04-24T12:00:00.000Z" });
    const ids = access.listContacts(access.DEFAULT_AGENT_ID).map((p) => p.contactId);
    expect(ids).toEqual([1, 2, 3]);
  });

  test("listContacts skips files that aren't .json", () => {
    mkdirSync(contactsDir, { recursive: true });
    writeFileSync(join(contactsDir, "README.txt"), "hi");
    writeFileSync(join(contactsDir, "stray"), "");
    access.writeContact(access.DEFAULT_AGENT_ID, { kind: "human", contactId: 1, firstPairedAt: "2026-04-25T12:00:00.000Z" });
    expect(access.listContacts(access.DEFAULT_AGENT_ID).map((p) => p.contactId)).toEqual([1]);
  });

  test("removeContact deletes the record", () => {
    access.writeContact(access.DEFAULT_AGENT_ID, { kind: "human", contactId: 7, firstPairedAt: "2026-04-25T12:00:00.000Z" });
    expect(access.loadContact(access.DEFAULT_AGENT_ID, 7)).not.toBeNull();
    access.removeContact(access.DEFAULT_AGENT_ID, 7);
    expect(access.loadContact(access.DEFAULT_AGENT_ID, 7)).toBeNull();
  });

  test("removeContact is silent on missing files", () => {
    expect(() => access.removeContact(access.DEFAULT_AGENT_ID, 9999)).not.toThrow();
  });
});

describe("principals — recordContactPair", () => {
  test("creates a fresh record when none exists", () => {
    const before = Date.now();
    const p = access.recordContactPair(access.DEFAULT_AGENT_ID, 50, "Alice");
    const after = Date.now();
    expect(p.contactId).toBe(50);
    expect(p.displayName).toBe("Alice");
    const ts = Date.parse(p.firstPairedAt);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  test("preserves firstPairedAt across re-pairs", async () => {
    const first = access.recordContactPair(access.DEFAULT_AGENT_ID, 50, "Alice");
    await new Promise((r) => setTimeout(r, 5));
    const second = access.recordContactPair(access.DEFAULT_AGENT_ID, 50, "Alice 2");
    expect(second.firstPairedAt).toBe(first.firstPairedAt);
    expect(second.displayName).toBe("Alice 2");
  });

  test("preserves displayName when re-pair omits one", () => {
    access.recordContactPair(access.DEFAULT_AGENT_ID, 50, "Alice");
    const second = access.recordContactPair(access.DEFAULT_AGENT_ID, 50);
    expect(second.displayName).toBe("Alice");
  });

  test("assigns subscriber role + wildcard capabilities (v1.3 slice 6)", () => {
    // Terminal pair = subscriber, always. Coordinating a QR/code from
    // the terminal IS the trust signal.
    const p = access.recordContactPair(access.DEFAULT_AGENT_ID, 50, "Alice");
    expect(p.role).toBe("subscriber");
    expect(p.capabilities).toEqual(["*"]);
  });

  test("re-pair elevates a previously-downgraded contact back to subscriber", () => {
    // Edge case: subscriber downgraded contact to family-member via the
    // XDC picker, then later coordinated a terminal re-pair. Re-pair is
    // the higher-trust act — it elevates back to subscriber. Subscriber
    // can downgrade again via the picker if it was a mistake.
    access.setContactRole(access.DEFAULT_AGENT_ID, 50, "family-member", "Alice");
    expect(access.loadContact(access.DEFAULT_AGENT_ID, 50)?.role).toBe("family-member");
    access.recordContactPair(access.DEFAULT_AGENT_ID, 50);
    expect(access.loadContact(access.DEFAULT_AGENT_ID, 50)?.role).toBe("subscriber");
    expect(access.loadContact(access.DEFAULT_AGENT_ID, 50)?.capabilities).toEqual(["*"]);
  });

  test("recovers from a corrupt existing record by overwriting", () => {
    mkdirSync(contactsDir, { recursive: true });
    writeFileSync(join(contactsDir, "50.json"), "{ not json");
    // Capture stderr so the recovery message doesn't pollute test output.
    const origErr = console.error;
    let logged = false;
    console.error = () => { logged = true; };
    try {
      const p = access.recordContactPair(access.DEFAULT_AGENT_ID, 50, "Alice");
      expect(p.role).toBe("subscriber");
      expect(p.displayName).toBe("Alice");
      expect(logged).toBe(true);
    } finally {
      console.error = origErr;
    }
  });
});

describe("principals — setContactRole (v1.3 slice 6)", () => {
  test("creates a fresh principal with the assigned role + bundle", () => {
    const p = access.setContactRole(access.DEFAULT_AGENT_ID, 60, "family-member", "Bob");
    expect(p.contactId).toBe(60);
    expect(p.displayName).toBe("Bob");
    expect(p.role).toBe("family-member");
    expect(p.capabilities).toEqual(["chat", "low_stakes_*"]);
    expect(access.loadContact(access.DEFAULT_AGENT_ID, 60)).toEqual(p);
  });

  test("mutates existing principal: role + capabilities updated, firstPairedAt preserved", async () => {
    const original = access.recordContactPair(access.DEFAULT_AGENT_ID, 60, "Bob");
    await new Promise((r) => setTimeout(r, 5));
    const updated = access.setContactRole(access.DEFAULT_AGENT_ID, 60, "family-member");
    expect(updated.role).toBe("family-member");
    expect(updated.capabilities).toEqual(["chat", "low_stakes_*"]);
    expect(updated.firstPairedAt).toBe(original.firstPairedAt);
    expect(updated.displayName).toBe("Bob");
  });

  test("invalidates the permissioned-contacts cache (cache invariant)", () => {
    // setContactRole upsert on a fresh contact must make
    // isContactPermissioned return true on the next read.
    expect(access.isContactPermissioned(access.DEFAULT_AGENT_ID, 70)).toBe(false);
    access.setContactRole(access.DEFAULT_AGENT_ID, 70, "guest");
    expect(access.isContactPermissioned(access.DEFAULT_AGENT_ID, 70)).toBe(true);
  });

  test("unknown role falls back to guest bundle (least-privilege)", () => {
    // capability-bundles.bundleFor returns ["chat"] for unrecognized roles.
    const p = access.setContactRole(access.DEFAULT_AGENT_ID, 80, "made-up-role-name");
    expect(p.role).toBe("made-up-role-name"); // role string preserved verbatim
    expect(p.capabilities).toEqual(["chat"]);  // guest bundle (fail-safe)
  });

  test("recovers from a corrupt existing record by overwriting", () => {
    mkdirSync(contactsDir, { recursive: true });
    writeFileSync(join(contactsDir, "90.json"), "{ not json");
    const origErr = console.error;
    let logged = false;
    console.error = () => { logged = true; };
    try {
      const p = access.setContactRole(access.DEFAULT_AGENT_ID, 90, "guest");
      expect(p.role).toBe("guest");
      expect(logged).toBe(true);
    } finally {
      console.error = origErr;
    }
  });
});

describe("principals — backfillFromAllowlist", () => {
  test("writes principal records for each existing owner", () => {
    access.addChat(1001, 50);
    access.addChat(1002, 50); // same owner
    access.addChat(1003, 60);
    const written = access.backfillFromAllowlist(access.DEFAULT_AGENT_ID);
    expect(written).toBe(2);
    expect(access.loadContact(access.DEFAULT_AGENT_ID, 50)).not.toBeNull();
    expect(access.loadContact(access.DEFAULT_AGENT_ID, 60)).not.toBeNull();
  });

  test("is idempotent (skips existing records)", () => {
    access.addChat(1001, 50);
    expect(access.backfillFromAllowlist(access.DEFAULT_AGENT_ID)).toBe(1);
    expect(access.backfillFromAllowlist(access.DEFAULT_AGENT_ID)).toBe(0);
  });

  test("ignores legacy chats without an owner", () => {
    access.addChat(1001); // no owner
    access.addChat(1002, 60);
    const written = access.backfillFromAllowlist(access.DEFAULT_AGENT_ID);
    expect(written).toBe(1);
    expect(access.loadContact(access.DEFAULT_AGENT_ID, 60)).not.toBeNull();
    expect(access.listContacts(access.DEFAULT_AGENT_ID)).toHaveLength(1);
  });

  test("handles an empty allowlist", () => {
    expect(access.backfillFromAllowlist(access.DEFAULT_AGENT_ID)).toBe(0);
    expect(access.listContacts(access.DEFAULT_AGENT_ID)).toEqual([]);
  });
});

describe("principals — chatsFor", () => {
  test("returns owned chats for a human principal", () => {
    access.addChat(1001, 50);
    access.addChat(1002, 50);
    access.addChat(1003, 60);
    access.recordContactPair(access.DEFAULT_AGENT_ID, 50);
    const human = access.loadContact(access.DEFAULT_AGENT_ID, 50)!;
    expect(access.chatsFor(human)).toEqual([1001, 1002]);
  });

  test("returns empty for a human with no chats", () => {
    access.recordContactPair(access.DEFAULT_AGENT_ID, 99);
    const human = access.loadContact(access.DEFAULT_AGENT_ID, 99)!;
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

describe("principals — isContactPermissioned (#66 Option A)", () => {
  test("returns false when neither principal nor allowlist entry exists", () => {
    expect(access.isContactPermissioned(access.DEFAULT_AGENT_ID, 42)).toBe(false);
  });

  test("returns true when a principal record exists, even with no chats", () => {
    // The whole point of #66: contact identity is the trust boundary,
    // independent of whether they currently own any approved chat.
    access.recordContactPair(access.DEFAULT_AGENT_ID, 42, "Joe");
    expect(access.isContactPermissioned(access.DEFAULT_AGENT_ID, 42)).toBe(true);
    // Sanity: no chat is owned by 42 yet.
    expect(access.chatsForOwner(42)).toEqual([]);
  });

  test("returns true via the legacy allowlist fallback (pre-Phase-2 install)", () => {
    // A pre-Phase-2 install has chat-allowlist entries but no principal
    // records yet (backfill hasn't run). We must still recognise them.
    access.addChat(7, 42);
    expect(access.loadContact(access.DEFAULT_AGENT_ID, 42)).toBeNull();
    expect(access.isContactPermissioned(access.DEFAULT_AGENT_ID, 42)).toBe(true);
  });

  test("returns false after removeContact + cleanup (full unpair)", () => {
    access.recordContactPair(access.DEFAULT_AGENT_ID, 42);
    access.addChat(7, 42);
    expect(access.isContactPermissioned(access.DEFAULT_AGENT_ID, 42)).toBe(true);
    access.removeChat(7);
    access.removeContact(access.DEFAULT_AGENT_ID, 42);
    expect(access.isContactPermissioned(access.DEFAULT_AGENT_ID, 42)).toBe(false);
  });

  test("returns true with principal-only state if removeChat happened but principal stayed", () => {
    // The intermediate state during a per-contact unpair: chats are
    // wiped first via cleanupChatState, then removeContact runs at the
    // end. Between the two, isContactPermissioned still reads true — that
    // window is fine because no message routing happens during it.
    access.recordContactPair(access.DEFAULT_AGENT_ID, 42);
    access.addChat(7, 42);
    access.removeChat(7);
    expect(access.isContactPermissioned(access.DEFAULT_AGENT_ID, 42)).toBe(true);
  });

  test("two contacts are independent", () => {
    access.recordContactPair(access.DEFAULT_AGENT_ID, 42);
    access.addChat(8, 99);
    expect(access.isContactPermissioned(access.DEFAULT_AGENT_ID, 42)).toBe(true);
    expect(access.isContactPermissioned(access.DEFAULT_AGENT_ID, 99)).toBe(true);
    access.removeContact(access.DEFAULT_AGENT_ID, 42);
    expect(access.isContactPermissioned(access.DEFAULT_AGENT_ID, 42)).toBe(false);
    expect(access.isContactPermissioned(access.DEFAULT_AGENT_ID, 99)).toBe(true);
  });

  test("removeChat alone (principal stays) — Option A's actual new state", () => {
    // Symmetric to "removeContact alone (chats stay)" in auto-pair.test.
    // After Phase A unpair runs cleanupChatState (which removes chat
    // entries) and BEFORE removeContact fires, this is the live state:
    // principal exists, no chats. isContactPermissioned must read true via
    // the principal.
    access.recordContactPair(access.DEFAULT_AGENT_ID, 42);
    access.addChat(7, 42);
    access.removeChat(7);
    expect(access.loadContact(access.DEFAULT_AGENT_ID, 42)).not.toBeNull();
    expect(access.chatsForOwner(42)).toEqual([]);
    expect(access.isContactPermissioned(access.DEFAULT_AGENT_ID, 42)).toBe(true);
  });

  test("permissioned-contacts cache invalidates on write/remove (v1.3 review fix)", () => {
    // Elena HURT 2 fix: isContactPermissioned hits an in-memory Set on
    // the hot path. The cache must be transparent — invalidation on
    // write/remove ensures the next read sees the mutation.
    expect(access.isContactPermissioned(access.DEFAULT_AGENT_ID, 42)).toBe(false); // populates empty cache
    access.recordContactPair(access.DEFAULT_AGENT_ID, 42);
    expect(access.isContactPermissioned(access.DEFAULT_AGENT_ID, 42)).toBe(true);  // cache rebuild after write
    access.removeContact(access.DEFAULT_AGENT_ID, 42);
    expect(access.isContactPermissioned(access.DEFAULT_AGENT_ID, 42)).toBe(false); // cache rebuild after remove
  });

  test("permissioned-contacts cache invalidates on setContactsAgentsDir", () => {
    // setContactsAgentsDir is a test-isolation hook — it changes the on-disk
    // agents root the cache reads from. Must invalidate so subsequent reads
    // don't return stale data from the prior dir.
    access.recordContactPair(access.DEFAULT_AGENT_ID, 42);
    expect(access.isContactPermissioned(access.DEFAULT_AGENT_ID, 42)).toBe(true);
    // Switch to a fresh empty agents dir.
    const newAgentsDir = mkdtempSync(join(tmpdir(), "dc-cache-isolate-"));
    access.setContactsAgentsDir(newAgentsDir);
    expect(access.isContactPermissioned(access.DEFAULT_AGENT_ID, 42)).toBe(false);
    rmSync(newAgentsDir, { recursive: true, force: true });
  });
});

describe("principals — hasAnyPermissionedContact", () => {
  test("false when both layers are empty (fresh install)", () => {
    expect(access.hasAnyPermissionedContact(access.DEFAULT_AGENT_ID)).toBe(false);
  });

  test("true when only a chat-allowlist entry exists (legacy install)", () => {
    access.addChat(7, 42);
    expect(access.hasAnyPermissionedContact(access.DEFAULT_AGENT_ID)).toBe(true);
  });

  test("true when only a principal record exists (Option A new state)", () => {
    // The asymmetry the reviewer flagged: a contact with a principal
    // but no chats was invisible to the legacy hasAnyOwner. The new
    // helper sees them.
    access.recordContactPair(access.DEFAULT_AGENT_ID, 42);
    expect(access.hasAnyPermissionedContact(access.DEFAULT_AGENT_ID)).toBe(true);
  });

  test("true when both layers have entries", () => {
    access.recordContactPair(access.DEFAULT_AGENT_ID, 42);
    access.addChat(7, 42);
    expect(access.hasAnyPermissionedContact(access.DEFAULT_AGENT_ID)).toBe(true);
  });

  test("returns false after every contact is fully unpaired", () => {
    access.recordContactPair(access.DEFAULT_AGENT_ID, 42);
    access.addChat(7, 42);
    expect(access.hasAnyPermissionedContact(access.DEFAULT_AGENT_ID)).toBe(true);
    access.removeChat(7);
    access.removeContact(access.DEFAULT_AGENT_ID, 42);
    expect(access.hasAnyPermissionedContact(access.DEFAULT_AGENT_ID)).toBe(false);
  });
});

describe("principals — removeContact error handling (P2.5)", () => {
  test("missing file is silent (expected — idempotent unpair)", () => {
    // Capture stderr to ensure no spurious log.
    const origErr = console.error;
    let logged = false;
    console.error = () => { logged = true; };
    try {
      access.removeContact(access.DEFAULT_AGENT_ID, 99999); // never existed
      expect(logged).toBe(false);
    } finally {
      console.error = origErr;
    }
  });
});

describe("principals — role + capabilities (v1.3 slice 1)", () => {
  test("loadContact fills defaults on legacy records (no role, no capabilities)", () => {
    // Write a v1.2.2-shape record (no role, no capabilities) directly to disk.
    mkdirSync(contactsDir, { recursive: true });
    writeFileSync(
      join(contactsDir, "55.json"),
      JSON.stringify({ kind: "human", contactId: 55, firstPairedAt: "2026-04-25T12:00:00.000Z" }),
    );
    const p = access.loadContact(access.DEFAULT_AGENT_ID, 55);
    expect(p).not.toBeNull();
    expect(p!.role).toBe("subscriber");
    expect(p!.capabilities).toEqual(["*"]);
  });

  test("loadContact preserves explicit role and capabilities when both present", () => {
    access.writeContact(access.DEFAULT_AGENT_ID, {
      kind: "human",
      contactId: 56,
      firstPairedAt: "2026-04-25T12:00:00.000Z",
      role: "family-member",
      capabilities: ["chat", "low_stakes_*"],
    });
    const p = access.loadContact(access.DEFAULT_AGENT_ID, 56);
    expect(p!.role).toBe("family-member");
    expect(p!.capabilities).toEqual(["chat", "low_stakes_*"]);
  });

  test("loadContact fills capabilities from role bundle when only role is set", () => {
    // Defensive: a record with role but missing capabilities (shouldn't happen
    // in practice, but loadContact must not return [] for such a record — that
    // would mean denied-everywhere on-disk corruption).
    mkdirSync(contactsDir, { recursive: true });
    writeFileSync(
      join(contactsDir, "57.json"),
      JSON.stringify({ kind: "human", contactId: 57, firstPairedAt: "2026-04-25T12:00:00.000Z", role: "guest" }),
    );
    const p = access.loadContact(access.DEFAULT_AGENT_ID, 57);
    expect(p!.role).toBe("guest");
    expect(p!.capabilities).toEqual(["chat"]);
  });

  test("writeContact + loadContact round-trips role and capabilities", () => {
    const p: access.Contact = {
      kind: "human",
      contactId: 58,
      firstPairedAt: "2026-04-25T12:00:00.000Z",
      role: "untrusted-agent",
      capabilities: ["chat"],
    };
    access.writeContact(access.DEFAULT_AGENT_ID, p);
    expect(access.loadContact(access.DEFAULT_AGENT_ID, 58)).toEqual(p);
  });

  test("writeContact writes principal file with mode 0600", () => {
    access.writeContact(access.DEFAULT_AGENT_ID, {
      kind: "human",
      contactId: 59,
      firstPairedAt: "2026-04-25T12:00:00.000Z",
    });
    const path = join(contactsDir, "59.json");
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("agent isolation — Phase 3 Commit 2", () => {
  test("records under different agentIds are isolated", () => {
    access.writeContact("claude-code", {
      kind: "human",
      contactId: 1,
      firstPairedAt: "2026-01-01T00:00:00Z",
    });
    expect(access.loadContact("claude-code", 1)).not.toBeNull();
    expect(access.loadContact("test-agent", 1)).toBeNull();
  });
});

describe("principals — getCapabilitiesFor (v1.3 slice 1)", () => {
  test("returns the principal's explicit capability set", () => {
    access.writeContact(access.DEFAULT_AGENT_ID, {
      kind: "human",
      contactId: 60,
      firstPairedAt: "2026-04-25T12:00:00.000Z",
      role: "family-member",
      capabilities: ["chat", "low_stakes_*"],
    });
    expect(access.getCapabilitiesFor(access.DEFAULT_AGENT_ID, 60)).toEqual(["chat", "low_stakes_*"]);
  });

  test("returns empty for unknown contact (fail-closed)", () => {
    expect(access.getCapabilitiesFor(access.DEFAULT_AGENT_ID, 9999)).toEqual([]);
  });

  test("falls back to role bundle when capabilities array is missing on disk", () => {
    mkdirSync(contactsDir, { recursive: true });
    writeFileSync(
      join(contactsDir, "61.json"),
      JSON.stringify({ kind: "human", contactId: 61, firstPairedAt: "2026-04-25T12:00:00.000Z", role: "guest" }),
    );
    expect(access.getCapabilitiesFor(access.DEFAULT_AGENT_ID, 61)).toEqual(["chat"]);
  });

  test("returns wildcard for legacy records (no role, no capabilities)", () => {
    mkdirSync(contactsDir, { recursive: true });
    writeFileSync(
      join(contactsDir, "62.json"),
      JSON.stringify({ kind: "human", contactId: 62, firstPairedAt: "2026-04-25T12:00:00.000Z" }),
    );
    // Legacy record loaded with role=subscriber default → wildcard bundle.
    expect(access.getCapabilitiesFor(access.DEFAULT_AGENT_ID, 62)).toEqual(["*"]);
  });

  test("explicit empty capabilities array is treated as denied-everywhere", () => {
    // Reviewer Oliver flagged this: pre-fix, the length>0 guard in
    // getCapabilitiesFor let `capabilities: []` fall through to the
    // role bundle (so a `guest` with explicit `[]` got `["chat"]`
    // instead of nothing). The fix honors the explicit array as-is.
    access.writeContact(access.DEFAULT_AGENT_ID, {
      kind: "human",
      contactId: 70,
      firstPairedAt: "2026-04-25T12:00:00.000Z",
      role: "subscriber",
      capabilities: [],
    });
    expect(access.getCapabilitiesFor(access.DEFAULT_AGENT_ID, 70)).toEqual([]);
  });
});
