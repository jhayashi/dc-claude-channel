/**
 * Chat transcript export (step one of the n-way memory migration).
 *
 * Reads one Delta Chat conversation out of the local dc-core sqlite DB and
 * turns it into a self-contained folder: a markdown transcript for humans and
 * models, a JSONL stream for tools, and the uploaded files themselves.
 *
 * The DB is opened read-only, which is safe while the dispatcher is running:
 * `accounts.lock` guards against a second dc-core *process*, and a read-only
 * sqlite handle is not one.
 *
 * Design: docs/superpowers/specs/2026-07-26-chat-transcript-export-design.md
 *
 * Everything above `writeExport` is pure — rows in, values out — so the
 * classification and attribution rules can be tested with literals.
 */

import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

/** Schema version written into manifest.json; bump when the shape changes. */
export const EXPORT_SCHEMA_VERSION = 1

/**
 * dc-core reserves chat ids 1..9 (deaddrop, trash, starred, archivedlink, …).
 * Anything at or below this is never a real conversation.
 */
export const LAST_SPECIAL_CHAT_ID = 9

/** dc-core's self contact. */
export const CONTACT_ID_SELF = 1
/** dc-core's "info" pseudo-contact, the author of system messages. */
export const CONTACT_ID_INFO = 2

// ---------------------------------------------------------------------------
// Row shapes (the subset of dc.db this tool reads)
// ---------------------------------------------------------------------------

export interface ChatRow {
  id: number
  type: number
  name: string
}

export interface ContactRow {
  id: number
  addr: string | null
  name: string | null
  authname: string | null
}

export interface MsgRow {
  id: number
  from_id: number
  timestamp: number
  type: number
  txt: string | null
  param: string | null
}

// ---------------------------------------------------------------------------
// Export model
// ---------------------------------------------------------------------------

export type SpeakerRole = 'agent' | 'human' | 'system'

export interface Speaker {
  contactId: number
  name: string
  addr: string | null
  role: SpeakerRole
}

export type AttachmentKind = 'image' | 'audio' | 'video' | 'file' | 'webxdc'

export interface Attachment {
  /** Path relative to the export root. */
  path: string
  /** Filename as the sender had it. */
  originalName: string
  mime: string | null
  kind: AttachmentKind
  /** Who put this file into the chat. `human` is the case that matters. */
  uploadedBy: 'agent' | 'human'
  /** Absolute source path in the blob dir; not serialised. */
  blobPath: string
  /** Filled in by writeExport. */
  bytes: number | null
  sha256: string | null
  missing: boolean
}

export interface ExportedMessage {
  msgId: number
  chatId: number
  ts: string
  tsUnix: number
  kind: 'dialogue' | 'system'
  from: Speaker
  text: string
  /** dc-core system-message command code, when this is a system message. */
  systemCmd: number | null
  attachments: Attachment[]
}

export interface ExportManifest {
  schemaVersion: number
  tool: string
  exportedAt: string
  source: {
    stateDir: string
    accountDir: string
    dbPath: string
  }
  chat: {
    id: number
    name: string
    type: number
    isGroup: boolean
  }
  agent: { id: string; sessionId: string | null } | null
  participants: Speaker[]
  counts: {
    messages: number
    dialogue: number
    system: number
    attachments: number
    attachmentsUploadedByHuman: number
    attachmentsMissing: number
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * dc-core stores message params as newline-separated `key=value`. Values may
 * themselves contain `=` (mime types do not, but filenames and Arg do), so
 * split on the first one only.
 */
export function parseParam(raw: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw) return out
  for (const line of raw.split('\n')) {
    if (!line) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    out[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return out
}

/** dc-core message type → attachment kind. */
export function attachmentKind(msgType: number, mime: string | null): AttachmentKind {
  if (mime === 'application/webxdc+zip') return 'webxdc'
  switch (msgType) {
    case 20:
    case 21:
    case 23:
      return 'image'
    case 40:
    case 41:
      return 'audio'
    case 50:
      return 'video'
    case 80:
      return 'webxdc'
    default:
      return 'file'
  }
}

/**
 * Make a filename safe to write without letting it escape the attachments dir.
 * Spaces survive — "MyMountSinai - Note from Care Team.pdf" should stay
 * recognisable.
 */
export function sanitiseFilename(name: string, fallback: string): string {
  const cleaned = Array.from(name)
    .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f)
    .join('')
    .replace(/[/\\]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  if (!cleaned) return fallback
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned
}

export type ChatSelection =
  | { ok: true; chat: ChatRow }
  | { ok: false; reason: 'none' | 'ambiguous'; candidates: ChatRow[] }

/**
 * Resolve `--chat`: a numeric id, or a case-insensitive substring that must
 * match exactly one real chat. An exact (case-insensitive) name match wins over
 * substring matches, so "Misc" selects "Misc" even if "Miscellaneous" exists.
 */
export function selectChat(chats: ChatRow[], selector: string): ChatSelection {
  const real = chats.filter((c) => c.id > LAST_SPECIAL_CHAT_ID)

  if (/^\d+$/.test(selector)) {
    const id = Number(selector)
    const hit = real.find((c) => c.id === id)
    return hit ? { ok: true, chat: hit } : { ok: false, reason: 'none', candidates: [] }
  }

  const needle = selector.toLowerCase()
  const exact = real.filter((c) => (c.name ?? '').toLowerCase() === needle)
  const matches = exact.length > 0 ? exact : real.filter((c) => (c.name ?? '').toLowerCase().includes(needle))

  if (matches.length === 0) return { ok: false, reason: 'none', candidates: [] }
  if (matches.length > 1) return { ok: false, reason: 'ambiguous', candidates: matches }
  return { ok: true, chat: matches[0]! }
}

export interface BuildContext {
  chat: ChatRow
  contacts: Map<number, ContactRow>
  /** Display name for the account itself — the agent's id where one is bound. */
  selfName: string
  selfAddr: string | null
  /** Absolute path of `<accountDir>/dc.db-blobs`, for resolving `$BLOBDIR`. */
  blobDir: string
}

/**
 * An agent's name is not in the DB — `displayname` is account-wide and would
 * label every agent identically. The binding's `agentId` is the honest label.
 */
export function speakerFor(fromId: number, ctx: BuildContext): Speaker {
  if (fromId === CONTACT_ID_SELF) {
    return { contactId: fromId, name: ctx.selfName, addr: ctx.selfAddr, role: 'agent' }
  }
  if (fromId === CONTACT_ID_INFO) {
    return { contactId: fromId, name: 'system', addr: null, role: 'system' }
  }
  const c = ctx.contacts.get(fromId)
  const name = (c?.name || c?.authname || c?.addr || `contact ${fromId}`).trim()
  return { contactId: fromId, name, addr: c?.addr ?? null, role: 'human' }
}

/** Rows → the export model. Pure: no file is read, no byte is copied. */
export function buildMessages(rows: MsgRow[], ctx: BuildContext): ExportedMessage[] {
  return rows.map((row) => {
    const param = parseParam(row.param)
    const from = speakerFor(row.from_id, ctx)
    const isSystem = param.S !== undefined || from.role === 'system'

    const attachments: Attachment[] = []
    const file = param.f
    if (file) {
      const blobName = basename(file)
      const originalName = sanitiseFilename(param.v || blobName, blobName)
      attachments.push({
        path: `attachments/${row.id}-${originalName}`,
        originalName: param.v || blobName,
        mime: param.m ?? null,
        kind: attachmentKind(row.type, param.m ?? null),
        uploadedBy: from.role === 'agent' ? 'agent' : 'human',
        blobPath: join(ctx.blobDir, blobName),
        bytes: null,
        sha256: null,
        missing: false,
      })
    }

    return {
      msgId: row.id,
      chatId: ctx.chat.id,
      ts: new Date(row.timestamp * 1000).toISOString(),
      tsUnix: row.timestamp,
      kind: isSystem ? 'system' : 'dialogue',
      from,
      text: (row.txt ?? '').trim(),
      systemCmd: param.S !== undefined ? Number(param.S) : null,
      attachments,
    }
  })
}

export function summarise(messages: ExportedMessage[]): ExportManifest['counts'] {
  const atts = messages.flatMap((m) => m.attachments)
  return {
    messages: messages.length,
    dialogue: messages.filter((m) => m.kind === 'dialogue').length,
    system: messages.filter((m) => m.kind === 'system').length,
    attachments: atts.length,
    attachmentsUploadedByHuman: atts.filter((a) => a.uploadedBy === 'human').length,
    attachmentsMissing: atts.filter((a) => a.missing).length,
  }
}

export function formatBytes(n: number | null): string {
  if (n === null) return 'unknown size'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The markdown transcript. Message ids appear in the headings because issue #6
 * requires memories to cite `chat:<chatId>/msg:<msgId>` — a model reading only
 * this file must still be able to cite correctly.
 */
export function renderTranscript(manifest: ExportManifest, messages: ExportedMessage[]): string {
  const out: string[] = []
  out.push(`# ${manifest.chat.name}`)
  out.push('')
  out.push(
    `Delta Chat transcript, chat ${manifest.chat.id}. Exported ${manifest.exportedAt} by ${manifest.tool}.`,
  )
  if (manifest.agent) out.push(`Agent bound to this chat: \`${manifest.agent.id}\`.`)
  out.push('')
  out.push('Participants:')
  for (const p of manifest.participants) {
    out.push(`- **${p.name}** (${p.role}${p.addr ? `, ${p.addr}` : ''})`)
  }
  out.push('')
  const c = manifest.counts
  out.push(
    `${c.messages} messages (${c.dialogue} dialogue, ${c.system} system), ` +
      `${c.attachments} attachments of which ${c.attachmentsUploadedByHuman} were uploaded by a person.`,
  )
  out.push('')
  out.push(
    'Citation anchor: the number in each heading is the Delta Chat message id, ' +
      `citable as \`chat:${manifest.chat.id}/msg:<id>\`.`,
  )
  out.push('')
  out.push('---')
  out.push('')

  for (const m of messages) {
    out.push(`## [${m.msgId}] ${m.ts} — ${m.from.name} (${m.from.role})`)
    out.push('')
    if (m.kind === 'system') {
      out.push(`_${m.text || '(system message)'}_`)
    } else if (m.text) {
      out.push(m.text)
    } else if (m.attachments.length === 0) {
      out.push('_(empty message)_')
    }
    for (const a of m.attachments) {
      out.push('')
      const verb = a.uploadedBy === 'human' ? '**uploaded**' : '**sent**'
      const missing = a.missing ? ' — ⚠️ FILE MISSING FROM BLOB DIR' : ''
      out.push(
        `📎 ${verb} \`${a.originalName}\` — ${a.mime ?? 'unknown type'}, ${formatBytes(a.bytes)}${missing}`,
      )
      out.push(`→ \`${a.path}\``)
    }
    out.push('')
  }

  return out.join('\n')
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

export interface WriteResult {
  warnings: string[]
}

/**
 * Copy every attachment, then write the three files. Attachment records are
 * enriched in place with size, digest and missing-ness before the transcript is
 * rendered, so the markdown and the JSONL cannot disagree about a file.
 */
export function writeExport(
  outDir: string,
  manifest: ExportManifest,
  messages: ExportedMessage[],
): WriteResult {
  const warnings: string[] = []
  mkdirSync(join(outDir, 'attachments'), { recursive: true })

  for (const m of messages) {
    for (const a of m.attachments) {
      try {
        const st = statSync(a.blobPath)
        copyFileSync(a.blobPath, join(outDir, a.path))
        a.bytes = st.size
        a.sha256 = createHash('sha256').update(readFileSync(a.blobPath)).digest('hex')
      } catch {
        a.missing = true
        warnings.push(`msg ${m.msgId}: blob missing, not exported: ${a.blobPath}`)
      }
    }
  }

  manifest.counts = summarise(messages)

  const jsonl = messages
    .map((m) =>
      JSON.stringify({
        ...m,
        attachments: m.attachments.map(({ blobPath: _blobPath, ...rest }) => rest),
      }),
    )
    .join('\n')

  writeFileSync(join(outDir, 'messages.jsonl'), jsonl + (jsonl ? '\n' : ''))
  writeFileSync(join(outDir, 'transcript.md'), renderTranscript(manifest, messages))
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  return { warnings }
}

// ---------------------------------------------------------------------------
// Locating the account
// ---------------------------------------------------------------------------

export function defaultStateDir(): string {
  return process.env.DC_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'deltachat')
}

/**
 * Resolve which account directory under `dc-data/` to read. `accounts.toml` is
 * parsed with regexes rather than a TOML dependency: the two fields needed
 * (`selected_account`, and each account's `id`/`dir`) are written by dc-core in
 * a fixed shape.
 */
export function resolveAccountDir(stateDir: string, accountId?: number): string {
  const dcData = join(stateDir, 'dc-data')
  const tomlPath = join(dcData, 'accounts.toml')

  let toml = ''
  try {
    toml = readFileSync(tomlPath, 'utf8')
  } catch {
    throw new Error(`cannot read ${tomlPath} — is DC_STATE_DIR / --state-dir correct?`)
  }

  const accounts: Array<{ id: number; dir: string }> = []
  for (const block of toml.split('[[accounts]]').slice(1)) {
    const id = block.match(/^\s*id\s*=\s*(\d+)/m)?.[1]
    const dir = block.match(/^\s*dir\s*=\s*"([^"]+)"/m)?.[1]
    if (id && dir) accounts.push({ id: Number(id), dir })
  }
  if (accounts.length === 0) throw new Error(`no accounts found in ${tomlPath}`)

  const wanted = accountId ?? Number(toml.match(/^\s*selected_account\s*=\s*(\d+)/m)?.[1] ?? accounts[0]!.id)
  const hit = accounts.find((a) => a.id === wanted)
  if (!hit) {
    throw new Error(`account ${wanted} not in ${tomlPath} (have: ${accounts.map((a) => a.id).join(', ')})`)
  }
  return join(dcData, hit.dir)
}

export function readBinding(stateDir: string, chatId: number): { id: string; sessionId: string | null } | null {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir, 'bindings', `${chatId}.json`), 'utf8'))
    if (!raw?.agentId) return null
    return { id: String(raw.agentId), sessionId: raw.sessionId ? String(raw.sessionId) : null }
  } catch {
    return null
  }
}

/** True when `dir` exists and holds anything. */
export function isNonEmptyDir(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0
  } catch {
    return false
  }
}
