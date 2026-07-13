/**
 * Help card content — the single structured source for #108's help card.
 *
 * Every entry derives from the 2026-07-09 journey validation (42 journeys
 * traced against the implementation) and the help-card design doc
 * (2026-07-10). Phrases are VALIDATED vocabulary — each one routes to a
 * real intent, tool, or card as of v1.4.18+. The Commands topic is
 * generated from slash-commands.ts so the #136 parity guarantee extends
 * to the card.
 *
 * Rules (enforced by test/help-content.test.ts):
 *  - every journey has a body; try-it journeys have >= 1 phrase
 *  - slash phrases must classify to a real router kind (or be
 *    dispatcher-intercepted specials)
 *  - quirk lines stay short (<= 140 chars) — they are footnotes
 *  - phrases with <placeholders> explain the fill-in in their body
 */

import { SLASH_COMMANDS, BLOCKED_COMMANDS } from './slash-commands.js'

export interface JourneyVerify {
  tier: 't1' | 't2' | 't3'
  /** t1: 'slash' | 'nl:<intent>' — what the classifier must return.
   *  t2: 'tool:<dc tool name>' | 'reply' — what the live turn must produce.
   *  t3: free-text pointer into HELP-SMOKE.md. */
  expect: string
  /** t2 only: phrase to actually send in the smoke when the display
   *  phrase contains a <placeholder> or needs fixture-specific wording. */
  smokePhrase?: string
}

export interface HelpJourney {
  /** Stable anchor id (future deep links: #topic/journey). */
  id: string
  title: string
  /**
   * Say-this chips. First is canonical — it's what Try-it drafts.
   * Empty array = explanatory entry, no Try-it button.
   */
  phrases: string[]
  /** Render phrases as slash commands (monospace chip). */
  slash?: boolean
  /** 2–3 sentences: what happens when you say it. */
  body: string
  /** Optional one-line honest caveat. */
  quirk?: string
  /** How later tasks machine-check this journey's phrases (#138). */
  verify?: JourneyVerify
}

export interface HelpTopic {
  id: string
  title: string
  /** Single glyph for the topic tile. */
  glyph: string
  journeys: HelpJourney[]
}

const gettingStarted: HelpTopic = {
  id: 'getting-started',
  title: 'Getting started',
  glyph: '👋',
  journeys: [
    {
      id: 'pairing',
      title: 'Pair your phone',
      phrases: [],
      body:
        'Run /deltachat:setup in your Claude Code terminal, scan the QR with Delta Chat, ' +
        'then type the 5-letter code from the new "Claude" chat back into the terminal. ' +
        'The code expires after an hour; rerun setup for a fresh QR.',
      quirk:
        'The QR pairs your device. To give someone else access, add them to a group with Claude and set their role.',
      verify: { tier: 't3', expect: 'HELP-SMOKE §pairing' },
    },
    {
      id: 'tour',
      title: 'Take (or retake) the tour',
      phrases: ['/tour'],
      slash: true,
      body:
        'A two-minute walkthrough of the three starter apps: the permission prompt, ' +
        'the file reviewer, and the Manage Agents card. Answer yes or no; answering ' +
        'anything else just parks the tour and I answer you normally.',
      verify: { tier: 't1', expect: 'slash' },
    },
    {
      id: 'starter-apps',
      title: 'The three starter apps',
      phrases: [],
      body:
        'Pairing drops three mini-apps into your chat: Permission Prompt (approve or deny ' +
        'sensitive actions), File Reviewer (read and comment on documents), and Manage ' +
        'Agents. Find all apps anytime via the four-boxes icon (⊞) top-right in the chat.',
    },
  ],
}

const chatsAndAgents: HelpTopic = {
  id: 'chats-agents',
  title: 'Chats & new agents',
  glyph: '✨',
  journeys: [
    {
      id: 'default-chat',
      title: 'Just talk',
      phrases: [],
      body:
        'Your paired chat runs the built-in Claude assistant — send any message and the ' +
        'finished reply posts back automatically. A 🔄 reaction means a cold start (~6s); ' +
        'reactions change as I work.',
    },
    {
      id: 'group-offer',
      title: 'Make a group, add Claude',
      phrases: [],
      body:
        'Create a Delta Chat group and add Claude to it — with no agent set up yet, ' +
        'I\'ll offer to create a specialist for that group (or reuse one of your agents).',
      verify: { tier: 't3', expect: 'HELP-SMOKE §native-moments' },
    },
    {
      id: 'browse-catalog',
      title: 'Browse the specialty catalog',
      phrases: ['help me set up an agent', 'what kinds of agents can you be?'],
      body:
        'Opens a catalog of 150+ specialties you can browse, search, and combine (up to ' +
        'three). Pick, tap Build, and I ask 2–3 quick questions in a fresh chat — or say ' +
        '"let\'s go" to skip straight to defaults.',
      verify: { tier: 't2', expect: 'tool:dc_open_create_card' },
    },
    {
      id: 'named-role',
      title: 'Name the role you want',
      phrases: ['make me a sleep coach', 'I want a tax assistant'],
      body:
        'Name a role and the catalog opens at the closest matching specialties. ' +
        'From there it\'s the same pick-and-build flow.',
      verify: { tier: 't2', expect: 'tool:dc_open_create_card' },
    },
    {
      id: 'describe-agent',
      title: 'Describe the whole agent',
      phrases: ['create an agent that summarizes my email every morning'],
      body:
        'Describe what you want end-to-end and I create the agent and a new chat for it ' +
        'directly — no catalog, no interview. Prefer full control? The create card also ' +
        'has a form: name, instructions, model (including custom model IDs), and tools.',
      verify: { tier: 't2', expect: 'tool:dc_create_agent' },
    },
  ],
}

const managingAgents: HelpTopic = {
  id: 'managing',
  title: 'Managing an agent',
  glyph: '🛠️',
  journeys: [
    {
      id: 'list-agents',
      title: 'See your agents',
      phrases: ['show me my agents', 'what agents do I have?'],
      body:
        'Sends the Manage Agents card: every agent with its model, trust badge, and how ' +
        'many chats use it. Tap an agent to edit, export, or delete it.',
      verify: { tier: 't2', expect: 'tool:dc_open_agent_manage_card' },
    },
    {
      id: 'edit-agent',
      title: 'Edit an agent',
      phrases: ['edit this agent'],
      body:
        'Opens the card to change the model (including a custom model ID under "Other"), ' +
        'instructions, tools, trust, and name. Changes take effect on the next message in ' +
        'every chat bound to that agent.',
      quirk: 'Custom model IDs are picker-only — "switch to <custom-id>" won\'t match.',
      verify: { tier: 't2', expect: 'tool:dc_open_agent_manage_card' },
    },
    {
      id: 'rename',
      title: 'Rename an agent',
      phrases: ['rename yourself to Atlas', 'call yourself Scout'],
      body:
        'Renames the agent on the spot — chat names and badges refresh everywhere it\'s ' +
        'used, no restart needed. Swap "Atlas" for whatever name you like.',
      verify: { tier: 't2', expect: 'tool:dc_update_agent' },
    },
    {
      id: 'refine',
      title: 'Refine how it behaves',
      phrases: ["let's refine you", 'be terser'],
      body:
        'I ask one question about what to change, then rewrite my own instructions — ' +
        'same agent, same conversation.',
      verify: { tier: 't1', expect: 'nl:refine' },
    },
    {
      id: 'model-switch',
      title: 'Switch the model',
      phrases: ['switch to opus', 'use haiku'],
      body:
        'Moves this chat\'s agent to the latest model of that tier (haiku/sonnet/opus). ' +
        'Applies from the next message.',
      verify: { tier: 't1', expect: 'nl:model-switch' },
    },
    {
      id: 'trust',
      title: 'Trust mode (skip permission prompts)',
      phrases: ['trust me', 'be safer'],
      body:
        '"Trust me" lets this agent act without permission prompts — everything ' +
        'auto-approves and is logged. "Be safer" turns prompts back on. Takes effect on ' +
        'your next message.',
      verify: { tier: 't1', expect: 'nl:trust-toggle' },
    },
    {
      id: 'memory-boost',
      title: 'Memory boost (auto-recall)',
      phrases: ['turn on memory boost'],
      body:
        'Opens the edit card at the "Auto-recall past messages" switch. When on, relevant ' +
        'older messages are re-injected automatically after long conversations compact. ' +
        'Off by default, per agent.',
      verify: { tier: 't2', expect: 'tool:dc_open_agent_manage_card' },
    },
    {
      id: 'switch-agent',
      title: "Switch this chat's agent",
      phrases: ['switch this chat to <agent name>', 'switch agents'],
      body:
        'Naming the agent switches immediately — fresh conversation unless you ask to ' +
        'keep it. Fill in <agent name> with one of yours; or say "switch agents" to pick ' +
        'from a list.',
      quirk: 'Works in groups too — a chat message from you is verifiable; card taps there are not.',
      verify: { tier: 't2', expect: 'tool:dc_rebind_chat', smokePhrase: 'switch this chat to smoke-target' },
    },
    {
      id: 'delete-agent',
      title: 'Delete an agent',
      phrases: ['delete the <name> agent'],
      body:
        'Fill in <name> with the agent to remove — this opens the Manage Agents card at ' +
        'the confirm step, since deletion is destructive (its chats switch to the default ' +
        'assistant). The built-in default agent can\'t be deleted.',
      verify: { tier: 't2', expect: 'tool:dc_open_agent_manage_card', smokePhrase: 'delete the smoke-target agent' },
    },
    {
      id: 'export-import',
      title: 'Export / import agents',
      phrases: [],
      body:
        'Export from the manage card sends the agent as a .md file — the same format your ' +
        'terminal ~/.claude/agents/ uses. Drop an agent .md (or .yaml) into any chat with ' +
        'me to import it.',
    },
  ],
}

const movingSessions: HelpTopic = {
  id: 'sessions',
  title: 'Moving sessions',
  glyph: '🔁',
  journeys: [
    {
      id: 'teleport-out',
      title: 'Continue this chat in your terminal',
      phrases: ['teleport this session to my terminal', 'resume this in my terminal'],
      body:
        'I post a cd … && claude --resume command here — paste it into your terminal ' +
        'after my reply lands and the session continues exactly where the chat left off. ' +
        'The chat stays in your list, disconnected.',
      quirk: 'Scheduled jobs tied to the chat are deleted unless you move them from the teleport card first.',
      verify: { tier: 't2', expect: 'tool:dc_resume_in_terminal' },
    },
    {
      id: 'import-session',
      title: 'Bring a terminal session into a chat',
      phrases: ['import a terminal session'],
      body:
        'Opens a picker of your recent terminal Claude sessions (last 5 days). Pick one ' +
        'and I create a new chat wired to it — original agent, same conversation, short recap.',
      quirk: "Sessions currently open in a terminal won't appear until you close them.",
      verify: { tier: 't2', expect: 'tool:dc_open_teleport_card' },
    },
    {
      id: 'group-rules',
      title: 'Doing this from a group',
      phrases: [],
      body:
        'In a group I can\'t verify who tapped a card, so teleport taps are refused there. ' +
        'Say it as a normal message instead ("teleport this session to my terminal") — a ' +
        'message from you is verifiable. Importing needs a chat with just the two of us.',
    },
  ],
}

const peoplePermissions: HelpTopic = {
  id: 'people',
  title: 'People & permissions',
  glyph: '🧑‍🤝‍🧑',
  journeys: [
    {
      id: 'roles',
      title: 'What roles mean',
      phrases: [],
      body:
        'Full access can do everything you can. Limited (family) can chat and do ' +
        'low-stakes things. Chat-only (guest) can talk but not act. Blocked people are ' +
        'invisible to the agent: no replies, and their words are hidden from it. ' +
        'Roles are per-agent — your sister can be family for one agent, nothing on another.',
    },
    {
      id: 'assign-by-message',
      title: 'Give someone access',
      phrases: ['give Alice full access', 'make Bob chat-only'],
      body:
        'Say it with the person\'s name in the chat where they act, and it applies ' +
        'immediately from their next message. Works in groups — it\'s your message, so ' +
        'it\'s verifiably you.',
      verify: { tier: 't2', expect: 'tool:dc_set_contact_role', smokePhrase: 'make the other person in this chat chat-only' },
    },
    {
      id: 'contacts-card',
      title: 'The contacts card',
      phrases: ['manage permissions', 'who can use this agent?'],
      body:
        'Shows everyone this agent knows, with a role picker per person. Open it from a ' +
        'chat using the agent whose people you want to manage.',
      quirk: 'In groups the card is view-only — set roles with a message there instead.',
      verify: { tier: 't2', expect: 'tool:dc_open_contacts_card' },
    },
    {
      id: 'new-member',
      title: 'When someone new joins',
      phrases: [],
      body:
        'When a new person joins a chat that has an agent, I offer to set what they\'re ' +
        'allowed to do. Nothing changes until you decide — new people can\'t use the agent ' +
        '(or be read by it) until you give them a role.',
      verify: { tier: 't3', expect: 'HELP-SMOKE §native-moments' },
    },
    {
      id: 'strangers',
      title: 'What strangers experience',
      phrases: [],
      body:
        'People without a role get no reply — even in your groups — and what they write ' +
        'is hidden from the agent unless you explicitly ask it to look, and even then ' +
        'it\'s treated as quoted text, never as instructions.',
    },
  ],
}

const workingTogether: HelpTopic = {
  id: 'working',
  title: 'Working together',
  glyph: '📝',
  journeys: [
    {
      id: 'file-review',
      title: 'Review documents & code',
      phrases: ['send me that as a file to review'],
      body:
        'Long documents arrive as a tappable reviewer card — comment on any line or ' +
        'paragraph and send; I apply your comments and send the file back. Reviewed files ' +
        'stay dismissed once your comments are sent.',
      verify: { tier: 't2', expect: 'tool:dc_send_file' },
    },
    {
      id: 'visual-apps',
      title: 'Visual apps: mockups, charts, games',
      phrases: ['build me a <thing> as an app'],
      body:
        'Ask for anything visual and I build a small app right in the chat — it stays in ' +
        'Delta Chat\'s app list, works on any device, and you can forward it to friends. ' +
        'Fill in <thing>: a game, a chart of your data, a UI mockup.',
      verify: { tier: 't2', expect: 'tool:dc_send_webxdc', smokePhrase: 'build me a tiny tic-tac-toe game as an app' },
    },
    {
      id: 'edit-message',
      title: 'Fix your last message',
      phrases: [],
      body:
        'Edit your most recent message in Delta Chat and I stop what I\'m doing and ' +
        'answer the corrected version instead — no need to repeat yourself.',
      verify: { tier: 't3', expect: 'HELP-SMOKE §edit-message' },
    },
    {
      id: 'stop',
      title: 'Stop me mid-task',
      phrases: ['/stop'],
      slash: true,
      body:
        'Halts the current turn immediately; your session survives and the next message ' +
        'continues where we left off. /clear stops AND wipes the session for a fresh start.',
      verify: { tier: 't1', expect: 'slash' },
    },
    {
      id: 'permission-prompts',
      title: 'Permission prompts',
      phrases: [],
      body:
        'When I need to do something sensitive you get a tappable card — Allow or Deny, ' +
        'one decision per request. No answer within ~5 minutes counts as Deny, and ' +
        'anything blocked is summarized at the end of the turn.',
      verify: { tier: 't3', expect: 'HELP-SMOKE §permissions' },
    },
  ],
}

const automationMemory: HelpTopic = {
  id: 'automation',
  title: 'Automation & memory',
  glyph: '⏰',
  journeys: [
    {
      id: 'schedules',
      title: 'Scheduled jobs',
      phrases: ['every morning at 8, send me the news'],
      body:
        'Ask in plain language and the job runs on schedule — even when the chat is idle, ' +
        'surviving restarts. A job belongs to the chat that created it; manage it from ' +
        'the same chat. /export-schedules backs them up as a file.',
      verify: { tier: 't2', expect: 'tool:dc_schedule', smokePhrase: 'every day at 23:57, say goodnight in this chat' },
    },
    {
      id: 'chat-search',
      title: 'Search this chat\'s history',
      phrases: ['search this chat for <topic>'],
      body:
        'Fill in <topic> with what you\'re looking for — I search the full history of ' +
        'this chat on demand. With memory boost on (see Managing an agent), relevant ' +
        'older messages also come back automatically in long conversations.',
      verify: { tier: 't2', expect: 'tool:dc_search_messages', smokePhrase: 'search this chat for goodnight' },
    },
    {
      id: 'agent-memory',
      title: 'What an agent remembers',
      phrases: ['what do you remember?'],
      body:
        'Each agent keeps its own long-term memory, shared across every chat using that ' +
        'agent — and with your terminal sessions of the same agent. Tell it "remember X" ' +
        'in any of them.',
      quirk: '/memory shows the project memory index — for the agent\'s own memory, just ask it.',
      verify: { tier: 't2', expect: 'reply' },
    },
    {
      id: 'voice',
      title: 'Voice messages',
      phrases: [],
      body:
        'Record a voice message and it\'s transcribed on-device (nothing leaves your ' +
        'machine), echoed back as 🎙️ text so you can verify, and answered like a typed ' +
        'message.',
      quirk: 'Only recorded voice messages transcribe — audio file attachments don\'t.',
      verify: { tier: 't3', expect: 'HELP-SMOKE §voice' },
    },
  ],
}

/** The Commands topic is GENERATED from slash-commands.ts (#136 parity). */
function commandsTopic(): HelpTopic {
  const journeys: HelpJourney[] = SLASH_COMMANDS.map((row, i) => ({
    id: `cmd-${row.cmd}-${i}`,
    title: `/${row.cmd}${row.args ? ' ' + row.args : ''}`,
    phrases: [`/${row.cmd}`],
    slash: true,
    verify: { tier: 't1', expect: 'slash' },
    body: row.blurb.charAt(0).toUpperCase() + row.blurb.slice(1) + '.' +
      (row.aliases?.length ? ` Also answers to ${row.aliases.map(a => `/${a}`).join(', ')}.` : ''),
  }))
  journeys.push({
    id: 'cmd-diagnostics',
    title: 'What did you do today?',
    phrases: ['what did you do today?', 'are you connected?'],
    body:
      'Ask and I send an audit file of every tool call, turn, and permission decision ' +
      '(last 24h by default) that you can scroll and comment on. "Are you connected?" ' +
      'returns my address and invite link.',
    verify: { tier: 't2', expect: 'tool:dc_show_events' },
  })
  journeys.push({
    id: 'cmd-blocked',
    title: 'Terminal-only commands',
    phrases: [],
    body:
      `${BLOCKED_COMMANDS.map(c => `/${c}`).join(', ')} exist in the Claude Code ` +
      'terminal but have no chat equivalent. Any other /command is forwarded to me as ' +
      'a skill invocation.',
  })
  return { id: 'commands', title: 'Commands & diagnostics', glyph: '⌨️', journeys }
}

export const HELP_TOPICS: readonly HelpTopic[] = [
  gettingStarted,
  chatsAndAgents,
  managingAgents,
  movingSessions,
  peoplePermissions,
  workingTogether,
  automationMemory,
  commandsTopic(),
]
