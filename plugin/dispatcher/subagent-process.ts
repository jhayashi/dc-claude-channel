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
import { randomUUID } from 'node:crypto'

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
  /** Working directory for the subagent. Defaults to process.cwd(). */
  cwd?: string
  /** Additional directories the subagent is allowed to touch. */
  addDirs?: string[]
  logf?: (fmt: string, ...args: unknown[]) => void
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
    this.sessionId = randomUUID()
    this.logf = opts.logf ?? (() => {})

    const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'unknown' } })()
    const envBlock = [
      'Environment:',
      `- Platform: ${process.platform}`,
      `- Timezone: ${tz}`,
      `- Working directory: ${opts.cwd ?? process.cwd()}`,
      `- Bound chat: ${opts.chatId}`,
      '- For the current date/time, run `date` via Bash (auto-allowed). Other read-only inspection commands (`pwd`, `whoami`, `uname`) are also auto-allowed.',
    ].join('\n')

    const args: string[] = [
      '-p',
      '--session-id', this.sessionId,
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--settings', opts.settingsPath,
      // Exclude user-level settings so we don't inherit the user's
      // SessionStart hooks (e.g. superpowers) which inject wall-of-text
      // skill prompts into every subagent cold spawn. Our own --settings
      // file (with the PreToolUse permission hook) is still loaded.
      '--setting-sources', 'project,local',
      '--permission-mode', 'default',
      '--append-system-prompt', envBlock,
    ]
    if (opts.mcpConfigPath) {
      args.push('--mcp-config', opts.mcpConfigPath, '--strict-mcp-config')
      // MCP tools can't prompt in headless -p mode and PreToolUse hooks
      // don't fire for them (spike 1E). Whitelist the whole dc server so
      // dispatcher-side authorization is the only gate. In headless -p
      // mode --allowedTools appears to be a hard whitelist (not just a
      // pre-approval list like the TUI) so we also list the built-in
      // tools the subagent needs; Bash/Edit/Write/WebFetch/NotebookEdit
      // still fire the PreToolUse hook for the actual permission check.
      args.push('--allowedTools', 'mcp__dc Bash Read Edit Write Grep Glob WebFetch NotebookEdit Task TodoWrite')
    }
    for (const dir of opts.addDirs ?? []) {
      args.push('--add-dir', dir)
    }

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

  private readFrame(predicate: (f: StreamFrame) => boolean, timeoutMs: number): Promise<StreamFrame> {
    for (let i = 0; i < this.frameQueue.length; i++) {
      if (predicate(this.frameQueue[i])) return Promise.resolve(this.frameQueue.splice(i, 1)[0])
    }
    return new Promise<StreamFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(resolveWrapper)
        if (idx >= 0) this.waiters.splice(idx, 1)
        reject(new Error(`timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      const resolveWrapper = (f: StreamFrame) => {
        if (!predicate(f)) { this.frameQueue.push(f); this.waiters.push(resolveWrapper); return }
        clearTimeout(timer)
        resolve(f)
      }
      this.waiters.push(resolveWrapper)
    })
  }

  async send(text: string, turnTimeoutMs = 120000): Promise<TurnResult> {
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
