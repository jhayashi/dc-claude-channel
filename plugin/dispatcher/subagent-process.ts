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

import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { FrameBuffer } from './frame-buffer'

interface StreamFrame {
  type: string
  subtype?: string
  result?: string
  duration_ms?: number
  permission_denials?: Array<{ tool_name?: string; tool_input?: { command?: string } }>
  [k: string]: unknown
}

/** The slice of an agent definition the spawn needs. AgentDef satisfies it. */
export interface SpawnAgent {
  name: string
  permissionMode?: string
  tools?: string
}

export interface SubagentSpawnOptions {
  chatId: number
  subagentId: string
  /**
   * The agent to spawn. `name` → `--agent` (CC reads model / prompt / tools /
   * memory from the .md). `permissionMode` / `tools` are forwarded as
   * `--permission-mode` / `--allowed-tools` because CC's headless `-p` runtime
   * does NOT apply the .md's permissionMode/tools to its grant decisions —
   * without this, trusted agents deadlock on a UI-less permission prompt.
   */
  agent: SpawnAgent
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
  /** Owner's display name from the DC contact card. */
  userName?: string
  /** Claude Code CLI version string (e.g. '2.1.100'). */
  claudeVersion?: string
  /** Session display name (synced with DC chat name). Passed as `--name`. */
  sessionName?: string
  logf?: (fmt: string, ...args: unknown[]) => void
  /**
   * Called for every chunk on the child's stderr. Used by server.ts to tee
   * the bytes to a file-backed log (subagent-stderr-<date>.log) so the
   * trace survives across dispatcher restarts and is available for crash
   * forensics. Independent of `logf`, which only goes to the dispatcher's
   * debug stream and is dropped when DEBUG is unset.
   */
  onStderr?: (text: string) => void
  /**
   * Called once when the child process exits. `code` is the POSIX exit
   * code, or null when the process was terminated by signal. Symmetrical
   * to onStderr — used to write the exit marker into the same log so the
   * trace ends with a recoverable exit reason.
   */
  onExit?: (code: number | null) => void
}

/**
 * Default built-in Claude Code tools list. Used by the agent-setup UI
 * picker and by the v1.3 → v1.4 migration as the "all built-ins"
 * fallback when a legacy agent had no `allowedBuiltinTools` field.
 *
 * Excluded by design: AskUserQuestion, EnterPlanMode, ExitPlanMode — these need
 * an interactive user UI that `claude -p` mode can't provide; the harness
 * auto-denies them and the user sees a "Some actions blocked by policy" card.
 * `/plan` and `/exit-plan` slash commands cover the planning use case via
 * prose rewriting instead.
 *
 * Drift surface — hand-maintained. CC adds tools across releases
 * (CronCreate, Monitor, RemoteTrigger etc. show up in this session's
 * deferred-tool list). Drift impact is feature-availability, not crash:
 * a tool absent from this list won't be granted to newly-migrated
 * agents nor toggleable in the setup UI, but already-saved agents that
 * enumerate the tool by name continue to work.
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
  if (!opts.agent || !opts.agent.name) {
    throw new Error('buildSubagentArgs: agent.name is required (v1.4 delegates to CC via --agent)')
  }
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'unknown' } })()
  const lines = [
    'Environment:',
    `- Platform: ${process.platform}`,
    `- Timezone: ${tz}`,
    `- Working directory: ${opts.cwd ?? process.cwd()}`,
    `- Bound chat: ${opts.chatId}`,
    `- Agent name: ${opts.agent.name}`,
  ]
  if (opts.userName) lines.push(`- User: ${opts.userName}`)
  if (opts.claudeVersion) lines.push(`- Claude Code: ${opts.claudeVersion}`)
  lines.push('- For the current date/time, run `date` via Bash (auto-allowed). Other read-only inspection commands (`pwd`, `whoami`, `uname`) are also auto-allowed.')
  // #140: observed live — a trusted subagent hand-deleted an agent .md,
  // bypassing the manage card's confirm + rebind cascade. Subagents never
  // see the channel instructions, so this rule must ride the env block.
  lines.push('- Agent definitions: NEVER create, edit, or delete files under ~/.claude/agents yourself, even when asked directly — direct file edits skip eviction, badge refresh, and the delete cascade that re-homes bound chats. Use dc_update_agent / dc_create_agent, and route deletion through the Manage Agents card (dc_open_agent_manage_card) so the owner confirms with a tap.')
  const envBlock = lines.join('\n')

  const args: string[] = [
    '-p',
    '--agent', opts.agent.name,
    ...(opts.resume ? ['--resume', opts.sessionId] : ['--session-id', opts.sessionId]),
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--settings', opts.settingsPath,
    '--append-system-prompt', envBlock,
  ]
  // CC reads model / system prompt / tools / memory from the agent .md
  // (via --agent), but does NOT propagate the .md's `permissionMode` into
  // the headless `-p` runtime — it still asks for tool-grant approval
  // for every MCP tool the agent calls, with no UI to grant. The hook in
  // settings.json only matches built-ins (Bash/Edit/Write/…), not MCP
  // tools, so MCP grants would deadlock. Forward the mode explicitly.
  if (opts.agent.permissionMode) {
    args.push('--permission-mode', opts.agent.permissionMode)
  }
  // Same story for the allowlist: the .md's `tools:` field declares the
  // surface but CC still prompts at use-time for non-pre-granted tools.
  // Pass --allowed-tools so MCP calls (and any built-ins) are pre-granted.
  const allowedTools = opts.agent.tools ?? ''
  if (allowedTools.length > 0) {
    args.push('--allowed-tools', allowedTools)
  }
  if (opts.sessionName) {
    args.push('--name', opts.sessionName)
  }
  if (opts.mcpConfigPath) {
    // No --strict-mcp-config: our dc server is merged with the user's
    // global MCP config (Gmail, Calendar, Telegram, etc.) so subagents
    // inherit the same MCP tools the terminal session has.
    args.push('--mcp-config', opts.mcpConfigPath)
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

/** A single side-effecting kill action; executed by `killTree`. */
export type KillStep =
  /** POSIX: `process.kill(pid, signal)` on a specific tree member. */
  | { kind: 'process-kill'; pid: number; signal: 'SIGTERM' | 'SIGKILL' }
  /** Windows: `taskkill <argv>` — `/T` walks the tree, `/F` forces. */
  | { kind: 'taskkill'; argv: string[] }
  /** Windows fallback: `this.child.kill(signal)` on the direct child. */
  | { kind: 'child-kill'; signal: 'SIGTERM' | 'SIGKILL' }

/**
 * Pure planner for `killTree` — given the platform, the child pid, its
 * descendant pids (POSIX only; empty on Windows), and the signal, return the
 * ordered list of kill steps. Extracted from `killTree` so the per-platform
 * decision can be unit-tested without spawning a real process (the win32
 * branch in particular can't be exercised live on Linux/macOS CI).
 *
 * - **POSIX**: kill descendants depth-first (the BFS-ordered `descendants`
 *   reversed, so a child dies before its parent), then the root pid.
 * - **Windows**: `taskkill /T /F /PID <pid>` first, while the tree is still
 *   intact for `/T` to walk; then a direct `child.kill` fallback so a missing
 *   or failed `taskkill` is never worse than the pre-fix direct-child kill.
 *   `/F` is unconditional — Windows has no graceful tree-kill analog to
 *   SIGTERM — so both signals route to the same forced teardown.
 */
export function planKillTree(
  platform: NodeJS.Platform,
  pid: number,
  descendants: number[],
  signal: 'SIGTERM' | 'SIGKILL',
): KillStep[] {
  if (platform === 'win32') {
    return [
      { kind: 'taskkill', argv: ['/T', '/F', '/PID', String(pid)] },
      { kind: 'child-kill', signal },
    ]
  }
  const steps: KillStep[] = []
  for (let i = descendants.length - 1; i >= 0; i--) {
    steps.push({ kind: 'process-kill', pid: descendants[i], signal })
  }
  steps.push({ kind: 'process-kill', pid, signal })
  return steps
}

export class SubagentProcess {
  readonly chatId: number
  readonly subagentId: string
  readonly sessionId: string
  private child: ChildProcessWithoutNullStreams
  private buf = ''
  /**
   * Ordered stdout frame buffer + reader state machine. Extracted so the
   * read/buffer/timeout logic is unit-testable (see frame-buffer.ts). send()
   * calls frames.clearStale() at each turn boundary so a late `result` frame
   * from a prior turn can never be mis-delivered as this turn's reply (the
   * off-by-one bug).
   */
  private frames = new FrameBuffer<StreamFrame>()
  private busy = false
  private closed = false
  private logf: (fmt: string, ...args: unknown[]) => void
  private onStderr?: (text: string) => void
  private onExit?: (code: number | null) => void
  lastUsed: number = Date.now()

  constructor(opts: SubagentSpawnOptions) {
    this.chatId = opts.chatId
    this.subagentId = opts.subagentId
    this.sessionId = opts.sessionId
    this.logf = opts.logf ?? (() => {})
    this.onStderr = opts.onStderr
    this.onExit = opts.onExit

    const { args } = buildSubagentArgs(opts)
    this.logf(
      'subagent %s: spawning chat=%d session=%s resume=%s',
      opts.subagentId, opts.chatId, opts.sessionId, String(opts.resume),
    )

    // detached: true makes the child the leader of its own process group on
    // POSIX, isolating it from the dispatcher's pgrp. NOTE: this alone does
    // NOT cascade signals — claude's Bash tool internally `setsid`s its tool
    // shells, so each shell sits in its OWN process group, separate from
    // claude's. The actual cascade happens via the explicit process-tree
    // walk in killTree(). detached:true is kept for clean isolation; the
    // tree walk is what makes /stop actually take down grandchildren.
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
      const text = chunk.toString('utf-8')
      this.logf('subagent %s stderr: %s', this.subagentId, text.trim())
      // Tee to the optional file sink (server.ts wires this to
      // logSubagentStderr). Swallow sink errors — observability must never
      // affect the live process.
      try { this.onStderr?.(text) } catch {}
    })
    this.child.on('exit', (code) => {
      this.closed = true
      this.logf('subagent %s exited code=%s', this.subagentId, String(code))
      try { this.onExit?.(code) } catch {}
      this.abortPendingReaders(new Error(`subagent ${this.subagentId} exited (code=${code})`))
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
      this.frames.push(frame)
    }
  }

  /**
   * Extend the in-flight turn deadline by extraMs. Used to pause the turn
   * timeout while a permission prompt is awaiting user input.
   */
  extendDeadline(extraMs: number): void {
    this.frames.extendDeadline(extraMs)
  }

  /**
   * Reject any in-flight readFrame so close()/exit unblock send() callers
   * synchronously instead of waiting out the turn timeout. Safe to call
   * with no reader pending — it just clears state.
   */
  private abortPendingReaders(err: Error): void {
    this.frames.markClosed()
    this.frames.abort(err)
  }

  async send(text: string, turnTimeoutMs = 4 * 60 * 60 * 1000): Promise<TurnResult> {
    if (!this.alive) throw new Error(`subagent ${this.subagentId} is not alive`)
    if (this.busy) throw new Error(`subagent ${this.subagentId} is busy`)
    this.busy = true
    this.lastUsed = Date.now()
    try {
      // Drop anything left buffered by a prior turn BEFORE starting this one.
      // A late `result` frame from an earlier turn (e.g. one that timed out
      // while its process kept running) would otherwise be returned here as
      // THIS turn's reply — the off-by-one / "responding to a prior question"
      // bug. We hold `busy`, so anything buffered now is provably stale.
      const dropped = this.frames.clearStale()
      if (dropped > 0) {
        this.logf('subagent %s: dropped %d stale frame(s) before turn', this.subagentId, dropped)
      }

      const inputFrame = { type: 'user', message: { role: 'user', content: text } }
      this.child.stdin.write(JSON.stringify(inputFrame) + '\n')

      const resultFrame = await this.frames.read(
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
    // Mark closed first + abort any pending readFrame so the awaiting send()
    // throws synchronously. Without this the caller would wait out the turn
    // timeout (default 1 hour) before learning the subagent was torn down.
    this.closed = true
    this.abortPendingReaders(new Error(`subagent ${this.subagentId} closed by dispatcher`))
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
  }

  /**
   * Signal the subagent's entire process tree.
   *
   * Why a tree walk and not process-group kill: claude's Bash tool internally
   * `setsid`s its tool shells (verified empirically — see
   * plugin/scripts/smoke-process-group-kill.sh). Each shell + its descendants
   * sit in their own process group, separate from claude's. So
   * `process.kill(-pid, signal)` on claude's pgrp doesn't reach them.
   *
   * Walking the parent-child tree via `pgrep -P` recursively bypasses pgrp
   * boundaries entirely — same shape as Windows `taskkill /T /F`. Wrapped in
   * try/catch per kill; ESRCH (already-exited) is benign.
   *
   * Windows path (#95): `taskkill /T /F /PID` walks and force-kills the whole
   * tree (no POSIX process groups there). A direct `child.kill` runs after as
   * a fallback so a missing/failed taskkill is never worse than the pre-fix
   * direct-child kill. NOTE: not exercised on Linux/macOS CI — verified by the
   * `planKillTree` unit tests (argv correctness) plus the PowerShell smoke
   * script; live Windows verification still pending a Windows user.
   *
   * The per-platform step ordering lives in the pure `planKillTree`; this
   * method just snapshots the tree and runs the steps.
   *
   * Race: between `collectDescendants` and the kill loop, claude could spawn
   * new grandchildren that we miss. Window is single-digit ms; long-running
   * tools (the targets of /stop) are unlikely to spawn new descendants in
   * that window. Acceptable.
   */
  private killTree(signal: 'SIGTERM' | 'SIGKILL'): void {
    const pid = this.child.pid
    if (pid === undefined) return  // spawn failed; nothing to signal
    // Snapshot the tree BEFORE killing — once the parent dies, descendants
    // reparent to init and we lose the linkage. (Windows walks the tree via
    // taskkill /T itself, so no snapshot is needed there.)
    const descendants = process.platform === 'win32' ? [] : this.collectDescendants(pid)
    // Each step is wrapped in try/catch: ESRCH (already-exited), a missing
    // taskkill binary, etc. are all benign on shutdown.
    for (const step of planKillTree(process.platform, pid, descendants, signal)) {
      try {
        if (step.kind === 'taskkill') execFileSync('taskkill', step.argv, { stdio: 'ignore' })
        else if (step.kind === 'child-kill') this.child.kill(step.signal)
        else process.kill(step.pid, step.signal)
      } catch {}
    }
  }

  /**
   * Collect every descendant PID of `rootPid` via a single `ps` snapshot.
   * Returns descendants in BFS order (shallowest first); kill in reverse for
   * depth-first teardown.
   *
   * One snapshot rather than N repeated `pgrep -P` calls: the recursive pgrep
   * approach has a race surface — transient PIDs between calls can be missed
   * or misattributed. Empirically observed during dispatcher-path verification
   * on 2026-05-05. Single ps invocation gives an atomic view of the parent
   * map; the walk is then in-memory.
   *
   * Linux + macOS both ship this ps invocation. Synchronous because killTree
   * is called once on shutdown — not a hot path.
   */
  private collectDescendants(rootPid: number): number[] {
    let raw = ''
    try {
      raw = execFileSync('ps', ['-e', '-o', 'pid=,ppid='], { encoding: 'utf-8' })
    } catch {
      return []
    }
    // Parent map (child → parent), then invert to a children map for BFS.
    const childMap = new Map<number, number[]>()
    for (const line of raw.split('\n')) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 2) continue
      const pid = parseInt(parts[0], 10)
      const ppid = parseInt(parts[1], 10)
      if (isNaN(pid) || isNaN(ppid)) continue
      if (!childMap.has(ppid)) childMap.set(ppid, [])
      childMap.get(ppid)!.push(pid)
    }
    const descendants: number[] = []
    const queue: number[] = [rootPid]
    const visited = new Set<number>([rootPid])
    while (queue.length > 0) {
      const p = queue.shift()!
      const kids = childMap.get(p) ?? []
      for (const k of kids) {
        if (visited.has(k)) continue  // defensive against cycles in malformed ps output
        visited.add(k)
        descendants.push(k)
        queue.push(k)
      }
    }
    return descendants
  }
}
