import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { DCClient, type MessageEditEvent } from '../dc-client.js'

// Shorten debounce drastically for tests — production value is 5000ms.
const TEST_DEBOUNCE_MS = 30
const originalDebounce = (DCClient as any).EDIT_DEBOUNCE_MS
;(DCClient as any).EDIT_DEBOUNCE_MS = TEST_DEBOUNCE_MS

afterAll(() => {
  (DCClient as any).EDIT_DEBOUNCE_MS = originalDebounce
})

const CONTACT_SELF = 1

/**
 * Build a minimally-wired DCClient with fake contextEvents + rpc so the
 * onMessageEdit filter pipeline can be exercised without a real DC server.
 *
 * Returns the client + the captured MsgsChanged callback (so tests can fire
 * synthetic events) + the message snapshot store (so tests can stage what
 * getMessage returns).
 */
function makeHarness() {
  const client = new DCClient()

  // Snapshot store: keyed by msgId. The fake getMessage returns whatever's
  // staged here. Default snapshot is a non-edited message; tests override.
  const snaps = new Map<number, any>()

  const fakeRpc = {
    getMessage: async (_accountId: number, msgId: number) => {
      const s = snaps.get(msgId)
      if (!s) throw new Error(`no snapshot staged for msgId=${msgId}`)
      return s
    },
  }

  let msgsChangedCb: ((event: { chatId: number; msgId: number }) => void) | null = null
  const fakeContextEvents = {
    on: (eventName: string, cb: any) => {
      if (eventName === 'MsgsChanged') {
        msgsChangedCb = cb
      }
    },
  }

  ;(client as any).rpc = fakeRpc
  ;(client as any).accountId = 1
  ;(client as any).contextEvents = fakeContextEvents

  return {
    client,
    snaps,
    fire: (event: { chatId: number; msgId: number }) => {
      if (!msgsChangedCb) throw new Error('onMessageEdit not yet registered')
      msgsChangedCb(event)
    },
    /** Manually set lastUserMsgId without going through onIncomingMessage. */
    setLastUserMsg: (chatId: number, msgId: number) => {
      ;(client as any).lastUserMsgId.set(chatId, msgId)
    },
    /** Manually cancel any pending edit timer (simulate IncomingMsg cancel). */
    simulateIncomingMsgCancel: (chatId: number, newMsgId: number) => {
      const map = (client as any).lastUserMsgId as Map<number, number>
      map.set(chatId, newMsgId)
      const timers = (client as any).pendingEditTimers as Map<number, NodeJS.Timeout>
      const t = timers.get(chatId)
      if (t) {
        clearTimeout(t)
        timers.delete(chatId)
      }
    },
  }
}

function wait(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

function snap(over: Partial<any> = {}): any {
  return {
    id: 7754,
    chatId: 14,
    fromId: 42,
    text: 'edited!',
    isEdited: true,
    receivedTimestamp: Math.floor(Date.now() / 1000),
    file: null,
    fileMime: null,
    fileBytes: 0,
    fileName: null,
    viewType: 'Text',
    sender: { displayName: 'tester' },
    downloadState: 'Done',
    systemMessageType: null,
    ...over,
  }
}

describe('DCClient.onMessageEdit filter pipeline', () => {
  let h: ReturnType<typeof makeHarness>
  let fires: MessageEditEvent[]

  beforeEach(() => {
    h = makeHarness()
    fires = []
    h.client.onMessageEdit((e) => { fires.push(e) })
  })

  test('chatId=0 → no fire, no RPC', async () => {
    h.setLastUserMsg(14, 7754)
    h.fire({ chatId: 0, msgId: 7754 })
    await wait(TEST_DEBOUNCE_MS * 3)
    expect(fires).toEqual([])
  })

  test('msgId=0 → no fire, no RPC', async () => {
    h.setLastUserMsg(14, 7754)
    h.fire({ chatId: 14, msgId: 0 })
    await wait(TEST_DEBOUNCE_MS * 3)
    expect(fires).toEqual([])
  })

  test('msgId NOT lastUserMsgId → no fire, no RPC (cheap pre-filter)', async () => {
    h.setLastUserMsg(14, 7754)
    h.fire({ chatId: 14, msgId: 9999 })
    await wait(TEST_DEBOUNCE_MS * 3)
    expect(fires).toEqual([])
    // If the RPC had been called, the harness's snaps map would throw.
    // The absence of an error here implies pre-filter skipped before RPC.
  })

  test('isEdited=false → no fire (after RPC, before handler)', async () => {
    h.setLastUserMsg(14, 7754)
    h.snaps.set(7754, snap({ isEdited: false }))
    h.fire({ chatId: 14, msgId: 7754 })
    await wait(TEST_DEBOUNCE_MS * 3)
    expect(fires).toEqual([])
  })

  test('self-authored (CONTACT_SELF) → no fire', async () => {
    h.setLastUserMsg(14, 7754)
    h.snaps.set(7754, snap({ fromId: CONTACT_SELF, isEdited: true }))
    h.fire({ chatId: 14, msgId: 7754 })
    await wait(TEST_DEBOUNCE_MS * 3)
    expect(fires).toEqual([])
  })

  test('legitimate edit → fires after debounce with correct shape', async () => {
    h.setLastUserMsg(14, 7754)
    h.snaps.set(7754, snap({ text: 'the edited text' }))
    h.fire({ chatId: 14, msgId: 7754 })
    await wait(TEST_DEBOUNCE_MS * 3)
    expect(fires.length).toBe(1)
    expect(fires[0]).toMatchObject({
      chatId: 14,
      msgId: 7754,
      fromId: 42,
      text: 'the edited text',
    })
  })

  test('three rapid fires within debounce → handler called ONCE (coalescing)', async () => {
    h.setLastUserMsg(14, 7754)
    h.snaps.set(7754, snap({ text: 'final' }))
    h.fire({ chatId: 14, msgId: 7754 })
    await wait(TEST_DEBOUNCE_MS / 3)
    h.fire({ chatId: 14, msgId: 7754 })
    await wait(TEST_DEBOUNCE_MS / 3)
    h.fire({ chatId: 14, msgId: 7754 })
    await wait(TEST_DEBOUNCE_MS * 3)
    expect(fires.length).toBe(1)
  })

  test('same text fired twice → handler called once (dedupe)', async () => {
    h.setLastUserMsg(14, 7754)
    h.snaps.set(7754, snap({ text: 'same text both times' }))
    h.fire({ chatId: 14, msgId: 7754 })
    await wait(TEST_DEBOUNCE_MS * 3)
    expect(fires.length).toBe(1)
    h.fire({ chatId: 14, msgId: 7754 })
    await wait(TEST_DEBOUNCE_MS * 3)
    expect(fires.length).toBe(1)  // unchanged — same text, dedupe wins
  })

  test('IncomingMsg supersedes pending edit timer (Elena #1 break-severity fix)', async () => {
    h.setLastUserMsg(14, 7754)
    h.snaps.set(7754, snap())
    h.fire({ chatId: 14, msgId: 7754 })
    // Halfway through debounce, a new IncomingMsg arrives — cancels timer
    await wait(TEST_DEBOUNCE_MS / 2)
    h.simulateIncomingMsgCancel(14, 8000)
    await wait(TEST_DEBOUNCE_MS * 3)
    expect(fires).toEqual([])  // edit never fired — newer msg won
  })

  test('different text on second edit → handler fires again', async () => {
    h.setLastUserMsg(14, 7754)
    h.snaps.set(7754, snap({ text: 'first edit' }))
    h.fire({ chatId: 14, msgId: 7754 })
    await wait(TEST_DEBOUNCE_MS * 3)
    expect(fires.length).toBe(1)
    expect(fires[0].text).toBe('first edit')

    h.snaps.set(7754, snap({ text: 'second edit (different)' }))
    h.fire({ chatId: 14, msgId: 7754 })
    await wait(TEST_DEBOUNCE_MS * 3)
    expect(fires.length).toBe(2)
    expect(fires[1].text).toBe('second edit (different)')
  })
})
