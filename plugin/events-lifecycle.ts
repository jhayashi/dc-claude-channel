import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export type LifecycleEvent =
  | { kind: 'graduation'; chatId: number; agentId: string; sessionId: string; leafIds: string[]; fromCoach: true }
  | { kind: 'refine-complete'; chatId: number; agentId: string; sessionId: string }
  | { kind: 'graduation-failed'; chatId: number; sessionId: string; leafIds: string[]; reason: string }

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
