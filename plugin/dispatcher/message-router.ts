/**
 * Classifies incoming Delta Chat events and routes them. The router
 * does not own any state of its own — it takes callbacks that wire
 * it to the dispatcher (cache) and legacy server.ts paths.
 *
 * This is deliberately small. The goal is to make classification
 * explicit and testable, not to reimplement every event handler.
 */

import type { Message } from '../dc-client.js'

export interface RouterHandlers {
  /** Regular user message → dispatch to subagent cache. */
  dispatchToSubagent: (chatId: number, text: string) => Promise<void>
  /** System message (e.g. "MemberRemovedFromGroup") → legacy cleanup. */
  handleSystemMessage: (msg: Message) => Promise<void>
  /** Locally-triggered ChatModified (e.g. self-leave) → legacy cleanup. */
  handleChatModified: (chatId: number) => Promise<void>
  /** Messages from unknown / unpaired chats → pairing/tutorial flow. */
  handleUnpaired: (msg: Message) => Promise<void>
  /** Messages from paired but unauthorized senders → ignore silently. */
  isAuthorized: (msg: Message) => boolean
  /** True if the sender is the owner who can actually command Claude. */
  isPaired: (chatId: number) => boolean
  logf?: (fmt: string, ...args: unknown[]) => void
}

export interface MessageRouter {
  onIncomingMessage: (msg: Message) => Promise<void>
  onChatModified: (chatId: number) => Promise<void>
}

export function createMessageRouter(handlers: RouterHandlers): MessageRouter {
  const log = handlers.logf ?? (() => {})

  return {
    async onIncomingMessage(msg: Message): Promise<void> {
      // System message first — never dispatch these to a subagent.
      if (msg.systemMessageType) {
        log('router: system msg chat=%d type=%s', msg.chatId, msg.systemMessageType)
        await handlers.handleSystemMessage(msg)
        return
      }

      // Not yet paired → send through pairing/tutorial.
      if (!handlers.isPaired(msg.chatId)) {
        log('router: unpaired chat=%d', msg.chatId)
        await handlers.handleUnpaired(msg)
        return
      }

      // Paired but sender not the owner → silently ignore.
      if (!handlers.isAuthorized(msg)) {
        log('router: unauthorized sender chat=%d from=%d', msg.chatId, msg.fromId ?? 0)
        return
      }

      // Empty text (attachment-only, etc.) — still route, let subagent decide.
      const text = msg.text || '(attachment)'
      log('router: dispatching chat=%d len=%d', msg.chatId, text.length)
      await handlers.dispatchToSubagent(msg.chatId, text)
    },

    async onChatModified(chatId: number): Promise<void> {
      log('router: chat modified chat=%d', chatId)
      await handlers.handleChatModified(chatId)
    },
  }
}
