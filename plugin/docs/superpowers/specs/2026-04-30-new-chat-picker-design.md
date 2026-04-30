# New-chat picker design (v2)

> **v2 changes** — open questions are resolved per Joe's review:
> default semantics A, reuse list shows all, middle card always enabled,
> confirmation has a processing state (no auto-dismiss), visual mirrors
> the home screen.

## Goal

Bring back the two flows v1.2.0 collapsed away:

1. **Use the default agent** — quick path for "I just want a chat with Claude, no setup."
2. **Reuse a saved agent** — one-tap start with an agent the user already built.
3. **Build a custom agent** — the existing wall + coach flow.

All three reachable from a single intermediate screen one tap below "Start a new chat" on the home card.

## What we lost in v1.2.0

The v1.x card had a "Start a new chat" → pick-from-templates / pick-existing flow that supported reuse. v1.2.0 wired "Start a new chat" directly into the wall (build-from-leaves) flow, which is right for someone building something new but skips the user who already has the right agent or just wants the default.

The legacy template-grid path is still reachable behind `DC_NEW_AGENT_FLOW=0`, but that's an env-var fallback, not a discoverable UX.

## The intermediate screen — `#new-chat-mode`

After tapping "Start a new chat" on the home card, show a screen with three cards stacked vertically. **Visual: matches the home screen** — icon + label + sub-text + chevron, same surface treatment, same spacing.

```
[icon] Default agent
       Just chat with Claude. No setup.                    >

[icon] Reuse a saved agent
       Start a chat with one of your existing agents.      >

[icon] Build a custom agent
       Coach-led setup from a 155-leaf catalog.            >
```

**Card 1 — Default agent.** Tap creates a new DC chat bound to the system-default agent (model: sonnet, no leaves, no skip-permissions, default system prompt). No further screens — straight to the new chat. Fast path: 1 tap from home, zero setup.

**Card 2 — Reuse a saved agent.** Tap opens the reuse picker (next section). Always enabled.

**Card 3 — Build a custom agent.** Tap goes to the existing wall screen.

## The reuse picker — `#reuse-picker`

A scrollable list of every saved agent (`agents.listAgents()`). One row per agent: badge (server-rendered PNG with correct pattern), name, model tier, "bound to N chats" if any. **No filtering** — shows all saved agents regardless of archetype, binding count, or recency. Sort: most-recently-bound first, then alphabetical.

Tap a row → confirmation screen. The header has a back chevron to the intermediate screen.

## The confirmation screen — modal over `#reuse-picker`

```
Start a new chat with "Sleep coach"?
[ Cancel ]   [ Start chat ]
```

After tapping "Start chat":
- Dialog stays open and **does not auto-dismiss** — agent-binding takes a few seconds (DC group create + member add + chat-name + badge + binding write).
- Show a processing state: spinner + "Setting up your chat…"
- On success, dispatcher emits a payload with the new chat id; card dismisses and the user can switch to the new chat from their chatlist.
- On failure, dialog flips to an error state with a Retry button. Cancel is always available.

## Implementation sketch

### WebXDC HTML (`webxdc/agent-setup.html`)

- Add `<div id="new-chat-mode">` and `<div id="reuse-picker">` screens between `#wall-screen` and `#manage`.
- Update the `ids` array in `show()` and the `.visible` CSS selector list to include both new screens.
- Replace `gotoNewChat()`'s direct `show('wall-screen')` call with `show('new-chat-mode')`.
- Add `gotoBuildCustom()` (= the old `gotoNewChat` body), `gotoReusePicker()`, `gotoDefaultAgent()`.
- Add `renderReusePickList()` that builds rows from the existing `state.existingAgents` payload. Reuse the row component already used on the manage screen so badge rendering goes through the patched `renderPreviewSvg(tier, trust, glyph, pattern)` path.
- Confirmation modal can reuse the existing `showConfirm` modal scaffold but with custom button copy ("Cancel" / "Start chat") and a processing-state branch.

### Dispatcher (`apps/agent-setup-app.ts`)

- Add a new payload type `start-default-chat`: handler creates a DC chat, binds it to the dispatcher's built-in default agent (synthesized on demand if not present), persists the binding, sends the new chat id back.
- Add `start-reuse-chat` with `{ agentId }`: handler creates the chat and binds the named agent. Same shape as the build-agent graduation success — write binding, set chat name to the agent name, install the agent badge, post the agent's first greeting.
- Both handlers send a `chat-ready` update on success, `chat-failed` with an error string on failure. Card listens and either dismisses (success) or flips the modal to error state (failure).
- The default-agent definition lives in a synthesized `default-agent.yaml` written on first use. That keeps it on disk so it shows up under Manage and the user can edit it like any other agent.

### Default-agent semantics (option A — confirmed)

The default agent is a single concrete `AgentDef` saved to disk like any other: name "Default agent", model `claude-sonnet-4-6`, no leaves, vanilla system prompt ("You are a helpful assistant."). It's a real persisted agent, not a virtual / on-the-fly one. Pros: shows up under Manage; the user can rename, retune, or delete it; refine works on it. Cons: if the user deletes it, "Default agent" on the intermediate screen needs to either re-create it or fall back to "this card is unavailable" — re-create is simpler, just lazy-write on tap.

(Option B was "spawn a fresh AgentDef on each tap so each default-chat starts pristine." Rejected: clutters the agent list and breaks refine.)

## Open questions — RESOLVED

| # | Question | Decision |
|---|----------|----------|
| 1 | Default agent semantics — A (one persisted default) or B (fresh per tap)? | **A** — one persisted default agent on disk. |
| 2 | Reuse list filtering — show all, or filter (archetype / recent / unbound)? | **Show all.** No filter. |
| 3 | Empty state when zero saved agents? | **Moot** — once we show all, the only empty case is a brand-new install. The reuse card stays enabled; tapping into an empty list shows a small "No saved agents yet — try building one" hint with a button that routes to the wall. |
| 4 | Middle card (reuse) — disable when list is empty, or always enable? | **Always enable.** With "show all" + the empty-state hint above, the card is always reachable. |
| 5 | Confirmation modal — auto-dismiss on tap, or wait for the chat to be created? | **Wait + processing state.** Don't auto-dismiss; show a spinner "Setting up your chat…" until the dispatcher reports success or failure. |
| 6 | Visual — match home screen, or use a distinct treatment for the picker? | **Match home screen.** Same card style as the home-action buttons. |

## Build sequence

1. Add `#new-chat-mode` screen + the three card buttons + the goto stubs. Wire `gotoNewChat()` to it. Bump APP_VERSION. Smoke test: tap on home → see the three cards. (No backend changes yet.)
2. Add `#reuse-picker` screen + `renderReusePickList()` + the confirmation modal scaffolding. Stub out the actual chat-create with a fake "Created!" toast. Smoke test: tap a row → confirm → toast.
3. Wire dispatcher handlers `start-reuse-chat` and `start-default-chat`. Implement processing state in the modal, success/failure dispatch. Smoke test: real chat creation, agent badge appears, binding persists.
4. Lazy-create the default agent on first `start-default-chat`. Smoke test: delete the default from Manage, hit the intermediate screen → tap "Default agent" → verify it's re-created.
5. Tier-1 Playwright tests for the intermediate screen (3 cards visible, taps navigate correctly), the reuse picker (rows render, badge pattern is correct), the confirmation modal (processing state, error state).

## Out of scope (this design)

- Multi-account / shared default agent across hosts.
- Inline agent editing from the reuse picker (separate task).
- Search/filter inside the reuse picker (deferred until N > ~20 saved agents is realistic).
- Animations / transitions between screens (CSS-only, can land later).

## Files touched

- `plugin/webxdc/agent-setup.html` — new screens, new gotos, new payload types, APP_VERSION bump.
- `plugin/apps/agent-setup-app.ts` — `start-default-chat` and `start-reuse-chat` handlers, default-agent lazy-create, success/failure dispatch back to the card.
- `plugin/agents.ts` — `getOrCreateDefaultAgent()` helper if not already present.
- `plugin/test/webxdc/agent-setup-mode-picker.pw.ts` — new test file.

## Files NOT touched

- The wall flow (`renderWall`, `showLeafDetail`, etc.) is unchanged — it's just reached via a different entry point.
- Coach + assembler + refine — unchanged.
- The legacy template-grid path behind `DC_NEW_AGENT_FLOW=0` — stays as-is, slated for removal in a future release.
