/**
 * One persistent `claude -p` child process, bound to a single chat.
 *
 * Copied from plugin/spikes/1a-named-sessions.ts with typed events
 * and a single-inflight send API.
 *
 * Contract:
 *   - Caller creates one SubagentProcess per chat.
 *   - Caller calls send(text) to forward a user message; only one
 *     send can be in flight at a time (enforced).
 *   - Caller awaits the returned Promise for the assistant's text
 *     response and the array of permission_denials from that turn.
 *   - Caller calls close() on eviction/shutdown.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { EffortLevel } from '../models.js'

interface StreamFrame {
  type: string
  subtype?: string
  result?: string
  duration_ms?: number
  permission_denials?: Array<{ tool_name?: string; tool_input?: { command?: string } }>
  [k: string]: unknown
}

export interface SubagentSpawnOptions {
  chatId: number
  subagentId: string
  /** Path to the generated per-subagent settings.json with the hook config. */
  settingsPath: string
  /** Path to the per-subagent mcp-config.json (loads dc tools-proxy). */
  mcpConfigPath?: string
  dispatcherSocket: string
  dispatcherSecret: string
  hookTimeoutSec?: number
  /**
   * Stable per-chat session id. Required. The first spawn for a chat
   * passes a fresh UUID with `resume: false` (creates the session); every
   * subsequent (re)spawn passes the same UUID with `resume: true` so the
   * child rehydrates the prior in-process turn history.
   */
  sessionId: string
  /** If true, use `--resume <sessionId>` instead of `--session-id <sessionId>`. */
  resume: boolean
  /** Working directory for the subagent. Defaults to process.cwd(). */
  cwd?: string
  /** Additional directories the subagent is allowed to touch. */
  addDirs?: string[]
  /** Override the model (e.g. 'claude-opus-4-6'). Defaults to CLI default. */
  model?: string
  /** Reasoning effort level. Passed as `--effort <level>` if set; CLI uses its persisted default otherwise. */
  effort?: EffortLevel
  /** Agent display name (e.g. 'Marketing Agent'). */
  agentName?: string
  /** Owner's display name from the DC contact card. */
  userName?: string
  /** Claude Code CLI version string (e.g. '2.1.100'). */
  claudeVersion?: string
  /** Session display name (synced with DC chat name). Passed as `--name`. */
  sessionName?: string
  /** Extra system prompt appended to the standard env block. */
  systemPrompt?: string
  /**
   * If true, attempt to suppress the user-level CLAUDE.md from being loaded.
   * Phase 1: this is currently a no-op — there is no verified CLI flag for
   * this and the plan defers the toggle to Phase 2. Accepted here so callers
   * can pass it without breaking when the mechanism lands.
   */
  suppressUserClaudeMd?: boolean
  logf?: (fmt: string, ...args: unknown[]) => void
  /**
   * Restrict which built-in tools the subagent can use.
   * null or undefined → all built-in tools allowed (default).
   * [] → no built-in tools (only MCP prefixes).
   * ['Read', 'Grep'] → only those built-ins.
   */
  allowedBuiltinTools?: string[] | null
  /**
   * Restrict which MCP servers the subagent can use.
   * null or undefined → all known servers allowed (default).
   * [] → no MCP servers at all.
   * ['dc', 'claude_ai_Gmail'] → only those server prefixes.
   */
  allowedMcpServers?: string[] | null
}

/** Known MCP server prefixes and their display names for the tool picker. */
export const KNOWN_MCP_SERVERS: Record<string, string> = {
  dc: 'DC Tools',
  claude_ai_Gmail: 'Gmail',
  claude_ai_Google_Calendar: 'Google Calendar',
  claude_ai_Slack: 'Slack',
  claude_ai_Notion: 'Notion',
  claude_ai_Asana: 'Asana',
  plugin_telegram_telegram: 'Telegram',
}

/** All known MCP server prefixes. */
export const ALL_MCP_SERVER_PREFIXES = Object.keys(KNOWN_MCP_SERVERS)

/**
 * Full list of built-in Claude Code tools passed via --allowedTools by default.
 *
 * Excluded by design: AskUserQuestion, EnterPlanMode, ExitPlanMode — these need
 * an interactive user UI that `claude -p` mode can't provide; the harness
 * auto-denies them and the user sees a "Some actions blocked by policy" card.
 * `/plan` and `/exit-plan` slash commands cover the planning use case via
 * prose rewriting instead.
 */
export const ALL_BUILTIN_TOOLS: string[] = [
  'Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob',
  'WebFetch', 'WebSearch', 'NotebookEdit',
  'Task', 'TaskOutput', 'TaskStop', 'TodoWrite',
  'Skill', 'ToolSearch',
  'LSP', 'EnterWorktree', 'ExitWorktree',
]

/** Short descriptions for each built-in tool (used by the agent-setup UI). */
export const BUILTIN_TOOL_DESCRIPTIONS: Record<string, string> = {
  Bash: 'Run shell commands',
  Read: 'Read file contents',
  Edit: 'Modify existing files',
  Write: 'Create new files',
  Grep: 'Search file contents',
  Glob: 'Find files by pattern',
  WebFetch: 'Fetch web pages',
  WebSearch: 'Search the web',
  NotebookEdit: 'Edit Jupyter notebooks',
  Task: 'Spawn sub-tasks',
  TaskOutput: 'Read sub-task output',
  TaskStop: 'Stop sub-tasks',
  TodoWrite: 'Track progress with todos',
  Skill: 'Use installed skills',
  ToolSearch: 'Load deferred tools',
  LSP: 'Language server queries',
  EnterWorktree: 'Work in isolated branch',
  ExitWorktree: 'Leave isolated branch',
}

/**
 * Build the argv for the `claude` child process. Extracted from the
 * constructor so it can be unit-tested without spawning a real process.
 */
export function buildSubagentArgs(
  opts: SubagentSpawnOptions,
): { args: string[]; envBlock: string } {
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'unknown' } })()
  const lines = [
    'Environment:',
    `- Platform: ${process.platform}`,
    `- Timezone: ${tz}`,
    `- Working directory: ${opts.cwd ?? process.cwd()}`,
    `- Bound chat: ${opts.chatId}`,
    `- Model: ${opts.model ?? 'default'} (this is authoritative — if your conversation history says a different model, it is outdated; trust this value)`,
    `- Effort: ${opts.effort ?? 'default'}`,
  ]
  if (opts.agentName) lines.push(`- Agent name: ${opts.agentName}`)
  if (opts.userName) lines.push(`- User: ${opts.userName}`)
  if (opts.claudeVersion) lines.push(`- Claude Code: ${opts.claudeVersion}`)
  lines.push('- For the current date/time, run `date` via Bash (auto-allowed). Other read-only inspection commands (`pwd`, `whoami`, `uname`) are also auto-allowed.')
  let envBlock = lines.join('\n')
  if (opts.systemPrompt && opts.systemPrompt.trim()) {
    envBlock += '\n\n' + opts.systemPrompt.trim()
  }

  const args: string[] = [
    '-p',
    ...(opts.resume ? ['--resume', opts.sessionId] : ['--session-id', opts.sessionId]),
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--settings', opts.settingsPath,
    // User-level settings (hooks, skills, superpowers, etc.) are
    // inherited by default. This is especially useful for coding
    // agents where the user's superpowers / skills / hooks give
    // real value. Per-group opt-out will come through the group
    // setup flow later.
    '--permission-mode', 'default',
    '--append-system-prompt', envBlock,
  ]
  if (opts.model) {
    args.push('--model', opts.model)
  }
  if (opts.effort) {
    args.push('--effort', opts.effort)
  }
  if (opts.sessionName) {
    args.push('--name', opts.sessionName)
  }
  if (opts.mcpConfigPath) {
    // No --strict-mcp-config: our dc server is merged with the user's
    // global MCP config (Gmail, Calendar, Telegram, etc.) so subagents
    // inherit the same MCP tools the terminal session has.
    args.push('--mcp-config', opts.mcpConfigPath)
    const builtinTools = opts.allowedBuiltinTools ?? ALL_BUILTIN_TOOLS
    const serverPrefixes = opts.allowedMcpServers ?? ALL_MCP_SERVER_PREFIXES
    const mcpPrefixes = serverPrefixes.map(s => `mcp__${s}`)
    args.push(
      '--allowedTools',
      [...mcpPrefixes, ...builtinTools].join(' '),
    )
  }
  for (const dir of opts.addDirs ?? []) {
    args.push('--add-dir', dir)
  }
  return { args, envBlock }
}

export interface TurnResult {
  text: string
  denials: Array<{ tool_name?: string; command?: string }>
  durationMs?: number
}

export class SubagentProcess {
  readonly chatId: number
  readonly subagentId: string
  readonly sessionId: string
  private child: ChildProcessWithoutNullStreams
  private buf = ''
  private frameQueue: StreamFrame[] = []
  private waiters: Array<(f: StreamFrame) => void> = []
  private busy = false
  private closed = false
  private logf: (fmt: string, ...args: unknown[]) => void
  lastUsed: number = Date.now()

  constructor(opts: SubagentSpawnOptions) {
    this.chatId = opts.chatId
    this.subagentId = opts.subagentId
    this.sessionId = opts.sessionId
    this.logf = opts.logf ?? (() => {})

    if (opts.suppressUserClaudeMd) {
      this.logf(
        'subagent %s: suppressUserClaudeMd=true requested, but no verified ' +
        'mechanism exists yet (Phase 1 deferred toggle). Ignoring.',
        opts.subagentId,
      )
    }
    const { args } = buildSubagentArgs(opts)
    this.logf(
      'subagent %s: spawning chat=%d session=%s resume=%s',
      opts.subagentId, opts.chatId, opts.sessionId, String(opts.resume),
    )

    // detached: true makes the child the leader of its own process group on
    // POSIX (no-op for that purpose on Windows). Combined with the negative-
    // PID signaling in close(), this cascades SIGTERM/SIGKILL to grandchildren
    // — claude's Bash-tool shells and their descendants — instead of orphaning
    // them. Empirical confirmation that claude does NOT cascade on its own:
    // plugin/scripts/smoke-process-group-kill.sh (#21).
    //
    // Stdio piping is unaffected: explicit pipe stdio overrides any detach
    // semantics around stdin/stdout/stderr.
    this.child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: opts.cwd,
      detached: true,
      env: {
        ...process.env,
        DC_DISPATCHER_SOCKET: opts.dispatcherSocket,
        DC_DISPATCHER_SECRET: opts.dispatcherSecret,
        DC_SUBAGENT_ID: opts.subagentId,
        DC_SUBAGENT_CHAT_ID: String(opts.chatId),
        DC_HOOK_TIMEOUT_SEC: String(opts.hookTimeoutSec ?? 300),
      },
    })

    this.child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk))
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.logf('subagent %s stderr: %s', this.subagentId, chunk.toString('utf-8').trim())
    })
    this.child.on('exit', (code) => {
      this.closed = true
      this.logf('subagent %s exited code=%s', this.subagentId, String(code))
    })
  }

  get pid(): number { return this.child.pid ?? -1 }
  get alive(): boolean { return !this.closed && this.child.exitCode === null }

  private onStdout(chunk: Buffer): void {
    this.buf += chunk.toString('utf-8')
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (!line.trim()) continue
      let frame: StreamFrame
      try { frame = JSON.parse(line) } catch { continue }
      // Compact trace of every frame (debug only).
      const snippet = line.length > 400 ? line.slice(0, 400) + '...' : line
      this.logf('subagent %s frame: %s', this.subagentId, snippet)
      if (this.waiters.length) {
        this.waiters.shift()!(frame)
      } else {
        this.frameQueue.push(frame)
      }
    }
  }

  /** Mutable deadline for the in-flight readFrame; extendDeadline mutates this. */
  private pendingDeadline = 0
  private pendingTimer: NodeJS.Timeout | null = null

  /**
   * Extend the in-flight turn deadline by extraMs. Used to pause the turn
   * timeout while a permission prompt is awaiting user input.
   */
  extendDeadline(extraMs: number): void {
    if (!this.pendingTimer || extraMs <= 0) return
    this.pendingDeadline += extraMs
  }

  private readFrame(predicate: (f: StreamFrame) => boolean, timeoutMs: number): Promise<StreamFrame> {
    for (let i = 0; i < this.frameQueue.length; i++) {
      if (predicate(this.frameQueue[i])) return Promise.resolve(this.frameQueue.splice(i, 1)[0])
    }
    return new Promise<StreamFrame>((resolve, reject) => {
      this.pendingDeadline = Date.now() + timeoutMs
      const arm = () => {
        const remaining = Math.max(0, this.pendingDeadline - Date.now())
        this.pendingTimer = setTimeout(() => {
          // Deadline may have been extended while we were sleeping; re-arm.
          if (Date.now() < this.pendingDeadline) { arm(); return }
          const idx = this.waiters.indexOf(resolveWrapper)
          if (idx >= 0) this.waiters.splice(idx, 1)
          this.pendingTimer = null
          reject(new Error(`timeout after ${timeoutMs}ms`))
        }, remaining)
      }
      arm()
      const resolveWrapper = (f: StreamFrame) => {
        if (!predicate(f)) { this.frameQueue.push(f); this.waiters.push(resolveWrapper); return }
        if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null }
        resolve(f)
      }
      this.waiters.push(resolveWrapper)
    })
  }

  async send(text: string, turnTimeoutMs = 4 * 60 * 60 * 1000): Promise<TurnResult> {
    if (!this.alive) throw new Error(`subagent ${this.subagentId} is not alive`)
    if (this.busy) throw new Error(`subagent ${this.subagentId} is busy`)
    this.busy = true
    this.lastUsed = Date.now()
    try {
      const inputFrame = { type: 'user', message: { role: 'user', content: text } }
      this.child.stdin.write(JSON.stringify(inputFrame) + '\n')

      const resultFrame = await this.readFrame(
        (f) => f.type === 'result' && (f.subtype === 'success' || f.subtype === 'error_during_execution'),
        turnTimeoutMs,
      )
      if (resultFrame.subtype === 'error_during_execution') {
        throw new Error(`subagent ${this.subagentId} error_during_execution (session ${resultFrame.session_id})`)
      }
      const denials = (resultFrame.permission_denials ?? []).map((d) => ({
        tool_name: d.tool_name,
        command: d.tool_input?.command,
      }))
      return {
        text: (resultFrame.result ?? '').toString(),
        denials,
        durationMs: resultFrame.duration_ms,
      }
    } finally {
      this.busy = false
      this.lastUsed = Date.now()
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    // Step 1: graceful — stdin EOF lets claude shut down cleanly via stream-json.
    try { this.child.stdin.end() } catch {}
    // Step 2: SIGTERM the whole process group on POSIX (negative PID = group);
    // fall back to direct-child kill on Windows. ESRCH (already exited) is fine.
    this.killTree('SIGTERM')
    // Step 3: 2s grace, then SIGKILL the group (or direct child on Windows).
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.killTree('SIGKILL')
        resolve()
      }, 2000)
      this.child.on('exit', () => { clearTimeout(t); resolve() })
    })
    this.closed = true
  }

  /**
   * Signal the subagent's whole process group on POSIX, or just the direct
   * child on Windows. Wrapped in try/catch — ESRCH (already-exited) is benign.
   *
   * Windows note: process groups in the POSIX sense don't exist; negative-PID
   * kill throws EINVAL. v1.4 follow-up will add `taskkill /T /F /PID <pid>`
   * for tree-kill on Windows. Until then Windows users get the pre-existing
   * direct-child-only behavior with a known grandchild-leak limitation.
   */
  private killTree(signal: 'SIGTERM' | 'SIGKILL'): void {
    const pid = this.child.pid
    if (pid === undefined) return  // spawn failed; nothing to signal
    if (process.platform === 'win32') {
      try { this.child.kill(signal) } catch {}
      return
    }
    try { process.kill(-pid, signal) } catch {}
  }
}
