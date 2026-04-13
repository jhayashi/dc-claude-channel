/**
 * Familiar runtime core — eval sandbox, in-memory registry, and persistence.
 *
 * A "familiar" is a lightweight WebXDC applet whose server-side behaviour
 * is defined by a short JS handler string authored by Claude and approved
 * by the user. The handler runs in a restricted eval sandbox where dangerous
 * Node/Bun globals are shadowed with `undefined`, leaving only standard JS
 * builtins (Math, JSON, Date, Array, etc.) and an explicit context object.
 *
 * **Security model:** The `new Function()` call is intentional — it is the
 * core mechanism that allows Claude to author interactive applet logic at
 * runtime. The user sees the handler source in the familiar YAML and
 * approves it before it runs. Dangerous globals (fs, process, fetch,
 * child_process, net, http, Bun, require, import, etc.) are shadowed in
 * the function's parameter list so they resolve to `undefined` inside the
 * handler body. This is defence-in-depth, not a security boundary — the
 * approval step is the primary gate.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context passed to handler functions at runtime. */
export interface SandboxContext {
  state: Record<string, unknown>
  sendUpdate: (payload: unknown) => void
  requestLLM: (prompt: string) => Promise<string>
  appId: string
  chatId: number
}

/** A registered familiar instance (in-memory + optional persistence). */
export interface FamiliarInstance {
  appId: string
  chatId: number
  msgId: number
  title: string
  html: string
  handler: string
  state: Record<string, unknown>
  persistent: boolean
  createdAt: string
  /** Compiled handler — not persisted; lazily compiled on first use. */
  _fn?: (update: unknown, ctx: SandboxContext) => Promise<{ error?: string }>
}

/** Parsed familiar definition from YAML import. */
export interface FamiliarYaml {
  name: string
  description?: string
  html: string
  handler: string
  persistent: boolean
  initialState: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Globals to shadow inside the sandbox
// ---------------------------------------------------------------------------

const SHADOWED_GLOBALS = [
  'require', 'module', 'exports',
  'fetch',
  'process',
  'globalThis',
  'Bun', 'Deno',
  '__dirname', '__filename',
  'fs', 'child_process', 'net', 'http', 'https', 'os', 'path', 'crypto',
  'Buffer',
  'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval',
] as const

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

/**
 * Compile a handler JS string into a callable async function.
 *
 * The handler body runs inside an async function where dangerous globals
 * are shadowed as `undefined` via parameter names. The handler can
 * reference `update` (the incoming WebXDC payload) and `ctx` (a
 * SandboxContext with state, sendUpdate, requestLLM, appId, chatId).
 *
 * **Security note:** The `new Function()` usage below is intentional and
 * is the core feature of the familiar runtime. Claude authors the handler
 * code; users review and approve it before execution. The shadowed globals
 * provide defence-in-depth but are not the primary security boundary.
 *
 * Returns a function `(update, ctx) => Promise<{error?}>`.
 */
export function createSandbox(
  handlerSource: string,
): (update: unknown, ctx: SandboxContext) => Promise<{ error?: string }> {
  // Reject dynamic import() — it's a keyword and can't be shadowed via
  // function parameters. This is a string-level check (defence-in-depth).
  if (/\bimport\s*\(/.test(handlerSource)) {
    throw new Error('handler must not use dynamic import()')
  }

  // Build parameter list: update, ctx, then all shadowed globals (= undefined)
  const params = ['update', 'ctx', ...SHADOWED_GLOBALS]

  // Wrap in async so handlers can use `await`
  const body = `"use strict";\n${handlerSource}`

  // Intentional use of Function constructor — see module-level security doc comment
  const compiled = Function(
    ...params,
    `return (async () => { ${body} })();`,
  )

  return async (update: unknown, ctx: SandboxContext): Promise<{ error?: string }> => {
    try {
      // Call with update, ctx, then undefined for every shadowed global
      const args: unknown[] = [update, ctx]
      for (let i = 0; i < SHADOWED_GLOBALS.length; i++) args.push(undefined)
      await compiled(...args)
      return {}
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { error: message }
    }
  }
}

/**
 * Validate that a handler string compiles without error.
 * Throws on syntax error with a message prefixed "handler".
 */
function validateHandler(source: string): void {
  try {
    createSandbox(source)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`handler compile error: ${msg}`)
  }
}

// ---------------------------------------------------------------------------
// In-memory registry
// ---------------------------------------------------------------------------

const byAppId = new Map<string, FamiliarInstance>()
const byMsgId = new Map<number, FamiliarInstance>()

/** Register an instance in the in-memory registry. */
export function registerInstance(inst: FamiliarInstance): void {
  byAppId.set(inst.appId, inst)
  byMsgId.set(inst.msgId, inst)
}

/** Look up an instance by appId. */
export function getInstance(appId: string): FamiliarInstance | undefined {
  return byAppId.get(appId)
}

/** Look up an instance by WebXDC message id. */
export function getInstanceByMsgId(msgId: number): FamiliarInstance | undefined {
  return byMsgId.get(msgId)
}

/** List all instances for a given chatId. */
export function listInstances(chatId: number): FamiliarInstance[] {
  const out: FamiliarInstance[] = []
  for (const inst of byAppId.values()) {
    if (inst.chatId === chatId) out.push(inst)
  }
  return out
}

/** Remove an instance from both maps. */
export function deleteInstance(appId: string): void {
  const inst = byAppId.get(appId)
  if (!inst) return
  byAppId.delete(appId)
  byMsgId.delete(inst.msgId)
}

/**
 * Get (or lazily compile) the handler function for an instance.
 * Returns undefined if the instance is not registered.
 */
export function getHandler(
  appId: string,
): ((update: unknown, ctx: SandboxContext) => Promise<{ error?: string }>) | undefined {
  const inst = byAppId.get(appId)
  if (!inst) return undefined
  if (!inst._fn) {
    inst._fn = createSandbox(inst.handler)
  }
  return inst._fn
}

/** Clear all in-memory state (for tests). */
export function _resetRegistry(): void {
  byAppId.clear()
  byMsgId.clear()
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

let FAMILIARS_DIR = join(homedir(), '.claude', 'channels', 'deltachat', 'familiars')

/** Override the storage directory (for tests). */
export function setFamiliarsDir(dir: string): void {
  FAMILIARS_DIR = dir
}

/** Return the current familiars storage directory. */
export function getFamiliarsDir(): string {
  return FAMILIARS_DIR
}

function instancePath(appId: string): string {
  return join(FAMILIARS_DIR, `${appId}.json`)
}

/** Persist a familiar instance to disk as JSON. */
export function persistInstance(inst: FamiliarInstance): void {
  mkdirSync(FAMILIARS_DIR, { recursive: true })
  const { _fn, ...serializable } = inst
  const finalPath = instancePath(inst.appId)
  const tmpPath = `${finalPath}.tmp.${process.pid}`
  writeFileSync(tmpPath, JSON.stringify(serializable, null, 2))
  renameSync(tmpPath, finalPath)
}

/** Delete a persisted familiar instance file. Returns true if removed. */
export function deletePersistedInstance(appId: string): boolean {
  const path = instancePath(appId)
  if (!existsSync(path)) return false
  unlinkSync(path)
  return true
}

/** Load all persisted familiar instances from disk. Invalid files are skipped. */
export function loadPersistedInstances(): FamiliarInstance[] {
  if (!existsSync(FAMILIARS_DIR)) return []
  const out: FamiliarInstance[] = []
  for (const entry of readdirSync(FAMILIARS_DIR)) {
    if (!entry.endsWith('.json')) continue
    try {
      const raw = JSON.parse(readFileSync(join(FAMILIARS_DIR, entry), 'utf-8'))
      // Minimal validation: must have appId, chatId, msgId, handler, html
      if (
        typeof raw.appId === 'string' &&
        typeof raw.chatId === 'number' &&
        typeof raw.msgId === 'number' &&
        typeof raw.handler === 'string' &&
        typeof raw.html === 'string'
      ) {
        out.push(raw as FamiliarInstance)
      }
    } catch {
      // skip invalid files
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// YAML import validation
// ---------------------------------------------------------------------------

/**
 * Parse and validate a familiar definition from a YAML string.
 * Validates required fields (name, html, handler) and that the handler
 * compiles. Returns a FamiliarYaml with defaults applied.
 *
 * Throws on validation failure with a descriptive message.
 */
export function parseFamiliarYaml(yamlStr: string): FamiliarYaml {
  const raw = YAML.parse(yamlStr)
  if (!raw || typeof raw !== 'object') {
    throw new Error('YAML did not produce an object')
  }

  if (typeof raw.name !== 'string' || !raw.name) {
    throw new Error('name is required and must be a non-empty string')
  }
  if (typeof raw.html !== 'string' || !raw.html) {
    throw new Error('html is required and must be a non-empty string')
  }
  if (typeof raw.handler !== 'string' || !raw.handler) {
    throw new Error('handler is required and must be a non-empty string')
  }

  // Validate handler compiles
  validateHandler(raw.handler)

  return {
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    html: raw.html,
    handler: raw.handler,
    persistent: typeof raw.persistent === 'boolean' ? raw.persistent : false,
    initialState:
      raw.initialState && typeof raw.initialState === 'object'
        ? (raw.initialState as Record<string, unknown>)
        : {},
  }
}
