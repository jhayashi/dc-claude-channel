import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { handleTeleportOutCommit, handleResumeAttach } from '../apps/teleport-app.js'
import * as resume from '../resume.js'
import * as bindings from '../bindings.js'
import * as agents from '../agents.js'
import * as sessionAgents from '../session-agents.js'
import * as access from '../access/index.js'

// #137: the full teleport out → resume attach round trip, filesystem-only.
// The one production seam this needed was handleResumeAttach's injectable
// sessionLive/listCandidates (the real ones shell to fuser and scan /proc).
// Guards the journey end to end: a chat teleported out and re-imported
// recovers its ORIGINAL agent via the session-agents index (which
// deliberately survives binding deletion), the same session id, and the
// lossless inline cwd.

const OUT_CHAT = 500
const OWNER = 11
const NEW_CHAT = 600
const SID = 'abcd1234-1111-2222-3333-444455556666'

describe('teleport out → attach round trip (#137)', () => {
  let tmp: string
  let workDir: string
  const authOk = async () => ({ ok: true }) as const

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'rt-'))
    workDir = join(tmp, 'project'); mkdirSync(workDir)
    agents.setAgentsDir(join(tmp, 'agents'))
    bindings.setBindingsDir(join(tmp, 'bindings'))
    sessionAgents.setIndexDir(join(tmp, 'session-agents'))
    access.setContactsAgentsDir(join(tmp, 'contacts'))
    resume.setProjectsRoot(join(tmp, 'projects'))

    agents.saveAgent({
      name: 'rt-agent', description: 't', model: 'claude-sonnet-5', body: 'x',
    } as agents.AgentDef)
    // Binding with sessionId+agentId — saveBinding records the
    // session-agents index entry that attach later recovers from.
    bindings.saveBinding({
      chatId: OUT_CHAT, agentId: 'rt-agent', inheritClaudeMd: false,
      sessionId: SID, workingDir: workDir, createdAt: new Date().toISOString(),
    })
    access.addChat(OUT_CHAT, OWNER)
    // The session .jsonl with the lossless inline cwd.
    const projDir = join(tmp, 'projects', resume.projectHashForCwd(workDir))
    mkdirSync(projDir, { recursive: true })
    writeFileSync(join(projDir, `${SID}.jsonl`), JSON.stringify({ cwd: workDir, type: 'user' }) + '\n')
  })

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  })

  test('out then attach recovers agent, session, and cwd', async () => {
    // ── OUT ──
    const sentOut: string[] = []
    const updatesOut: any[] = []
    const ctxOut: any = {
      client: {
        getChatName: async () => 'RT Chat',
        send: async (_c: number, text: string) => { sentOut.push(text); return 1 },
        sendWebXDCUpdate: async (_m: number, u: string) => { updatesOut.push(JSON.parse(u).payload) },
      },
      subagentCache: { evictChat: async () => {} },
      scheduleStore: { deleteForChat: () => 0, moveForChat: () => 0 },
      cleanupChatState: async (chatId: number) => { bindings.deleteBinding(chatId) },
      logf: () => {},
    }
    await handleTeleportOutCommit(ctxOut, 90, { requestId: 1, chatId: OUT_CHAT }, authOk)

    const done = updatesOut.find(p => p.type === 'teleport_out_done')
    expect(done).toBeTruthy()
    expect(done.command).toContain(`claude --resume ${SID}`)
    expect(done.command).toContain(`cd ${workDir}`)
    // command was delivered into the chat before teardown
    expect(sentOut.some(t => t.includes(SID))).toBe(true)
    // binding is gone; the session-agents index survives (by design)
    expect(bindings.getBinding(OUT_CHAT)).toBeNull()
    expect(sessionAgents.getAgentForSession(SID)).toBe('rt-agent')

    // ── ATTACH ──
    const updatesIn: any[] = []
    const ctxIn: any = {
      client: {
        createGroup: async () => NEW_CHAT,
        addContactToChat: async () => {},
        getChatContacts: async () => [1, OWNER],
        setChatProfileImage: async () => {},
        setChatName: async () => {},
        send: async () => 2,
        sendWebXDCUpdate: async (_m: number, u: string) => { updatesIn.push(JSON.parse(u).payload) },
      },
      logf: () => {},
    }
    await handleResumeAttach(
      ctxIn, 91, OUT_CHAT /*source*/, { requestId: 2, sessionId: SID }, authOk,
      { sessionLive: () => false, listCandidates: () => [] },
    )

    const ok = updatesIn.find(p => p.type === 'resume_attach_ok')
    expect(ok).toBeTruthy()
    // the new chat recovered the ORIGINAL agent through the index
    const newBinding = bindings.getBinding(NEW_CHAT)
    expect(newBinding).not.toBeNull()
    expect(newBinding!.agentId).toBe('rt-agent')
    expect(newBinding!.sessionId).toBe(SID)
    expect(newBinding!.workingDir).toBe(workDir)
  })

  test('attach refuses a session that is live in a terminal', async () => {
    bindings.deleteBinding(OUT_CHAT) // free the session for attach
    const updatesIn: any[] = []
    const ctxIn: any = {
      client: {
        getChatContacts: async () => [1, OWNER],
        sendWebXDCUpdate: async (_m: number, u: string) => { updatesIn.push(JSON.parse(u).payload) },
      },
      logf: () => {},
    }
    await handleResumeAttach(
      ctxIn, 91, OUT_CHAT, { requestId: 3, sessionId: SID }, authOk,
      { sessionLive: () => true, listCandidates: () => [] },
    )
    const err = updatesIn.find(p => p.type === 'resume_attach_err')
    expect(err).toBeTruthy()
    expect(err.message).toContain('active in a terminal')
  })
})
