# Pairing and Access Control

## Feature: Pairing and access control

### Intended behavior

A newly installed Claude Code plugin is unpaired (no Delta Chat contacts have access). The user must pair a phone via QR code to grant it access to Claude.

**Pairing flow (happy path):**

1. User runs `/deltachat:setup` in the terminal.
2. Plugin arms a 5-minute pairing window and creates a "Claude" group chat server-side.
3. Plugin prints a browser link that displays a QR code.
4. User scans the QR from Delta Chat on their phone using the "Scan QR code" feature.
5. Plugin detects the securejoin-complete event from Delta Chat core (verified-contact completion at 1000/1000 progress).
6. Plugin checks: if the armed window is still active AND either no owner exists yet OR the contact is a known owner, it posts a welcome message into the newly-created 1:1 chat with a 5-letter pairing code (e.g., "abcde").
7. User reads the code in Delta Chat, returns to the terminal, and runs `/deltachat:setup pair abcde`.
8. Plugin validates the code, approves the chat, and starts the onboarding tutorial.
9. User completes the tutorial (permission prompt, file reviewer, agent setup, optional game build).
10. Chat is now paired; subsequent messages from that contact are routed to the default agent.

**Fallback flows:**

- If the user sends a message in an unpaired chat before running `/deltachat:setup pair`, the plugin posts a pairing code inline (requires completing pairing from terminal).
- If a known owner (someone who already paired a device) sends the first message in an unpaired chat, the chat is instantly auto-paired to that contact (skips tutorial, routes directly to subagent).
- If multiple devices are paired, only the first device can initiate new pairings via securejoin (subsequent scans of stale QR links are ignored if sent by unknown contacts).

### State machine / transitions

**Unpaired chat states:**
- `UNPAIRED_UNKNOWN`: No owner has initiated contact. Any contact sending a message → `AWAITING_PAIR_CODE` (code generated, awaited).
- `AWAITING_PAIR_CODE`: Code is pending (in-memory, 1-hour TTL). Contact sends `/deltachat:setup pair <code>` → `PAIRED` (on success) or `AWAITING_PAIR_CODE` (wrong code, code expired).

**Paired chat states:**
- `PAIRED_TUTORIAL_OFFERED`: Freshly paired, tutorial not started. User answers yes/no → `TUTORIAL_PERMISSIONS` / `TUTORIAL_DONE`.
- `TUTORIAL_PERMISSIONS` / `TUTORIAL_FILE` / `TUTORIAL_AGENT` / ... : Multi-step tutorial with yes/no branches and optional game build at the end.
- `TUTORIAL_DONE`: Tutorial complete or skipped. Chat is live; messages routed to subagent.

**Armed window (pairing window state):**
- `DISARMED` (default): No pending pairing. `/deltachat:setup` → `ARMED_5MIN`.
- `ARMED_5MIN`: 5-minute TTL. Securejoin-complete event during this window → consumes window, posts code if conditions met. Window expires → auto-clears.

**Owner/access gates (after first pair):**
- If any chat has an owner set, only known owners can:
  - Initiate new pairings via securejoin during armed window.
  - Auto-pair when sending first message to unpaired chat.
- Unknown contacts sending first message to unpaired chat are silently ignored (logged but no response).

### Persisted state

**Files on disk:**

1. **Approved chats allowlist:** `~/.claude/channels/deltachat/approved/<chatId>`
   - One file per approved chat ID (integer filename).
   - **Content:** Contact ID (integer) on a single line, or empty (legacy, pre-owner-tracking).
   - **Lifecycle:** Created by `completePairing()` during `/deltachat:setup pair <code>`. Deleted by `removeChat()` during unpair. Read at startup by `allowedChats()`, `isAllowed()`, `getOwner()`.

2. **Tutorial state (in-memory, not persisted):** Map<chatId, TutorialState>
   - Tracks onboarding progress per chat.
   - **Reset at:** Session restart (lost), or explicitly by `/deltachat:setup tour` or `/tour` chat command.
   - **Read by:** `handleMessage()` to advance tutorial, `handleAppResponse()` to react to WebXDC app interactions.

3. **Arm-window state (in-memory, not persisted):** `{ _armedUntil: timestamp | null, _armedGroupChatId: groupChatId | null }`
   - **Lifetime:** 5 minutes from `armPairing()` call, or until consumed by `consumeArmedWindow()` (whichever comes first).
   - **Group chat:** Created by `dc_access_arm_pairing` tool, stamped with default agent's icon. Returned to user as QR. Re-created on each `/deltachat:setup` (old group left on server if not cleaned up).

4. **Pending pairings (in-memory):** Map<code, { chatId, contactId, createdAt }>
   - **Lifetime:** 1 hour (`PAIRING_EXPIRY_MS = 3,600,000` ms). Pruned automatically by `pruneExpired()`.
   - **Idempotency:** Same chatId re-requesting pairing before the code expires returns the same code.
   - **Limit:** Max 3 concurrent pending codes per process; `startPairing()` throws if exceeded.

### Observable surface

**Slash commands:**

- `/deltachat:setup` — Arm pairing window, create group, print QR link. No args.
- `/deltachat:setup pair <code>` — Complete pairing. Validates code, approves chat, starts tutorial. `code` is 5 lowercase letters.
- `/deltachat:setup unpair [<contact_id>] [freeze|delete]` — Revoke access. No args: list paired contacts. With contact_id: unpair that device (freeze: leave chat read-only; delete: remove chat entirely).
- `/deltachat:setup list` — Debug tool; show approved chat IDs.
- `/deltachat:setup tour [<chat_id>]` — Restart tutorial in a paired chat. Optional numeric chat_id.

**Hooks (executed by Claude Code harness):**

- **SessionStart** (`plugin/scripts/session-start.sh`): Detects if plugin is loaded and channel flag present. If no chat is paired, shows unpaired-session banner with `/deltachat:setup` prompt. Exits 0 on any transient error.

**Messages dispatched into Delta Chat:**

- *"Hi, I'm Claude. To finish pairing, run this in your terminal: `/deltachat:setup pair <code>`"* — Posted to 1:1 chat during securejoin-complete + armed window.
- *"Pairing required — run in Claude Code: `/deltachat:setup pair <code>`"* — Posted to unpaired chat on first message from unknown contact (fallback if securejoin didn't arm).
- Tutorial messages (5 steps, per `tutorial.ts` state machine):
  - Offer to tour 3 apps.
  - Explain permission prompts + send test prompt.
  - Explain file reviewer + send sample file.
  - Offer to create new agent/chat.
  - Offer to build a game.

**WebXDC cards (sent during pairing):**

- **Permission Prompt** (`webxdc/permission-prompt.html`): Demo permission card showing Allow/Deny buttons. Sent by tutorial step 1, intercepted to advance tutorial on tap.
- **File Reviewer** (`webxdc/file-reviewer.html`): Document viewer with syntax highlighting + inline comments. Sent by tutorial step 2, intercepted on interaction.
- **Agent Setup** (`webxdc/agent-setup.html`): Agent creation form + paired-devices list. Sent by tutorial step 3. Used for future agent management, not tutorial.

**MCP tools (permission-gated, available in terminal only):**

- `dc_access_arm_pairing()` → arms window, returns "Pairing armed for 5 minutes (until ISO-8601)".
- `dc_access_pair(code: string)` → validates & completes pairing, starts tutorial, returns "Paired chat {chatId} successfully".
- `dc_access_list()` → returns list of allowed chat IDs (for debugging).
- `dc_access_unpair(contact_id?: number, mode?: 'freeze'|'delete')` → unpairs device(s), posts farewell, returns count of chats affected.
- `dc_start_tutorial(chat_id?: number)` → restarts tutorial in specified (or only) paired chat.
- `dc_invite_link()` → returns invite link SVG QR from bot's account (not chat-specific, created at account init).

### Primary source files

- **`plugin/access.ts`** (~313 lines): Allowlist file I/O, pairing code generation/validation, arm-window state, owner tracking, `listPaired()` for UI display.
- **`plugin/tutorial.ts`** (~248 lines): Onboarding state machine (7 states: offered, permissions_explain, file_explain, agent_offered, agent_wait, phase2_offered, game_choice, done). Yields actions (messages, app cards, handoff) per user input.
- **`plugin/server.ts`** (pairing-related sections): MCP tool handlers for `dc_access_*` and `dc_start_tutorial`. Event handlers: `onSecurejoinComplete()` posts pairing code if window armed. `handleUnpairedMessage()` auto-pairs or generates fallback code. Tutorial intercept in `dispatchPairedMessage()`.
- **`plugin/dc-client.ts`** (~678 lines): RPC wrapper; `onSecurejoinComplete()` handler fires when DC core signals securejoin progress=1000. `getContact()`, `createGroup()` used by pairing flow.
- **`plugin/scripts/session-start.sh`** (~93 lines): Bash hook; detects channel flag, checks for ≥1 approved chat, prints unpaired-session banner if needed.
- **`plugin/skills/setup/SKILL.md`** (~123 lines): User-facing skill definition; dispatches on `/deltachat:setup` argument, calls MCP tools, shows QR link and tutorial guidance.

### Audit notes

1. **`isPendingPair()` is orphaned** (`access.ts`): Exported but never called in the codebase. Used only by tests. Unclear intent — appears to be a debugging utility but not integrated into any flow.

2. **TOCTOU in auto-pair logic** (`server.ts`, unpaired-message handler):
   - Race: Between checking `isKnownOwner(contactId)` and calling `addChat(chatId, contactId)`, the contact could be revoked via `/deltachat:setup unpair` in another terminal.
   - Impact: Rare (microsecond window), but if triggered, the chat would be approved despite the contact being mid-revocation.

3. **Silent failure if contact becomes unknown during securejoin** (`server.ts`, securejoin-complete handler):
   - If owner is established (≥1 paired chat), a stale QR scan by an unknown contact is silently dropped (logged, no message to chat).
   - User sees no feedback; they wait for the code that never comes.

4. **Arm-window cleanup on re-arm** (`server.ts`, `dc_access_arm_pairing` handler):
   - Old "Claude" group chat is left on the bot's side.
   - User may end up with multiple stale "Claude" groups if they re-arm many times without finishing pairing.

5. **MAX_PENDING = 3 limit is per-process, not global** (`access.ts`):
   - If the dispatcher crashes and restarts, the pending-pairing counter resets.
   - Impact: Low; can lead to unexpected "too many pending pairings" errors mid-recovery.

6. **Owner contact ID stored as bare integer** (`access.ts`):
   - No validation that the contact ID is valid/exists in Delta Chat.
   - Phantom owners can still trigger auto-pair if contact is deleted from DC.

7. **Tutorial state not persisted** (`tutorial.ts`, `server.ts`):
   - Restarting the session mid-tutorial loses progress.
   - User must re-run `/deltachat:setup tour` or `/tour` in the chat to restart.

8. **`createGroup()` race with securejoin** (`server.ts`):
   - Sequencing is tight but not atomically gated; theoretical race where joiner lands in 1:1 before group exists.

9. **Pairing code alphabet excludes 'l' (lowercase L)** (`access.ts`):
   - `CODE_ALPHABET = "abcdefghijkmnopqrstuvwxyz"`.
   - Prevents confusion with '1' or 'I', but not documented in user-facing help.

10. **No expiry message posted when pairing code expires** (`server.ts`):
    - User waiting >1 hour before running `pair <code>` gets a cryptic error.
    - Better UX: post "pairing window closed" in chat with re-arm suggestion.

11. **`addChat()` silently succeeds if directory is unwritable** (`access.ts`):
    - `mkdirSync` / `writeFileSync` errors are caught by MCP handler and returned to user; message could be clearer.

12. **Subagent blocklist prevents in-chat agents from calling pairing tools** (`server.ts`, `SUBAGENT_TOOL_BLOCKLIST`):
    - Intentional (prevents agents from auto-pairing or revoking), but not documented inline.

13. **Missing validation of chatId in `dc_start_tutorial`** (`server.ts`):
    - Validates integer + allowlist; doesn't verify chat still exists in DC core.

14. **Session-start hook walks process tree up to 8 levels** (`session-start.sh`):
    - Multiple shell/tmux/systemd layers can cause flag detection to fall back to "assume flag present" — may mask actual flag-missing cases.
