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
    withFakeRpc(client, { getMessage: async (_acc: number, id: number) => rawSnap(id) })
    const [m] = await client.getHistoryMessages([1])
    expect(m.id).toBe(1)
    expect(m.senderName).toBe('Alice')          // from sender.displayName
    expect(m.timestamp instanceof Date).toBe(true) // from receivedTimestamp * 1000
    expect(m.timestamp.getTime()).toBe(1_000_000)
    expect(m.fromId).toBe(5)
    expect(typeof m.timestamp.toISOString()).toBe('string') // formatHistoryLine relies on this
  })

  test('getHistoryMessages skips ids that fail to hydrate', async () => {
    const client = new DCClient()
    withFakeRpc(client, {
      getMessage: async (_acc: number, id: number) => { if (id === 2) throw new Error('gone'); return rawSnap(id) },
    })
    const out = await client.getHistoryMessages([1, 2, 3])
    expect(out.map(m => m.id)).toEqual([1, 3])
  })
})
