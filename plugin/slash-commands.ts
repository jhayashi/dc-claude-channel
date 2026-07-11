/**
 * The structured slash-command table — the single source of truth for
 * everything that documents commands (#108 increment 1, #136 lesson).
 *
 * Consumers:
 *  - slash-handler.ts: HELP_TEXT is GENERATED from this table (buildHelpText)
 *  - slash-router.ts: the terminal-only blocked set imports BLOCKED_COMMANDS
 *  - help-content.ts (help card, #108): the Commands topic maps these rows
 *  - test/help-text-parity.test.ts: pins the table ↔ router ↔ text triangle
 *
 * Adding a command: add the router case (slash-router.ts), then a row here —
 * the parity suite fails until both exist and agree. Never hand-edit
 * HELP_TEXT prose again.
 */

export interface SlashCommandDoc {
  /** Primary command name, without the slash. */
  cmd: string
  /** Display-only argument signature, e.g. '<haiku|sonnet|opus>'. */
  args?: string
  /** One-line description shown in /help and the help card. */
  blurb: string
  /** Alternate names the router accepts (same behavior). */
  aliases?: string[]
  /**
   * Where the command is handled:
   *  - 'router': classified by slash-router.ts and handled in slash-handler.ts
   *  - 'dispatcher': intercepted in server.ts BEFORE the classifier
   *    (must never collide with a router command — the intercept wins)
   */
  source: 'router' | 'dispatcher'
}

export const SLASH_COMMANDS: readonly SlashCommandDoc[] = [
  { cmd: 'help', blurb: 'show this list', source: 'router' },
  { cmd: 'stop', blurb: 'stop the current turn; resume on next message', source: 'router' },
  { cmd: 'clear', blurb: 'stop + wipe session (next message starts completely fresh)', source: 'router' },
  {
    cmd: 'model', args: '<haiku|sonnet|opus>',
    blurb: "switch the bound agent's model (curated tiers only; custom model IDs are set from the agent edit card)",
    source: 'router',
  },
  {
    cmd: 'effort', args: '<low|medium|high|xhigh|max|default>',
    blurb: "set the agent's reasoning effort",
    source: 'router',
  },
  { cmd: 'compact', blurb: 'compact conversation context', source: 'router' },
  { cmd: 'usage', blurb: '7-day token usage report with chart', aliases: ['cost'], source: 'router' },
  { cmd: 'think', args: '<question>', blurb: 'engage extended thinking before responding', source: 'router' },
  { cmd: 'ultrathink', args: '<question>', blurb: 'engage maximum extended thinking', source: 'router' },
  { cmd: 'plan', args: '[task]', blurb: 'enter plan mode (no changes until you approve)', source: 'router' },
  { cmd: 'exit-plan', blurb: 'exit plan mode and execute the approved plan', source: 'router' },
  { cmd: 'memory', blurb: 'show memory index', source: 'router' },
  { cmd: 'memory', args: 'show <key>', blurb: 'show a specific memory entry', source: 'router' },
  { cmd: 'mcp', blurb: 'list configured MCP servers', source: 'router' },
  { cmd: 'plugin', blurb: 'list installed plugins', aliases: ['plugins'], source: 'router' },
  { cmd: 'tour', blurb: 'restart the onboarding tour', aliases: ['tutorial'], source: 'dispatcher' },
  { cmd: 'export-schedules', blurb: "export this chat's recurring jobs as a file", aliases: ['export-schedule'], source: 'dispatcher' },
]

/**
 * Commands that exist in the terminal CLI but have no chat equivalent.
 * slash-router.ts derives its blocked set from this list.
 */
export const BLOCKED_COMMANDS: readonly string[] = [
  'config',
  'keybindings',
  'keybindings-help',
  'update-config',
  'loop',
  'schedule',
]

/** Render the /help text from the table. slash-handler exports the result. */
export function buildHelpText(): string {
  const lines = SLASH_COMMANDS.map(row => {
    const args = row.args ? ` ${row.args}` : ''
    const aliases = row.aliases?.length
      ? ` (alias: ${row.aliases.map(a => `/${a}`).join(', ')})`
      : ''
    return `/${row.cmd}${args} — ${row.blurb}${aliases}`
  })
  const blocked = BLOCKED_COMMANDS.map(c => `/${c}`).join(', ')
  return [
    'Available commands:',
    ...lines,
    `Terminal-only (not available in chat): ${blocked}`,
    'Other /commands are forwarded to Claude as skill invocations.',
  ].join('\n')
}
