#!/usr/bin/env bun
/**
 * Per-agent contacts dump (v1.4.9, D7).
 *
 * Walks `~/.claude/agents/*.dc/contacts/` and prints a table of
 * (agentId, contactId, role, capabilities, firstPairedAt, displayName).
 * Designed for pre/post-migration diff verification — run before
 * shipping v1.4.9 to see only `claude-code` populated, run after the
 * canonical-seed startup to see records replicated into every bound
 * agent's sidecar.
 *
 * Usage:
 *   bun run scripts/dump-contacts.ts              # human-readable table
 *   bun run scripts/dump-contacts.ts --json       # machine-readable JSON
 *   DC_TEST_CONTACTS_DIR=/tmp/foo bun run … --json  # override base dir
 *
 * Exit codes:
 *   0 — dump complete (zero records is a valid result)
 *   1 — unreadable contacts dir (catastrophic, e.g. permissions)
 *
 * NOTE: this script reads the same DC_TEST_CONTACTS_DIR env var that
 * the dispatcher honors, so test data can be inspected by setting the
 * env var to the test root before running.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

interface ContactRecord {
  agentId: string
  contactId: number
  role: string | null
  capabilities: string[] | null
  firstPairedAt: string | null
  displayName: string | null
  source: string
}

const baseDir = process.env.DC_TEST_CONTACTS_DIR ?? join(homedir(), '.claude', 'agents')

if (!existsSync(baseDir)) {
  console.error(`dump-contacts: base dir does not exist: ${baseDir}`)
  process.exit(1)
}

let entries: string[]
try {
  entries = readdirSync(baseDir)
} catch (err) {
  console.error(`dump-contacts: cannot read base dir ${baseDir}:`, err)
  process.exit(1)
}

const records: ContactRecord[] = []

for (const entry of entries) {
  if (!entry.endsWith('.dc')) continue
  const agentId = entry.slice(0, -'.dc'.length)
  const contactsDir = join(baseDir, entry, 'contacts')
  if (!existsSync(contactsDir)) continue
  let files: string[]
  try {
    files = readdirSync(contactsDir)
  } catch (err) {
    console.error(`dump-contacts: cannot read ${contactsDir}:`, err)
    continue
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const cid = parseInt(f.slice(0, -'.json'.length), 10)
    if (!Number.isFinite(cid)) continue
    const path = join(contactsDir, f)
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'))
      records.push({
        agentId,
        contactId: cid,
        role: parsed.role ?? null,
        capabilities: parsed.capabilities ?? null,
        firstPairedAt: parsed.firstPairedAt ?? null,
        displayName: parsed.displayName ?? null,
        source: path,
      })
    } catch (err) {
      console.error(`dump-contacts: corrupt record ${path}:`, (err as Error).message)
    }
  }
}

records.sort((a, b) => (
  a.agentId.localeCompare(b.agentId) || a.contactId - b.contactId
))

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(records, null, 2) + '\n')
  process.exit(0)
}

// Human-readable table.
if (records.length === 0) {
  console.log(`(no contact records under ${baseDir}/*.dc/contacts/)`)
  process.exit(0)
}

const agentWidth = Math.max(8, ...records.map(r => r.agentId.length))
const roleWidth = Math.max(6, ...records.map(r => (r.role ?? '—').length))
const nameWidth = Math.max(8, ...records.map(r => (r.displayName ?? '—').length))

const header = [
  'agent'.padEnd(agentWidth),
  'cid'.padStart(5),
  'role'.padEnd(roleWidth),
  'display'.padEnd(nameWidth),
  'firstPairedAt',
  'capabilities',
].join('  ')
console.log(header)
console.log('-'.repeat(header.length))

for (const r of records) {
  console.log([
    r.agentId.padEnd(agentWidth),
    String(r.contactId).padStart(5),
    (r.role ?? '—').padEnd(roleWidth),
    (r.displayName ?? '—').padEnd(nameWidth),
    r.firstPairedAt ?? '—',
    JSON.stringify(r.capabilities ?? []),
  ].join('  '))
}

console.log()
console.log(`(${records.length} record(s) across ${new Set(records.map(r => r.agentId)).size} agent(s))`)
