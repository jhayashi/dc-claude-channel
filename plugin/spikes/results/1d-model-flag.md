# Spike 1d-model-flag: `claude -p --model` accepts haiku/sonnet/opus

**Verdict:** ✅ PASS — all three model aliases accepted in headless mode

## Evidence

| Measurement | Value |
|---|---|
| --model haiku exit | 0 |
|    → stdout | ok |
|    → stderr |  |
| --model sonnet exit | 0 |
|    → stdout | ok |
|    → stderr |  |
| --model opus exit | 0 |
|    → stdout | ok |
|    → stderr |  |

## Notes

If any fail, Phase 4 (per-group model selection) is cut from v0.9.
