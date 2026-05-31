import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export type LifecycleEvent =
  | { kind: 'graduation'; chatId: number; agentId: string; sessionId: string; leafIds: string[]; fromCoach: true }
  | { kind: 'refine-complete'; chatId: number; agentId: string; sessionId: string }
  | { kind: 'graduation-failed'; chatId: number; sessionId: string; leafIds: string[]; reason: string }
  /**
   * v1.4.9 — emitted once per agent that had records seeded from
   * claude-code's canonical sidecar at startup. recordCount is the
   * number of <agentId>.dc/contacts/<cid>.json files newly written.
   * Absence on a given startup = no seeding needed (post-migration
   * steady state) or no bindings for that agent.
   */
  | { kind: 'contacts-seeded'; agentId: string; recordCount: number }
  /**
   * v1.4.9 — emitted once per binding whose agentId references a
   * .md file that no longer exists (D6 orphaned binding). The binding
   * is skipped — its chat's members are not seeded into any sidecar.
   * Surfaced so an operator can clean up orphaned bindings or
   * re-create the missing agent definition.
   */
  | { kind: 'contacts-seeded-skipped'; chatId: number; agentId: string; reason: 'orphaned_binding' }

let DIR = process.env.DC_EVENT_DIR
  ? join(process.env.DC_EVENT_DIR)
  : join(process.env.DC_STATE_DIR ?? join(homedir(), '.claude/channels/deltachat'), 'events')

export function setLifecycleEventDir(dir: string) { DIR = dir }

export function logLifecycleEvent(ev: LifecycleEvent) {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })
    const date = new Date().toISOString().slice(0, 10)
    const path = join(DIR, `agent-lifecycle-${date}.log`)
    const line = JSON.stringify({ ts: new Date().toISOString(), ...ev }) + '\n'
    appendFileSync(path, line)
  } catch {
    // Observability is best-effort; never affect main flow.
  }
}
