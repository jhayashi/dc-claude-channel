import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as access from "../access/index.js";
import { decideCapability } from "../access/capabilities.js";

const root = mkdtempSync(join(tmpdir(), "dc-capabilities-"));
const agentsDir = join(root, "agents");
const approvedDir = join(root, "approved");

beforeEach(() => {
  rmSync(agentsDir, { recursive: true, force: true });
  rmSync(approvedDir, { recursive: true, force: true });
  access.setContactsAgentsDir(agentsDir);
  access.setApprovedDir(approvedDir);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

// Resolve + decide, the way the dispatcher composes it for the default
// originator: getCapabilitiesFor(contactId) → decideCapability(caps, required).
// A null contactId is a terminal session (no record load; subscriber bundle).
function decide(contactId: number | null, required: string | null | undefined) {
  const caps = contactId === null ? null : access.getCapabilitiesFor(access.DEFAULT_AGENT_ID, contactId);
  return access.decideCapability(caps, required);
}

describe("capability decision (role → caps → decision) — happy path", () => {
  test("subscriber gets allow on every annotated capability", () => {
    access.writeContact(access.DEFAULT_AGENT_ID, {
      kind: "human",
      contactId: 50,
      firstPairedAt: "2026-01-01T00:00:00Z",
      role: "subscriber",
      capabilities: ["*"],
    });
    for (const cap of ["chat", "private_data_read", "private_data_write", "real_world_action", "infrastructure"]) {
      const d = decide(50, cap);
      expect(d.decision).toBe("allow");
      expect(d.required).toBe(cap);
    }
  });

  test("family-member gets allow on chat, deny on private_data_read", () => {
    access.writeContact(access.DEFAULT_AGENT_ID, {
      kind: "human",
      contactId: 60,
      firstPairedAt: "2026-01-01T00:00:00Z",
      role: "family-member",
      capabilities: ["chat", "low_stakes_*"],
    });
    expect(decide(60, "chat").decision).toBe("allow");
    expect(decide(60, "low_stakes_chat").decision).toBe("allow");
    expect(decide(60, "private_data_read").decision).toBe("would_deny");
    expect(decide(60, "real_world_action").decision).toBe("would_deny");
  });

  test("guest gets allow on chat, deny on everything else", () => {
    access.writeContact(access.DEFAULT_AGENT_ID, {
      kind: "human",
      contactId: 70,
      firstPairedAt: "2026-01-01T00:00:00Z",
      role: "guest",
      capabilities: ["chat"],
    });
    expect(decide(70, "chat").decision).toBe("allow");
    expect(decide(70, "private_data_read").decision).toBe("would_deny");
    expect(decide(70, "infrastructure").decision).toBe("would_deny");
  });
});

describe("capability decision — fail-closed paths", () => {
  test("unknown contact gets would_deny on every capability", () => {
    expect(decide(9999, "chat").decision).toBe("would_deny");
    expect(decide(9999, "private_data_read").decision).toBe("would_deny");
    expect(decide(9999, "infrastructure").decision).toBe("would_deny");
  });

  test("unknown contact reports empty originator capabilities", () => {
    expect(decide(9999, "chat").originatorCapabilities).toEqual([]);
  });

  test("explicit empty capabilities array denies even subscribers", () => {
    access.writeContact(access.DEFAULT_AGENT_ID, {
      kind: "human",
      contactId: 80,
      firstPairedAt: "2026-01-01T00:00:00Z",
      role: "subscriber",
      capabilities: [],
    });
    expect(decide(80, "chat").decision).toBe("would_deny");
  });
});

describe("capability decision — null/missing required capability", () => {
  test("null required capability is treated as `chat` tier (safe default)", () => {
    access.writeContact(access.DEFAULT_AGENT_ID, {
      kind: "human",
      contactId: 90,
      firstPairedAt: "2026-01-01T00:00:00Z",
      role: "guest",
      capabilities: ["chat"],
    });
    // Tool authors who haven't annotated yet get chat-tier behavior.
    const d = decide(90, null);
    expect(d.decision).toBe("allow");
    expect(d.required).toBe("chat");
  });

  test("undefined required capability is treated as `chat` tier", () => {
    access.writeContact(access.DEFAULT_AGENT_ID, {
      kind: "human",
      contactId: 91,
      firstPairedAt: "2026-01-01T00:00:00Z",
      role: "guest",
      capabilities: ["chat"],
    });
    const d = decide(91, undefined);
    expect(d.decision).toBe("allow");
    expect(d.required).toBe("chat");
  });
});

describe("capability decision — null originator (terminal calls)", () => {
  test("null originator gets allow with the wildcard bundle (terminal session)", () => {
    // Terminal-CC calls have no originator contact id — the terminal IS the
    // subscriber by definition, so the decision is `allow` with `["*"]`.
    const d = decide(null, "infrastructure");
    expect(d.decision).toBe("allow");
    expect(d.required).toBe("infrastructure");
    expect(d.originatorCapabilities).toEqual(["*"]);
  });
});

describe("capability decision — relay case (requestor_contact_id)", () => {
  // The dispatcher resolves the originator from args.requestor_contact_id when
  // present (validating chat membership in the gate). Whichever contactId the
  // gate chose is what gets resolved + decided here.

  test("subscriber's caps used when no requestor declared (default path)", () => {
    access.writeContact(access.DEFAULT_AGENT_ID, {
      kind: "human",
      contactId: 100,
      firstPairedAt: "2026-01-01T00:00:00Z",
      role: "subscriber",
      capabilities: ["*"],
    });
    expect(decide(100, "private_data_write").decision).toBe("allow");
  });

  test("family-member's caps used when declared as requestor", () => {
    access.writeContact(access.DEFAULT_AGENT_ID, {
      kind: "human",
      contactId: 100,
      firstPairedAt: "2026-01-01T00:00:00Z",
      role: "subscriber",
      capabilities: ["*"],
    });
    access.writeContact(access.DEFAULT_AGENT_ID, {
      kind: "human",
      contactId: 200,
      firstPairedAt: "2026-01-01T00:00:00Z",
      role: "family-member",
      capabilities: ["chat", "low_stakes_*"],
    });
    // Subscriber's chat agent declares requestor = family-member.
    // Gate runs against family-member's bundle.
    expect(decide(200, "chat").decision).toBe("allow");
    expect(decide(200, "private_data_write").decision).toBe("would_deny");
    expect(decide(200, "real_world_action").decision).toBe("would_deny");
  });

  test("untrusted-agent declared as requestor stays in chat-tier", () => {
    access.writeContact(access.DEFAULT_AGENT_ID, {
      kind: "human",
      contactId: 300,
      firstPairedAt: "2026-01-01T00:00:00Z",
      role: "untrusted-agent",
      capabilities: ["chat"],
    });
    expect(decide(300, "chat").decision).toBe("allow");
    expect(decide(300, "private_data_read").decision).toBe("would_deny");
    expect(decide(300, "infrastructure").decision).toBe("would_deny");
  });
});

describe("decideCapability", () => {
  test("null caps (terminal session) → allow with wildcard bundle", () => {
    const d = decideCapability(null, "chat");
    expect(d.decision).toBe("allow");
    expect(d.originatorCapabilities).toEqual(["*"]);
    expect(d.required).toBe("chat");
  });
  test("caps cover the requirement → allow", () => {
    expect(decideCapability(["*"], "low_stakes_email").decision).toBe("allow");
    expect(decideCapability(["chat"], "chat").decision).toBe("allow");
  });
  test("caps lack the requirement → would_deny", () => {
    expect(decideCapability(["chat"], "low_stakes_email").decision).toBe("would_deny");
    expect(decideCapability([], "chat").decision).toBe("would_deny");
  });
  test("missing/empty required defaults to chat tier", () => {
    expect(decideCapability(["chat"], undefined).required).toBe("chat");
    expect(decideCapability(["chat"], "").required).toBe("chat");
  });
});
