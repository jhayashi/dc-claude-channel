# Architecture Decision Records

Each ADR captures a load-bearing decision: what was decided, why, and what alternatives were rejected. The point is to prevent re-litigating the same question across sessions, code reviews, and onboarding.

**When to write one.**

- A future reviewer would ask "why this and not the obvious alternative?" — and the obvious alternative has a real reason it was rejected.
- A refactor was suggested and turned down for a load-bearing reason; you don't want the same suggestion to keep coming back.
- A constraint was discovered (upstream limitation, dc-core behavior, security boundary) that shaped the design and isn't visible from the code alone.

**When NOT to write one.**

- The reason is ephemeral ("not worth it right now," "out of scope for this PR").
- The reason is self-evident from the code.
- The decision is implementation detail rather than architecture.

**Format.** ADRs are short. Status, context, decision, consequences. No long preamble. Numbered sequentially in `NNNN-title.md`. Status moves through `Proposed → Accepted → Superseded` (rarely `Rejected`). Don't edit accepted ADRs in place; supersede them with a new one.

See [ADR-template.md](ADR-template.md) for the skeleton.

## Index

- [ADR-0001](0001-subagent-per-chat-with-lru-cache.md) — Subagent-per-chat with LRU cache (vs single multiplexed session)
- [ADR-0002](0002-agent-definition-and-binding-split.md) — Agent definition / binding split (vs unified record)
- [ADR-0003](0003-principals-as-trust-source.md) — Principals (contact identity) as the trust source (vs chatId-based ownership)
- [ADR-0004](0004-kill-and-respawn-for-interrupt.md) — Kill-and-respawn for interrupt (vs blocked on upstream control frames)
