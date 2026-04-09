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
}

/**
 * Build the argv for the `claude` child process. Extracted from the
 * constructor so it can be unit-tested without spawning a real process.
 */
export function buildSubagentArgs(
  opts: SubagentSpawnOptions,
): { args: string[]; envBlock: string } {
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'unknown' } })()
  let envBlock = [
    'Environment:',
    `- Platform: ${process.platform}`,
    `- Timezone: ${tz}`,
    `- Working directory: ${opts.cwd ?? process.cwd()}`,
    `- Bound chat: ${opts.chatId}`,
    '- For the current date/time, run `date` via Bash (auto-allowed). Other read-only inspection commands (`pwd`, `whoami`, `uname`) are also auto-allowed.',
  ].join('\n')
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
  if (opts.mcpConfigPath) {
    args.push('--mcp-config', opts.mcpConfigPath, '--strict-mcp-config')
    args.push('--allowedTools', 'mcp__dc Bash Read Edit Write Grep Glob WebFetch WebSearch NotebookEdit Task TodoWrite')
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

    this.child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: opts.cwd,
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
        (f) => f.type === 'result' && f.subtype === 'success',
        turnTimeoutMs,
      )
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
    try { this.child.stdin.end() } catch {}
    try { this.child.kill('SIGTERM') } catch {}
    // Wait up to 2s for graceful exit, then SIGKILL
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try { this.child.kill('SIGKILL') } catch {}
        resolve()
      }, 2000)
      this.child.on('exit', () => { clearTimeout(t); resolve() })
    })
    this.closed = true
  }
}
