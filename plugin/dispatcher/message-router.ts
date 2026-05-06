/**
 * Classifies incoming Delta Chat events and routes them. The router
 * does not own any state of its own — it takes callbacks that wire
 * it to the dispatcher (cache) and legacy server.ts paths.
 *
 * This is deliberately small. The goal is to make classification
 * explicit and testable, not to reimplement every event handler.
 */

import type { Message, MessageEditEvent } from '../dc-client.js'

export interface RouterHandlers {
  /** Regular user message → dispatch to subagent cache. */
  dispatchToSubagent: (msg: Message) => Promise<void>
  /** System message (e.g. "MemberRemovedFromGroup") → legacy cleanup. */
  handleSystemMessage: (msg: Message) => Promise<void>
  /** Locally-triggered ChatModified (e.g. self-leave) → legacy cleanup. */
  handleChatModified: (chatId: number) => Promise<void>
  /** Edit-as-interrupt (#45): evict + redispatch with edited text. */
  handleEdit: (event: MessageEditEvent) => Promise<void>
  /** Messages from unknown / unpaired chats → pairing/tutorial flow. */
  handleUnpaired: (msg: Message) => Promise<void>
  /** Messages from paired but unauthorized senders → ignore silently. */
  isAuthorized: (msg: Message) => boolean
  /** True if the editor's contactId is permissioned for this chat (#45). */
  isEditorAuthorized: (chatId: number, fromId: number) => boolean
  /** True if the sender is the owner who can actually command Claude. */
  isPaired: (chatId: number) => boolean
  logf?: (fmt: string, ...args: unknown[]) => void
}

export interface MessageRouter {
  onIncomingMessage: (msg: Message) => Promise<void>
  onChatModified: (chatId: number) => Promise<void>
  onMessageEdit: (event: MessageEditEvent) => Promise<void>
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

      log('router: dispatching chat=%d len=%d file=%s', msg.chatId, (msg.text ?? '').length, msg.file ?? '')
      await handlers.dispatchToSubagent(msg)
    },

    async onChatModified(chatId: number): Promise<void> {
      log('router: chat modified chat=%d', chatId)
      await handlers.handleChatModified(chatId)
    },

    async onMessageEdit(event: MessageEditEvent): Promise<void> {
      // Edit pre-filters live in dc-client (single-message, lastUserMsgId,
      // debounce, dedupe). The router gates only on auth/permission.
      if (!handlers.isPaired(event.chatId)) {
        log('router: edit on unpaired chat=%d msg=%d — drop', event.chatId, event.msgId)
        return
      }
      if (!handlers.isEditorAuthorized(event.chatId, event.fromId)) {
        log('router: edit by unauthorized contact=%d on chat=%d — drop', event.fromId, event.chatId)
        return
      }
      log('router: dispatching edit chat=%d msg=%d from=%d len=%d',
          event.chatId, event.msgId, event.fromId, event.text.length)
      await handlers.handleEdit(event)
    },
  }
}
