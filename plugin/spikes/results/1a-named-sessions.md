# Spike 1a-named-sessions: Named sessions for headless `claude -p`

**Verdict:** ❌ FAIL — continuity FAILED — fallback: explicit dc_chat_history injection in prompt; parallelism OK; cold-start within budget; warm-start within budget

## Evidence

| Measurement | Value |
|---|---|
| 1. continuity (second call sees first) | FAIL |
|    → second.stdout |  |
| 2. parallel two-chat wall time | 290 ms (budget < 5000) |
|    → call A spawn→exit | 290 ms |
|    → call B spawn→exit | 288 ms |
| 3. cold-start spawn→first byte | 266 ms (budget < 1500) |
| 4. warm-start spawn→first byte | 268 ms (budget < 500) |

## Notes

If continuity fails, fallback is documented in plan §"Fallback if 1A.1 fails". If cold-start fails, Phase 2.5 (warm pool) becomes mandatory.
