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
#
# - access/contacts.ts — defines the const + canonical-seed source carve-out
# - access/pairing.ts — terminal-pair flow (Phase 3.1 of plan; terminal CC
#   IS the claude-code agent so the pair record correctly goes there)
# - access/chat-allowlist.ts — startup seed paths
# - agents.ts — defines the const + auto-seed logic
# - bindings.ts — hosts getBindingAgentId, the *only* sanctioned default-
#   agent fallback in production code. All other lookups route through
#   getBindingAgentId(chatId) so the fallback is centralized.
ALLOWED=(
  "access/contacts.ts"
  "access/pairing.ts"
  "access/chat-allowlist.ts"
  "agents.ts"
  "bindings.ts"
)

# Build a grep exclusion pattern for the allowed paths.
EXCLUDE_REGEX=""
for f in "${ALLOWED[@]}"; do
  EXCLUDE_REGEX="${EXCLUDE_REGEX:+${EXCLUDE_REGEX}|}${f}"
done

# Pattern explanation: we match `access.DEFAULT_AGENT_ID` (also catches
# `ctx.access.DEFAULT_AGENT_ID` and `accessNs.DEFAULT_AGENT_ID` — any
# *.access.DEFAULT_AGENT_ID form). This is the per-agent contacts/
# capability lookup pattern that Phase 2 of v1.4.9 sweeps away. We
# deliberately do NOT match `agents.DEFAULT_AGENT_ID` — that's used as
# an identifier-default when resolving which agent to bind/attach
# (e.g., resolveAttachAgent's final fallback), distinct from "which
# agent owns this contact decision." Treating those as violations
# would force pointless rewrites that hurt readability without
# fixing real bugs.
MATCHES=$(grep -RnE 'access\.DEFAULT_AGENT_ID' \
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
