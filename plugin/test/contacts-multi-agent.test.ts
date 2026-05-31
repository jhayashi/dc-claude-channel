import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as access from "../access/index.js";

/**
 * Tests for v1.4.9 multi-agent helpers introduced after the /code-review:
 *
 *   - hasContactRecordForAnyAgent — corruption-safe "does any agent
 *     hold a record for this contact?" query. Replaces the inline
 *     IIFE in dc_access_unpair so a corrupt sidecar record can't
 *     break the unpair command.
 *
 *   - backfillFromAllowlist's required agentId param — the
 *     `= DEFAULT_AGENT_ID` default was a regression footgun
 *     (callers could silently funnel back through claude-code).
 *     Removed; this test pins the explicit-arg requirement at
 *     runtime (TypeScript also catches it at compile time).
 *
 * Plan: docs/superpowers/plans/2026-05-31-contacts-per-agent.md
 *       /code-review findings #1 + #3 (2026-05-31).
 */
describe("hasContactRecordForAnyAgent", () => {
  let tmpRoot: string;
  let agentsDir: string;

  function seedAgentMd(name: string): void {
    writeFileSync(
      join(agentsDir, `${name}.md`),
      `---\nname: ${name}\nmodel: claude-sonnet-4-6\n---\nbody\n`,
    );
  }

  function seedContact(agentId: string, cid: number, partial: { role?: string } = {}): void {
    const dir = join(agentsDir, `${agentId}.dc`, "contacts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${cid}.json`),
      JSON.stringify({
        kind: "human",
        contactId: cid,
        firstPairedAt: "2026-04-25T00:00:00.000Z",
        role: partial.role ?? "subscriber",
        capabilities: ["*"],
      }),
    );
  }

  function seedCorruptContact(agentId: string, cid: number): void {
    const dir = join(agentsDir, `${agentId}.dc`, "contacts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${cid}.json`), "{ not valid json");
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "dc-multi-agent-"));
    agentsDir = join(tmpRoot, "agents");
    mkdirSync(agentsDir, { recursive: true });
    access.setContactsAgentsDir(agentsDir);
  });

  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

  test("returns true when at least one agent has a valid record", () => {
    seedAgentMd("dc-developer");
    seedContact("dc-developer", 11);
    expect(access.hasContactRecordForAnyAgent(11, ["claude-code", "dc-developer"])).toBe(true);
  });

  test("returns false when no agent has a record", () => {
    expect(access.hasContactRecordForAnyAgent(99, ["claude-code", "dc-developer"])).toBe(false);
  });

  // /code-review finding #1 — the inline IIFE in dc_access_unpair lets
  // loadContact throw uncaught when a sidecar record is corrupt
  // (CLAUDE.md + slice-3-5: "loadContact may throw on corrupt /
  // unreadable record"). This helper has to stay green in that
  // scenario or the user's unpair command silently fails.
  test("skips agents with corrupt records and keeps scanning the rest", () => {
    seedAgentMd("agent-a");
    seedAgentMd("agent-b");
    seedCorruptContact("agent-a", 11); // would throw if not caught
    seedContact("agent-b", 11);

    expect(access.hasContactRecordForAnyAgent(11, ["agent-a", "agent-b"])).toBe(true);
  });

  test("returns false when every candidate record is corrupt", () => {
    seedAgentMd("agent-a");
    seedAgentMd("agent-b");
    seedCorruptContact("agent-a", 11);
    seedCorruptContact("agent-b", 11);

    expect(access.hasContactRecordForAnyAgent(11, ["agent-a", "agent-b"])).toBe(false);
  });

  test("empty agent list returns false (no records to check)", () => {
    expect(access.hasContactRecordForAnyAgent(11, [])).toBe(false);
  });
});

describe("listAllAgentIds with agentExists filter", () => {
  let tmpRoot: string;
  let agentsDir: string;
  let bindingsDir: string;

  function seedAgentMd(name: string): void {
    writeFileSync(
      join(agentsDir, `${name}.md`),
      `---\nname: ${name}\nmodel: claude-sonnet-4-6\n---\nbody\n`,
    );
  }

  function seedBinding(chatId: number, agentId: string): void {
    writeFileSync(
      join(bindingsDir, `${chatId}.json`),
      JSON.stringify({ chatId, agentId, createdAt: new Date().toISOString() }),
    );
  }

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "dc-listall-"));
    agentsDir = join(tmpRoot, "agents");
    bindingsDir = join(tmpRoot, "bindings");
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(bindingsDir, { recursive: true });
    const bindings = await import("../bindings.js");
    bindings.setBindingsDir(bindingsDir);
  });

  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

  test("without filter, includes orphan-binding agents", async () => {
    seedAgentMd("agent-a");
    seedBinding(10, "agent-a");
    seedBinding(11, "ghost-agent"); // .md missing
    const bindings = await import("../bindings.js");

    const ids = bindings.listAllAgentIds();
    expect(ids.has("agent-a")).toBe(true);
    expect(ids.has("ghost-agent")).toBe(true);
    expect(ids.has("claude-code")).toBe(true);
  });

  // /code-review finding #2 — backfillFromAllowlist writes to
  // <agentId>.dc/contacts/<cid>.json, creating litter files in
  // sidecars whose agent .md no longer exists. The canonical-seed
  // migration filters orphans symmetrically; backfill should too.
  // The filter is an opt-in to keep unpair's "clean every sidecar"
  // semantics intact (unpair WANTS to wipe orphan records).
  test("with agentExists filter, excludes orphan-binding agents", async () => {
    seedAgentMd("agent-a");
    seedBinding(10, "agent-a");
    seedBinding(11, "ghost-agent");
    const bindings = await import("../bindings.js");

    const ids = bindings.listAllAgentIds({
      agentExists: (id) => id === "agent-a" || id === "claude-code",
    });
    expect(ids.has("agent-a")).toBe(true);
    expect(ids.has("ghost-agent")).toBe(false);
    expect(ids.has("claude-code")).toBe(true); // default always included
  });

  test("filter applies to default agent too if it returns false (degenerate but consistent)", async () => {
    seedAgentMd("agent-a");
    seedBinding(10, "agent-a");
    const bindings = await import("../bindings.js");

    // Pathological case: claude-code.md missing. We still include it —
    // the default is always in the set regardless of agentExists, to
    // preserve the canonical pairing-target invariant. Filter only
    // applies to *bound* agentIds from listBindings().
    const ids = bindings.listAllAgentIds({
      agentExists: () => false,
    });
    expect(ids.has("claude-code")).toBe(true);
    expect(ids.has("agent-a")).toBe(false);
  });
});
