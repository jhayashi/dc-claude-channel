/**
 * Capability gate orchestration (v1.3 review fix #4 — Oliver P2 #3).
 *
 * Extracts the per-tool-call gate logic out of server.ts's socket
 * handler so it can be unit-tested. server.ts calls `applyCapabilityGate`
 * with deps, then drives audit-log emission and tool dispatch from the
 * returned `GateResult`.
 *
 * Gate flow:
 *   1. Resolve originator: chat's pairing contact by default; or the
 *      validated `args.requestor_contact_id` (T1 relay case from the
 *      security review).
 *   2. Validate `requestor_contact_id` if present: positive integer +
 *      chat membership. Reject malformed/non-member values with
 *      `capability_invalid_requestor`.
 *   3. Run `evaluateCapability(originator, requiredCapability)` —
 *      wrapped in try/catch per security review T4. Principal-store
 *      errors (corrupt records, FS errors that aren't ENOENT) deny
 *      with `capability_lookup_error`. Coverage gap from slice 4
 *      (Oliver P2 #1) is fixed by the loadContact change in this same
 *      review batch.
 *   4. If `evaluateCapability` returns `would_deny`, deny with
 *      `capability_deny`.
 *   5. Otherwise, allow. server.ts then dispatches the tool.
 *
 * Arg-stripping: `requestor_contact_id` is dispatcher-only — tools
 * shouldn't see it. The gate returns `scrubbedArgs` (with the field
 * removed) regardless of outcome so server.ts has one consistent
 * value to pass through to tool dispatch.
 */

import type { CapabilityDecision } from "./capabilities.js";

export interface GateDeps {
  agentId: string;
  /**
   * Resolves the default originator for a tool call when
   * `requestor_contact_id` is not declared. Wired in server.ts to
   * consult the per-chat current-driver tracker (the actual message
   * sender, when a message is in flight) before falling back to the
   * chat's pairing contact. Pre-fix this was just
   * `firstPermissionedContact` (always the pairing contact), which
   * meant role tiers below subscriber didn't actually enforce unless
   * the subagent self-declared the requestor.
   */
  defaultOriginator: (chatId: number) => number | null;
  evaluateCapability: (agentId: string, originator: number | null, required: string | null | undefined) => CapabilityDecision;
  getChatContacts: (chatId: number) => Promise<number[]>;
  logf?: (fmt: string, ...args: unknown[]) => void;
}

export type GateDenyReason =
  | "capability_deny"
  | "capability_lookup_error"
  | "capability_invalid_requestor";

export type GateOutcome =
  | {
      kind: "allow";
      originator: number | null;
      required: string;
      caps: readonly string[];
    }
  | {
      kind: "deny";
      reason: GateDenyReason;
      originator: number | null;
      required: string;
      caps: readonly string[];
      message: string;
    };

export interface GateResult {
  outcome: GateOutcome;
  /**
   * Tool args with `requestor_contact_id` stripped. Equal to the input
   * `args` when the field was absent. Always populated, regardless of
   * outcome — caller can pass this to the tool unconditionally.
   */
  scrubbedArgs: Record<string, unknown>;
}

const DEFAULT_REQUIRED = "chat";

// ── Schema augmentation (v1.3 review fix #5) ───────────────────────────────
//
// The gate accepts an optional `requestor_contact_id` arg on every
// annotated tool (T1 mitigation for the relay case). Pre-fix the
// parameter was documented in the channel system prompt but absent
// from every tool's `inputSchema`, leaving agents to discover it from
// prompt text alone — fragile, and stricter MCP clients could strip
// the unknown arg silently. `withRequestorParam` merges the parameter
// into every annotated tool's schema at registration time so it
// shows up in tool-list responses to subagents and the terminal MCP
// client.
//
// Tools without `requiresCapability` skip the merge — they're not
// gated, so the parameter would be meaningless.

const REQUESTOR_PARAM_DESCRIPTION =
  "Optional. When acting on behalf of a non-pairing contact in this chat " +
  "(e.g., a family member relayed a request via the subscriber), declare " +
  "their contact_id (numeric string) so the capability gate runs against " +
  "THEIR permissions, not the pairing contact's. Validated as a current " +
  "chat member; calls with a non-member id are refused with " +
  "capability_invalid_requestor.";

interface SchemaShape {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export function withRequestorParam<
  T extends {
    name: string;
    description: string;
    inputSchema: SchemaShape;
    requiresCapability?: string;
  },
>(t: T): T {
  if (!t.requiresCapability) return t;
  return {
    ...t,
    inputSchema: {
      ...t.inputSchema,
      properties: {
        ...t.inputSchema.properties,
        requestor_contact_id: { type: "string", description: REQUESTOR_PARAM_DESCRIPTION },
      },
    },
  };
}

export async function applyCapabilityGate(
  chatId: number,
  toolName: string,
  args: Record<string, unknown>,
  requiredCapability: string | undefined,
  deps: GateDeps,
): Promise<GateResult> {
  const required = requiredCapability && requiredCapability.length > 0 ? requiredCapability : DEFAULT_REQUIRED;

  // Build scrubbedArgs eagerly so every return path has it.
  const { requestor_contact_id: requestorRaw, ...scrubbed } = args;
  const scrubbedArgs: Record<string, unknown> = scrubbed;

  // Default originator: the actual message sender (for in-flight turns)
  // or the chat's pairing contact (synthetic / scheduled / collect calls).
  let originator: number | null = deps.defaultOriginator(chatId);

  // Resolve `requestor_contact_id` if declared.
  if (requestorRaw !== undefined && requestorRaw !== null) {
    const n =
      typeof requestorRaw === "string"
        ? Number(requestorRaw)
        : typeof requestorRaw === "number"
          ? requestorRaw
          : NaN;
    if (Number.isNaN(n) || !Number.isInteger(n) || n <= 0) {
      return {
        outcome: {
          kind: "deny",
          reason: "capability_invalid_requestor",
          originator: null,
          required,
          caps: [],
          message: `requestor_contact_id must be a positive integer; got ${JSON.stringify(requestorRaw)}`,
        },
        scrubbedArgs,
      };
    }
    let members: number[];
    try {
      members = await deps.getChatContacts(chatId);
    } catch (err) {
      deps.logf?.("capability gate: getChatContacts threw for chat=%d: %v", chatId, err);
      return {
        outcome: {
          kind: "deny",
          reason: "capability_lookup_error",
          originator: n,
          required,
          caps: [],
          message: "could not validate requestor membership; refused for safety",
        },
        scrubbedArgs,
      };
    }
    if (!members.includes(n)) {
      return {
        outcome: {
          kind: "deny",
          reason: "capability_invalid_requestor",
          originator: n,
          required,
          caps: [],
          message: `requestor_contact_id ${n} is not a member of chat ${chatId}`,
        },
        scrubbedArgs,
      };
    }
    originator = n;
  }

  // Run the capability check. `evaluateCapability` may throw if the
  // principal store has a corrupt record (loadContact propagates non-
  // ENOENT FS errors and JSON-parse / schema-mismatch failures since
  // the slice-3-5 review fix). Catch and route to lookup-error so the
  // operator's `jq` queries can distinguish "we said no" from "we
  // couldn't decide" (security review T4).
  let decision: CapabilityDecision;
  try {
    decision = deps.evaluateCapability(deps.agentId, originator, required);
  } catch (err) {
    deps.logf?.("capability gate: evaluateCapability threw for chat=%d tool=%s: %v", chatId, toolName, err);
    return {
      outcome: {
        kind: "deny",
        reason: "capability_lookup_error",
        originator,
        required,
        caps: [],
        message: `capability lookup error for ${toolName}; refused for safety`,
      },
      scrubbedArgs,
    };
  }

  if (decision.decision === "would_deny") {
    return {
      outcome: {
        kind: "deny",
        reason: "capability_deny",
        originator,
        required: decision.required,
        caps: decision.originatorCapabilities,
        message: `${toolName} requires capability "${decision.required}"; originator (contact ${originator ?? "null"}) lacks it`,
      },
      scrubbedArgs,
    };
  }

  return {
    outcome: {
      kind: "allow",
      originator,
      required: decision.required,
      caps: decision.originatorCapabilities,
    },
    scrubbedArgs,
  };
}
