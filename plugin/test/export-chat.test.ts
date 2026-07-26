import { describe, test, expect, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  attachmentKind,
  buildMessages,
  isNonEmptyDir,
  parseParam,
  readBinding,
  renderTranscript,
  resolveAccountDir,
  sanitiseFilename,
  selectChat,
  speakerFor,
  summarise,
  writeExport,
  EXPORT_SCHEMA_VERSION,
  type BuildContext,
  type ChatRow,
  type ContactRow,
  type ExportManifest,
  type MsgRow,
} from '../export-chat'

const tmpDirs: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

const CHAT: ChatRow = { id: 30, type: 120, name: 'Health - Family Q&A' }

function ctxWith(blobDir: string, overrides: Partial<BuildContext> = {}): BuildContext {
  const contacts = new Map<number, ContactRow>([
    // The real chat-30 owner: empty `name`, authname "Joe". The fallback
    // chain is load-bearing, not decorative.
    [11, { id: 11, addr: 'joe@example.org', name: '', authname: 'Joe' }],
    [12, { id: 12, addr: 'nameless@example.org', name: '', authname: '' }],
  ])
  return {
    chat: CHAT,
    contacts,
    selfName: 'healthcare-question-helper',
    selfAddr: 'agent@example.org',
    blobDir,
    ...overrides,
  }
}

describe('parseParam', () => {
  test('splits newline-separated key=value', () => {
    expect(parseParam('c=1\nf=$BLOBDIR/a.jpg\nm=image/jpeg\nv=photo.jpg')).toEqual({
      c: '1',
      f: '$BLOBDIR/a.jpg',
      m: 'image/jpeg',
      v: 'photo.jpg',
    })
  })

  test('keeps = inside a value', () => {
    expect(parseParam('E=index.html#file-a=b\nS=32')).toEqual({ E: 'index.html#file-a=b', S: '32' })
  })

  test('tolerates null, empty and malformed lines', () => {
    expect(parseParam(null)).toEqual({})
    expect(parseParam('')).toEqual({})
    expect(parseParam('\n=novalue\nbare\nk=v')).toEqual({ k: 'v' })
  })
})

describe('attachmentKind', () => {
  test('maps dc-core message types', () => {
    expect(attachmentKind(20, 'image/jpeg')).toBe('image')
    expect(attachmentKind(23, 'image/webp')).toBe('image')
    expect(attachmentKind(41, 'audio/ogg')).toBe('audio')
    expect(attachmentKind(50, 'video/mp4')).toBe('video')
    expect(attachmentKind(60, 'application/pdf')).toBe('file')
    expect(attachmentKind(10, null)).toBe('file')
  })

  test('webxdc wins on mime even when the type says otherwise', () => {
    expect(attachmentKind(60, 'application/webxdc+zip')).toBe('webxdc')
    expect(attachmentKind(80, null)).toBe('webxdc')
  })
})

describe('sanitiseFilename', () => {
  test('keeps spaces and hyphens', () => {
    expect(sanitiseFilename('MyMountSinai - Note from Care Team.pdf', 'x')).toBe(
      'MyMountSinai - Note from Care Team.pdf',
    )
  })

  test('cannot escape the attachments dir', () => {
    // Slashes become underscores first, then any leading dots are stripped,
    // so no output can be a relative path.
    expect(sanitiseFilename('../../etc/passwd', 'x')).toBe('_.._etc_passwd')
    expect(sanitiseFilename('a/b\\c.txt', 'x')).toBe('a_b_c.txt')
  })

  test('falls back when nothing survives', () => {
    expect(sanitiseFilename('...', 'blob.bin')).toBe('blob.bin')
    expect(sanitiseFilename('', 'blob.bin')).toBe('blob.bin')
  })

  test('truncates very long names', () => {
    expect(sanitiseFilename('a'.repeat(300), 'x')).toHaveLength(120)
  })
})

describe('selectChat', () => {
  const chats: ChatRow[] = [
    { id: 1, type: 120, name: 'deaddrop' },
    { id: 3, type: 120, name: 'trash' },
    { id: 17, type: 120, name: 'Misc' },
    { id: 25, type: 120, name: 'DC Coding Chat' },
    { id: 30, type: 120, name: 'Health - Family Q&A' },
    { id: 42, type: 120, name: 'DC Coding A' },
  ]

  test('selects by numeric id', () => {
    const r = selectChat(chats, '30')
    expect(r.ok && r.chat.name).toBe('Health - Family Q&A')
  })

  test('never selects a dc-core special chat', () => {
    expect(selectChat(chats, '3')).toEqual({ ok: false, reason: 'none', candidates: [] })
    expect(selectChat(chats, 'trash')).toEqual({ ok: false, reason: 'none', candidates: [] })
  })

  test('selects by case-insensitive substring', () => {
    const r = selectChat(chats, 'health - family')
    expect(r.ok && r.chat.id).toBe(30)
  })

  test('reports ambiguity with candidates instead of guessing', () => {
    const r = selectChat(chats, 'DC Coding')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('ambiguous')
      expect(r.candidates.map((c) => c.id)).toEqual([25, 42])
    }
  })

  test('an exact name match beats substring matches', () => {
    const withSuper: ChatRow[] = [...chats, { id: 50, type: 120, name: 'Miscellaneous' }]
    const r = selectChat(withSuper, 'Misc')
    expect(r.ok && r.chat.id).toBe(17)
  })

  test('unknown selector', () => {
    expect(selectChat(chats, 'nope')).toEqual({ ok: false, reason: 'none', candidates: [] })
  })
})

describe('speakerFor', () => {
  const ctx = ctxWith('/nonexistent')

  test('contact 1 is the agent, named from the binding', () => {
    expect(speakerFor(1, ctx)).toEqual({
      contactId: 1,
      name: 'healthcare-question-helper',
      addr: 'agent@example.org',
      role: 'agent',
    })
  })

  test('contact 2 is dc-core system', () => {
    expect(speakerFor(2, ctx).role).toBe('system')
  })

  test('human name falls back name to authname to addr', () => {
    expect(speakerFor(11, ctx).name).toBe('Joe')
    expect(speakerFor(12, ctx).name).toBe('nameless@example.org')
    expect(speakerFor(99, ctx).name).toBe('contact 99')
    expect(speakerFor(11, ctx).role).toBe('human')
  })
})

describe('buildMessages', () => {
  const blobDir = tmp('dc-export-blobs-')

  test('an S= param classifies the message as system', () => {
    const rows: MsgRow[] = [
      { id: 4045, from_id: 1, timestamp: 1777987000, type: 10, txt: 'You changed group name', param: 'E=New agent\nS=2\nb=1' },
      { id: 4046, from_id: 11, timestamp: 1777987100, type: 10, txt: 'hello', param: 'c=1' },
    ]
    const [sys, dlg] = buildMessages(rows, ctxWith(blobDir))
    expect(sys!.kind).toBe('system')
    expect(sys!.systemCmd).toBe(2)
    expect(dlg!.kind).toBe('dialogue')
    expect(dlg!.systemCmd).toBeNull()
  })

  test('an upload keeps its caption, its original name and its uploader', () => {
    const rows: MsgRow[] = [
      {
        id: 4285,
        from_id: 11,
        timestamp: 1778032262,
        type: 20,
        txt: 'These are the medications they gave him already',
        param: 'c=1\nf=$BLOBDIR/bbea9f2ea4cff13208818a07c00d660.jpg\nm=image/jpeg\nv=image_2026-05-06_01-51-02.jpg',
      },
    ]
    const [m] = buildMessages(rows, ctxWith(blobDir))
    expect(m!.text).toBe('These are the medications they gave him already')
    expect(m!.attachments).toHaveLength(1)
    const a = m!.attachments[0]!
    expect(a.originalName).toBe('image_2026-05-06_01-51-02.jpg')
    expect(a.path).toBe('attachments/4285-image_2026-05-06_01-51-02.jpg')
    expect(a.kind).toBe('image')
    expect(a.uploadedBy).toBe('human')
    expect(a.blobPath).toBe(join(blobDir, 'bbea9f2ea4cff13208818a07c00d660.jpg'))
  })

  test('a file the agent sent is not an upload', () => {
    const rows: MsgRow[] = [
      { id: 4471, from_id: 1, timestamp: 1778090866, type: 80, txt: '', param: 'f=$BLOBDIR/x.xdc\nm=application/webxdc+zip\nv=file-reviewer.xdc' },
    ]
    const [m] = buildMessages(rows, ctxWith(blobDir))
    expect(m!.attachments[0]!.uploadedBy).toBe('agent')
    expect(m!.attachments[0]!.kind).toBe('webxdc')
  })

  test('timestamps become ISO strings', () => {
    const rows: MsgRow[] = [{ id: 1, from_id: 11, timestamp: 1778032262, type: 10, txt: 'x', param: '' }]
    expect(buildMessages(rows, ctxWith(blobDir))[0]!.ts).toBe('2026-05-06T01:51:02.000Z')
  })
})

describe('writeExport', () => {
  function fixture() {
    const blobDir = tmp('dc-export-blobs-')
    const outDir = tmp('dc-export-out-')
    writeFileSync(join(blobDir, 'good.pdf'), 'PDF BYTES')
    const rows: MsgRow[] = [
      { id: 100, from_id: 11, timestamp: 1778032262, type: 60, txt: 'progress notes', param: 'f=$BLOBDIR/good.pdf\nm=application/pdf\nv=Note from Care Team.pdf' },
      { id: 101, from_id: 1, timestamp: 1778032300, type: 10, txt: 'Got it.', param: '' },
      { id: 102, from_id: 11, timestamp: 1778032400, type: 20, txt: '', param: 'f=$BLOBDIR/gone.jpg\nm=image/jpeg\nv=lost.jpg' },
    ]
    const messages = buildMessages(rows, ctxWith(blobDir))
    const manifest: ExportManifest = {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      tool: 'test',
      exportedAt: '2026-07-26T00:00:00.000Z',
      source: { stateDir: '/s', accountDir: '/a', dbPath: '/a/dc.db' },
      chat: { id: 30, name: CHAT.name, type: 120, isGroup: true },
      agent: { id: 'healthcare-question-helper', sessionId: 'abc' },
      participants: [messages[0]!.from, messages[1]!.from],
      counts: summarise(messages),
    }
    const { warnings } = writeExport(outDir, manifest, messages)
    return { outDir, manifest, messages, warnings }
  }

  test('copies the attachment under <msgId>-<original name>', () => {
    const { outDir } = fixture()
    const p = join(outDir, 'attachments', '100-Note from Care Team.pdf')
    expect(existsSync(p)).toBe(true)
    expect(readFileSync(p, 'utf8')).toBe('PDF BYTES')
  })

  test('records size and digest', () => {
    const { messages } = fixture()
    const a = messages[0]!.attachments[0]!
    expect(a.bytes).toBe(9)
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(a.missing).toBe(false)
  })

  test('a missing blob warns but does not abort the export', () => {
    const { outDir, messages, warnings, manifest } = fixture()
    expect(messages[2]!.attachments[0]!.missing).toBe(true)
    expect(warnings.some((w) => w.includes('102'))).toBe(true)
    expect(manifest.counts.attachmentsMissing).toBe(1)
    // Everything else still landed.
    expect(existsSync(join(outDir, 'transcript.md'))).toBe(true)
    expect(existsSync(join(outDir, 'messages.jsonl'))).toBe(true)
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(true)
  })

  test('counts distinguish who uploaded what', () => {
    const { manifest } = fixture()
    expect(manifest.counts.messages).toBe(3)
    expect(manifest.counts.attachments).toBe(2)
    expect(manifest.counts.attachmentsUploadedByHuman).toBe(2)
  })

  test('jsonl drops the absolute blob path but keeps the citable id', () => {
    const { outDir } = fixture()
    const lines = readFileSync(join(outDir, 'messages.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    const first = JSON.parse(lines[0]!)
    expect(first.msgId).toBe(100)
    expect(first.chatId).toBe(30)
    expect(first.from.name).toBe('Joe')
    expect(first.attachments[0].blobPath).toBeUndefined()
    expect(first.attachments[0].path).toBe('attachments/100-Note from Care Team.pdf')
  })

  test('transcript and jsonl cite the same message ids', () => {
    const { outDir } = fixture()
    const md = readFileSync(join(outDir, 'transcript.md'), 'utf8')
    const jsonlIds = readFileSync(join(outDir, 'messages.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).msgId)
    for (const id of jsonlIds) expect(md).toContain(`## [${id}]`)
  })

  test('the transcript says who uploaded a file, next to what they said', () => {
    const { outDir } = fixture()
    const md = readFileSync(join(outDir, 'transcript.md'), 'utf8')
    expect(md).toContain('progress notes')
    expect(md).toContain('**uploaded** `Note from Care Team.pdf`')
    expect(md).toContain('attachments/100-Note from Care Team.pdf')
    expect(md).toContain('FILE MISSING FROM BLOB DIR')
  })
})

describe('renderTranscript', () => {
  test('states the citation rule so a reader of the markdown alone can obey it', () => {
    const messages = buildMessages(
      [{ id: 7, from_id: 11, timestamp: 1778032262, type: 10, txt: 'hi', param: '' }],
      ctxWith('/nonexistent'),
    )
    const manifest: ExportManifest = {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      tool: 'test',
      exportedAt: '2026-07-26T00:00:00.000Z',
      source: { stateDir: '/s', accountDir: '/a', dbPath: '/a/dc.db' },
      chat: { id: 30, name: CHAT.name, type: 120, isGroup: true },
      agent: { id: 'healthcare-question-helper', sessionId: null },
      participants: [messages[0]!.from],
      counts: summarise(messages),
    }
    const md = renderTranscript(manifest, messages)
    expect(md).toContain('chat:30/msg:<id>')
    expect(md).toContain('# Health - Family Q&A')
    expect(md).toContain('healthcare-question-helper')
  })
})

describe('resolveAccountDir', () => {
  function stateDirWith(toml: string): string {
    const d = tmp('dc-export-state-')
    mkdirSync(join(d, 'dc-data'), { recursive: true })
    writeFileSync(join(d, 'dc-data', 'accounts.toml'), toml)
    return d
  }

  test('follows selected_account', () => {
    const d = stateDirWith(
      'selected_account = 2\nnext_id = 3\n\n[[accounts]]\nid = 1\ndir = "aaa"\n\n[[accounts]]\nid = 2\ndir = "bbb"\n',
    )
    expect(resolveAccountDir(d)).toBe(join(d, 'dc-data', 'bbb'))
  })

  test('--account overrides it', () => {
    const d = stateDirWith(
      'selected_account = 2\n\n[[accounts]]\nid = 1\ndir = "aaa"\n\n[[accounts]]\nid = 2\ndir = "bbb"\n',
    )
    expect(resolveAccountDir(d, 1)).toBe(join(d, 'dc-data', 'aaa'))
  })

  test('names the file when it is missing', () => {
    expect(() => resolveAccountDir(tmp('dc-export-empty-'))).toThrow(/accounts\.toml/)
  })

  test('rejects an unknown account id', () => {
    const d = stateDirWith('selected_account = 1\n\n[[accounts]]\nid = 1\ndir = "aaa"\n')
    expect(() => resolveAccountDir(d, 9)).toThrow(/account 9/)
  })
})

describe('readBinding', () => {
  test('reads agentId and sessionId', () => {
    const d = tmp('dc-export-bind-')
    mkdirSync(join(d, 'bindings'), { recursive: true })
    writeFileSync(
      join(d, 'bindings', '30.json'),
      JSON.stringify({ chatId: 30, agentId: 'health-helper', sessionId: 'uuid-1' }),
    )
    expect(readBinding(d, 30)).toEqual({ id: 'health-helper', sessionId: 'uuid-1' })
  })

  test('an unbound chat is not an error', () => {
    expect(readBinding(tmp('dc-export-bind-'), 99)).toBeNull()
  })
})

describe('isNonEmptyDir', () => {
  test('false for missing and empty, true for occupied', () => {
    const d = tmp('dc-export-empty-')
    expect(isNonEmptyDir(join(d, 'nope'))).toBe(false)
    expect(isNonEmptyDir(d)).toBe(false)
    writeFileSync(join(d, 'f'), 'x')
    expect(isNonEmptyDir(d)).toBe(true)
  })
})
