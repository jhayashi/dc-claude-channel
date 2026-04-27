/**
 * Dispatcher fixture for Tier-2 integration tests.
 *
 * Spawns `bun server.ts` as a child process with HOME pointed at a
 * scoped fixture directory. The dispatcher writes its account, agents,
 * bindings, dc-data, etc. under that HOME — same as it would on a real
 * machine, just isolated from the developer's actual ~/.claude/ tree.
 *
 * Talks to the running dispatcher over the MCP stdio transport (the
 * same surface the user's terminal Claude Code uses). The MCP `Client`
 * comes from `@modelcontextprotocol/sdk` which is already a top-level
 * dependency.
 *
 * stderr is captured line-by-line for `waitForLog()` assertions and
 * mirrored to the test runner so failures are debuggable.
 *
 * Persistent across test runs: the same fixture HOME is reused so the
 * dispatcher's bot account isn't re-provisioned on every run. Set
 * `RESET_TEST_ACCOUNTS=1` to wipe before booting.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

export interface DispatcherOptions {
  /** Persistent fixture HOME for the dispatcher. */
  home: string;
  /** Path to plugin/server.ts. */
  serverPath: string;
  /** Chatmail relay (default nine.testrun.org). */
  chatmail?: string;
  /** Forwarded to the subprocess; set to capture stderr to a file. */
  extraEnv?: Record<string, string>;
  /** stderr line callback (default: prefix with "[dispatcher] " and write to process.stderr). */
  onStderr?: (line: string) => void;
}

export class Dispatcher {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private mcp: Client | null = null;
  private stderrBuf = "";
  private logLines: string[] = [];
  private logWaiters: { re: RegExp; resolve: (line: string) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  private opts: DispatcherOptions;

  constructor(opts: DispatcherOptions) {
    this.opts = opts;
    if (!existsSync(opts.home)) mkdirSync(opts.home, { recursive: true });
  }

  /**
   * Boot the dispatcher subprocess and connect an MCP client over its
   * stdio. Resolves once the dispatcher's MCP server is responding to
   * tool listing — i.e. it's past account configure + IO start.
   */
  async boot(): Promise<void> {
    // Strip the dispatcher-coupling env vars the parent shell may have
    // exported so the spawned dispatcher can't accidentally adopt the
    // user's credentials, socket, or subagent identity. The test runs
    // from inside the user's dispatcher when invoked via Delta Chat,
    // which exports these. Other DC_* vars (DC_RPC_DEBUG, RUST_LOG, …)
    // pass through.
    const STRIPPED = new Set([
      "DC_ADDRESS", "DC_PASSWORD",
      "DC_DISPATCHER_SOCKET", "DC_DISPATCHER_SECRET",
      "DC_SUBAGENT_ID", "DC_SUBAGENT_CHAT_ID",
      "DC_TOOLS_MANIFEST",
    ]);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (STRIPPED.has(k)) continue;
      if (typeof v === "string") env[k] = v;
    }
    env.HOME = this.opts.home;
    // Explicit opt → DC_TEST_RELAY env → local default → public chatmail.
    env.DC_CHATMAIL = this.opts.chatmail
      ?? process.env.DC_TEST_RELAY
      ?? "localhost:8443";
    Object.assign(env, this.opts.extraEnv ?? {});

    const transport = new StdioClientTransport({
      command: "bun",
      args: [this.opts.serverPath],
      env,
      stderr: "pipe",
    });

    const stderrStream = transport.stderr;
    if (stderrStream) {
      stderrStream.on("data", (chunk: Buffer) => this.absorbStderr(chunk.toString("utf8")));
    }

    this.mcp = new Client({ name: "tier2-test-fixture", version: "0.0.1" }, { capabilities: {} });
    await this.mcp.connect(transport);
    // Cheap sanity ping — also confirms the dispatcher made it past account provisioning.
    await this.mcp.listTools();
  }

  /** Atomic call → arms the 5-minute pairing window and creates a fresh "Claude" group. */
  async armPairing(): Promise<string> {
    return this.callText("dc_access_arm_pairing", {});
  }

  /** Returns the textual securejoin URL for the armed group. */
  async inviteLink(): Promise<string> {
    return this.callText("dc_invite_link", {});
  }

  /** Submit the 5-letter code from the welcome message to complete pairing. */
  async pair(code: string): Promise<string> {
    return this.callText("dc_access_pair", { code });
  }

  /** Send a text message into a chat the dispatcher already has access to. */
  async sendText(chatId: number, text: string): Promise<string> {
    return this.callText("reply", { chat_id: String(chatId), text });
  }

  /** Read the most recent N messages of a chat via dc_chat_history. */
  async chatHistory(chatId: number, count = 20): Promise<string> {
    return this.callText("dc_chat_history", { chat_id: String(chatId), count });
  }

  /** Resolves with the next stderr line that matches `re`, or rejects after `timeoutMs`. */
  waitForLog(re: RegExp, timeoutMs = 30_000): Promise<string> {
    // First check buffered lines so a callback racing the test doesn't lose the match.
    for (const line of this.logLines) {
      if (re.test(line)) return Promise.resolve(line);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.logWaiters = this.logWaiters.filter((w) => w.timer !== timer);
        reject(new Error(`waitForLog: timeout after ${timeoutMs}ms waiting for ${re}`));
      }, timeoutMs);
      this.logWaiters.push({ re, resolve, reject, timer });
    });
  }

  /** SIGTERM the dispatcher and wait for it to exit. */
  async kill(): Promise<void> {
    try { await this.mcp?.close(); } catch {}
    this.mcp = null;
    if (this.proc) {
      this.proc.kill();
      try { await this.proc.exited; } catch {}
      this.proc = null;
    }
    for (const w of this.logWaiters) {
      clearTimeout(w.timer);
      w.reject(new Error("dispatcher killed"));
    }
    this.logWaiters = [];
  }

  private async callText(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.mcp) throw new Error("dispatcher not booted");
    const res = await this.mcp.callTool({ name, arguments: args });
    if (res.isError) throw new Error(`MCP tool ${name} returned error: ${JSON.stringify(res.content)}`);
    const content = res.content as Array<{ type: string; text?: string }>;
    const first = content?.[0];
    if (!first || first.type !== "text" || typeof first.text !== "string") {
      throw new Error(`MCP tool ${name} returned non-text content: ${JSON.stringify(content)}`);
    }
    return first.text;
  }

  private absorbStderr(chunk: string): void {
    this.stderrBuf += chunk;
    let nl: number;
    while ((nl = this.stderrBuf.indexOf("\n")) !== -1) {
      const line = this.stderrBuf.slice(0, nl);
      this.stderrBuf = this.stderrBuf.slice(nl + 1);
      this.logLines.push(line);
      (this.opts.onStderr ?? defaultStderr)(line);
      // Notify waiters.
      for (const w of [...this.logWaiters]) {
        if (w.re.test(line)) {
          clearTimeout(w.timer);
          this.logWaiters = this.logWaiters.filter((x) => x !== w);
          w.resolve(line);
        }
      }
    }
  }
}

function defaultStderr(line: string): void {
  process.stderr.write(`[dispatcher] ${line}\n`);
}

/** Compute a default fixture home under `plugin/test/integration/.fixtures/dispatcher`. */
export function defaultFixtureHome(integrationDir: string): string {
  return resolve(integrationDir, ".fixtures", "dispatcher-home");
}

/** Wipe the fixture home — call before `boot()` if `RESET_TEST_ACCOUNTS=1`. */
export function resetFixtureHome(home: string): void {
  if (existsSync(home)) rmSync(home, { recursive: true, force: true });
}
