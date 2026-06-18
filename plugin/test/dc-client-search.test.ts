import { describe, test, expect } from 'bun:test'
import { DCClient } from '../dc-client'

function withFakeRpc(client: DCClient, rpc: Record<string, unknown>, accountId = 7): void {
  ;(client as unknown as { rpc: unknown }).rpc = rpc
  ;(client as unknown as { accountId: number }).accountId = accountId
}

// A raw dc-core message snapshot — the shape rpc.getMessage actually returns.
function rawSnap(id: number) {
  return {
    id, chatId: 10, fromId: 5,
    sender: { displayName: 'Alice' },
    text: `body ${id}`,
    receivedTimestamp: 1000, // unix SECONDS
    file: null, fileMime: null, fileBytes: null, fileName: null,
    viewType: 'Text', systemMessageType: 'Unknown',
  }
}

describe('DCClient search wrappers', () => {
  test('searchMessageIds forwards (accountId, query, chatId)', async () => {
    const client = new DCClient()
    const calls: unknown[] = []
    withFakeRpc(client, { searchMessages: async (...a: unknown[]) => { calls.push(a); return [11, 12] } })
    const ids = await client.searchMessageIds('hello', 42)
    expect(ids).toEqual([11, 12])
    expect(calls[0]).toEqual([7, 'hello', 42])
  })

  test('searchMessageIds passes null chatId for a global search', async () => {
    const client = new DCClient()
    const calls: unknown[] = []
    withFakeRpc(client, { searchMessages: async (...a: unknown[]) => { calls.push(a); return [] } })
    await client.searchMessageIds('hi', null)
    expect(calls[0]).toEqual([7, 'hi', null])
  })

  test('getHistoryMessages adapts the raw snapshot to the dc-client Message shape', async () => {
    const client = new DCClient()
    withFakeRpc(client, { getMessages: async (_acc: number, ids: number[]) => Object.fromEntries(ids.map(id => [id, rawSnap(id)])) })
    const [m] = await client.getHistoryMessages([1])
    expect(m.id).toBe(1)
    expect(m.senderName).toBe('Alice')          // from sender.displayName
    expect(m.timestamp instanceof Date).toBe(true) // from receivedTimestamp * 1000
    expect(m.timestamp.getTime()).toBe(1_000_000)
    expect(m.fromId).toBe(5)
    expect(typeof m.timestamp.toISOString()).toBe('string') // formatHistoryLine relies on this
  })

  test('getHistoryMessages fetches in ONE batch call, not N singular gets', async () => {
    const client = new DCClient()
    const calls: unknown[] = []
    withFakeRpc(client, { getMessages: async (...a: unknown[]) => { calls.push(a); const ids = a[1] as number[]; return Object.fromEntries(ids.map(id => [id, rawSnap(id)])) } })
    const out = await client.getHistoryMessages([1, 2, 3])
    expect(out.map(m => m.id)).toEqual([1, 2, 3])
    expect(calls.length).toBe(1)              // single round-trip
    expect(calls[0]).toEqual([7, [1, 2, 3]])  // (accountId, ids)
  })

  test('getHistoryMessages falls back to sortTimestamp when receivedTimestamp is 0 (sent/self messages)', async () => {
    const client = new DCClient()
    // Outgoing/self messages have receivedTimestamp 0; the real send time lives in sortTimestamp.
    const sent = { ...rawSnap(1), receivedTimestamp: 0, sortTimestamp: 1500, timestamp: 1500 }
    withFakeRpc(client, { getMessages: async () => ({ 1: sent }) })
    const [m] = await client.getHistoryMessages([1])
    expect(m.timestamp.getTime()).toBe(1_500_000) // sortTimestamp*1000, NOT epoch 0
  })

  test('getHistoryMessages skips ids that fail to hydrate (error variant in the batch map)', async () => {
    const client = new DCClient()
    // dc-core returns a per-id map; a failed load is an error variant with no `id` field.
    withFakeRpc(client, {
      getMessages: async (_acc: number, ids: number[]) =>
        Object.fromEntries(ids.map(id => [id, id === 2 ? { kind: 'error', error: 'gone' } : rawSnap(id)])),
    })
    const out = await client.getHistoryMessages([1, 2, 3])
    expect(out.map(m => m.id)).toEqual([1, 3])
  })

  test('getHistoryMessages returns [] for no ids without calling rpc', async () => {
    const client = new DCClient()
    let called = false
    withFakeRpc(client, { getMessages: async () => { called = true; return {} } })
    expect(await client.getHistoryMessages([])).toEqual([])
    expect(called).toBe(false)
  })
})
