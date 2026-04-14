import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { familiarApp } from '../apps/familiar-app'
import {
  _resetRegistry,
  setFamiliarsDir,
  getInstance,
  getInstanceByMsgId,
  listInstances,
  loadPersistedInstances,
} from '../familiar-runtime'
import type { AppContext } from '../webxdc-app'

const testDir = mkdtempSync(join(tmpdir(), 'dc-familiar-app-test-'))

// ---------------------------------------------------------------------------
// Mock AppContext factory
// ---------------------------------------------------------------------------

let nextMsgId = 1000
const sentWebXDCs: Array<{ chatId: number; path: string }> = []
const sentUpdates: Array<{ msgId: number; update: string }> = []
const registeredMsgs: Array<{ msgId: number; chatId: number }> = []
const unregisteredMsgs: number[] = []

function makeCtx(allowedChatIds: number[] = [42]): AppContext {
  return {
    client: {
      sendWebXDC: async (chatId: number, path: string) => {
        sentWebXDCs.push({ chatId, path })
        return nextMsgId++
      },
      sendWebXDCUpdate: async (msgId: number, update: string) => {
        sentUpdates.push({ msgId, update })
      },
    } as any,
    mcp: {} as any,
    isAllowed: (chatId: number) => allowedChatIds.includes(chatId),
    allowedChats: () => allowedChatIds,
    logf: () => {},
    safeName: (s: string) => s,
    registerWebXDCMsg: (msgId: number, _app: any, chatId: number) => {
      registeredMsgs.push({ msgId, chatId })
    },
    unregisterWebXDCMsg: (msgId: number) => {
      unregisteredMsgs.push(msgId)
    },
    evictSubagent: async () => {},
    getAvailableMcpServers: () => [],
  }
}

beforeEach(() => {
  _resetRegistry()
  setFamiliarsDir(testDir)
  nextMsgId = 1000
  sentWebXDCs.length = 0
  sentUpdates.length = 0
  registeredMsgs.length = 0
  unregisteredMsgs.length = 0
  // Clean files
  if (existsSync(testDir)) {
    for (const f of readdirSync(testDir)) {
      rmSync(join(testDir, f), { force: true })
    }
  }
})
afterAll(() => rmSync(testDir, { recursive: true, force: true }))

// ---------------------------------------------------------------------------
// tools()
// ---------------------------------------------------------------------------

describe('tools()', () => {
  test('returns four tools', () => {
    const tools = familiarApp.tools()
    expect(tools.length).toBe(4)
    const names = tools.map((t) => t.name)
    expect(names).toContain('dc_familiar_create')
    expect(names).toContain('dc_familiar_update')
    expect(names).toContain('dc_familiar_list')
    expect(names).toContain('dc_familiar_delete')
  })
})

// ---------------------------------------------------------------------------
// dc_familiar_create
// ---------------------------------------------------------------------------

describe('dc_familiar_create', () => {
  test('builds app and registers instance', async () => {
    const ctx = makeCtx()
    const result = await familiarApp.callTool('dc_familiar_create', {
      chat_id: '42',
      title: 'Counter',
      html: '<html><script src="webxdc.js"></script><body>hi</body></html>',
      handler: 'ctx.sendUpdate({ count: (ctx.state.count || 0) + 1 });',
    }, ctx)

    expect(result).not.toBeNull()
    expect(result!.isError).toBeUndefined()
    expect(result!.content[0]!.text).toContain('Created familiar "Counter"')
    expect(result!.content[0]!.text).toContain('app_id:')

    // Should have sent a WebXDC
    expect(sentWebXDCs.length).toBe(1)
    expect(sentWebXDCs[0]!.chatId).toBe(42)

    // Should have registered the WebXDC msg
    expect(registeredMsgs.length).toBe(1)
    expect(registeredMsgs[0]!.chatId).toBe(42)

    // Instance should be in registry
    const instances = listInstances(42)
    expect(instances.length).toBe(1)
    expect(instances[0]!.title).toBe('Counter')
    expect(instances[0]!.chatId).toBe(42)
  })

  test('rejects html with sendUpdate missing senderAddr', async () => {
    const ctx = makeCtx()
    const result = await familiarApp.callTool('dc_familiar_create', {
      chat_id: '42',
      title: 'Missing',
      html: '<html><script>window.webxdc.sendUpdate({payload: {x: 1}}, "");</script></html>',
      handler: 'ctx.sendUpdate({});',
    }, ctx)

    expect(result!.isError).toBe(true)
    expect(result!.content[0]!.text).toContain('senderAddr')
  })

  test('rejects invalid handler (syntax error)', async () => {
    const ctx = makeCtx()
    const result = await familiarApp.callTool('dc_familiar_create', {
      chat_id: '42',
      title: 'Bad',
      html: '<html><body>hi</body></html>',
      handler: 'function(( {',
    }, ctx)

    expect(result).not.toBeNull()
    expect(result!.isError).toBe(true)
    expect(result!.content[0]!.text).toContain('handler compile error')
  })

  test('rejects unauthorized chat', async () => {
    const ctx = makeCtx([99])
    const result = await familiarApp.callTool('dc_familiar_create', {
      chat_id: '42',
      title: 'Test',
      html: '<html></html>',
      handler: 'ctx.sendUpdate({});',
    }, ctx)

    expect(result!.isError).toBe(true)
    expect(result!.content[0]!.text).toContain('not on the allowlist')
  })

  test('persists instance when persistent=true', async () => {
    const ctx = makeCtx()
    await familiarApp.callTool('dc_familiar_create', {
      chat_id: '42',
      title: 'Persistent App',
      html: '<html></html>',
      handler: 'ctx.sendUpdate({});',
      persistent: true,
    }, ctx)

    const persisted = loadPersistedInstances()
    expect(persisted.length).toBe(1)
    expect(persisted[0]!.persistent).toBe(true)
  })

  test('sets initial_state on the instance', async () => {
    const ctx = makeCtx()
    await familiarApp.callTool('dc_familiar_create', {
      chat_id: '42',
      title: 'Stateful',
      html: '<html></html>',
      handler: 'ctx.sendUpdate({});',
      initial_state: { count: 10 },
    }, ctx)

    const instances = listInstances(42)
    expect(instances[0]!.state).toEqual({ count: 10 })
  })
})

// ---------------------------------------------------------------------------
// dc_familiar_list
// ---------------------------------------------------------------------------

describe('dc_familiar_list', () => {
  test('returns empty for chat with no apps', async () => {
    const ctx = makeCtx()
    const result = await familiarApp.callTool('dc_familiar_list', {
      chat_id: '42',
    }, ctx)

    expect(result).not.toBeNull()
    expect(result!.content[0]!.text).toContain('No familiar apps')
  })

  test('lists apps after creation', async () => {
    const ctx = makeCtx()
    await familiarApp.callTool('dc_familiar_create', {
      chat_id: '42',
      title: 'App One',
      html: '<html></html>',
      handler: 'ctx.sendUpdate({});',
    }, ctx)
    await familiarApp.callTool('dc_familiar_create', {
      chat_id: '42',
      title: 'App Two',
      html: '<html></html>',
      handler: 'ctx.sendUpdate({});',
    }, ctx)

    const result = await familiarApp.callTool('dc_familiar_list', {
      chat_id: '42',
    }, ctx)

    expect(result!.content[0]!.text).toContain('App One')
    expect(result!.content[0]!.text).toContain('App Two')
  })
})

// ---------------------------------------------------------------------------
// dc_familiar_delete
// ---------------------------------------------------------------------------

describe('dc_familiar_delete', () => {
  test('removes instance from registry and unregisters WebXDC msg', async () => {
    const ctx = makeCtx()
    const createResult = await familiarApp.callTool('dc_familiar_create', {
      chat_id: '42',
      title: 'To Delete',
      html: '<html></html>',
      handler: 'ctx.sendUpdate({});',
    }, ctx)

    // Extract app_id from result text
    const appIdMatch = createResult!.content[0]!.text.match(/app_id: ([\w-]+)/)
    const appId = appIdMatch![1]!

    const deleteResult = await familiarApp.callTool('dc_familiar_delete', {
      chat_id: '42',
      app_id: appId,
    }, ctx)

    expect(deleteResult!.isError).toBeUndefined()
    expect(deleteResult!.content[0]!.text).toContain('Deleted familiar')
    expect(getInstance(appId)).toBeUndefined()
    expect(listInstances(42).length).toBe(0)
    expect(unregisteredMsgs.length).toBe(1)
  })

  test('returns error for nonexistent app', async () => {
    const ctx = makeCtx()
    const result = await familiarApp.callTool('dc_familiar_delete', {
      chat_id: '42',
      app_id: 'nonexistent',
    }, ctx)

    expect(result!.isError).toBe(true)
    expect(result!.content[0]!.text).toContain('not found')
  })

  test('deletes persisted file for persistent app', async () => {
    const ctx = makeCtx()
    await familiarApp.callTool('dc_familiar_create', {
      chat_id: '42',
      title: 'Persistent Delete',
      html: '<html></html>',
      handler: 'ctx.sendUpdate({});',
      persistent: true,
    }, ctx)

    expect(loadPersistedInstances().length).toBe(1)

    const instances = listInstances(42)
    const appId = instances[0]!.appId

    await familiarApp.callTool('dc_familiar_delete', {
      chat_id: '42',
      app_id: appId,
    }, ctx)

    expect(loadPersistedInstances().length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// dc_familiar_update
// ---------------------------------------------------------------------------

describe('dc_familiar_update', () => {
  test('sends update to existing app', async () => {
    const ctx = makeCtx()
    await familiarApp.callTool('dc_familiar_create', {
      chat_id: '42',
      title: 'Updatable',
      html: '<html></html>',
      handler: 'ctx.sendUpdate({});',
    }, ctx)

    const instances = listInstances(42)
    const appId = instances[0]!.appId
    sentUpdates.length = 0

    const result = await familiarApp.callTool('dc_familiar_update', {
      chat_id: '42',
      app_id: appId,
      payload: { action: 'refresh' },
    }, ctx)

    expect(result!.isError).toBeUndefined()
    expect(result!.content[0]!.text).toContain('Update sent')
    expect(sentUpdates.length).toBe(1)
    const parsed = JSON.parse(sentUpdates[0]!.update)
    expect(parsed.payload).toEqual({ action: 'refresh' })
  })

  test('rejects update for nonexistent app', async () => {
    const ctx = makeCtx()
    const result = await familiarApp.callTool('dc_familiar_update', {
      chat_id: '42',
      app_id: 'nope',
      payload: {},
    }, ctx)

    expect(result!.isError).toBe(true)
    expect(result!.content[0]!.text).toContain('not found')
  })
})

// ---------------------------------------------------------------------------
// callTool returns null for unknown tool
// ---------------------------------------------------------------------------

describe('callTool dispatch', () => {
  test('returns null for unknown tool', async () => {
    const ctx = makeCtx()
    const result = await familiarApp.callTool('dc_something_else', {}, ctx)
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// onWebXDCUpdate
// ---------------------------------------------------------------------------

describe('onWebXDCUpdate', () => {
  test('invokes handler on incoming update', async () => {
    const ctx = makeCtx()
    await familiarApp.callTool('dc_familiar_create', {
      chat_id: '42',
      title: 'Echo',
      html: '<html></html>',
      handler: 'ctx.sendUpdate({ echo: update.text });',
    }, ctx)

    const instances = listInstances(42)
    const inst = instances[0]!
    sentUpdates.length = 0

    // Simulate WebXDC update
    await familiarApp.onWebXDCUpdate!(inst.msgId, [
      { serial: 1, maxSerial: 1, payload: { text: 'hello' } } as any,
    ], ctx)

    // Handler should have called sendUpdate
    expect(sentUpdates.length).toBe(1)
    const parsed = JSON.parse(sentUpdates[0]!.update)
    expect(parsed.payload).toEqual({ echo: 'hello' })
  })

  test('persists state after handler for persistent app', async () => {
    const ctx = makeCtx()
    await familiarApp.callTool('dc_familiar_create', {
      chat_id: '42',
      title: 'Stateful',
      html: '<html></html>',
      handler: 'ctx.state.count = (ctx.state.count || 0) + 1; ctx.sendUpdate({ count: ctx.state.count });',
      persistent: true,
    }, ctx)

    const instances = listInstances(42)
    const inst = instances[0]!

    await familiarApp.onWebXDCUpdate!(inst.msgId, [
      { serial: 1, maxSerial: 1, payload: { action: 'increment' } } as any,
    ], ctx)

    // State should be updated in memory
    expect(inst.state.count).toBe(1)

    // State should be persisted to disk
    const persisted = loadPersistedInstances()
    expect(persisted.length).toBe(1)
    expect(persisted[0]!.state.count).toBe(1)
  })
})
