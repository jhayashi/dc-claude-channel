import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as access from "../access/index.js";

describe("migrateContactsToAgentScoped", () => {
  let tmpRoot: string;
  let legacyPrincipalsDir: string;
  let agentsDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "dc-contacts-migration-"));
    legacyPrincipalsDir = join(tmpRoot, "principals");
    agentsDir = join(tmpRoot, "agents");
    access.setPrincipalsDir(legacyPrincipalsDir);
    access.setContactsAgentsDir(agentsDir);
  });

  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

  test("moves records from principals/humans/ to agents/claude-code/contacts/", () => {
    mkdirSync(join(legacyPrincipalsDir, "humans"), { recursive: true });
    writeFileSync(
      join(legacyPrincipalsDir, "humans", "42.json"),
      JSON.stringify({ kind: "human", contactId: 42, firstPairedAt: "2026-01-01T00:00:00.000Z" }),
    );
    writeFileSync(
      join(legacyPrincipalsDir, "humans", "99.json"),
      JSON.stringify({ kind: "human", contactId: 99, firstPairedAt: "2026-02-01T00:00:00.000Z" }),
    );

    const count = access.migrateContactsToAgentScoped();

    expect(count).toBe(2);
    expect(existsSync(join(agentsDir, "claude-code", "contacts", "42.json"))).toBe(true);
    expect(existsSync(join(agentsDir, "claude-code", "contacts", "99.json"))).toBe(true);
  });

  test("renames principals/ to principals.legacy/ after migration", () => {
    mkdirSync(join(legacyPrincipalsDir, "humans"), { recursive: true });
    writeFileSync(
      join(legacyPrincipalsDir, "humans", "1.json"),
      JSON.stringify({ kind: "human", contactId: 1, firstPairedAt: "2026-01-01T00:00:00.000Z" }),
    );

    access.migrateContactsToAgentScoped();

    expect(existsSync(legacyPrincipalsDir)).toBe(false);
    expect(existsSync(`${legacyPrincipalsDir}.legacy`)).toBe(true);
  });

  test("is idempotent — returns 0 if agents/claude-code/contacts/ already exists", () => {
    mkdirSync(join(legacyPrincipalsDir, "humans"), { recursive: true });
    writeFileSync(
      join(legacyPrincipalsDir, "humans", "1.json"),
      JSON.stringify({ kind: "human", contactId: 1, firstPairedAt: "2026-01-01T00:00:00.000Z" }),
    );

    const count1 = access.migrateContactsToAgentScoped();
    const count2 = access.migrateContactsToAgentScoped();

    expect(count1).toBe(1);
    expect(count2).toBe(0);
  });

  test("returns 0 when no legacy principals directory exists (clean install)", () => {
    expect(access.migrateContactsToAgentScoped()).toBe(0);
    expect(existsSync(join(agentsDir, "claude-code", "contacts"))).toBe(false);
  });

  test("skips non-JSON files during migration", () => {
    mkdirSync(join(legacyPrincipalsDir, "humans"), { recursive: true });
    writeFileSync(join(legacyPrincipalsDir, "humans", "README.txt"), "ignore me");
    writeFileSync(
      join(legacyPrincipalsDir, "humans", "5.json"),
      JSON.stringify({ kind: "human", contactId: 5, firstPairedAt: "2026-01-01T00:00:00.000Z" }),
    );

    const count = access.migrateContactsToAgentScoped();

    expect(count).toBe(1);
    expect(readdirSync(join(agentsDir, "claude-code", "contacts"))).toEqual(["5.json"]);
  });

  test("loadContact reads from new path after migration", () => {
    mkdirSync(join(legacyPrincipalsDir, "humans"), { recursive: true });
    writeFileSync(
      join(legacyPrincipalsDir, "humans", "42.json"),
      JSON.stringify({
        kind: "human",
        contactId: 42,
        firstPairedAt: "2026-01-01T00:00:00.000Z",
        role: "subscriber",
        capabilities: ["*"],
      }),
    );

    access.migrateContactsToAgentScoped();

    const contact = access.loadContact(access.DEFAULT_AGENT_ID, 42);
    expect(contact).not.toBeNull();
    expect(contact!.contactId).toBe(42);
    expect(contact!.role).toBe("subscriber");
  });

  test("writeContact writes to new path (no legacy dir needed)", () => {
    access.writeContact(access.DEFAULT_AGENT_ID, {
      kind: "human",
      contactId: 77,
      firstPairedAt: "2026-01-01T00:00:00.000Z",
      role: "family-member",
      capabilities: ["chat", "low_stakes_*"],
    });

    expect(existsSync(join(agentsDir, "claude-code", "contacts", "77.json"))).toBe(true);
    expect(existsSync(join(legacyPrincipalsDir, "humans", "77.json"))).toBe(false);
  });
});
