# Agent Creation Redesign — Design Spec

**Date:** 2026-04-28
**Status:** Draft, awaiting user review
**Scope:** Replace the current "New chat" path through the agent-setup WebXDC card with a guided, ontology-driven creation flow. Add multi-expert "mash-up" agents, a coach-led interview, in-chat NL controls, and a refreshed badge system. Preserve all v1.x flows that aren't named here (Manage, Resume terminal, Send to terminal, Paired devices).
**Related:**
- [v0.4.1 catalog (Sheet)](https://docs.google.com/spreadsheets/d/1cuSNsRRLLzGv-yNB_B9GUcIP0Q3fFYR47vA3Gb2ATbE/edit)
- v1.0.2 badge system (`plugin/agent-icons/`, `plugin/agent-icon-render.ts`)
- Agent definitions (`plugin/agents.ts`, `plugin/templates.ts`)
- Existing setup card (`plugin/webxdc/agent-setup.html`)

---

## 1. Goals

1. **Solve the three problems with templates.** Today's narrow template gallery (a) under-samples what people want, (b) requires customers to trust opaque starter prompts, and (c) limits the user's imagination to whatever 12 templates we shipped.
2. **Inspire as much as catalog.** A user who doesn't know what they want should leave the picker with a richer sense of what's possible. A user who knows exactly what they want should still get there fast.
3. **Make agents personal without making them intimidating.** Customers co-author the system prompt through a brief, conversational coach interview rather than editing a textarea.
4. **Allow combinations.** A "Sleep coach + Stress coach + Mindfulness guide" agent should be one chat, one prompt, one identity — not three agents in a group.
5. **Stay portable.** Agents created via this flow remain exportable as Claude Managed Agents YAML; the system prompt is plain prose with no channel-specific markup.
6. **Keep the home tidy.** All paths into agent management — new, refine, manage, resume, send-to-terminal, paired devices — remain reachable from one card.

## 2. Non-goals

- Migration of v1.x agents/templates/bindings. They coexist by sitting where they sit; the new flow produces the same `AgentDef` + `Binding` shape.
- Investment, medical, legal, etc. **advice**. Liability-flagged leaves stay strictly non-advisory.
- A separate "panel of experts" UI for mash-ups. One unified agent, not many.
- Hard caps on mash-up size or schedule density. Soft warnings only.
- Voice as a first-class feature beyond the existing local-Whisper pipeline. The coach is voice-friendly; nothing more.
- A "marketplace" for user-shared agents. Out of scope.

---

## 3. Concept model

The user-facing concepts, in order of how often they're encountered:

| Concept | Definition |
|---|---|
| **Agent** | A persona with a name, glyph, badge pattern, model tier, system prompt, and tool allowlist. Lives in `~/.claude/channels/deltachat/agents/<id>.yaml`. Reusable across chats. |
| **Chat** | A DC chat bound to one agent. Holds the session UUID. Lives in `bindings/<chatId>.json`. |
| **Specialty** | An L2 grouping in the ontology (e.g., "Health, wellness, caregiving"). 26 of these total. |
| **Leaf** | A specific agent kind within a specialty (e.g., "Sleep coach"). 155 of these total. The atomic unit the user picks. Some are subject-parameterized (e.g., Tutor *(subject)*). |
| **Mash-up** | An agent whose expertise spans 2+ leaves, with one unified system prompt. Any leaves can be combined; the catalog's `combines_with` column suggests compatible pairings. |
| **Coach** | A temporary persona used during agent creation (and during Refine). Interviews the user for 3–5 turns, then transparently graduates to the working agent in the same chat. |
| **Refine** | A coach-led pass over an existing agent. Reachable from the home card OR by saying so naturally inside any agent chat. |
| **Personality** | A named preset (Coach / Drill Sergeant / Mentor / Pal / Professor) plus optional domain-conditional sliders. Drives the *voice* paragraph of the system prompt. |
| **Trust** | Whether the agent runs in skip-permissions mode (`metadata['x-dc-skipPermissions']`). User-toggleable via NL. Reflected in the badge pattern (solid = no trust, pattern = trust). |
| **Model tier** | The Claude model the agent uses. Per-agent metadata. NL-switchable ("switch to sonnet"). Reflected in badge color (Haiku green / Sonnet amber / Opus orange). |
| **Tools** | The set of built-in tools and MCP services the agent is allowed to use. Picked dynamically by the coach based on leaf-implied tools and the user's connected services. |

---

## 4. User journey — happy path

1. User opens Agent settings card → home → **Start a new chat**.
2. Wall view: 26 specialty tiles in a 2-column grid. User taps **Health, wellness, caregiving**.
3. L2 leaf list appears. User taps **Sleep coach**.
4. Detail card: pitch, parameter prompts (none for Sleep coach), pairs-with chips (Stress · Mindfulness · Nutrition · Fitness · Mental-health peer-support · Health-metric tracker · Yoga · Recovery accountability · Therapeutic-adjacent).
5. User taps `+ Add to mash-up` chip on **Stress-management coach** and **Mindfulness & meditation guide**. Each chip flips to a checkmark.
6. Persistent build pill at the top: "Mashing up 3 specialists / Sleep coach + Stress coach + Mindfulness guide / Review →".
7. User taps **Review →**.
8. Review screen: list of selected specialties (each removable), merged-pitch preview, cap warning if 4+, **+ Add another** button, **Build & start chatting →** primary CTA.
9. User taps **Build & start chatting**. A new DC chat opens with the coach as the agent. Coach badge: temporary "coach" pattern + Sonnet color (default tier for new agents).
10. Coach interviews for 3–5 turns. Reflects each answer before the next question. Default behavior; user can short-circuit by saying *"let's go"*.
11. After the last useful answer, coach soft-graduates: stops asking, starts answering as the working agent. **The chat avatar swaps from the coach badge to the agent's badge** (user-round glyph + selected pattern + Sonnet color).
12. Agent runs under the assembled system prompt for all subsequent turns.

Refine, model-switch, trust-toggle: all happen inside the agent chat with NL triggers (see §10) — no card navigation required.

---

## 5. Ontology v0.4.1 — 155 leaves

Three paths, 26 specialties, 155 leaves. Authored at curation time; users navigate, don't edit. Bidirectional `combines_with` (symmetric closure applied 2026-04-28). 35 leaves carry a non-advisory liability flag.

**Path 1 — Expert (121 leaves, 24 specialties).** A person-shaped specialist the user works alongside.
- Sciences (2) · Information & knowledge (4) · Languages & humanities (3) · Architecture & design (3) · Trades & hands-on (4) · Hospitality & food (5) · Personal care & service (5) · Business & finance (14) · Community & social service (5) · Creative & arts (13) · Skill teacher (1, parameterized) · Hobbies & outdoors (8) · Collecting (1, parameterized) · Health, wellness, caregiving (17) · Legal (3) · Engineering & technical (8) · Personal coaches (4) · Therapeutic-adjacent (3) · Education (4) · Education leadership (3) · Public sector / civic (4) · Religious & spiritual (2) · Media & writing (3) · Protective service (2)

Sciences and Languages & humanities skew small because aggressive parameterization absorbed several leaves into "Hard-science research partner *(field)*" and "Social scientist *(field)*". Hobbies & outdoors absorbed a separate Sports & recreation L2 (sports-fan / coaching-assistant lives here now).

**Path 2 — Service (10 leaves).** An agent with a standing job (schedule or trigger).
- Daily news / feed briefing · Inbox & notification triage · Pipeline & system health monitor · Price / availability watcher · Calendar / scheduling assistant · Content draft creator · Subscription & renewal tracker · Bill / payment monitor · Personal data backup monitor · Health-metric tracker

**Path 3 — Goal (24 leaves).** A bounded engagement with an end.
- Trip planner · Event planner · Major-purchase research · Job search / interview prep · Education milestone · Move / relocate · New-baby prep · Project manager · Research project · Video / content series production · Divorce / separation navigator · Bereavement & funeral planner · Retirement-transition planner · Career pivot / sabbatical planner · Empty-nest transition coach · Recovery-from-illness manager · Mortgage / refinance / foreclosure navigator · Immigration & naturalization journey · Caregiving-onset planner · Pet acquisition or pet-loss planner · Coming-out / identity-transition support · Tax-prep journey · Estate & will planning helper · Adoption / foster journey

### 5.1 Authoring conventions

- **Roles, not actions.** Brainstorming, planning, research, summarization, reminders, notifications, drafting — capabilities every agent gets dynamically. Not leaves.
- **Subject parameterization.** Within a specialty, all leaves sit at the same abstraction level. "Tutor *(subject)*" not "Algebra tutor"; coach asks for the subject during the interview.
- **One home per leaf.** PM moved from Business to Goal because PM is goal-shaped, not expert-shaped.
- **Liability flags.** Each leaf carries zero or one flag from: medical, legal, financial-investment, tax, immigration, veterinary, religious-authority, eldercare, mental-health. Flagged leaves trigger the shared non-advisory framing template (see §11).
- **Pairs are bidirectional.** If A's `combines_with` lists B, B's lists A. Authors only need to write one direction; the dispatcher applies symmetric closure on load.

---

## 6. Home IA — 6 cards, grouped

```
─────────────────── Agent shaping ───────────────────
[ Start a new chat       ]  Pick existing OR build new
[ Refine an agent        ]  Coach-guided edit
[ Manage agents          ]  Form-edit, delete, export
─────────────────── Sessions & devices ──────────────
[ Resume terminal session ]  unchanged from v1.x
[ Send chat to terminal   ]  unchanged from v1.x
[ Paired devices          ]  unchanged from v1.x
```

Two visual groups separated by a hairline divider. Each card retains the v1.x action-card pattern (icon, label, description, right chevron). Refine is the only new entry; everything else is current.

**Refine, NL re-entry.** Inside any agent chat, if the user says something like "let's refine you," "I want to tweak your prompt," "be sharper on X," the dispatcher detects the intent and pivots into the Refine flow inline (coach reopens with the existing prompt as context). No card navigation required.

---

## 7. Navigation CX — the wall

Replaces the current `#new-chat` step. Single screen.

**Header:** crumb (Home › Build new agent) + version badge.

**Search bar:** filters as you type across leaf names, pitches, specialties, and parameters. Empty = browse mode (see grid). Non-empty = result list (up to 25 visible, scrollable).

**Helper line:** "155 agents grouped by 26 specialties. Tap a tile to see all of its agents, or filter."

**Specialty tile grid:** 2 columns. Each tile shows:
- Path color tag (Expert orange / Service green / Goal blue)
- Specialty name
- Leaf count (e.g., "17") in the right corner, mono-font
- 3 sample leaves below, separated by interpuncts

**L2 drill-in:** tapping a tile replaces the grid with that specialty's leaf list. Back-bar at top returns to the wall.

**Leaf detail card:** tapping a leaf opens an inline detail card.
- Path color tag + leaf name
- Parameter line ("Asks you about: [parameter]") if parameterized
- Pitch (2 sentences)
- Pairs-with chips — see §8
- CTAs — see §8

---

## 8. Mashup CX — multi-leaf agents

Multi-leaf is a first-class capability. Any leaf can pair with any other leaf at the system level; the catalog's `combines_with` is the *suggested* combinations the UI surfaces.

**Detail card has two CTAs side-by-side:**
- *Empty build:* `+ Add to mash-up` (secondary, orange outline) · `Build now` (primary, orange — single-agent fast path)
- *Non-empty build:* `+ Add to mash-up` (secondary) · `Add & review` (primary)
- *Already in build:* `✓ In your mash-up` (disabled secondary) · `Review →` (primary)

**Pairs-with chips.** The leaf's `combines_with` rendered as inline tappable chips. Tap = add that partner to the mash-up *and* flip the chip to a checkmark. One-tap addition, no navigation.

**Persistent build pill** at the top of the body whenever the build holds 1+ specialties. Animates in on first appearance.
- Glyph: count circle ("3")
- Title: "Mashing up 3 specialists" (or "Building 1 specialist")
- Sub: first 3 leaf names, joined with `+`, plus "+ N more" if longer
- CTA chip: "Review →"

**Cap warning.** When build size ≥ 4, an amber `⚠ Adding more may dilute the agent's focus. Three is usually the sweet spot.` line appears below the pill. No hard cap; user is always free to proceed.

**Review screen.** Tapping the pill opens this view.
- H2: "Your mash-up agent" (or "Your new agent" for size 1)
- Sub: "These N specialties combine into **one** agent with a unified system prompt. The coach helps you weight them and tune voice next."
- List of selected specialties with × per row to remove
- Merged-pitch preview ("How it will introduce itself") — at runtime, the model composes; in the spec we show first-sentence concatenation as a placeholder
- CTA row: `+ Add another` (back to wall) · `Build & start chatting →` (primary)

---

## 9. Coach conversation

The coach is a temporary persona that runs in the new chat for the first 3–5 turns. Its purpose: collect just enough context to assemble a working system prompt.

### 9.1 Principles

1. **Conversational, not interrogative.** One question at a time. Coach reflects what it heard before the next question (the *reflect-always* pattern; voice-friendly and rapport-building for text users too).
2. **Leaf-aware.** Coach script branches by leaf shape (see 9.3).
3. **Brief.** Aim for 3 questions; soft cap at 5. The agent learns more once the user uses it.
4. **Same voice across all leaves.** Helpful, terse, asks before assuming. The differentiator after graduation is the agent's voice, not the coach's.
5. **Graduation is soft + visual.** No verbal handoff. The coach simply stops asking and starts being the agent. The chat avatar swaps from the coach badge to the agent's badge at the moment of graduation — that's the visual signal.
6. **Skip affordance.** First coach message includes "or just say *let's go* and I'll use defaults." Yes, always offered.
7. **Re-openable.** Refine reopens a focused mini-interview anytime, with the existing prompt as context.

### 9.2 Sample transcripts

**Single leaf — Tutor *(subject = Algebra II)***

> 🎓 *Coach:* "Got it — a tutor. What subject, and who's the learner? (Or just say *let's go* and I'll use defaults.)"
> 👤 *User:* "Algebra II, my 8th grader Sam."
> 🎓 *Coach:* "Got it: Algebra II for Sam. Two questions about how I should be: when Sam's stuck, do you want me to give the answer faster, or push them to discover it? And how strict about showing work?"
> 👤 *User:* "Push them. Always show work."
> 🎓 *Coach:* "Push-mode and work-always-shown — got it. Last one: should I have access to your Gmail in case Sam's teacher emails homework or grade reports?"
> 👤 *User:* "Yes."
> *(Coach's next message comes in the agent's voice. Avatar swaps.)*
> 🎯 *Agent:* "Hey Sam — what did you all work on today?"

**Mash-up — Sleep + Stress + Mindfulness**

> 🎓 *Coach:* "Three big specialties — sleep, stress, mindfulness. Which is the bigger pain right now? (Or *let's go*.)"
> 👤 *User:* "Sleep, but the stress is what's driving it."
> 🎓 *Coach:* "So sleep leads, with stress as the lens whenever it shows up. How direct should I be — gentle nudge, or pull no punches?"
> 👤 *User:* "Gentle but honest. I get defensive."
> 🎓 *Coach:* "Gentle and honest — got it. Last one: should I monitor your Oura when it changes, and would a daily 8pm 'how was today?' check-in be too much?"
> 👤 *User:* "Yes to Oura, 8pm is fine."
> *(Avatar swaps.)*
> 🎯 *Agent:* "Hi. When did you sleep last night, and how does today feel?"

**Service — News briefing**

> 🎓 *Coach:* "What topics, and what time should I send it? (*Let's go* takes default tech-news + 7am.)"
> 👤 *User:* "AI safety, US politics, climate. 7am weekdays."
> 🎓 *Coach:* "AI safety + US politics + climate, 7am weekdays — got it. Sources you want me to pull from? You can name outlets or I'll use a sensible default."
> 👤 *User:* "Default + Stratechery."
> 🎓 *Coach:* "Default + Stratechery. Length — 5 minutes, 10, or whatever it takes?"
> 👤 *User:* "5 minutes."
> *(Avatar swaps. First briefing arrives the next morning.)*

### 9.3 Per-leaf-shape coach script

| Shape | Coach asks |
|---|---|
| **Parameterized** (Tutor, Translator, Skill teacher, Pet trainer, etc.) | Parameter value first, then style/tools |
| **Health/wellness** (non-advisory) | Specific situation, non-advisory framing reinforced, tools (tracker integration), check-in cadence |
| **Mash-up (≥2 leaves)** | Which leaf leads (only when not obvious; "all equal" is the default fallback); how to switch lenses |
| **Service** (Daily briefing, Inbox triage, etc.) | Schedule, sources, output length, escalation rules |
| **Goal** (Trip, Move, Job-search, etc.) | Timeline, milestone, key constraints, who else is involved |
| **Liability-flagged** | Coach inserts the non-advisory framing naturally and confirms scope |

### 9.4 Refine conversation

Triggered by Home → Refine card OR by NL inside any agent chat. Coach loads the existing assembled prompt as context, asks "What do you want to change?" once, and probes only what's relevant. Updates only the affected blocks (see §11.4); other blocks remain byte-identical so unrelated behavior is preserved.

---

## 10. NL controls

Three classes of in-chat NL commands the dispatcher detects and acts on, replying to confirm. Each mutates the `AgentDef` on disk; the badge re-renders on next read.

### 10.1 Model switch

Triggers (case-insensitive, examples):
- "switch to sonnet" / "use opus" / "make this faster" / "downgrade to haiku"

Action: update `AgentDef.model` to the latest model in the named tier. Reply: "Switched to Sonnet 4.6 — I'll feel about the same with quicker responses." Badge tier color updates on next render.

Default tier for new agents: Sonnet (latest). Spec carries a "use latest in this tier" rule rather than hardcoding versions; resolution happens at agent-spawn time using the dispatcher's known-model registry.

### 10.2 Trust toggle

Triggers:
- "trust me" / "turn on trust" / "skip permissions" → enable
- "be safer" / "turn off trust" / "ask before tools" → disable

Action: flip `metadata['x-dc-skipPermissions']` on the `AgentDef`. Reply: "Trust on — I'll skip permission prompts for tools." Badge pattern fills (trust on) or goes solid (trust off) on next render.

### 10.3 Refine entry

Triggers:
- "let's refine you" / "I want to tweak your prompt" / "be sharper on X" / "be less Y from now on"

Action: pivot into the Refine flow inline (see §9.4). The dispatcher's intent classifier hands the next user turn off to the coach with the existing prompt as context.

---

## 11. System-prompt assembly

The agent's `system` prompt comes together at the **graduation moment** by composing leaf-authored content with coach-captured user preferences. Same assembly machinery runs for Refine, but only modified blocks are rewritten.

### 11.1 Format — plain prose, five paragraphs in fixed order

Plain English, no XML tags, no Markdown headers. Section transitions handled by lead phrases ("Your expertise." "How you sound." etc.). This is the most portable form: round-trips through Claude Managed Agents YAML cleanly because it's just a string.

| # | Paragraph | Purpose |
|---|---|---|
| 1 | **Identity** | Who the agent is, in one sentence. Mash-up: lead lens called out. |
| 2 | **Expertise** | What it knows, broken out per leaf. Authored at catalog-curation time. |
| 3 | **Voice** | Personality preset + slider modifications, applied as fixed-text snippets. |
| 4 | **Preferences** | User's specific coach answers, paraphrased verbatim. |
| 5 | **Scope** | Liability framing if any, tool affordances, what's in/out of bounds. |

### 11.2 Sample assembled prompt — single leaf

Agent: **Tutor *(subject = Algebra II)***, Drill Sergeant preset, Direct (vs Socratic) slider, prefs *push to discover* + *always show work*, Gmail tool wired.

```
You are an Algebra II tutor for Sam, an 8th grader.

Your expertise. As a tutor, teach from where the learner is. Diagnose
gaps before reteaching. Connect new concepts to ones already mastered.
Track what's been mastered vs still wobbly across sessions.

How you sound. Drill Sergeant — terse, direct, demanding follow-through.
Don't soften hard truths. Hold the bar. Direct, not Socratic — answer
questions when asked, but...

Specific preferences from this user. When Sam is stuck, push them to
discover the answer rather than giving it. Two prompts max before
stepping in. Always require Sam to show their work; refuse a bare
answer. Address Sam by name.

What's in and out of scope. Tools available: Gmail (read-only) — surface
messages from Sam's teacher about homework or grade reports. Don't
reply on Sam's behalf. If Sam tries to redirect to non-algebra topics,
redirect once, then go where they need to go for that turn — but circle
back to algebra within the next exchange.
```

### 11.3 Sample assembled prompt — mash-up

Agent: **Sleep coach + Stress-management coach + Mindfulness & meditation guide**, sleep-led, Mentor preset, gentle/earnest sliders, Oura monitoring + 8pm check-ins.

```
You are a wellness partner who unifies sleep, stress, and mindfulness
into one coherent practice. Sleep is the lead lens — when topics
intersect, frame through sleep. Stress is the secondary lens.
Mindfulness is the practice toolkit you draw from.

Your expertise. As a sleep coach (lead), build and maintain a
sleep-hygiene plan with the user; read tracker data weekly and surface
what changed. As a stress-management coach (secondary), use breathing,
time-blocking, and cognitive-reframe practices; when stress is upstream
of poor sleep, name that explicitly. As a mindfulness guide (toolkit),
suggest practices tuned to where the user is — secular framing, drawing
from breath, body-scan, walking, and journaling traditions.

How you sound. Mentor — balanced, advice-on-request, holds space.
Patient (gentle nudges, not pull-no-punches). Earnest (no winks or
jokes about hard things).

Specific preferences from this user. Sleep is the bigger pain right
now, but stress is what's driving it — lead with sleep; bring in stress
whenever relevant. Be honest, but precede hard observations with
reflection of what the user shared. Daily 8pm check-in: ask how today
felt — one short question, not a form.

What's in and out of scope. Tools available: Oura via Apple Health
bridge — observe nightly sleep score, HRV, resting HR; surface changes,
don't lecture. You are not a clinician — if the user describes symptoms
suggesting a medical issue (chest pain, sustained insomnia >2 weeks,
etc.), suggest seeing a provider. Scheduled: 8pm daily check-in posts
here.
```

### 11.4 Authoring vs runtime

| Source | Lives where | Generates |
|---|---|---|
| Per-leaf catalog YAML | `plugin/templates/` (subset) + new `plugin/leaves/` (full catalog) | Identity stem + Expertise paragraph for that leaf |
| Personality preset | `plugin/personality-presets.ts` (fixed snippets) | Voice paragraph (+ slider modifiers) |
| Coach interview | accumulated during the chat, persisted to `AgentDef.metadata.coach-answers` | Preferences paragraph; mash-up lead pick; tool toggles & schedules |
| Liability template | `plugin/liability-frames.ts` (one shared snippet per flag) | Trailing addendum to Scope paragraph |
| Tool defaults | per-leaf `suggestedTools` field + user's enabled MCP servers | `--allowedTools` config + Tool affordances clause in Scope |

### 11.5 Refine — incremental rewrite

Refine modifies only the blocks the user asked about. A coach probe like *"be sharper on the math but stay gentle on tone"* rewrites the Voice paragraph and (likely) the Preferences paragraph; Identity, Expertise, and Scope remain byte-identical. This preserves unrelated behavior — the agent still has the same opinions about everything we didn't touch.

---

## 12. Personality model

Five named presets, applied as fixed-text snippets in the Voice paragraph.

| Preset | Snippet seed |
|---|---|
| **Coach** | "Warm, patient, asks before answering. Reflect what you hear before responding." |
| **Drill Sergeant** | "Terse, direct, demanding follow-through. Don't soften hard truths." |
| **Mentor** | "Balanced, advice-on-request, holds space." |
| **Pal** | "Casual, playful, encouraging. Light humor where it fits." |
| **Professor** | "Formal, thorough, comprehensive. Cite sources when relevant." |

**Domain-conditional sliders.** Surfaced only when the leaf's specialty calls for them.
- *Educator agents:* Socratic ↔ Direct
- *Coach/Mentor agents:* Patient ↔ Demanding · Earnest ↔ Playful
- *Service agents:* Quiet ↔ Verbose (notification chattiness)
- *Creative agents:* Conventional ↔ Avant-garde

Sliders modify the preset snippet additively. The coach surfaces them as part of its second-question batch (see §9.2).

---

## 13. Tools

Picked dynamically by the coach based on:
1. The leaf's `suggestedTools` (authored).
2. The user's enabled MCP servers (from existing per-agent `allowedMcpServers` infrastructure, v0.10+).
3. Coach answers ("Yes, watch my Gmail" / "No, don't post to Slack").

The dispatcher writes the resulting allowlist to `AgentDef.allowedBuiltinTools` and `AgentDef.allowedMcpServers`. Spawned subagents enforce via `--allowedTools`. The Scope paragraph of the system prompt names the tools and when to use them.

Built-in tools default to "all allowed" if the user opts for *let's go*. MCP servers default to "none" unless the leaf explicitly suggests one and the user confirms.

---

## 14. Liability framing

Nine flags carrying a shared non-advisory template applied by the dispatcher per-leaf:

medical · legal · financial-investment · tax · immigration · veterinary · religious-authority · eldercare · mental-health

The shared snippet appended to the Scope paragraph reads (illustrative, exact wording in `plugin/liability-frames.ts`):

> You are not a [licensed clinician / attorney / advisor / etc.]. You don't diagnose, prescribe, or render binding professional advice. If the user describes a situation that would warrant a licensed professional, recommend they seek one — without overstating the urgency or being alarmist.

The coach also reinforces this naturally during the interview ("Heads up — I'm here to help you think through it, not to diagnose").

---

## 15. Badge system

Single glyph (user-round, Lucide). Three tier colors. Eight pattern variants (trust on) plus solid (trust off). Total visual matrix: 8 × 3 = 24 trust-on combinations + 3 trust-off solids = **27 unique badges**.

### 15.1 Patterns

| # | Name | Description |
|---|---|---|
| 1 | Checker | 2×2 alternating squares, 64px cells. Existing. |
| 2 | Mini-checker | 8×8 grid, 32px cells. Denser, textile-y. |
| 3 | Stripes | 4 horizontal bands, 64px each. |
| 4 | V-stripes | 4 vertical bands, 64px each. |
| 5 | Quartered | Four equal squares. Heraldic. |
| 6 | Quartered-X | Four triangles meeting at center. Hourglass shape. |
| 7 | Dots | 4×4 grid, radius 20. |
| 8 | Big-dots | 2×2 grid, radius 40. Poster-like. |

Pattern selection is a user choice at agent-creation. Default = Checker. NL trust-toggle preserves the user's pattern pick on the next trust-on cycle.

### 15.2 Tier colors

Same as today's v1.0.2 system:
- Haiku → green (`#B4862A` solid / `#D9B25B` accent)
- Sonnet → amber (`#3DA85A` solid / `#65C081` accent)
- Opus → orange (`#D97757` solid / `#F2A778` accent)

### 15.3 Coach badge

Distinct from any agent badge. Used during the coach interview only; flips to the agent's badge at graduation.
- Glyph: existing user-round (consistent with the "boring on purpose" call)
- Pattern: a dedicated coach pattern (TBD in implementation — proposal: a "spinner" of dots radiating from the glyph, or simply Mini-checker with a muted grey palette to signal "in-progress")
- Tier color: matches the tier the user picked (or Sonnet default)

The handoff visual is the load-bearing signal of "settling-in" — see §9.1 principle 5.

### 15.4 Implementation reuse

All glyph + pattern + tier rendering reuses `plugin/agent-icon-render.ts` and the prebuilt cache in `plugin/agent-badges-prebuilt/`. Adding the 7 new patterns requires updating `palettes.ts` to expose pattern variants and extending the `<pattern>` definition in `buildBadgeSvg`. The unique-id-per-render fix from the mockup phase carries over (each `<pattern>` gets a fresh id at render time).

---

## 16. Storage & lifecycle

No schema changes beyond what v0.10–1.1.5 already supports. The new flow produces:

- **`AgentDef`** — same shape, now with `metadata['x-dc-leaves']` (the array of leaf ids in the mash-up), `metadata['x-dc-personality-preset']`, `metadata['x-dc-personality-sliders']`, `metadata['x-dc-pattern']`, `metadata['x-dc-coach-answers']` (verbatim record for Refine context). Exporting still produces a Claude Managed Agents YAML; the metadata block is `x-dc-`-prefixed and ignored by the API.
- **`Binding`** — unchanged (chatId, agentId, sessionId, inheritClaudeMd, workingDir, createdAt).
- **No template gallery**. Today's `plugin/templates/*.yaml` library is no longer surfaced through the new flow, but remains on disk for backward compat (existing imports still work).

Refine mutates the `AgentDef` in place; same `sessionId` continues; next turn runs under the new prompt.

---

## 17. Open questions for implementation

These are intentionally underspecified — they're decisions that emerge during build, not before.

1. **Coach pattern / glyph.** §15.3 leaves the exact coach badge styling open. Worth a brief design pass during implementation to find a treatment that reads as "temporary" without being childish.
2. **NL intent classifier scope.** The spec lists three classes (model-switch, trust-toggle, Refine). Implementation needs a small classifier that runs every user turn but only fires above a confidence threshold to avoid false positives. Worth picking the threshold by hand-labeled examples during build.
3. **Mash-up "lead lens" detection.** §9.3 says the coach asks about lead only when not obvious. "Obvious" is fuzzy; needs a heuristic during build (e.g., when one leaf's `combines_with` lists the others as juniors, treat it as default lead).
4. **Cap-warning copy.** §8 cap warning at 4+ specialties. Wording is placeholder; copy editor pass during implementation.
5. **Skill-teacher and Collector parameter UX.** Both leaves carry an open parameter ("which skill?", "which item type?"). Coach handles it conversationally, but might benefit from a small autocomplete based on common values surfaced during the interview.
6. **Refine context window.** Loading the full existing system prompt + the user's change request into the coach's context may push token usage. Implementation should consider summarizing the prompt for the coach instead of including it verbatim.
7. **Badge pattern picker UI.** During mash-up build, the user picks a pattern. Where exactly does that live in the wizard — the review screen, a separate step, or after first turn? Defer to implementation prototyping.

---

## 18. Glossary (alphabetized)

- **AgentDef** — the YAML file describing an agent; lives in `agents/<id>.yaml`.
- **Archetype** — Joe-coined v1.0.2 concept (role / utility / project) used today for badge palette selection. **Deprecated by this spec** in favor of the path → leaf model. Existing agents retain their archetype metadata for backward compat but new agents don't write it.
- **Binding** — chat ↔ agent link record.
- **Coach** — the temporary creation persona.
- **Leaf** — an atomic agent kind in the ontology.
- **Mash-up** — an agent with 2+ leaves and one unified system prompt.
- **Path** — Expert / Service / Goal — the top of the ontology.
- **Pattern** — the badge background variant (Checker / Mini-checker / Stripes / V-stripes / Quartered / Quartered-X / Dots / Big-dots).
- **Personality preset** — one of Coach / Drill Sergeant / Mentor / Pal / Professor.
- **Refine** — coach-led pass over an existing agent.
- **Specialty** — an L2 grouping; 26 of them.
- **Tier** — model family (Haiku / Sonnet / Opus); maps to badge color.
- **Trust** — skip-permissions mode flag.
