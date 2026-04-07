# v0.8.3 plan — auto-pair new chats with a known owner

## Goal

When a paired user adds Claude to a new group (or starts a new 1:1
chat), the bot should respond immediately without requiring a fresh
pairing handshake. The existing per-chat pairing requirement is
redundant: the "only owner can command Claude" rule already gates
non-owner messages at the contact level, so per-chat pairing adds
friction with no incremental security.

## Behavior change

Today: every new chat → "Pairing required, run /deltachat:access pair
abcde" → user types code in terminal → chat is approved.

After: every new chat where `msg.fromId` is the owner of *any* existing
approved chat → silently auto-add to the allowlist with the same owner,
fall through to normal handling. No code, no terminal interaction.

The first-ever pairing (no prior owner exists) is unchanged. The
existing stranger-lockout (`hasAnyOwner() && !isKnownOwner(fromId)`) is
unchanged.

## Implementation

The injection point is `server.ts` around line 617 inside
`onIncomingMessage`. The current order:

```typescript
if (!access.isAllowed(msg.chatId)) {
  // stranger lockout
  if (access.hasAnyOwner() && msg.fromId && !access.isKnownOwner(msg.fromId)) {
    return
  }
  // ...start pairing flow
}
```

New order:

```typescript
if (!access.isAllowed(msg.chatId)) {
  // Stranger lockout (unchanged)
  if (access.hasAnyOwner() && msg.fromId && !access.isKnownOwner(msg.fromId)) {
    logf('dc channel: ignoring pairing request from unknown contact %d in chat %d', msg.fromId, msg.chatId)
    return
  }
  // NEW: auto-pair if sender is a known owner
  if (msg.fromId && access.isKnownOwner(msg.fromId)) {
    access.addChat(msg.chatId, msg.fromId)
    logf('dc channel: auto-paired chat %d to known owner %d', msg.chatId, msg.fromId)
    // Fall through to normal message handling below
  } else {
    // Original first-ever pairing flow
    try {
      const code = access.startPairing(msg.chatId, msg.fromId ?? 0)
      const pairMsg = 'Pairing required \u2014 run in Claude Code:\n\n/deltachat:access pair ' + code
      await client.send(msg.chatId, pairMsg)
    } catch (err) {
      logf('dc channel: pairing error for chat %d: %v', msg.chatId, err)
    }
    return
  }
}
```

The fall-through preserves the existing owner-only group rule (lines
636-646) and tutorial / Claude dispatch.

## What does NOT change

- `access.ts` API stays identical. We're using existing functions:
  `isKnownOwner`, `addChat`, `hasAnyOwner`. No migration needed.
- The 1:1 first-pair flow with the QR code and terminal command is
  untouched. That's still how a new user becomes the owner.
- The stranger-lockout rule is untouched.
- Group chats where a non-owner sends a message still get silently
  ignored at lines 636-646.
- The `approved/` directory format is unchanged (chat_id files containing
  owner contact_id).

## Edge cases

| Scenario | Behavior |
|---|---|
| Paired owner adds bot to a new 1:1 with a stranger | Auto-paired. Stranger's messages get owner-only-rule filtered. |
| Paired owner creates a group with bot + owner only | Auto-paired immediately on first owner message. |
| Two paired devices/contacts of the same human | Both can auto-pair new chats independently. |
| Bot added to a group by a stranger (owner not in group) | First message comes from stranger → `isKnownOwner` false → stranger lockout → silent ignore. Correct. |
| Bot added to a group with no existing owners (first-ever install scenario) | `hasAnyOwner()` false → falls through to original pairing flow. Correct — first install still requires explicit pairing. |
| Owner sends from a brand-new contact ID (e.g., re-installed Delta Chat) | Treated as stranger because the new contact ID isn't `isKnownOwner`. Forces re-pairing. Acceptable. |

## Tests

Add `test/auto-pair.test.ts`:

1. **No prior owner → original pairing flow runs.** Mock chat, no
   approved entries, message arrives from contact 5 → expect a pairing
   message sent, chat NOT in allowlist.
2. **Known owner in new chat → auto-pair.** Pre-approve chat 10 with
   owner 5. Message arrives in chat 20 from contact 5 → expect chat 20
   approved with owner 5, no pairing message sent.
3. **Stranger in new chat with owners present → silent ignore.**
   Pre-approve chat 10 with owner 5. Message arrives in chat 20 from
   contact 7 → expect chat 20 NOT approved, no pairing message, no
   reply.
4. **Auto-paired group with non-owner second message → owner-only rule
   applies.** Pre-approve chat 10 with owner 5, auto-pair chat 20 via
   message from 5, then message from contact 7 in chat 20 → silently
   ignored (group has bot + 5 + 7 + maybe others).
5. **Two known owners → both can auto-pair independently.** Owner A
   pairs chat 10, owner B pairs chat 11. Message from A in chat 30 →
   chat 30 owner = A. Message from B in chat 31 → chat 31 owner = B.

These are pure-function tests against `access.ts` + a mock of the
server's auto-pair branch. No DC RPC needed.

## Files touched

- **Modified:** `plugin/server.ts` — ~10 lines changed in
  `onIncomingMessage`
- **New:** `plugin/test/auto-pair.test.ts` — 5 unit tests
- **Modified:** `plugin/.claude-plugin/plugin.json` (0.8.2 → 0.8.3)
- **Modified:** `.claude-plugin/marketplace.json` (0.8.2 → 0.8.3)
- **Modified:** `CLAUDE.md` — document the auto-pair behavior in the
  access section
- **Modified:** `README.md` — update the "Pair your chat" section to
  note that *additional* chats are auto-paired after the first one

## Risk summary

| Risk | Severity | Mitigation |
|---|---|---|
| Auto-pairing a chat the user didn't intend (bot added to a group by an attacker who happens to be an owner from a different context) | **Low** — would require a known owner to add the bot to a chat with an attacker, and the existing owner-only rule still gates non-owner messages | Document; consider opt-out env var if real-world reports surface |
| Existing users notice the change in flow and are confused | **Low** | Release notes call it out; the change is strictly less work for the user |
| `msg.fromId` is 0 (system / unknown sender) | Already handled | The `msg.fromId &&` guard prevents auto-pair on null sender |
| Race: two messages arrive in a new chat simultaneously, both auto-pair | **Low** — `addChat` is idempotent (writeFileSync overwrites) | No mitigation needed |

## Estimated effort

- server.ts edit: 15 min
- 5 unit tests: 30 min
- README + CLAUDE.md updates: 10 min
- Manual verification (paired user adds bot to new group, expect
  immediate response): 15 min
- Commit + tag v0.8.3 + push: 10 min

**Total: ~1.5 hours.**
