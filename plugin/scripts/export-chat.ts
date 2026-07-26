#!/usr/bin/env bun
/**
 * Export one Delta Chat conversation — text, speakers and uploaded files — into
 * a self-contained folder.
 *
 * Step one of the n-way memory migration (n-way issue #6): step two reads the
 * folder this writes and seeds an agent's wiki from it.
 *
 * Usage:
 *   bun run scripts/export-chat.ts --list
 *   bun run scripts/export-chat.ts --chat 30 --out ~/exports/health
 *   bun run scripts/export-chat.ts --chat "Health - Family" --out ~/exports/health
 *
 * Flags:
 *   --chat <id|name>   numeric chat id, or a substring matching exactly one chat
 *   --out <dir>        destination folder (created if absent)
 *   --list             list chats with visible-message counts, then exit
 *   --force            overwrite a non-empty --out
 *   --state-dir <dir>  override $DC_STATE_DIR (~/.claude/channels/deltachat)
 *   --account <id>     override accounts.toml's selected_account
 *
 * Exit codes:
 *   0 — export written (missing blobs are warnings, not failures)
 *   1 — unknown/ambiguous chat, unreadable DB, or non-empty --out without --force
 *
 * Safe to run while the dispatcher is up: the DB is opened read-only, and
 * accounts.lock guards against a second dc-core process, not a reader.
 *
 * Design: docs/superpowers/specs/2026-07-26-chat-transcript-export-design.md
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  EXPORT_SCHEMA_VERSION,
  LAST_SPECIAL_CHAT_ID,
  buildMessages,
  defaultStateDir,
  isNonEmptyDir,
  readBinding,
  resolveAccountDir,
  selectChat,
  summarise,
  writeExport,
  type ChatRow,
  type ContactRow,
  type ExportManifest,
  type MsgRow,
  type Speaker,
} from '../export-chat.ts'

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`)
}
function die(msg: string): never {
  console.error(`export-chat: ${msg}`)
  process.exit(1)
}

const stateDir = resolve(flag('state-dir') ?? defaultStateDir())
const accountFlag = flag('account')

let accountDir: string
try {
  accountDir = resolveAccountDir(stateDir, accountFlag ? Number(accountFlag) : undefined)
} catch (e) {
  die(String(e instanceof Error ? e.message : e))
}

const dbPath = join(accountDir, 'dc.db')
let db: Database
try {
  db = new Database(dbPath, { readonly: true })
} catch (e) {
  die(`cannot open ${dbPath} read-only: ${e instanceof Error ? e.message : e}`)
}

const chats = db.query('select id, type, name from chats order by id').all() as ChatRow[]

if (has('list')) {
  const counts = new Map<number, number>()
  for (const r of db
    .query('select chat_id as c, count(*) as n from msgs where hidden = 0 and deleted = 0 group by chat_id')
    .all() as Array<{ c: number; n: number }>) {
    counts.set(r.c, r.n)
  }
  for (const c of chats.filter((c) => c.id > LAST_SPECIAL_CHAT_ID)) {
    console.log(`${String(c.id).padStart(4)}  ${String(counts.get(c.id) ?? 0).padStart(5)} msgs  ${c.name}`)
  }
  process.exit(0)
}

const selector = flag('chat')
if (!selector) die('need --chat <id|name> (or --list)')
const outFlag = flag('out')
if (!outFlag) die('need --out <dir>')
const outDir = resolve(outFlag)

const picked = selectChat(chats, selector)
if (!picked.ok) {
  if (picked.reason === 'ambiguous') {
    die(
      `"${selector}" matches ${picked.candidates.length} chats:\n` +
        picked.candidates.map((c) => `  ${c.id}  ${c.name}`).join('\n') +
        '\nUse the numeric id.',
    )
  }
  die(`no chat matches "${selector}". Try --list.`)
}
const chat = picked.chat

if (isNonEmptyDir(outDir) && !has('force')) {
  die(`${outDir} is not empty — pass --force to overwrite.`)
}

const rows = db
  .query(
    'select id, from_id, timestamp, type, txt, param from msgs ' +
      'where chat_id = ? and hidden = 0 and deleted = 0 order by timestamp asc, id asc',
  )
  .all(chat.id) as MsgRow[]

const contacts = new Map<number, ContactRow>()
for (const c of db.query('select id, addr, name, authname from contacts').all() as ContactRow[]) {
  contacts.set(c.id, c)
}

const config = new Map<string, string>()
for (const r of db.query('select keyname, value from config').all() as Array<{
  keyname: string
  value: string
}>) {
  config.set(r.keyname, r.value)
}

const binding = readBinding(stateDir, chat.id)
const ctx = {
  chat,
  contacts,
  selfName: binding?.id ?? config.get('displayname') ?? 'agent',
  selfAddr: config.get('configured_addr') ?? null,
  blobDir: join(accountDir, 'dc.db-blobs'),
}

const messages = buildMessages(rows, ctx)

const seen = new Map<number, Speaker>()
for (const m of messages) if (!seen.has(m.from.contactId)) seen.set(m.from.contactId, m.from)

const manifest: ExportManifest = {
  schemaVersion: EXPORT_SCHEMA_VERSION,
  tool: 'dc-claude-channel/scripts/export-chat.ts',
  exportedAt: new Date().toISOString(),
  source: { stateDir, accountDir, dbPath },
  chat: { id: chat.id, name: chat.name, type: chat.type, isGroup: chat.type === 120 },
  agent: binding,
  participants: [...seen.values()].sort((a, b) => a.contactId - b.contactId),
  counts: summarise(messages),
}

mkdirSync(outDir, { recursive: true })
const { warnings } = writeExport(outDir, manifest, messages)
db.close()

const c = manifest.counts
console.log(`Exported chat ${chat.id} "${chat.name}" → ${outDir}`)
console.log(`  ${c.messages} messages (${c.dialogue} dialogue, ${c.system} system)`)
console.log(`  ${c.attachments} attachments, ${c.attachmentsUploadedByHuman} uploaded by a person`)
for (const w of warnings) console.warn(`  warning: ${w}`)
if (c.attachmentsMissing > 0) console.warn(`  ${c.attachmentsMissing} attachment(s) missing from the blob dir`)
