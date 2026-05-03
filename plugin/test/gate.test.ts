import { describe, test, expect } from "bun:test";
import type { CapabilityDecision } from "../access/capabilities.js";
import type { GateDeps, GateOutcome } from "../access/gate.js";
import { applyCapabilityGate, withRequestorParam } from "../access/gate.js";

// ── Test fixtures ────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<GateDeps> = {}): GateDeps {
  return {
    agentId: 'claude-code',
    defaultOriginator: () => 50, // default subscriber
    evaluateCapability: () => ({
      required: "chat",
      originatorCapabilities: ["*"],
      decision: "allow",
    }),
    getChatContacts: async () => [1, 50],
    logf: () => {},
    ...overrides,
  };
}

function decision(
  originatorCapabilities: readonly string[],
  required: string,
  d: "allow" | "would_deny",
): CapabilityDecision {
  return { required, originatorCapabilities, decision: d };
}

// ── Happy path ──────────────────────────────────────────────────────────────

describe("applyCapabilityGate — allow paths", () => {
  test("default originator (pairing contact), capability covered → allow", async () => {
    const result = await applyCapabilityGate(7, "dc_send_file", {}, "private_data_write", makeDeps({
      defaultOriginator: () => 50,
      evaluateCapability: (_agentId, id, req) => {
        expect(id).toBe(50);
        expect(req).toBe("private_data_write");
        return decision(["*"], "private_data_write", "allow");
      },
    }));
    expect(result.outcome.kind).toBe("allow");
    if (result.outcome.kind === "allow") {
      expect(result.outcome.originator).toBe(50);
      expect(result.outcome.required).toBe("private_data_write");
      expect(result.outcome.caps).toEqual(["*"]);
    }
  });

  test("declared requestor_contact_id (member), capability covered → allow with requestor as originator", async () => {
    const result = await applyCapabilityGate(7, "dc_send", { requestor_contact_id: "200" }, "chat", makeDeps({
      defaultOriginator: () => 50,
      getChatContacts: async () => [1, 50, 200],
      evaluateCapability: (_agentId, id) => {
        expect(id).toBe(200); // gate uses declared requestor, not pairing contact
        return decision(["chat", "low_stakes_*"], "chat", "allow");
      },
    }));
    expect(result.outcome.kind).toBe("allow");
    if (result.outcome.kind === "allow") {
      expect(result.outcome.originator).toBe(200);
      expect(result.outcome.caps).toEqual(["chat", "low_stakes_*"]);
    }
  });

  test("requestor_contact_id passed as number (not string) is accepted", async () => {
    const result = await applyCapabilityGate(7, "dc_send", { requestor_contact_id: 200 }, "chat", makeDeps({
      getChatContacts: async () => [1, 50, 200],
      evaluateCapability: () => decision(["chat"], "chat", "allow"),
    }));
    expect(result.outcome.kind).toBe("allow");
  });

  test("missing requiresCapability defaults to chat tier", async () => {
    const result = await applyCapabilityGate(7, "unknown_tool", {}, undefined, makeDeps({
      evaluateCapability: (_agentId, _id, req) => {
        expect(req).toBe("chat");
        return decision(["chat"], "chat", "allow");
      },
    }));
    expect(result.outcome.kind).toBe("allow");
    if (result.outcome.kind === "allow") expect(result.outcome.required).toBe("chat");
  });
});

// ── capability_invalid_requestor paths ─────────────────────────────────────

describe("applyCapabilityGate — capability_invalid_requestor", () => {
  test("non-numeric string", async () => {
    const result = await applyCapabilityGate(7, "dc_send", { requestor_contact_id: "abc" }, "chat", makeDeps());
    expect(result.outcome.kind).toBe("deny");
    if (result.outcome.kind === "deny") {
      expect(result.outcome.reason).toBe("capability_invalid_requestor");
      expect(result.outcome.message).toContain("positive integer");
    }
  });

  test("negative number", async () => {
    const result = await applyCapabilityGate(7, "dc_send", { requestor_contact_id: -5 }, "chat", makeDeps());
    expect(result.outcome.kind).toBe("deny");
    if (result.outcome.kind === "deny") {
      expect(result.outcome.reason).toBe("capability_invalid_requestor");
    }
  });

  test("zero", async () => {
    const result = await applyCapabilityGate(7, "dc_send", { requestor_contact_id: 0 }, "chat", makeDeps());
    expect(result.outcome.kind).toBe("deny");
  });

  test("float (non-integer)", async () => {
    const result = await applyCapabilityGate(7, "dc_send", { requestor_contact_id: 3.5 }, "chat", makeDeps());
    expect(result.outcome.kind).toBe("deny");
    if (result.outcome.kind === "deny") {
      expect(result.outcome.reason).toBe("capability_invalid_requestor");
    }
  });

  test("non-member contact id", async () => {
    const result = await applyCapabilityGate(7, "dc_send", { requestor_contact_id: 999 }, "chat", makeDeps({
      getChatContacts: async () => [1, 50, 200], // 999 not in chat
    }));
    expect(result.outcome.kind).toBe("deny");
    if (result.outcome.kind === "deny") {
      expect(result.outcome.reason).toBe("capability_invalid_requestor");
      expect(result.outcome.originator).toBe(999); // caller declared it; gate records honestly
      expect(result.outcome.message).toContain("not a member");
    }
  });

  test("null requestor_contact_id is treated as absent (default originator path)", async () => {
    const result = await applyCapabilityGate(7, "dc_send", { requestor_contact_id: null }, "chat", makeDeps({
      defaultOriginator: () => 50,
      evaluateCapability: () => decision(["*"], "chat", "allow"),
    }));
    // null acts as "not declared" — fall through to pairing contact.
    expect(result.outcome.kind).toBe("allow");
    if (result.outcome.kind === "allow") expect(result.outcome.originator).toBe(50);
  });
});

// ── capability_lookup_error paths ──────────────────────────────────────────

describe("applyCapabilityGate — capability_lookup_error", () => {
  test("getChatContacts throws (during requestor validation)", async () => {
    const result = await applyCapabilityGate(7, "dc_send", { requestor_contact_id: "200" }, "chat", makeDeps({
      getChatContacts: async () => { throw new Error("dc-core unreachable") },
    }));
    expect(result.outcome.kind).toBe("deny");
    if (result.outcome.kind === "deny") {
      expect(result.outcome.reason).toBe("capability_lookup_error");
      expect(result.outcome.originator).toBe(200); // we know the declared id; surface it for audit
      expect(result.outcome.message).toContain("requestor membership");
    }
  });

  test("evaluateCapability throws (corrupt principal record)", async () => {
    const result = await applyCapabilityGate(7, "dc_send", {}, "chat", makeDeps({
      defaultOriginator: () => 50,
      evaluateCapability: () => { throw new Error("schema mismatch in /path/principal/50.json") },
    }));
    expect(result.outcome.kind).toBe("deny");
    if (result.outcome.kind === "deny") {
      expect(result.outcome.reason).toBe("capability_lookup_error");
      expect(result.outcome.originator).toBe(50);
      expect(result.outcome.message).toContain("lookup error");
    }
  });
});

// ── capability_deny paths ──────────────────────────────────────────────────

describe("applyCapabilityGate — capability_deny", () => {
  test("would_deny propagates as capability_deny with originator + caps", async () => {
    const result = await applyCapabilityGate(7, "dc_send_file", {}, "private_data_write", makeDeps({
      defaultOriginator: () => 200,
      evaluateCapability: () => decision(["chat", "low_stakes_*"], "private_data_write", "would_deny"),
    }));
    expect(result.outcome.kind).toBe("deny");
    if (result.outcome.kind === "deny") {
      expect(result.outcome.reason).toBe("capability_deny");
      expect(result.outcome.originator).toBe(200);
      expect(result.outcome.caps).toEqual(["chat", "low_stakes_*"]);
      expect(result.outcome.required).toBe("private_data_write");
      expect(result.outcome.message).toContain("private_data_write");
      expect(result.outcome.message).toContain("contact 200");
    }
  });

  test("relay-case deny: declared requestor's caps used, not pairing-contact's", async () => {
    // Pre-fix bug: this case logged subscriber's caps (allow) in tools log
    // but family-member's caps (deny) in permissions log. Now consistent.
    const result = await applyCapabilityGate(7, "dc_send_file", { requestor_contact_id: 200 }, "private_data_write", makeDeps({
      defaultOriginator: () => 50, // subscriber, would have * caps
      getChatContacts: async () => [1, 50, 200],
      evaluateCapability: (_agentId, id) => {
        expect(id).toBe(200); // gate must check requestor's caps, not subscriber's
        return decision(["chat"], "private_data_write", "would_deny");
      },
    }));
    expect(result.outcome.kind).toBe("deny");
    if (result.outcome.kind === "deny") {
      expect(result.outcome.originator).toBe(200);
      expect(result.outcome.caps).toEqual(["chat"]);
    }
  });
});

// ── Arg-stripping invariant ─────────────────────────────────────────────────

describe("applyCapabilityGate — scrubbedArgs", () => {
  test("requestor_contact_id is stripped from scrubbedArgs on allow", async () => {
    const result = await applyCapabilityGate(7, "dc_send", { chat_id: "7", text: "hi", requestor_contact_id: "200" }, "chat", makeDeps({
      getChatContacts: async () => [1, 50, 200],
      evaluateCapability: () => decision(["chat"], "chat", "allow"),
    }));
    expect(result.scrubbedArgs).toEqual({ chat_id: "7", text: "hi" });
    expect("requestor_contact_id" in result.scrubbedArgs).toBe(false);
  });

  test("requestor_contact_id is stripped from scrubbedArgs on deny", async () => {
    const result = await applyCapabilityGate(7, "dc_send", { chat_id: "7", requestor_contact_id: "200" }, "chat", makeDeps({
      getChatContacts: async () => [1, 50, 200],
      evaluateCapability: () => decision(["chat"], "chat", "would_deny"),
    }));
    expect("requestor_contact_id" in result.scrubbedArgs).toBe(false);
  });

  test("scrubbedArgs equals input when no requestor_contact_id was present", async () => {
    const result = await applyCapabilityGate(7, "dc_send", { chat_id: "7", text: "hi" }, "chat", makeDeps({
      evaluateCapability: () => decision(["*"], "chat", "allow"),
    }));
    expect(result.scrubbedArgs).toEqual({ chat_id: "7", text: "hi" });
  });
});

// ── withRequestorParam (schema augmentation) ───────────────────────────────

describe("withRequestorParam", () => {
  const baseTool = {
    name: "dc_send",
    description: "Send a message",
    inputSchema: {
      type: "object" as const,
      properties: {
        chat_id: { type: "string", description: "Chat ID" },
        text: { type: "string", description: "Message body" },
      },
      required: ["chat_id", "text"],
    },
    requiresCapability: "chat",
  };

  test("annotated tool gains requestor_contact_id property", () => {
    const augmented = withRequestorParam(baseTool);
    expect(augmented.inputSchema.properties).toHaveProperty("requestor_contact_id");
    expect((augmented.inputSchema.properties.requestor_contact_id as { type: string }).type).toBe("string");
  });

  test("preserves all original properties", () => {
    const augmented = withRequestorParam(baseTool);
    expect(augmented.inputSchema.properties.chat_id).toEqual(baseTool.inputSchema.properties.chat_id);
    expect(augmented.inputSchema.properties.text).toEqual(baseTool.inputSchema.properties.text);
  });

  test("preserves required fields (requestor_contact_id stays optional)", () => {
    const augmented = withRequestorParam(baseTool);
    expect(augmented.inputSchema.required).toEqual(["chat_id", "text"]);
    expect(augmented.inputSchema.required).not.toContain("requestor_contact_id");
  });

  test("preserves name + description + requiresCapability + other top-level fields", () => {
    const augmented = withRequestorParam(baseTool);
    expect(augmented.name).toBe("dc_send");
    expect(augmented.description).toBe("Send a message");
    expect(augmented.requiresCapability).toBe("chat");
  });

  test("does not mutate the input tool", () => {
    const original = { ...baseTool, inputSchema: { ...baseTool.inputSchema, properties: { ...baseTool.inputSchema.properties } } };
    withRequestorParam(original);
    expect("requestor_contact_id" in original.inputSchema.properties).toBe(false);
  });

  test("non-annotated tool is returned unchanged", () => {
    const unannotated = {
      name: "dc_x",
      description: "X",
      inputSchema: { type: "object" as const, properties: { a: { type: "string" } } },
      // no requiresCapability
    };
    const result = withRequestorParam(unannotated);
    expect(result).toBe(unannotated);
    expect("requestor_contact_id" in result.inputSchema.properties).toBe(false);
  });
});
