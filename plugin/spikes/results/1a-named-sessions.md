# Spike 1a-named-sessions: Persistent-subagent round-trip latency

**Verdict:** ✅ PASS — persistent subagent design is viable

## Evidence

| Measurement | Value |
|---|---|
| 1. persistent mode: both prompts answered | PASS |
|    → msg1 wall | 2369 ms (api 1277) |
|    → msg1 result | ok |
|    → msg2 wall | 1316 ms (api 1313) |
|    → msg2 result | cobalt |
| 2. 2nd msg round-trip < 2000 ms | PASS |
| 3. parallelism across two processes | PASS |
|    → parallel wall | 3126 ms |
|    → slower individual | 3126 ms |
|    → msg1 result | 1 2 3 4 5 |
|    → msg2 result | 6 7 8 9 10 |
| 4. idle RSS ≤ 500 MB | 316 MB |
| in-process continuity (bonus) | PASS (cobalt recalled) |

## Notes

This spike validates the LRU persistent-subagent design. A passing run means the dispatcher can keep up to DC_SUBAGENT_MAX_ACTIVE (default 4) processes alive, each with one chat's context resident, and get sub-2s per-message turnaround after the first.
