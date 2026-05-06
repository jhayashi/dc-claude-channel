import { describe, test, expect, beforeEach } from 'bun:test'
import { createMessageRouter, type RouterHandlers } from '../dispatcher/message-router.js'
import type { MessageEditEvent, Message } from '../dc-client.js'

function makeEdit(overrides: Partial<MessageEditEvent> = {}): MessageEditEvent {
  return {
    chatId: 100,
    msgId: 7754,
    fromId: 42,
    text: 'edited text',
    timestamp: new Date(),
    ...overrides,
  }
}

interface FakeHandlers extends RouterHandlers {
  // counters for assertions
  __editCalls: MessageEditEvent[]
  __dispatchCalls: Message[]
}

function makeHandlers(overrides: Partial<RouterHandlers> = {}): FakeHandlers {
  const editCalls: MessageEditEvent[] = []
  const dispatchCalls: Message[] = []
  const base: RouterHandlers = {
    isPaired: () => true,
    isAuthorized: () => true,
    isEditorAuthorized: () => true,
    handleEdit: async (e) => { editCalls.push(e) },
    dispatchToSubagent: async (m) => { dispatchCalls.push(m) },
    handleSystemMessage: async () => {},
    handleChatModified: async () => {},
    handleUnpaired: async () => {},
    logf: () => {},
    ...overrides,
  }
  return Object.assign(base, { __editCalls: editCalls, __dispatchCalls: dispatchCalls }) as FakeHandlers
}

describe('message-router onMessageEdit', () => {
  let handlers: FakeHandlers

  beforeEach(() => {
    handlers = makeHandlers()
  })

  test('edit on paired chat with authorized editor → handleEdit fires', async () => {
    const router = createMessageRouter(handlers)
    const event = makeEdit()
    await router.onMessageEdit(event)
    expect(handlers.__editCalls).toEqual([event])
  })

  test('edit on unpaired chat → handleEdit does NOT fire', async () => {
    handlers = makeHandlers({ isPaired: () => false })
    const router = createMessageRouter(handlers)
    await router.onMessageEdit(makeEdit())
    expect(handlers.__editCalls).toEqual([])
  })

  test('edit by unauthorized editor (e.g. demoted to no-permissions) → handleEdit does NOT fire', async () => {
    handlers = makeHandlers({ isEditorAuthorized: () => false })
    const router = createMessageRouter(handlers)
    await router.onMessageEdit(makeEdit())
    expect(handlers.__editCalls).toEqual([])
  })

  test('edit re-checks editor capability against fromId, not chatId pairing contact', async () => {
    let receivedFromId = -1
    handlers = makeHandlers({
      isEditorAuthorized: (chatId, fromId) => {
        receivedFromId = fromId
        return fromId === 99  // only contact 99 is authorized
      },
    })
    const router = createMessageRouter(handlers)
    await router.onMessageEdit(makeEdit({ fromId: 99 }))
    expect(receivedFromId).toBe(99)
    expect(handlers.__editCalls.length).toBe(1)
    // Different editor → drop
    await router.onMessageEdit(makeEdit({ fromId: 50 }))
    expect(handlers.__editCalls.length).toBe(1)  // unchanged
  })

  test('handleEdit error propagates as a rejection (caller handles)', async () => {
    handlers = makeHandlers({
      handleEdit: async () => { throw new Error('boom') },
    })
    const router = createMessageRouter(handlers)
    await expect(router.onMessageEdit(makeEdit())).rejects.toThrow('boom')
  })
})
