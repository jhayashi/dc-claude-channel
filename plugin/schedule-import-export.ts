/**
 * Schedule import/export helpers (#67).
 *
 * Round-trip serialization for `ScheduledJob` records to a portable
 * `.schedules.yaml` format. Mirrors the pattern used by the agent-YAML
 * (`plugin/agents.ts:importAgentFromYaml`) and `.familiar.yaml` flows.
 *
 * Export omits state fields (`createdAt`, `lastFiredAt`, `targetMs`,
 * `jobId`) — they're recomputed at import time. The `chatId` field is
 * also stripped because each import binds the schedule to the
 * receiving chat regardless of where the export came from.
 *
 * Import generates fresh `jobId`s — there's no dedup against existing
 * schedules, so importing the same file twice creates duplicates.
 * That's intentional: dedup against (cron, prompt) is fragile (typo
 * fixes legitimately produce a "different" schedule), and the user
 * has dc_schedule_list + dc_schedule_delete to prune duplicates.
 */

import YAML from 'yaml'
import { z } from 'zod'
import { CronExpressionParser } from 'cron-parser'
import type { ScheduledJob } from './dispatcher/schedule-store.js'

/** What goes on disk per schedule entry in the YAML — strict subset of ScheduledJob. */
const ScheduleEntrySchema = z.object({
  cron:       z.string().min(1).max(120),
  prompt:     z.string().min(1).max(4000),
  recurring:  z.boolean(),
  expires_at: z.string().nullable().optional(),
})

/** Top-level YAML envelope. */
const SchedulesYamlSchema = z.object({
  version:        z.literal(1).optional(),
  exported_at:    z.string().optional(),
  source_chat_id: z.number().optional(),
  schedules:      z.array(ScheduleEntrySchema),
})

export type ScheduleEntry = z.infer<typeof ScheduleEntrySchema>
export type SchedulesYaml = z.infer<typeof SchedulesYamlSchema>

/**
 * Render a list of ScheduledJob to a `.schedules.yaml` string. Filters
 * to recurring jobs by default — one-shots have a date-specific
 * `targetMs` whose meaning rarely transports between machines, and
 * including them silently leads to confusing imports of expired
 * one-shots. Caller can opt back in by setting includeOneShots.
 */
export function serializeSchedules(
  jobs: ScheduledJob[],
  opts: { sourceChatId?: number; includeOneShots?: boolean } = {},
): { yaml: string; included: number; skippedOneShots: number } {
  const includeOneShots = opts.includeOneShots === true
  const filtered = jobs.filter(j => includeOneShots || j.recurring)
  const skippedOneShots = jobs.length - filtered.length

  const doc: SchedulesYaml = {
    version: 1,
    exported_at: new Date().toISOString(),
    schedules: filtered.map(j => ({
      cron: j.cron,
      prompt: j.prompt,
      recurring: j.recurring,
      expires_at: j.expiresAt,
    })),
  }
  if (opts.sourceChatId !== undefined) doc.source_chat_id = opts.sourceChatId

  return {
    yaml: YAML.stringify(doc),
    included: filtered.length,
    skippedOneShots,
  }
}

/**
 * Parse a `.schedules.yaml` document into ScheduledJob records bound
 * to `targetChatId`. Throws on schema or cron-parse errors with a
 * short message suitable for echoing back to the user. Each entry
 * gets a fresh randomly-generated jobId, current `createdAt`, null
 * `lastFiredAt`, and a recomputed `targetMs` (one-shots only).
 *
 * One-shots whose cron expression has no future match (e.g. an
 * already-past date-specific cron) are dropped — caller gets the
 * `skippedExpired` count to surface in the import-confirmation message.
 */
export function parseSchedulesYaml(
  yamlStr: string,
  targetChatId: number,
): { jobs: ScheduledJob[]; skippedExpired: number; sourceChatId: number | null } {
  const raw = YAML.parse(yamlStr) as unknown
  const parsed = SchedulesYamlSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`schedule import: invalid YAML: ${parsed.error.issues[0]?.message ?? 'schema error'}`)
  }

  const now = Date.now()
  const jobs: ScheduledJob[] = []
  let skippedExpired = 0
  for (const entry of parsed.data.schedules) {
    // Validate cron — throw early so the user gets a clear error.
    try {
      CronExpressionParser.parse(entry.cron)
    } catch (err) {
      throw new Error(`schedule import: invalid cron "${entry.cron}": ${err instanceof Error ? err.message : err}`)
    }
    let targetMs: number | null = null
    if (!entry.recurring) {
      try {
        const next = CronExpressionParser.parse(entry.cron, { currentDate: new Date(now) }).next().toDate().getTime()
        if (next <= now) {
          skippedExpired++
          continue
        }
        targetMs = next
      } catch {
        skippedExpired++
        continue
      }
    }
    jobs.push({
      jobId: Math.random().toString(36).slice(2, 8),
      chatId: targetChatId,
      cron: entry.cron,
      prompt: entry.prompt,
      recurring: entry.recurring,
      createdAt: new Date().toISOString(),
      expiresAt: entry.expires_at ?? null,
      lastFiredAt: null,
      targetMs,
    })
  }

  return {
    jobs,
    skippedExpired,
    sourceChatId: parsed.data.source_chat_id ?? null,
  }
}
