import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as access from "../access/index.js";

/**
 * Tests for `migrateContactsCanonicalSeed` — v1.4.9 contacts-per-agent
 * migration that back-fills each bound agent's sidecar from
 * `claude-code.dc/contacts/` so the per-agent read+write flip in Phases
 * 2-3 doesn't strand permissioned contacts.
 *
 * Plan: docs/superpowers/plans/2026-05-31-contacts-per-agent.md (Phase 1)
 *
 * Inversion-of-control design: the function takes a `bindings` snapshot,
 * a `getChatMembers(chatId) → number[]` callback, and an
 * `agentExists(agentId) → boolean` callback. Tests pass fixtures; the
 * server.ts caller wires `client.getChatContacts` + `agents.getAgent`.
 * Keeps the migration synchronous, deterministic, and unit-testable
 * without a live dc-client.
 */
describe("migrateContactsCanonicalSeed", () => {
  let tmpRoot: string;
  let agentsDir: string;

  function makeBinding(chatId: number, agentId: string | undefined) {
    return { chatId, agentId };
  }

  function seedClaudeCodeContact(cid: number, partial: Partial<{ role: string; firstPairedAt: string; capabilities: string[]; displayName: string }> = {}) {
    const dir = join(agentsDir, "claude-code.dc", "contacts");
    mkdirSync(dir, { recursive: true });
    const body = {
      kind: "human",
      contactId: cid,
      firstPairedAt: partial.firstPairedAt ?? "2026-04-25T00:00:00.000Z",
      role: partial.role ?? "subscriber",
      capabilities: partial.capabilities ?? ["*"],
      ...(partial.displayName !== undefined ? { displayName: partial.displayName } : {}),
    };
    writeFileSync(join(dir, `${cid}.json`), JSON.stringify(body));
  }

  function seedAgentMd(name: string): void {
    writeFileSync(
      join(agentsDir, `${name}.md`),
      `---\nname: ${name}\nmodel: claude-sonnet-4-6\n---\nbody\n`,
    );
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "dc-canonical-seed-"));
    agentsDir = join(tmpRoot, "agents");
    mkdirSync(agentsDir, { recursive: true });
    access.setContactsAgentsDir(agentsDir);
  });

  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

  test("seeds two agents from their own bindings' chat members", () => {
    seedAgentMd("dc-developer");
    seedAgentMd("librarian");
    seedClaudeCodeContact(11, { role: "subscriber" });
    seedClaudeCodeContact(12, { role: "family-member" });

    const members: Record<number, number[]> = {
      14: [11],   // dc-developer chat → has contact 11
      27: [12],   // librarian chat → has contact 12
    };

    const result = access.migrateContactsCanonicalSeed(
      [
        makeBinding(14, "dc-developer"),
        makeBinding(27, "librarian"),
      ],
      (chatId) => members[chatId] ?? [],
      (agentId) => existsSync(join(agentsDir, `${agentId}.md`)),
    );

    expect(result.perAgent.get("dc-developer")).toBe(1);
    expect(result.perAgent.get("librarian")).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(existsSync(join(agentsDir, "dc-developer.dc", "contacts", "11.json"))).toBe(true);
    expect(existsSync(join(agentsDir, "librarian.dc", "contacts", "12.json"))).toBe(true);
  });

  test("preserves role/capabilities/firstPairedAt/displayName when copying", () => {
    seedAgentMd("dc-developer");
    seedClaudeCodeContact(11, {
      role: "family-member",
      firstPairedAt: "2026-03-15T12:34:56.789Z",
      capabilities: ["chat", "low_stakes_*"],
      displayName: "Alice",
    });

    access.migrateContactsCanonicalSeed(
      [makeBinding(14, "dc-developer")],
      () => [11],
      () => true,
    );

    const copied = JSON.parse(
      readFileSync(join(agentsDir, "dc-developer.dc", "contacts", "11.json"), "utf-8"),
    );
    expect(copied.role).toBe("family-member");
    expect(copied.capabilities).toEqual(["chat", "low_stakes_*"]);
    expect(copied.firstPairedAt).toBe("2026-03-15T12:34:56.789Z");
    expect(copied.displayName).toBe("Alice");
  });

  test("skips bindings already pointed at claude-code (already canonical)", () => {
    seedAgentMd("claude-code");
    seedClaudeCodeContact(11);

    const result = access.migrateContactsCanonicalSeed(
      [makeBinding(10, "claude-code")],
      () => [11],
      () => true,
    );

    expect(result.perAgent.size).toBe(0);
    expect(result.skipped).toEqual([]);
    // Source untouched (would be a no-op copy onto itself), no per-agent
    // counter incremented.
  });

  test("idempotent — second run reports zero new copies", () => {
    seedAgentMd("dc-developer");
    seedClaudeCodeContact(11);

    const bindings = [makeBinding(14, "dc-developer")];
    const getMembers = () => [11];
    const agentExists = () => true;

    const r1 = access.migrateContactsCanonicalSeed(bindings, getMembers, agentExists);
    const r2 = access.migrateContactsCanonicalSeed(bindings, getMembers, agentExists);

    expect(r1.perAgent.get("dc-developer")).toBe(1);
    expect(r2.perAgent.size).toBe(0);
  });

  test("does not overwrite a target record that already exists (per-agent divergence)", () => {
    seedAgentMd("dc-developer");
    seedClaudeCodeContact(11, { role: "subscriber" });
    // dc-developer already has a custom role for contact 11 (set via picker).
    const targetDir = join(agentsDir, "dc-developer.dc", "contacts");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(
      join(targetDir, "11.json"),
      JSON.stringify({
        kind: "human",
        contactId: 11,
        firstPairedAt: "2026-04-25T00:00:00.000Z",
        role: "guest",
        capabilities: ["chat"],
      }),
    );

    const result = access.migrateContactsCanonicalSeed(
      [makeBinding(14, "dc-developer")],
      () => [11],
      () => true,
    );

    expect(result.perAgent.size).toBe(0);
    // dc-developer's custom role preserved.
    const preserved = JSON.parse(readFileSync(join(targetDir, "11.json"), "utf-8"));
    expect(preserved.role).toBe("guest");
  });

  test("leaves true strangers unpopulated (member with no claude-code record)", () => {
    seedAgentMd("dc-developer");
    // No claude-code record for contact 99.

    const result = access.migrateContactsCanonicalSeed(
      [makeBinding(14, "dc-developer")],
      () => [99],
      () => true,
    );

    expect(result.perAgent.size).toBe(0);
    expect(existsSync(join(agentsDir, "dc-developer.dc", "contacts", "99.json"))).toBe(false);
  });

  test("skips orphaned bindings (agent .md missing) with reason='orphaned_binding'", () => {
    // No seedAgentMd("ghost-agent"); binding points at a nonexistent agent.
    seedClaudeCodeContact(11);

    const result = access.migrateContactsCanonicalSeed(
      [makeBinding(14, "ghost-agent")],
      () => [11],
      (agentId) => existsSync(join(agentsDir, `${agentId}.md`)),
    );

    expect(result.perAgent.size).toBe(0);
    expect(result.skipped).toEqual([
      { chatId: 14, agentId: "ghost-agent", reason: "orphaned_binding" },
    ]);
    expect(existsSync(join(agentsDir, "ghost-agent.dc"))).toBe(false);
  });

  test("skips bindings without an agentId (chat paired but not yet bound to an agent)", () => {
    seedClaudeCodeContact(11);

    const result = access.migrateContactsCanonicalSeed(
      [makeBinding(14, undefined)],
      () => [11],
      () => true,
    );

    expect(result.perAgent.size).toBe(0);
    expect(result.skipped).toEqual([]);
  });

  test("excludes reserved DC contact ids (≤ 9) and CONTACT_SELF (1)", () => {
    seedAgentMd("dc-developer");
    // No seed for 1 or 9 — but if we attempted to copy them, we'd still
    // skip them because they're below the threshold (regardless of
    // whether a stale record exists).
    seedClaudeCodeContact(1); // would normally be CONTACT_SELF
    seedClaudeCodeContact(7);

    const result = access.migrateContactsCanonicalSeed(
      [makeBinding(14, "dc-developer")],
      () => [1, 7, 11],
      () => true,
    );

    seedClaudeCodeContact(11);
    // Re-run to pick up contact 11 now seeded.
    const r2 = access.migrateContactsCanonicalSeed(
      [makeBinding(14, "dc-developer")],
      () => [1, 7, 11],
      () => true,
    );

    // First run: only the 1/7 entries are present; both excluded.
    expect(result.perAgent.get("dc-developer") ?? 0).toBe(0);
    // Second run: contact 11 seeded; 1/7 still skipped.
    expect(r2.perAgent.get("dc-developer")).toBe(1);
    expect(existsSync(join(agentsDir, "dc-developer.dc", "contacts", "1.json"))).toBe(false);
    expect(existsSync(join(agentsDir, "dc-developer.dc", "contacts", "7.json"))).toBe(false);
    expect(existsSync(join(agentsDir, "dc-developer.dc", "contacts", "11.json"))).toBe(true);
  });

  test("dedupes members across multiple chats bound to the same agent", () => {
    seedAgentMd("dc-developer");
    seedClaudeCodeContact(11);
    // Two chats, both bound to dc-developer, both with contact 11.
    const members: Record<number, number[]> = { 14: [11], 15: [11] };

    const result = access.migrateContactsCanonicalSeed(
      [makeBinding(14, "dc-developer"), makeBinding(15, "dc-developer")],
      (cid) => members[cid] ?? [],
      () => true,
    );

    // Copy happens once (idempotent on second chat); count is 1.
    expect(result.perAgent.get("dc-developer")).toBe(1);
    expect(existsSync(join(agentsDir, "dc-developer.dc", "contacts", "11.json"))).toBe(true);
  });

  test("returns empty result for empty bindings list", () => {
    const result = access.migrateContactsCanonicalSeed([], () => [], () => true);
    expect(result.perAgent.size).toBe(0);
    expect(result.skipped).toEqual([]);
  });

  test("continues seeding other bindings when one chat's getChatMembers throws", () => {
    seedAgentMd("agent-a");
    seedAgentMd("agent-b");
    seedClaudeCodeContact(11);

    const result = access.migrateContactsCanonicalSeed(
      [makeBinding(20, "agent-a"), makeBinding(21, "agent-b")],
      (chatId) => {
        if (chatId === 20) throw new Error("dc-core unavailable");
        return [11];
      },
      () => true,
    );

    expect(result.perAgent.get("agent-a") ?? 0).toBe(0);
    expect(result.perAgent.get("agent-b")).toBe(1);
  });

  test("invalidates the contact-policy cache after seeding (so isContactPermissioned sees fresh state)", () => {
    seedAgentMd("dc-developer");
    seedClaudeCodeContact(11);

    // Pre-seed cache by querying dc-developer (should be empty).
    expect(access.isContactPermissioned("dc-developer", 11)).toBe(false);

    access.migrateContactsCanonicalSeed(
      [makeBinding(14, "dc-developer")],
      () => [11],
      () => true,
    );

    // Post-seed: cache must reflect new record without manual invalidation.
    expect(access.isContactPermissioned("dc-developer", 11)).toBe(true);
  });
});
