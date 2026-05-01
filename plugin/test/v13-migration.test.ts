import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as access from "../access/index.js";

const root = mkdtempSync(join(tmpdir(), "dc-v13-migration-"));
const approvedDir = join(root, "approved");
const approvedLegacyDir = `${approvedDir}.legacy`;
const principalsDir = join(root, "principals");

beforeEach(() => {
  rmSync(approvedDir, { recursive: true, force: true });
  rmSync(approvedLegacyDir, { recursive: true, force: true });
  rmSync(principalsDir, { recursive: true, force: true });
  access.setApprovedDir(approvedDir);
  access.setPrincipalsDir(principalsDir);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("v1.3 migration — full happy path", () => {
  test("legacy approved/ install → seed → backfill → membership populate → retire", async () => {
    // Pre-v1.3 install: approved/100 contains contact id "50".
    mkdirSync(approvedDir, { recursive: true });
    writeFileSync(join(approvedDir, "100"), "50");
    writeFileSync(join(approvedDir, "200"), "60");

    // Production startup sequence (mirrors server.ts):
    //   1. seedFromLegacyDir — cache picks up the on-disk legacy state
    //   2. backfillFromAllowlist — principals written for any cache
    //      entry without one (uses listPaired which now reads the cache)
    //   3. populateAllowlistFromMembership — verify against dc-core
    //   4. retireApprovedDir — rename approved/ → approved.legacy/

    // Step 1: seed cache from legacy dir.
    access.seedFromLegacyDir();
    expect(access.isAllowed(100)).toBe(true);
    expect(access.isAllowed(200)).toBe(true);
    expect(access.firstPermissionedContact(100)).toBe(50);
    expect(access.firstPermissionedContact(200)).toBe(60);

    // Step 2: backfill writes principals for legacy owners.
    expect(access.backfillFromAllowlist()).toBe(2);
    expect(access.loadHuman(50)).not.toBeNull();
    expect(access.loadHuman(60)).not.toBeNull();

    // Step 3: membership scan confirms each chat is permissioned.
    const fakeGetChats = async () => [100, 200];
    const fakeGetChatContacts = async (id: number) => id === 100 ? [50, 1] : [60, 1];
    await access.populateAllowlistFromMembership(fakeGetChats, fakeGetChatContacts);
    expect(access.isAllowed(100)).toBe(true);
    expect(access.isAllowed(200)).toBe(true);

    // Step 4: retire the legacy directory.
    access.retireApprovedDir();
    expect(existsSync(approvedDir)).toBe(false);
    expect(existsSync(approvedLegacyDir)).toBe(true);
    expect(readdirSync(approvedLegacyDir).sort()).toEqual(["100", "200"]);
  });
});

describe("v1.3 migration — integrity guard (T5)", () => {
  test("approved/ entry without backing principal is left in place", () => {
    // Corrupted state: approved/300 names contact 70, but no principal.
    mkdirSync(approvedDir, { recursive: true });
    writeFileSync(join(approvedDir, "300"), "70");
    // Don't seed from legacy dir — the cache is empty.
    // (Membership populate would also leave the chat unpermissioned because
    // contact 70 has no principal.)
    expect(access.isAllowed(300)).toBe(false);
    access.retireApprovedDir();
    // Integrity check refuses to rename — orphan stays in place.
    expect(existsSync(approvedDir)).toBe(true);
    expect(existsSync(join(approvedDir, "300"))).toBe(true);
    expect(existsSync(approvedLegacyDir)).toBe(false);
  });

  test("partial orphans block the entire rename", () => {
    // Half-good: chat 400 has a principal in cache, chat 401 doesn't.
    access.addChat(400, 80); // seeds the cache for 400
    mkdirSync(approvedDir, { recursive: true });
    writeFileSync(join(approvedDir, "400"), "80");
    writeFileSync(join(approvedDir, "401"), "81"); // 401 not in cache
    access.retireApprovedDir();
    // Both files stay; the legacy dir is not created.
    expect(existsSync(join(approvedDir, "400"))).toBe(true);
    expect(existsSync(join(approvedDir, "401"))).toBe(true);
    expect(existsSync(approvedLegacyDir)).toBe(false);
  });
});

describe("v1.3 migration — idempotence", () => {
  test("retireApprovedDir is a no-op when approved/ is missing", () => {
    expect(existsSync(approvedDir)).toBe(false);
    expect(() => access.retireApprovedDir()).not.toThrow();
    expect(existsSync(approvedLegacyDir)).toBe(false);
  });

  test("retireApprovedDir is a no-op when approved.legacy/ already exists", () => {
    // First-run state: approved/ retired into approved.legacy/.
    mkdirSync(approvedLegacyDir, { recursive: true });
    writeFileSync(join(approvedLegacyDir, "999"), "1");
    // Second run: approved/ recreated (e.g., by a stale write somewhere).
    mkdirSync(approvedDir, { recursive: true });
    writeFileSync(join(approvedDir, "100"), "50");
    access.addChat(100, 50); // make 100 cache-permissioned
    access.retireApprovedDir();
    // approved/ stays — we don't clobber an existing legacy snapshot.
    expect(existsSync(approvedDir)).toBe(true);
    expect(existsSync(approvedLegacyDir)).toBe(true);
    expect(existsSync(join(approvedLegacyDir, "999"))).toBe(true);
  });
});

describe("v1.3 migration — seedFromLegacyDir", () => {
  test("populates cache from legacy approved/ files", () => {
    mkdirSync(approvedDir, { recursive: true });
    writeFileSync(join(approvedDir, "10"), "100");
    writeFileSync(join(approvedDir, "20"), "200");
    writeFileSync(join(approvedDir, "30"), ""); // legacy pre-owner, no contact
    access.seedFromLegacyDir();
    expect(access.isAllowed(10)).toBe(true);
    expect(access.isAllowed(20)).toBe(true);
    expect(access.isAllowed(30)).toBe(true);
    expect(access.firstPermissionedContact(10)).toBe(100);
    expect(access.firstPermissionedContact(20)).toBe(200);
    expect(access.firstPermissionedContact(30)).toBe(null);
  });

  test("is silent when approved/ is missing", () => {
    expect(() => access.seedFromLegacyDir()).not.toThrow();
    expect(access.allowedChats()).toEqual([]);
  });

  test("ignores non-numeric filenames", () => {
    mkdirSync(approvedDir, { recursive: true });
    writeFileSync(join(approvedDir, "README"), "ignore me");
    writeFileSync(join(approvedDir, "100"), "50");
    access.seedFromLegacyDir();
    expect(access.allowedChats()).toEqual([100]);
  });
});
