import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createSandbox,
  registerInstance,
  getInstance,
  getInstanceByMsgId,
  listInstances,
  deleteInstance,
  getHandler,
  persistInstance,
  deletePersistedInstance,
  loadPersistedInstances,
  parseFamiliarYaml,
  setFamiliarsDir,
  _resetRegistry,
  type FamiliarInstance,
  type SandboxContext,
} from '../familiar-runtime'

const testDir = mkdtempSync(join(tmpdir(), 'dc-familiar-test-'))

beforeEach(() => {
  _resetRegistry()
  setFamiliarsDir(testDir)
  // Clean files between tests
  if (existsSync(testDir)) {
    for (const f of readdirSync(testDir)) {
      rmSync(join(testDir, f), { force: true })
    }
  }
})
afterAll(() => rmSync(testDir, { recursive: true, force: true }))

// ---------------------------------------------------------------------------
// Sandbox tests
// ---------------------------------------------------------------------------
describe('createSandbox', () => {
  test('handler receives update and can call sendUpdate', async () => {
    const fn = createSandbox(`
      ctx.sendUpdate({ echo: update.text });
    `)
    const sent: unknown[] = []
    const ctx: SandboxContext = {
      state: {},
      sendUpdate: (p: unknown) => { sent.push(p) },
      requestLLM: async () => '',
      appId: 'test-app',
      chatId: 1,
    }
    const result = await fn({ text: 'hello' }, ctx)
    expect(result.error).toBeUndefined()
    expect(sent).toEqual([{ echo: 'hello' }])
  })

  test('handler cannot access fs, process, fetch, Bun', async () => {
    const fn = createSandbox(`
      const results = {
        fs: typeof fs,
        process: typeof process,
        fetch: typeof fetch,
        Bun: typeof Bun,
        require: typeof require,
        child_process: typeof child_process,
        net: typeof net,
        http: typeof http,
        https: typeof https,
        os: typeof os,
        path: typeof path,
        crypto: typeof crypto,
        Buffer: typeof Buffer,
        setTimeout: typeof setTimeout,
        setInterval: typeof setInterval,
        globalThis: typeof globalThis,
      };
      ctx.sendUpdate(results);
    `)
    const sent: unknown[] = []
    const ctx: SandboxContext = {
      state: {},
      sendUpdate: (p: unknown) => { sent.push(p) },
      requestLLM: async () => '',
      appId: 'test-app',
      chatId: 1,
    }
    await fn({}, ctx)
    const results = sent[0] as Record<string, string>
    expect(results.fs).toBe('undefined')
    expect(results.process).toBe('undefined')
    expect(results.fetch).toBe('undefined')
    expect(results.Bun).toBe('undefined')
    expect(results.require).toBe('undefined')
    expect(results.child_process).toBe('undefined')
    expect(results.net).toBe('undefined')
    expect(results.http).toBe('undefined')
    expect(results.https).toBe('undefined')
    expect(results.os).toBe('undefined')
    expect(results.path).toBe('undefined')
    expect(results.crypto).toBe('undefined')
    expect(results.Buffer).toBe('undefined')
    expect(results.setTimeout).toBe('undefined')
    expect(results.setInterval).toBe('undefined')
    expect(results.globalThis).toBe('undefined')
  })

  test('handler with dynamic import() is rejected at compile time', () => {
    expect(() => createSandbox('const m = await import("node:fs")')).toThrow(
      'handler must not use dynamic import()',
    )
    expect(() => createSandbox('import ("node:os")')).toThrow(
      'handler must not use dynamic import()',
    )
    // Regular use of the word "import" in a string literal should be fine
    expect(() => createSandbox('ctx.sendUpdate({ msg: "import data" })')).not.toThrow()
  })

  test('handler can use standard builtins (Math, JSON, Date, Array)', async () => {
    const fn = createSandbox(`
      const arr = [3, 1, 2];
      const sorted = Array.from(arr).sort();
      const pi = Math.PI;
      const json = JSON.stringify({ a: 1 });
      const now = typeof Date;
      ctx.sendUpdate({ sorted, pi, json, now });
    `)
    const sent: unknown[] = []
    const ctx: SandboxContext = {
      state: {},
      sendUpdate: (p: unknown) => { sent.push(p) },
      requestLLM: async () => '',
      appId: 'test-app',
      chatId: 1,
    }
    await fn({}, ctx)
    const results = sent[0] as Record<string, unknown>
    expect(results.sorted).toEqual([1, 2, 3])
    expect(results.pi).toBe(Math.PI)
    expect(results.json).toBe('{"a":1}')
    expect(results.now).toBe('function')
  })

  test('handler errors are caught and returned as {error: message}', async () => {
    const fn = createSandbox(`
      throw new Error('boom');
    `)
    const ctx: SandboxContext = {
      state: {},
      sendUpdate: () => {},
      requestLLM: async () => '',
      appId: 'test-app',
      chatId: 1,
    }
    const result = await fn({}, ctx)
    expect(result.error).toBe('boom')
  })

  test('requestLLM is callable from handler (async)', async () => {
    const fn = createSandbox(`
      const reply = await ctx.requestLLM('what is 2+2?');
      ctx.sendUpdate({ reply });
    `)
    const sent: unknown[] = []
    const ctx: SandboxContext = {
      state: {},
      sendUpdate: (p: unknown) => { sent.push(p) },
      requestLLM: async (prompt: string) => `answer to: ${prompt}`,
      appId: 'test-app',
      chatId: 1,
    }
    const result = await fn({}, ctx)
    expect(result.error).toBeUndefined()
    expect(sent).toEqual([{ reply: 'answer to: what is 2+2?' }])
  })
})

// ---------------------------------------------------------------------------
// YAML parsing tests
// ---------------------------------------------------------------------------
describe('parseFamiliarYaml', () => {
  test('parses valid familiar YAML with all fields', () => {
    const yaml = [
      'name: Counter',
      'description: A simple counter',
      'html: "<div>counter</div>"',
      'handler: "ctx.sendUpdate({ count: (ctx.state.count || 0) + 1 });"',
      'persistent: true',
      'initialState:',
      '  count: 0',
    ].join('\n')
    const result = parseFamiliarYaml(yaml)
    expect(result.name).toBe('Counter')
    expect(result.description).toBe('A simple counter')
    expect(result.html).toBe('<div>counter</div>')
    expect(result.handler).toContain('ctx.sendUpdate')
    expect(result.persistent).toBe(true)
    expect(result.initialState).toEqual({ count: 0 })
  })

  test('rejects YAML without name', () => {
    const yaml = [
      'html: "<div>hi</div>"',
      'handler: "ctx.sendUpdate({});"',
    ].join('\n')
    expect(() => parseFamiliarYaml(yaml)).toThrow(/name/)
  })

  test('rejects YAML without html', () => {
    const yaml = [
      'name: NoHtml',
      'handler: "ctx.sendUpdate({});"',
    ].join('\n')
    expect(() => parseFamiliarYaml(yaml)).toThrow(/html/)
  })

  test('rejects YAML with invalid handler (syntax error)', () => {
    const yaml = [
      'name: BadHandler',
      'html: "<div>hi</div>"',
      'handler: "function(( {"',
    ].join('\n')
    expect(() => parseFamiliarYaml(yaml)).toThrow(/handler/)
  })

  test('defaults persistent to false and initialState to {}', () => {
    const yaml = [
      'name: Minimal',
      'html: "<div>hi</div>"',
      'handler: "ctx.sendUpdate({});"',
    ].join('\n')
    const result = parseFamiliarYaml(yaml)
    expect(result.persistent).toBe(false)
    expect(result.initialState).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------
describe('registry', () => {
  function makeInstance(overrides: Partial<FamiliarInstance> = {}): FamiliarInstance {
    return {
      appId: 'app-1',
      chatId: 10,
      msgId: 100,
      title: 'Test App',
      html: '<div>test</div>',
      handler: 'ctx.sendUpdate({});',
      state: {},
      persistent: false,
      createdAt: new Date().toISOString(),
      ...overrides,
    }
  }

  test('registerInstance and getInstance', () => {
    const inst = makeInstance()
    registerInstance(inst)
    expect(getInstance('app-1')).toBe(inst)
  })

  test('getInstanceByMsgId lookup', () => {
    const inst = makeInstance({ appId: 'app-2', msgId: 200 })
    registerInstance(inst)
    expect(getInstanceByMsgId(200)).toBe(inst)
    expect(getInstanceByMsgId(999)).toBeUndefined()
  })

  test('listInstances filters by chatId', () => {
    registerInstance(makeInstance({ appId: 'a1', chatId: 10 }))
    registerInstance(makeInstance({ appId: 'a2', chatId: 10 }))
    registerInstance(makeInstance({ appId: 'a3', chatId: 20 }))
    expect(listInstances(10).map(i => i.appId)).toEqual(['a1', 'a2'])
    expect(listInstances(20).map(i => i.appId)).toEqual(['a3'])
    expect(listInstances(99)).toEqual([])
  })

  test('deleteInstance removes from both maps', () => {
    const inst = makeInstance({ appId: 'del-1', msgId: 300 })
    registerInstance(inst)
    expect(getInstance('del-1')).toBeDefined()
    expect(getInstanceByMsgId(300)).toBeDefined()
    deleteInstance('del-1')
    expect(getInstance('del-1')).toBeUndefined()
    expect(getInstanceByMsgId(300)).toBeUndefined()
  })

  test('getHandler returns compiled function', () => {
    const inst = makeInstance({
      appId: 'handler-test',
      handler: 'ctx.sendUpdate({ ran: true });',
    })
    registerInstance(inst)
    const fn = getHandler('handler-test')
    expect(fn).toBeDefined()
    expect(typeof fn).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Persistence tests
// ---------------------------------------------------------------------------
describe('persistence', () => {
  function makeInstance(overrides: Partial<FamiliarInstance> = {}): FamiliarInstance {
    return {
      appId: 'persist-1',
      chatId: 10,
      msgId: 100,
      title: 'Persisted App',
      html: '<div>persisted</div>',
      handler: 'ctx.sendUpdate({});',
      state: { count: 42 },
      persistent: true,
      createdAt: new Date().toISOString(),
      ...overrides,
    }
  }

  test('persistInstance writes JSON, loadPersistedInstances reads it back', () => {
    const inst = makeInstance()
    persistInstance(inst)
    const loaded = loadPersistedInstances()
    expect(loaded.length).toBe(1)
    expect(loaded[0]!.appId).toBe('persist-1')
    expect(loaded[0]!.state).toEqual({ count: 42 })
    expect(loaded[0]!.html).toBe('<div>persisted</div>')
    expect(loaded[0]!.handler).toBe('ctx.sendUpdate({});')
  })

  test('deletePersistedInstance removes the file', () => {
    const inst = makeInstance({ appId: 'persist-del' })
    persistInstance(inst)
    expect(loadPersistedInstances().length).toBe(1)
    deletePersistedInstance('persist-del')
    expect(loadPersistedInstances().length).toBe(0)
  })
})
