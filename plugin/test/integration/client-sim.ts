/**
 * Client simulator for Tier-2 integration tests.
 *
 * Plays the role of the "phone-side" Delta Chat user. Wraps
 * `@deltachat/jsonrpc-client` directly (NOT via the dispatcher's
 * `dc-client.ts`, which hard-codes its data dir to `~/.claude/...`)
 * so the simulator's account state lives wherever the test wants it.
 *
 * Usage:
 *
 *   const sim = await ClientSim.boot({ stateDir, relay });
 *   const chatId = await sim.secureJoin(qrUri);
 *   const welcome = await sim.waitForMessage(chatId, /pair/);
 *   await sim.sendText(chatId, "hello");
 *   await sim.close();
 */

import type { DeltaChatOverJsonRpcServer } from "@deltachat/stdio-rpc-server";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { isTestRelay } from "./chatmail-probe.js";

export interface SimMessage {
  id: number;
  chatId: number;
  text: string;
  fromId: number;
  /** True for DC core info/system messages (e.g. "X added Y to group"). */
  isInfo: boolean;
}

export interface BootOptions {
  /** Persistent state dir for this simulator's DC account. */
  stateDir: string;
  /**
   * Chatmail relay host:port for the HTTPS /new API (default nine.testrun.org).
   * Local relays (localhost / 127.0.0.1 / _* test-domain) automatically get
   * TLS verification disabled and explicit IMAP/SMTP port overrides.
   */
  relay?: string;
  /**
   * IMAP port to set explicitly (overrides DC core's autoconfiguration).
   * Required when using a local relay mapped to a non-standard port.
   * Defaults to RELAY_IMAPS_PORT env var or 10993 for local relays.
   */
  imapsPort?: number;
  /**
   * SMTP submission port to set explicitly.
   * Defaults to RELAY_SMTPS_PORT env var or 10465 for local relays.
   */
  smtpsPort?: number;
  /** Display name on the wire. */
  displayName?: string;
}

export class ClientSim {
  private dc: DeltaChatOverJsonRpcServer;
  private accountId: number;
  private incoming: SimMessage[] = [];
  private waiters: { chatId: number | null; predicate: (m: SimMessage) => boolean; resolve: (m: SimMessage) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];

  private constructor(dc: DeltaChatOverJsonRpcServer, accountId: number) {
    this.dc = dc;
    this.accountId = accountId;
  }

  /**
   * Boot the simulator. If `stateDir` already contains a configured
   * account, that account is reused. Otherwise a new chatmail account
   * is provisioned and persisted.
   */
  static async boot(opts: BootOptions): Promise<ClientSim> {
    if (!existsSync(opts.stateDir)) mkdirSync(opts.stateDir, { recursive: true });
    const { startDeltaChat } = await import("@deltachat/stdio-rpc-server");
    const dc = await startDeltaChat(opts.stateDir, { muteStdErr: process.env.DC_SIM_DEBUG !== "1" });

    const existing = await dc.rpc.getAllAccountIds();
    let accountId: number;
    if (existing.length > 0) {
      // Reuse the first configured account on disk.
      accountId = existing[0];
      const configured = await dc.rpc.isConfigured(accountId);
      if (!configured) {
        // Half-provisioned account from a prior crash; finish it.
        await dc.rpc.configure(accountId);
      }
    } else {
      accountId = await dc.rpc.addAccount();
      try {
        const relay = opts.relay ?? "nine.testrun.org";
        const host = relay.split(":")[0];
        const testRelay = isTestRelay(host);

        // Local/test-domain relays use self-signed TLS — skip verification.
        const fetchOpts: RequestInit & { tls?: { rejectUnauthorized: boolean } } = {
          method: "POST",
        };
        if (testRelay) fetchOpts.tls = { rejectUnauthorized: false };

        const resp = await fetch(`https://${relay}/new`, fetchOpts);
        if (!resp.ok) throw new Error(`chatmail /new HTTP ${resp.status}`);
        const creds = (await resp.json()) as { email: string; password: string };
        if (!creds.email || !creds.password) throw new Error("chatmail /new returned empty creds");

        await dc.rpc.setConfig(accountId, "addr", creds.email);
        await dc.rpc.setConfig(accountId, "mail_pw", creds.password);
        await dc.rpc.setConfig(accountId, "displayname", opts.displayName ?? "TestPhone");

        if (testRelay) {
          // Override DC core's autoconfiguration so it connects to the
          // loopback-mapped ports instead of trying to DNS-resolve the
          // _chatmail.test domain.  Set before configure() for the
          // connection test; re-apply after in case autoconfig resets them.
          const imapsPort = opts.imapsPort
            ?? Number(process.env.RELAY_IMAPS_PORT ?? "10993");
          const smtpsPort = opts.smtpsPort
            ?? Number(process.env.RELAY_SMTPS_PORT ?? "10465");
          await dc.rpc.setConfig(accountId, "mail_server", "127.0.0.1");
          await dc.rpc.setConfig(accountId, "send_server", "127.0.0.1");
          await dc.rpc.setConfig(accountId, "mail_port", String(imapsPort));
          await dc.rpc.setConfig(accountId, "send_port", String(smtpsPort));
          // "3" = AcceptInvalidCertificates — accept self-signed test certs
          await dc.rpc.setConfig(accountId, "imap_certificate_checks", "3");
          await dc.rpc.setConfig(accountId, "smtp_certificate_checks", "3");
        }

        await dc.rpc.configure(accountId);

        if (testRelay) {
          // Re-apply cert checks after configure() in case autoconfig reset them.
          await dc.rpc.setConfig(accountId, "imap_certificate_checks", "3");
          await dc.rpc.setConfig(accountId, "smtp_certificate_checks", "3");
        }
      } catch (err) {
        await dc.rpc.removeAccount(accountId).catch(() => {});
        throw err;
      }
    }

    // Wire incoming-message capture before starting IO.
    const sim = new ClientSim(dc, accountId);
    const events = dc.getContextEvents(accountId);
    events.on("IncomingMsg", async (ev: { msgId: number }) => {
      try {
        const msg = await dc.rpc.getMessage(accountId, ev.msgId);
        const sm: SimMessage = { id: msg.id, chatId: msg.chatId, text: msg.text ?? "", fromId: msg.fromId, isInfo: msg.isInfo };
        sim.absorbMessage(sm);
      } catch {
        // Best-effort — message may have been deleted between event and fetch.
      }
    });

    await dc.rpc.startIo(accountId);
    return sim;
  }

  /** Account address (e.g. for log lines / debugging). */
  async getAddress(): Promise<string> {
    return (await this.dc.rpc.getConfig(this.accountId, "addr")) ?? "";
  }

  /**
   * Join a chat by scanning a securejoin QR. Returns the chatId once the
   * handshake completes. Blocks for up to ~60s.
   */
  async secureJoin(qrUri: string): Promise<number> {
    return await this.dc.rpc.secureJoin(this.accountId, qrUri);
  }

  /** Send a text message and return the message id. */
  async sendText(chatId: number, text: string): Promise<number> {
    return await this.dc.rpc.miscSendTextMessage(this.accountId, chatId, text);
  }

  /**
   * Highest incoming-buffer message id for `chatId`, or 0 if none seen.
   * Use as a baseline before sending a prompt so subsequent
   * `waitForMessage` calls can filter `m.id > baseline` and skip
   * historical messages already in the buffer (welcome banners, prior
   * test runs).
   */
  getMaxIncomingMsgId(chatId: number): number {
    let max = 0;
    for (const m of this.incoming) {
      if (m.chatId === chatId && m.id > max) max = m.id;
    }
    return max;
  }

  /**
   * Wait until an incoming message in `chatId` (or any chat if null)
   * matches `predicate`. Resolves with the matching message; rejects
   * after `timeoutMs`.
   */
  waitForMessage(chatId: number | null, predicate: (m: SimMessage) => boolean, timeoutMs = 60_000): Promise<SimMessage> {
    // Replay buffered messages first.
    for (const m of this.incoming) {
      if ((chatId === null || m.chatId === chatId) && predicate(m)) {
        return Promise.resolve(m);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`waitForMessage: timeout after ${timeoutMs}ms (chatId=${chatId})`));
      }, timeoutMs);
      this.waiters.push({ chatId, predicate, resolve, reject, timer });
    });
  }

  /** Get the most recent N messages in a chat. */
  async chatHistory(chatId: number, count = 20): Promise<SimMessage[]> {
    const items = await this.dc.rpc.getMessageListItems(this.accountId, chatId, false, false);
    const slice = items.slice(-count);
    const out: SimMessage[] = [];
    for (const id of slice) {
      try {
        const msg = await this.dc.rpc.getMessage(this.accountId, id);
        out.push({ id: msg.id, chatId: msg.chatId, text: msg.text ?? "", fromId: msg.fromId, isInfo: msg.isInfo });
      } catch {
        // skip unreadable
      }
    }
    return out;
  }

  /** Shut down RPC + child process. */
  async close(): Promise<void> {
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new Error("simulator closed"));
    }
    this.waiters = [];
    try { await this.dc.rpc.stopIo(this.accountId); } catch {}
    try { (this.dc as unknown as { close?: () => void }).close?.(); } catch {}
  }

  private absorbMessage(m: SimMessage): void {
    this.incoming.push(m);
    for (const w of [...this.waiters]) {
      if ((w.chatId === null || m.chatId === w.chatId) && w.predicate(m)) {
        clearTimeout(w.timer);
        this.waiters = this.waiters.filter((x) => x !== w);
        w.resolve(m);
      }
    }
  }
}

/** Wipe the simulator's state dir — call before `boot()` if `RESET_TEST_ACCOUNTS=1`. */
export function resetFixtureState(stateDir: string): void {
  if (existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true });
}
