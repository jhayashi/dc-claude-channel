/**
 * Role → capability bundle map.
 *
 * Roles are what the subscriber picks at pair time (or via the agent-setup
 * dropdown for existing contacts); capabilities are the runtime gate the
 * dispatcher checks on every DC tool call.
 *
 * Vocabulary (v1.3.0):
 *   - "*"               — matches anything (subscriber/trusted-agent only)
 *   - "chat"            — basic chat tools (dc_send, dc_chat_history, etc.)
 *   - "low_stakes_*"    — reserved namespace for future low-friction variants
 *   - "private_data_read" — surfacing user private data (attachments, etc.)
 *   - "private_data_write" — sending content into a chat as the user
 *   - "real_world_action" — schedules, familiar apps, anything user-visible
 *   - "infrastructure"  — mutating trust state itself (unpair, role changes)
 *
 * Adding a new capability is non-breaking for `subscriber` and
 * `trusted-agent` (their wildcard covers it). For other roles, the new
 * capability is denied by default until ROLES is edited — that's the safe
 * default. Renaming a capability is breaking; don't.
 */
export const ROLES = {
  subscriber: ["*"],
  "trusted-agent": ["*"],
  "family-member": ["chat", "low_stakes_*"],
  "untrusted-agent": ["chat"],
  guest: ["chat"],
} as const satisfies Record<string, readonly string[]>;

export type Role = keyof typeof ROLES;

const GUEST_BUNDLE: readonly string[] = ROLES.guest;

/**
 * Resolve a role string to its capability bundle. Unknown roles fall back to
 * the guest bundle (fail-safe — least privilege when in doubt).
 */
export function bundleFor(role: string): readonly string[] {
  if (role && Object.prototype.hasOwnProperty.call(ROLES, role)) {
    return ROLES[role as Role];
  }
  return GUEST_BUNDLE;
}

/**
 * Does `set` grant `required`?
 *
 *   - "*" matches anything
 *   - exact match of an entry to `required` matches
 *   - "<prefix>_*" matches any required starting with "<prefix>_"
 *     (note: bare "low_stakes" is NOT matched by "low_stakes_*"; the
 *     trailing "_" in the glob is required)
 */
export function hasCapability(set: readonly string[], required: string): boolean {
  for (const cap of set) {
    if (cap === "*") return true;
    if (cap === required) return true;
    if (cap.endsWith("_*")) {
      const prefix = cap.slice(0, -1); // keeps the underscore: "low_stakes_*" → "low_stakes_"
      if (required.startsWith(prefix)) return true;
    }
  }
  return false;
}
