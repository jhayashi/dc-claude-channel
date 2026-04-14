import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  registerInstance,
  listInstances,
  deleteInstance,
  deletePersistedInstance,
  persistInstance,
  setFamiliarsDir,
  _resetRegistry,
  type FamiliarInstance,
} from '../familiar-runtime'

const testDir = mkdtempSync(join(tmpdir(), 'dc-familiar-cleanup-test-'))

beforeEach(() => {
  _resetRegistry()
  setFamiliarsDir(testDir)
})

describe('familiar cleanup on chat delete', () => {
  test('deleteInstance + deletePersistedInstance clears both memory and disk', () => {
    const inst: FamiliarInstance = {
      appId: 'test-app',
      chatId: 42,
      msgId: 1000,
      title: 'Test',
      html: '<script src="webxdc.js"></script><script>window.webxdc.sendUpdate({payload:{senderAddr:window.webxdc.selfAddr}}, "")</script>',
      handler: 'ctx.sendUpdate({ok: true})',
      state: {},
      persistent: true,
      createdAt: new Date().toISOString(),
    }
    registerInstance(inst)
    persistInstance(inst)
    expect(listInstances(42).length).toBe(1)

    for (const i of listInstances(42)) {
      deleteInstance(i.appId)
      if (i.persistent) deletePersistedInstance(i.appId)
    }

    expect(listInstances(42).length).toBe(0)
    expect(existsSync(join(testDir, 'test-app.json'))).toBe(false)
  })
})
