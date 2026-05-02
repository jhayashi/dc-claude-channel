import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as access from "../access/index.js";

const root = mkdtempSync(join(tmpdir(), "dc-allowlist-populate-"));
const agentsDir = join(root, "agents");
const approvedDir = join(root, "approved");

beforeEach(() => {
  rmSync(agentsDir, { recursive: true, force: true });
  rmSync(approvedDir, { recursive: true, force: true });
  access.setContactsAgentsDir(agentsDir);
  access.setApprovedDir(approvedDir); // also clears the in-memory cache
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("populateAllowlistFromMembership", () => {
  test("permissions chats whose membership includes a principal", async () => {
    access.writeContact({ kind: "human", contactId: 100, firstPairedAt: "2026-01-01T00:00:00Z" });
    const fakeGetChats = async () => [1, 2];
    const fakeGetChatContacts = async (chatId: number) =>
      chatId === 1 ? [100, 1] : [999, 1]; // CONTACT_SELF=1 always present
    await access.populateAllowlistFromMembership(fakeGetChats, fakeGetChatContacts);
    expect(access.isAllowed(1)).toBe(true);
    expect(access.isAllowed(2)).toBe(false);
    expect(access.firstPermissionedContact(1)).toBe(100);
    expect(access.firstPermissionedContact(2)).toBe(null);
  });

  test("ignores chats with no contacts", async () => {
    const fakeGetChats = async () => [3];
    const fakeGetChatContacts = async () => [];
    await access.populateAllowlistFromMembership(fakeGetChats, fakeGetChatContacts);
    expect(access.isAllowed(3)).toBe(false);
  });

  test("first principal in membership order wins for owner cache", async () => {
    access.writeContact({ kind: "human", contactId: 100, firstPairedAt: "2026-01-01T00:00:00Z" });
    access.writeContact({ kind: "human", contactId: 200, firstPairedAt: "2026-01-02T00:00:00Z" });
    const fakeGetChats = async () => [5];
    const fakeGetChatContacts = async () => [200, 100, 1];
    await access.populateAllowlistFromMembership(fakeGetChats, fakeGetChatContacts);
    expect(access.firstPermissionedContact(5)).toBe(200);
  });

  test("CONTACT_SELF (id 1) is skipped", async () => {
    // The bot's own contact id should not permission an empty chat.
    const fakeGetChats = async () => [9];
    const fakeGetChatContacts = async () => [1]; // only the bot itself
    await access.populateAllowlistFromMembership(fakeGetChats, fakeGetChatContacts);
    expect(access.isAllowed(9)).toBe(false);
  });

  test("does not clobber an owner already seeded from legacy dir", async () => {
    // Simulate legacy seeding having set the owner first.
    access.addChat(7, 50);
    expect(access.firstPermissionedContact(7)).toBe(50);
    // Then membership scan finds principal 100 in the same chat.
    access.writeContact({ kind: "human", contactId: 100, firstPairedAt: "2026-01-01T00:00:00Z" });
    const fakeGetChats = async () => [7];
    const fakeGetChatContacts = async () => [100, 1];
    await access.populateAllowlistFromMembership(fakeGetChats, fakeGetChatContacts);
    // The earlier seed wins for owner; chat is still permissioned either way.
    expect(access.isAllowed(7)).toBe(true);
    expect(access.firstPermissionedContact(7)).toBe(50);
  });
});

describe("refreshAllowlistForChat", () => {
  test("updates a single chat's permissioned status", async () => {
    access.writeContact({ kind: "human", contactId: 100, firstPairedAt: "2026-01-01T00:00:00Z" });
    let contacts: number[] = [999, 1];
    const fakeGetChatContacts = async () => contacts;
    await access.refreshAllowlistForChat(7, fakeGetChatContacts);
    expect(access.isAllowed(7)).toBe(false);
    contacts = [999, 100, 1];
    await access.refreshAllowlistForChat(7, fakeGetChatContacts);
    expect(access.isAllowed(7)).toBe(true);
    expect(access.firstPermissionedContact(7)).toBe(100);
    contacts = [999, 1];
    await access.refreshAllowlistForChat(7, fakeGetChatContacts);
    expect(access.isAllowed(7)).toBe(false);
    expect(access.firstPermissionedContact(7)).toBe(null);
  });

  test("removes a chat from the cache when last principal leaves", async () => {
    access.writeContact({ kind: "human", contactId: 100, firstPairedAt: "2026-01-01T00:00:00Z" });
    let contacts: number[] = [100, 1];
    const fakeGetChatContacts = async () => contacts;
    await access.refreshAllowlistForChat(8, fakeGetChatContacts);
    expect(access.isAllowed(8)).toBe(true);
    contacts = [1];
    await access.refreshAllowlistForChat(8, fakeGetChatContacts);
    expect(access.isAllowed(8)).toBe(false);
    expect(access.firstPermissionedContact(8)).toBe(null);
  });
});
