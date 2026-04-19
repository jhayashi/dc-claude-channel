import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  registerInstance,
  listInstances,
  persistInstance,
  cleanupFamiliarForChat,
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
  test('cleanupFamiliarForChat clears both memory and disk and returns msgIds', () => {
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

    const msgIds = cleanupFamiliarForChat(42)

    expect(msgIds).toEqual([1000])
    expect(listInstances(42).length).toBe(0)
    expect(existsSync(join(testDir, 'test-app.json'))).toBe(false)
  })

  test('cleanupFamiliarForChat on chat with no instances returns empty array', () => {
    expect(cleanupFamiliarForChat(999)).toEqual([])
  })

  test('cleanupFamiliarForChat leaves persistent file when instance was not persisted', () => {
    const inst: FamiliarInstance = {
      appId: 'ephemeral-app',
      chatId: 77,
      msgId: 2000,
      title: 'Ephemeral',
      html: '<script src="webxdc.js"></script><script>window.webxdc.sendUpdate({payload:{senderAddr:window.webxdc.selfAddr}}, "")</script>',
      handler: 'ctx.sendUpdate({ok: true})',
      state: {},
      persistent: false,
      createdAt: new Date().toISOString(),
    }
    registerInstance(inst)
    expect(cleanupFamiliarForChat(77)).toEqual([2000])
    expect(existsSync(join(testDir, 'ephemeral-app.json'))).toBe(false)
  })
})
