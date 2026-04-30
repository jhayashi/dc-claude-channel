/**
 * End-to-end happy-path test for the new-agent flow (Task 11.4).
 *
 * Drives the dispatcher-side build pipeline as the user would experience
 * it from the WebXDC card:
 *   1. User picks Sleep + Stress + Mindfulness on the wall and taps
 *      Build & start chatting → `handleBuildAgent` (the dispatcher
 *      handler the WebXDC `build-agent` payload calls into).
 *   2. Coach asks lead, voice, tools questions in turn; user answers
 *      via `advanceCoach`.
 *   3. Coach hits done → `graduateAgent` writes the AgentDef + Binding,
 *      logs the lifecycle event, and posts the new-chat greeting.
 *
 * Assertions only inspect the public artifacts: agent YAML, binding
 * JSON, lifecycle JSONL log, and the stub DC client's call log.
 * `appSessions` (the agent-setup app's private session map) is NOT
 * touched — going through `onWebXDCUpdate` would require pre-seeding
 * that map and the plan calls that out as off-limits.
 */

import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import * as agents from '../agents.js'
import * as bindings from '../bindings.js'
import * as access from '../access/index.js'
import { setLifecycleEventDir } from '../events-lifecycle.js'
import { setBadgeCacheDir, renderAgentBadge } from '../agent-icon-render.js'
import { setLeavesDir } from '../leaves.js'
import {
  handleBuildAgent,
  graduateAgent,
  coachSessions,
} from '../apps/agent-setup-app.js'
import { advanceCoach, isCoachDone } from '../coach.js'
import type { AppContext } from '../webxdc-app.js'

// ---------- temp dirs ---------------------------------------------------

const agentsDir = mkdtempSync(join(tmpdir(), 'dc-e2e-agents-'))
const bindingsDir = mkdtempSync(join(tmpdir(), 'dc-e2e-bindings-'))
const approvedDir = mkdtempSync(join(tmpdir(), 'dc-e2e-approved-'))
const eventDir = mkdtempSync(join(tmpdir(), 'dc-e2e-events-'))
const badgeDir = mkdtempSync(join(tmpdir(), 'dc-e2e-badges-'))

beforeAll(() => {
  agents.setAgentsDir(agentsDir)
  bindings.setBindingsDir(bindingsDir)
  access.setApprovedDir(approvedDir)
  setLifecycleEventDir(eventDir)
  setBadgeCacheDir(badgeDir)
  setLeavesDir(join(import.meta.dir, '..', 'leaves'))
})

afterAll(() => {
  for (const d of [agentsDir, bindingsDir, approvedDir, eventDir, badgeDir]) {
    rmSync(d, { recursive: true, force: true })
  }
})

// ---------- stubs --------------------------------------------------------

interface StubClient {
  send: ReturnType<typeof mock>
  sendReaction: ReturnType<typeof mock>
  setChatName: ReturnType<typeof mock>
  setChatProfileImage: ReturnType<typeof mock>
  createGroup: ReturnType<typeof mock>
  addContactToChat: ReturnType<typeof mock>
  getChatContacts: ReturnType<typeof mock>
  getFullChat: ReturnType<typeof mock>
  sendWebXDC: ReturnType<typeof mock>
  sendWebXDCUpdate: ReturnType<typeof mock>
  // catch-all
  [k: string]: unknown
}

function makeCtx(opts: {
  newChatId: number
  ownerContactId: number
}): { ctx: AppContext; client: StubClient } {
  let nextMsgId = 1000

  const client: StubClient = {
    send: mock(async (_chatId: number, _text: string) => nextMsgId++),
    sendReaction: mock(async () => {}),
    setChatName: mock(async () => {}),
    setChatProfileImage: mock(async () => {}),
    createGroup: mock(async (_name: string) => opts.newChatId),
    addContactToChat: mock(async () => {}),
    getChatContacts: mock(async () => [1, opts.ownerContactId]),
    getFullChat: mock(async () => ({
      contactIds: [1, opts.ownerContactId],
      pastContactIds: [],
      canSend: true,
      selfInGroup: true,
    })),
    sendWebXDC: mock(async () => nextMsgId++),
    sendWebXDCUpdate: mock(async () => {}),
  }

  const ctx: AppContext = {
    // Cast — only the methods listed above are exercised; anything else
    // would surface as an undefined-call error and fail the test loudly.
    client: client as unknown as AppContext['client'],
    mcp: {} as unknown as AppContext['mcp'],
    isAllowed: (chatId: number) => access.isAllowed(chatId),
    allowedChats: () => access.allowedChats(),
    logf: () => {},
    safeName: (s: string) => s,
    registerWebXDCMsg: () => {},
    unregisterWebXDCMsg: () => {},
    evictSubagent: async () => {},
    getAvailableMcpServers: () => [],
    getConnectedMcpServers: () => [],
    scheduleStore: {} as unknown as AppContext['scheduleStore'],
    subagentCache: { evictChat: async () => {} },
    cleanupChatState: async () => {},
  }

  return { ctx, client }
}

// ---------- the test ----------------------------------------------------

describe('agent-creation E2E (wall → coach → graduation)', () => {
  test('three-leaf mash-up: Sleep / Stress / Mindfulness', async () => {
    const sourceChatId = 100   // user's pairing/home chat
    const newChatId = 200      // chat created by handleBuildAgent
    const ownerContactId = 11

    // Approve the source chat so resolveOwner / isAllowed succeed.
    access.addChat(sourceChatId, ownerContactId)

    const { ctx, client } = makeCtx({ newChatId, ownerContactId })

    // 1. User taps Build & start chatting on the wall (after picking
    //    Sleep coach + Stress + Mindfulness via pairs-with chips).
    //    handleBuildAgent creates the new chat, kicks off a coach
    //    interview, and posts the first question.
    await handleBuildAgent(
      ctx,
      sourceChatId,
      ['sleep-coach', 'stress-management-coach', 'mindfulness-meditation-guide'],
      'checker',
      async () => ownerContactId,
    )

    // Coach session created on the new chat with the chosen leaves.
    const coach = coachSessions.get(newChatId)
    expect(coach).toBeDefined()
    expect(coach!.leafIds).toEqual([
      'sleep-coach',
      'stress-management-coach',
      'mindfulness-meditation-guide',
    ])

    // First question is the lead-pick (none of the three is on Service,
    // so isObviousLead returns null and the lead step fires).
    expect(coach!.coachState.nextQuestion).toMatch(/which of these specialties is the bigger pain/i)

    // Mirror the dispatcher's coach-interception loop (server.ts ~2310):
    // for each user reply, advanceCoach + post the next question (or
    // graduate if done). Using a tiny helper keeps the loop in lockstep
    // with what the production dispatcher does on each inbound message.
    async function userReply(text: string): Promise<void> {
      const s = coachSessions.get(newChatId)
      if (!s) throw new Error('coach session missing')
      s.coachState = advanceCoach(s.coachState, text)
      if (isCoachDone(s.coachState)) {
        await graduateAgent(ctx, newChatId)
      } else if (s.coachState.nextQuestion) {
        await ctx.client.send(newChatId, s.coachState.nextQuestion)
      }
    }

    // 2. User answers lead question — picks Sleep coach.
    await userReply('sleep is destroying me')
    expect(coach!.coachState.answers.leadLeafId).toBe('sleep-coach')

    // 3. Coach now asks voice question.
    expect(coach!.coachState.nextQuestion).toMatch(/how direct/i)
    await userReply('gentle nudge, not drill sergeant')

    // 4. Coach now asks tools question.
    expect(coach!.coachState.nextQuestion).toMatch(/services/i)
    await userReply('connect Oura and Apple Health')

    // 5. Coach is done → graduateAgent ran inside the last userReply.
    //    (also verifies the coach session was torn down on graduation.)
    expect(coachSessions.has(newChatId)).toBe(false)

    // ---- assertion 1: persisted agent + binding -----------------------

    const binding = bindings.getBinding(newChatId)
    expect(binding).not.toBeNull()
    // Agent id is the slugified composed name. Three-leaf mash-up with
    // lead = sleep-coach → "Sleep coach + 2 more" → "sleep-coach-2-more".
    // (The plan's `/^agent-/` placeholder predates synthesizeAgentId
    // landing; assert what the slug actually is so a future change to
    // the slug rule fails this test loudly.)
    expect(binding!.agentId).toBe('sleep-coach-2-more')

    const agent = agents.getAgent(binding!.agentId)
    expect(agent).not.toBeNull()
    const paragraphs = agent!.system.split(/\n\s*\n/).filter(p => p.trim())
    expect(paragraphs.length).toBe(5)              // 5-paragraph structure
    expect(agent!.system).toContain('Sleep coach') // lead leaf named
    expect(agent!.system).toContain('Stress-management coach')
    expect(agent!.system).toContain('Mindfulness & meditation guide')
    // Both `medical` (sleep-coach) and `mental-health` (stress-management-coach)
    // liability frames open with "not a licensed clinician" — assertion
    // covers either / both.
    expect(agent!.system.toLowerCase()).toContain('not a licensed clinician')

    // Metadata — coach answers + leaves persisted for downstream tools.
    expect(agent!.metadata?.['x-dc-leaves']).toEqual([
      'sleep-coach',
      'stress-management-coach',
      'mindfulness-meditation-guide',
    ])
    expect(agent!.metadata?.['x-dc-coach-answers']).toBeDefined()

    // ---- assertion 2: lifecycle event captured -------------------------

    const today = new Date().toISOString().slice(0, 10)
    const logPath = join(eventDir, `agent-lifecycle-${today}.log`)
    expect(existsSync(logPath)).toBe(true)
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n').map(l => JSON.parse(l))
    const grad = lines.find(l => l.kind === 'graduation' && l.chatId === newChatId)
    expect(grad).toBeDefined()
    expect(grad.agentId).toBe(binding!.agentId)
    expect(grad.fromCoach).toBe(true)
    expect(grad.leafIds).toEqual([
      'sleep-coach',
      'stress-management-coach',
      'mindfulness-meditation-guide',
    ])

    // ---- assertion 3: chat avatar swapped ------------------------------

    // graduateAgent calls setAgentIcon which renders + setChatProfileImage.
    expect(client.setChatProfileImage).toHaveBeenCalled()
    // The badge cache holds the rendered PNG for the agent's
    // archetype/family/trust/glyph/pattern combo. (composeAgentName +
    // metadata sets archetype=role, pattern=checker; default model is
    // sonnet; trust default is false; default role glyph is user-round.)
    const badgePath = await renderAgentBadge({
      archetype: 'role',
      modelFamily: 'sonnet',
      trust: false,
      glyph: 'user-round',
      pattern: 'checker',
    })
    expect(existsSync(badgePath)).toBe(true)

    // ---- assertion 4: each coach question + greeting was sent ----------

    const sendCalls = (client.send as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map(args => ({ chatId: args[0] as number, text: args[1] as string }))

    // Lead question (sent right after handleBuildAgent created the chat).
    expect(sendCalls.some(c => c.chatId === newChatId && /which.*bigger pain/i.test(c.text))).toBe(true)
    // Voice question (sent after the lead answer was advanced).
    expect(sendCalls.some(c => c.chatId === newChatId && /how direct/i.test(c.text))).toBe(true)
    // Tools question (sent after the voice answer was advanced).
    expect(sendCalls.some(c => c.chatId === newChatId && /services/i.test(c.text))).toBe(true)
    // Graduation greeting.
    expect(sendCalls.some(c => c.chatId === newChatId && /ready/i.test(c.text))).toBe(true)
    // Chat got renamed to the agent name.
    expect(client.setChatName).toHaveBeenCalledWith(newChatId, expect.stringContaining('Sleep coach'))

    // NOTE: The plan's example also asserts
    //   stubSubagentCache.dispatch.toHaveBeenCalledWith(chatId, { source: 'system' })
    // but graduateAgent does NOT dispatch a synthetic system turn — it
    // sends a plain greeting via `client.send` and lets the subagent
    // spawn lazily on the user's next message (see comment in
    // agent-setup-app.ts:725-735). Asserting reality.
  })
})
