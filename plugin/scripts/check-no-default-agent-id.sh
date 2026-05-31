#!/usr/bin/env bash
# v1.4.9 (D8) — fail the build if DEFAULT_AGENT_ID appears in production
# code outside the allowed carve-outs.
#
# Why: pre-v1.4.9 every production caller hardcoded DEFAULT_AGENT_ID,
# parking every contact record under claude-code.dc/contacts/ regardless
# of which agent owned the chat. v1.4.9 flips reads + writes to per-agent
# sidecars. This guard prevents a regression where a new call site
# silently funnels back through claude-code.
#
# Allowed files (intentional or definitional):
#   access/contacts.ts    — defines the const + the in-module carve-outs
#                            (canonical-seed source, terminal-pair fallback)
#   agents.ts             — defines the const + auto-seed logic
#   access/pairing.ts     — terminal-pair flow (terminal CC IS the
#                            claude-code agent; see Phase 3.1 of the plan)
#   access/chat-allowlist.ts — startup seed paths that fall back to
#                                claude-code when the binding's agentId
#                                cannot yet be resolved
#   test/**               — fixture data
#   scripts/**            — verification tools (this file et al.)
#   docs/**               — plan + spec references
#
# Run from plugin/ dir. Exits 0 on pass, 1 on violation with a pointer
# to the plan doc.

set -euo pipefail

if [ ! -d "access" ] || [ ! -d "test" ]; then
  echo "check-no-default-agent-id: must be run from the plugin/ directory" >&2
  exit 2
fi

# Allowed file paths (relative to plugin/), one per line.
ALLOWED=(
  "access/contacts.ts"
  "access/pairing.ts"
  "access/chat-allowlist.ts"
  "agents.ts"
)

# Build a grep exclusion pattern for the allowed paths.
EXCLUDE_REGEX=""
for f in "${ALLOWED[@]}"; do
  EXCLUDE_REGEX="${EXCLUDE_REGEX:+${EXCLUDE_REGEX}|}${f}"
done

# Search all .ts files outside test/, scripts/, and node_modules/.
# Skip the allowed files via grep -v.
MATCHES=$(grep -RnE 'DEFAULT_AGENT_ID' \
  --include='*.ts' \
  --exclude-dir='node_modules' \
  --exclude-dir='test' \
  --exclude-dir='scripts' \
  --exclude-dir='.claude' \
  . 2>/dev/null \
  | grep -vE "^\./(${EXCLUDE_REGEX}):" \
  || true)

if [ -n "$MATCHES" ]; then
  echo "check-no-default-agent-id: VIOLATION — DEFAULT_AGENT_ID used outside allowed files:"
  echo ""
  echo "$MATCHES"
  echo ""
  echo "If this is intentional, add the file to ALLOWED in this script and"
  echo "document why in docs/superpowers/plans/2026-05-31-contacts-per-agent.md."
  echo ""
  echo "Otherwise: route through getBindingAgentId(chatId) instead. The whole"
  echo "point of v1.4.9 is to stop funneling every contact decision through"
  echo "the claude-code default agent. See the plan doc for the rationale."
  exit 1
fi

echo "check-no-default-agent-id: OK — no production callers using DEFAULT_AGENT_ID outside allowed files."
exit 0
