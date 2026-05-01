import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as access from "../access/index.js";

const root = mkdtempSync(join(tmpdir(), "dc-capabilities-"));
const principalsDir = join(root, "principals");
const approvedDir = join(root, "approved");

beforeEach(() => {
  rmSync(principalsDir, { recursive: true, force: true });
  rmSync(approvedDir, { recursive: true, force: true });
  access.setPrincipalsDir(principalsDir);
  access.setApprovedDir(approvedDir);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("evaluateCapability — happy path", () => {
  test("subscriber gets allow on every annotated capability", () => {
    access.writeContact({
      kind: "human",
      contactId: 50,
      firstPairedAt: "2026-01-01T00:00:00Z",
      role: "subscriber",
      capabilities: ["*"],
    });
    for (const cap of ["chat", "private_data_read", "private_data_write", "real_world_action", "infrastructure"]) {
      const decision = access.evaluateCapability(50, cap);
      expect(decision.decision).toBe("allow");
      expect(decision.required).toBe(cap);
    }
  });

  test("family-member gets allow on chat, deny on private_data_read", () => {
    access.writeContact({
      kind: "human",
      contactId: 60,
      firstPairedAt: "2026-01-01T00:00:00Z",
      role: "family-member",
      capabilities: ["chat", "low_stakes_*"],
    });
    expect(access.evaluateCapability(60, "chat").decision).toBe("allow");
    expect(access.evaluateCapability(60, "low_stakes_chat").decision).toBe("allow");
    expect(access.evaluateCapability(60, "private_data_read").decision).toBe("would_deny");
    expect(access.evaluateCapability(60, "real_world_action").decision).toBe("would_deny");
  });

  test("guest gets allow on chat, deny on everything else", () => {
    access.writeContact({
      kind: "human",
      contactId: 70,
      firstPairedAt: "2026-01-01T00:00:00Z",
      role: "guest",
      capabilities: ["chat"],
    });
    expect(access.evaluateCapability(70, "chat").decision).toBe("allow");
    expect(access.evaluateCapability(70, "private_data_read").decision).toBe("would_deny");
    expect(access.evaluateCapability(70, "infrastructure").decision).toBe("would_deny");
  });
});

describe("evaluateCapability — fail-closed paths", () => {
  test("unknown contact gets would_deny on every capability", () => {
    expect(access.evaluateCapability(9999, "chat").decision).toBe("would_deny");
    expect(access.evaluateCapability(9999, "private_data_read").decision).toBe("would_deny");
    expect(access.evaluateCapability(9999, "infrastructure").decision).toBe("would_deny");
  });

  test("unknown contact reports empty originator capabilities", () => {
    const decision = access.evaluateCapability(9999, "chat");
    expect(decision.originatorCapabilities).toEqual([]);
  });

  test("explicit empty capabilities array denies even subscribers", () => {
    access.writeContact({
      kind: "human",
      contactId: 80,
      firstPairedAt: "2026-01-01T00:00:00Z",
      role: "subscriber",
      capabilities: [],
    });
    expect(access.evaluateCapability(80, "chat").decision).toBe("would_deny");
  });
});

describe("evaluateCapability — null/missing required capability", () => {
  test("null required capability is treated as `chat` tier (safe default)", () => {
    access.writeContact({
      kind: "human",
      contactId: 90,
      firstPairedAt: "2026-01-01T00:00:00Z",
      role: "guest",
      capabilities: ["chat"],
    });
    // Tool authors who haven't annotated yet get chat-tier behavior.
    const decision = access.evaluateCapability(90, null);
    expect(decision.decision).toBe("allow");
    expect(decision.required).toBe("chat");
  });

  test("undefined required capability is treated as `chat` tier", () => {
    access.writeContact({
      kind: "human",
      contactId: 91,
      firstPairedAt: "2026-01-01T00:00:00Z",
      role: "guest",
      capabilities: ["chat"],
    });
    const decision = access.evaluateCapability(91, undefined);
    expect(decision.decision).toBe("allow");
    expect(decision.required).toBe("chat");
  });
});

describe("evaluateCapability — null originator (terminal calls)", () => {
  test("null originator gets allow with would_deny=false (terminal session)", () => {
    // Terminal-CC calls have no originator contact id. Slice 3 logs them
    // as `allow` (the terminal IS the subscriber by definition); slice 4
    // will keep this behavior — terminal calls are unrestricted.
    const decision = access.evaluateCapability(null, "infrastructure");
    expect(decision.decision).toBe("allow");
    expect(decision.required).toBe("infrastructure");
    expect(decision.originatorCapabilities).toEqual(["*"]);
  });
});
