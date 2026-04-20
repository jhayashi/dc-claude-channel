# Scheduled Jobs

## Feature: Scheduled jobs

### Intended behavior

Agents can schedule recurring or one-shot prompts to fire into a chat as synthetic user turns at specified times. Jobs persist across dispatcher restarts and are independent of subagent lifetime. Scheduled jobs execute under the same agent binding as the chat, subject to chat-access controls and allowed-tool restrictions (per-agent `allowedBuiltinTools` and `allowedMcpServers` are honored when the job fires).

Each job has an optional expiration timestamp (`expiresAt`, ISO 8601); recurring jobs are dropped when expired. One-shot jobs that fire in the past are skipped on startup (no catch-up policy). The job-creation endpoint (`dc_schedule`) warns if a cron expression would fire >30 times in the next 7 days.

### State machine / transitions

- **Creation** — User calls `dc_schedule` with cron, prompt, recurring flag, optional `expiresAt`. Cron is validated via cron-parser. For one-shot jobs, the next fire time (`targetMs`) is pre-computed at creation. Job is written to disk via `ScheduleStore.save()` and added to the in-process scheduler.
- **Arming** — Scheduler calculates the nearest future fire time across all jobs, arms a single `setTimeout` for that moment (capped at 2^31-1 ms ≈ 24.8 days; overflow re-arms on wake).
- **Fire** — At `armedFor` time, scheduler loads all jobs from disk, filters by expiration and fire eligibility. Due jobs dispatch via `dispatch(chatId, text)`, which sends a synthetic user turn through `subagentCache.dispatch`. Recurring jobs update `lastFiredAt`; one-shots are deleted.
- **Deletion** — User calls `dc_schedule_delete(chatId, jobId)`. Scheduler re-arms immediately.
- **Cleanup** — On graceful shutdown, `stop()` clears the timer. Expired jobs and past-due one-shots are reaped on next startup via `reapStaleOnStartup()`.

### Persisted state

**Location:** `~/.claude/channels/deltachat/schedules/<chatId>-<jobId>.json` (per-job atomic files).

**Format:** `ScheduledJob` object:
```json
{
  "jobId": "string (6-char random slug)",
  "chatId": 12345,
  "cron": "5-field cron expression",
  "prompt": "string (≤4000 chars)",
  "recurring": true,
  "createdAt": "ISO 8601",
  "expiresAt": "ISO 8601 | null",
  "lastFiredAt": "ISO 8601 | null",
  "targetMs": 1234567890
}
```

**Atomic writes:** `ScheduleStore.save()` writes to a temp file with PID+UUID suffix, then renames into place to avoid concurrent-write collisions.

**Chat migration:** `moveForChat(fromChatId, toChatId)` renames all job files and rewrites the `chatId` field inside each, with collision detection to prevent silent jobId loss.

### Observable surface

**Tools exposed:**
- `dc_schedule(chat_id, cron, prompt, recurring?, expires_at?)` — Create a job. Returns `{job_id, next_fire_at, warning?}`. Warning issued if >30 fires in 7 days.
- `dc_schedule_list(chat_id)` — List all jobs for a chat. Returns array of `{job_id, cron, prompt, recurring, next_fire_at, expires_at, created_at, last_fired_at}`.
- `dc_schedule_delete(chat_id, job_id)` — Delete a job. Returns `{deleted: true|false}`.

**Auth:** All three tools require `chat_id` parameter. Caller (subagent) must be bound to that chat or an error is returned. Enforced via `callerChatId` (per-socket binding) and `access.isAllowed()` check.

**Dispatch format:** Scheduled prompts are injected as user messages with a synthetic header: `[dc chat_id=<id> event=scheduled job=<jobId>]\n<prompt>`.

**Limits & constraints:**
- Prompt max 4000 chars.
- Cron validation via cron-parser; invalid expressions rejected at creation time.
- `countFiresIn7Days()` caps at 10,000 iterations (pathological defense).
- Missed fires (system downtime) are skipped, not retried.

### Primary source files

- `plugin/dispatcher/scheduler.ts` — In-process cron engine, Scheduler class, fire loop, rearm logic.
- `plugin/dispatcher/schedule-store.ts` — ScheduleStore class, per-job JSON files, `moveForChat`, atomic writes.
- `plugin/server.ts` — Tool registration and dispatch (tool schemas and handler wiring).

### Audit notes

Jobs do not themselves generate audit entries. However, the dispatched prompt text is treated as a regular user message and subject to skip-permissions auto-approve logic if the agent has `x-dc-skipPermissions` set. Each tool call made during that turn will be audited normally. The `[dc chat_id=... event=scheduled job=...]` header is visible in the prompt for later reconstruction of intent.
