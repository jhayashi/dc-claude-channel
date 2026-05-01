/**
 * Reaction event router — surfaces DC reactions to subagents as synthetic
 * turns on the existing dispatch channel.
 *
 * Rules (see docs/...phase4 reactions spec):
 *   1. Drop reactions in chats not on the allowlist.
 *   2. Drop reactions from non-owners in owned chats.
 *   3. Drop reactions if no live subagent is cached for the chat — we do
 *      not wake/cold-spawn a subagent just for a reaction.
 *   4. Otherwise buffer briefly (debounce) to batch bursts, then dispatch
 *      one synthetic user-turn through the subagent cache. SubagentCache
 *      handles single-inflight serialization internally; if the chat is
 *      mid-turn the synthetic message queues behind it.
 *
 * This module is pure wiring — no direct DC client or server.ts imports —
 * so it can be unit-tested with fakes.
 */

import type { ReactionEvent } from '../dc-client.js'

export interface ReactionRouterOptions {
  /** True if the chat is paired / on the access allowlist. */
  isAllowed: (chatId: number) => boolean
  /** Returns the responsible contact id for a chat, or null if unowned. */
  firstPermissionedContact: (chatId: number) => number | null
  /** True if a live subagent is cached for the chat. */
  hasLiveSubagent: (chatId: number) => boolean
  /** Dispatch a synthetic user turn through the subagent cache. */
  dispatchSynthetic: (chatId: number, text: string) => Promise<void>
  /** Debounce window in ms. Multiple reactions inside this window are batched. */
  debounceMs?: number
  /** Max buffered reactions per chat before dropping oldest. */
  maxBufferPerChat?: number
  logf?: (fmt: string, ...args: unknown[]) => void
  /** Injectable timer for tests. */
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
}

interface ChatBuffer {
  events: ReactionEvent[]
  timer: unknown | null
}

export class ReactionRouter {
  private buffers = new Map<number, ChatBuffer>()
  private logf: (fmt: string, ...args: unknown[]) => void
  private debounceMs: number
  private maxBufferPerChat: number
  private setTimer: (cb: () => void, ms: number) => unknown
  private clearTimer: (h: unknown) => void

  constructor(private opts: ReactionRouterOptions) {
    this.logf = opts.logf ?? (() => {})
    this.debounceMs = opts.debounceMs ?? 250
    this.maxBufferPerChat = opts.maxBufferPerChat ?? 16
    this.setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  /** Route a single reaction event. */
  handle(ev: ReactionEvent): void {
    if (!this.opts.isAllowed(ev.chatId)) {
      this.logf('reaction: drop chat=%d not paired', ev.chatId)
      return
    }
    const owner = this.opts.firstPermissionedContact(ev.chatId)
    if (owner !== null && ev.fromId !== owner) {
      this.logf('reaction: drop chat=%d non-owner fromId=%d owner=%d', ev.chatId, ev.fromId, owner)
      return
    }
    if (!this.opts.hasLiveSubagent(ev.chatId)) {
      this.logf('reaction: drop chat=%d no live subagent', ev.chatId)
      return
    }

    let buf = this.buffers.get(ev.chatId)
    if (!buf) {
      buf = { events: [], timer: null }
      this.buffers.set(ev.chatId, buf)
    }
    buf.events.push(ev)
    if (buf.events.length > this.maxBufferPerChat) {
      const dropped = buf.events.shift()!
      this.logf('reaction: buffer overflow chat=%d, dropped oldest %s from %s', ev.chatId, dropped.reaction || '(cleared)', dropped.senderName)
    }
    if (buf.timer) this.clearTimer(buf.timer)
    buf.timer = this.setTimer(() => { this.flush(ev.chatId).catch(() => {}) }, this.debounceMs)
  }

  /** Flush the buffered reactions for a chat as a single synthetic turn. */
  private async flush(chatId: number): Promise<void> {
    const buf = this.buffers.get(chatId)
    if (!buf || buf.events.length === 0) return
    const events = buf.events.slice()
    buf.events = []
    buf.timer = null
    const text = formatReactionBatch(chatId, events)
    try {
      await this.opts.dispatchSynthetic(chatId, text)
    } catch (err) {
      this.logf('reaction: dispatch failed chat=%d: %v', chatId, err)
    }
  }
}

/** Format one or more reaction events as a synthetic user-turn text. */
export function formatReactionBatch(chatId: number, events: ReactionEvent[]): string {
  const header = `[dc chat_id=${chatId} event=reaction]`
  if (events.length === 1) {
    const e = events[0]
    if (e.reaction) {
      return `${header}\n${e.senderName} reacted ${e.reaction} to your message id=${e.msgId}`
    }
    return `${header}\n${e.senderName} cleared their reaction on message id=${e.msgId}`
  }
  const lines = [`${header}`, `${events.length} reactions while you were working:`]
  for (const e of events) {
    if (e.reaction) {
      lines.push(`- ${e.senderName} reacted ${e.reaction} to msg ${e.msgId}`)
    } else {
      lines.push(`- ${e.senderName} cleared their reaction on msg ${e.msgId}`)
    }
  }
  return lines.join('\n')
}
