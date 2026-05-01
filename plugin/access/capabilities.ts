/**
 * Capability orchestration helper (v1.3 slice 3).
 *
 * Given an originator contact and the capability a tool requires,
 * returns a decision plus context the dispatcher can log. Slice 3
 * surfaces decisions in the tool-call event log without enforcing;
 * slice 4 flips `would_deny` to a hard refuse.
 *
 * Layered above:
 *   - `principals-policy.ts:getCapabilitiesFor(contactId)` — resolves
 *     a contact's bundle (or returns `[]` for unknown contacts)
 *   - `capability-bundles.ts:hasCapability(set, required)` — wildcard /
 *     glob / exact-match logic
 *
 * Three callers of note:
 *   1. Subagent tool calls — originator = `firstPermissionedContact(callerChatId)`
 *      (the chat's pairing contact by default; or an explicitly-declared
 *      `requestor_contact_id` per the security review's T1 mitigation,
 *      which lands in slice 4).
 *   2. Terminal-CC calls — originator = `null`. The terminal session
 *      IS the subscriber by definition; the dispatcher trusts it
 *      unconditionally. Decision: `allow`, capabilities: `["*"]`.
 *   3. Synthetic-turn / scheduler calls — originator = the chat's
 *      pairing contact (same as case 1; synthetic turns inherit the
 *      chat's owner authority).
 */

import { hasCapability } from "./capability-bundles.js";
import { getCapabilitiesFor } from "./principals-policy.js";

/** Tool annotations without `requiresCapability` default to chat-tier. */
const DEFAULT_REQUIRED_CAPABILITY = "chat";

/** Terminal sessions get the wildcard bundle — they ARE the subscriber. */
const TERMINAL_BUNDLE: readonly string[] = ["*"];

export interface CapabilityDecision {
  /** What was checked. `chat` if the tool didn't annotate. */
  required: string;
  /** The originator's resolved bundle. `[]` for unknown contacts; `["*"]` for terminal. */
  originatorCapabilities: readonly string[];
  /**
   * `allow` — originator's bundle covers the requirement.
   * `would_deny` — bundle lacks the requirement; slice 4 will refuse the call.
   */
  decision: "allow" | "would_deny";
}

/**
 * Evaluate whether `originatorContactId` (null for terminal sessions)
 * has the capability required by a tool. Returns the decision plus
 * the data the audit log needs.
 */
export function evaluateCapability(
  originatorContactId: number | null,
  requiredCapability: string | null | undefined,
): CapabilityDecision {
  const required = requiredCapability && requiredCapability.length > 0
    ? requiredCapability
    : DEFAULT_REQUIRED_CAPABILITY;

  // Terminal calls bypass — the terminal session is the subscriber.
  if (originatorContactId === null) {
    return {
      required,
      originatorCapabilities: TERMINAL_BUNDLE,
      decision: "allow",
    };
  }

  const originatorCapabilities = getCapabilitiesFor(originatorContactId);
  const decision = hasCapability(originatorCapabilities, required) ? "allow" : "would_deny";
  return { required, originatorCapabilities, decision };
}
