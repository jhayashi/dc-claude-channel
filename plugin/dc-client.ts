/**
 * dc-client.ts — Delta Chat RPC client wrapper.
 *
 * Wraps @deltachat/jsonrpc-client's StdioDeltaChat (via @deltachat/stdio-rpc-server)
 * to provide a high-level API for the Claude Code channel plugin.
 *
 * Supports event-driven message and WebXDC update handling via
 * Delta Chat's built-in TinyEmitter event system.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { waitForReady } from "./bootstrap.js";
import type { DeltaChatOverJsonRpcServer } from "@deltachat/stdio-rpc-server";
import type { RawClient } from "@deltachat/jsonrpc-client";

// Lazy-loaded so the bundler doesn't resolve @deltachat/* at startup,
// which fails on a fresh install before `bun install` has run.
// server.ts awaits waitForReady() before calling start(); the dynamic
// import here is the actual load after that gate opens.
async function loadStartDeltaChat(): Promise<typeof import("@deltachat/stdio-rpc-server").startDeltaChat> {
  await waitForReady();
  return (await import("@deltachat/stdio-rpc-server")).startDeltaChat;
}

// ── Exported types ──────────────────────────────────────────────────────

/**
 * Normalize the systemMessageType value returned by deltachat-rpc-server.
 *
 * dc-core returns 'Unknown' (the SystemMessage enum default) for every
 * regular text message — not null or undefined. Leaving that as a truthy
 * string breaks downstream `if (msg.systemMessageType)` checks in server.ts,
 * which would treat every text message as a system message and silently
 * drop it. Real system messages have values like 'MemberRemovedFromGroup',
 * 'GroupNameChanged', etc.
 */
export function normalizeSystemMessageType(raw: string | null | undefined): string | undefined {
  if (!raw || raw === 'Unknown') return undefined
  return raw
}

export interface Message {
  id: number;
  chatId: number;
  senderName: string;
  text: string;
  timestamp: Date;
  /** File path on local disk (images, documents, audio, etc.) */
  file?: string;
  /** MIME type of the attachment */
  fileMime?: string;
  /** File size in bytes */
  fileBytes?: number;
  /** Display filename */
  fileName?: string;
  /** Message view type (Text, Image, Audio, Video, File, Gif, Sticker, Webxdc, etc.) */
  viewType?: string;
  /** Delta Chat contact ID of the sender */
  fromId?: number;
  /** System message type (e.g. "MemberRemovedFromGroup") when this is a system info msg */
  systemMessageType?: string;
}

/**
 * A reaction change event surfaced by DC's ReactionsChanged event.
 * `reaction` is the new reaction string for the reactor; empty string
 * means the reactor cleared their previous reaction.
 */
export interface ReactionEvent {
  chatId: number;
  msgId: number;
  fromId: number;
  senderName: string;
  reaction: string;
  timestamp: Date;
}

/**
 * A message-edit event surfaced after debounce + dedupe (#45). Fires
 * only when the edited message is the most-recent user message in the
 * chat — older edits are dropped at the dc-client layer.
 */
export interface MessageEditEvent {
  chatId: number;
  msgId: number;
  fromId: number;
  text: string;
  timestamp: Date;
}

export interface BotStatus {
  address: string;
  connected: boolean;
  inviteLink: string;
}

export interface WebXDCUpdate {
  payload: unknown;
  serial: number;
}

// ── Constants ───────────────────────────────────────────────────────────

const DC_DATA_DIR = join(
  homedir(),
  ".claude",
  "channels",
  "deltachat",
  "dc-data",
);

/** DC contact ID for "self" (our own outgoing messages). */
const CONTACT_SELF = 1;

/** Connectivity value indicating fully connected. */
const DC_CONNECTIVITY_CONNECTED = 4000;

// ── Client ──────────────────────────────────────────────────────────────

import type { RateLimiter } from './dispatcher/send-rate-limiter.js';

export class DCClient {
  private dc: DeltaChatOverJsonRpcServer | null = null;
  private rpc: RawClient | null = null;
  private accountId: number = 0;
  private contextEvents: ReturnType<DeltaChatOverJsonRpcServer['getContextEvents']> | null = null;
  private logFn: ((format: string, ...args: unknown[]) => void) | null = null;
  private rateLimiter: RateLimiter | null = null;

  // ── Edit-as-interrupt state (#45) ──────────────────────────────────────
  // Most-recent inbound (non-self) msgId per chat. Set on every IncomingMsg;
  // backfilled at dispatcher startup. Read by onMessageEdit's pre-filter to
  // skip RPC for edits to non-most-recent messages.
  private lastUserMsgId: Map<number, number> = new Map();
  // Per-chat debounce timer for coalesced edits. At most one timer per chat;
  // each new MsgsChanged for the chat resets the timer.
  private pendingEditTimers: Map<number, NodeJS.Timeout> = new Map();
  // Per-(chatId, msgId) snapshot of the last text we fired on. Used to dedupe
  // re-fires when DC's MsgsChanged repeats with the same content.
  private editLastFiredText: Map<string, string> = new Map();
  // Default debounce window — edits within this window coalesce to one fire.
  // 5s is long enough to absorb a typing-pause-typing edit storm without
  // making single-edit responsiveness too laggy.
  private static EDIT_DEBOUNCE_MS = 5000;

  /** Set a logger for internal error reporting. */
  setLogger(fn: (format: string, ...args: unknown[]) => void): void {
    this.logFn = fn;
  }

  /**
   * Set the outbound rate limiter. All send-style methods will acquire
   * a token from it before issuing the RPC. Pass null to disable.
   * The chatmail server enforces a per-account GCRA bucket (default 60/min,
   * 10 burst); this mirrors it client-side so we never get 4xx-rejected.
   */
  setRateLimiter(limiter: RateLimiter | null): void {
    this.rateLimiter = limiter;
  }

  private async acquireSendToken(): Promise<void> {
    if (this.rateLimiter) await this.rateLimiter.acquire();
  }

  private log(format: string, ...args: unknown[]): void {
    this.logFn?.(format, ...args);
  }

  private ensureRpc(): RawClient {
    if (!this.rpc) {
      throw new Error("DCClient not started; call start() first");
    }
    return this.rpc;
  }

  private ensureAccount(): { rpc: RawClient; accountId: number } {
    const rpc = this.ensureRpc();
    if (this.accountId === 0) {
      throw new Error(
        "No account initialised; call initAccount() or startSavedAccount() first",
      );
    }
    return { rpc, accountId: this.accountId };
  }

  /**
   * Ensure a message's blob is downloaded. `downloadFullMessage` kicks off
   * the download but returns before it completes — state typically goes
   * Available → InProgress → Done. Poll until Done (or terminal error, or
   * timeout) so handlers see a usable file. Returns the latest snapshot.
   */
  private async ensureDownloaded(snap: any, msgId: number): Promise<any> {
    const { rpc, accountId } = this.ensureAccount();
    if (snap.downloadState !== 'Available' && snap.downloadState !== 'InProgress') {
      return snap;
    }
    if (snap.downloadState === 'Available') {
      this.log('dc-client: downloading full message %d', msgId);
      await rpc.downloadFullMessage(accountId, msgId).catch(err =>
        this.log('dc-client: downloadFullMessage error for %d: %v', msgId, err),
      );
    }
    const DEADLINE_MS = 30_000;
    const POLL_MS = 250;
    const start = Date.now();
    let latest = snap;
    while (Date.now() - start < DEADLINE_MS) {
      latest = await rpc.getMessage(accountId, msgId);
      if (latest.downloadState === 'Done'
        || latest.downloadState === 'Failure'
        || latest.downloadState === 'Undecipherable') break;
      await new Promise(r => setTimeout(r, POLL_MS));
    }
    this.log('dc-client: after download msg=%d: downloadState=%s file=%s elapsed=%dms',
      msgId, latest.downloadState, latest.file ?? 'null', Date.now() - start);
    return latest;
  }

  /**
   * Start the deltachat-rpc-server subprocess.
   * Creates the data directory if it does not exist.
   */
  async start(): Promise<void> {
    mkdirSync(DC_DATA_DIR, { recursive: true });
    const startDeltaChat = await loadStartDeltaChat();
    // DC_RPC_DEBUG=1 forwards deltachat-rpc-server stderr (incl. RUST_LOG) to
    // the parent process. Muted by default since the rpc-server is chatty.
    const muteStdErr = process.env.DC_RPC_DEBUG !== "1";
    this.dc = await startDeltaChat(DC_DATA_DIR, { muteStdErr });
    this.rpc = this.dc.rpc;
  }

  /**
   * Provision a new bot account on a chatmail server.
   * Calls startIo immediately since this is the first run (no queued messages to miss).
   */
  async initAccount(
    name: string,
    chatmailServer: string,
  ): Promise<{ address: string; password: string; inviteLink: string }> {
    const rpc = this.ensureRpc();

    const accountId = await rpc.addAccount();
    let success = false;

    try {
      const url = `https://${chatmailServer}/new`;
      const host = chatmailServer.split(":")[0];
      const testRelay = host === "localhost" || host === "127.0.0.1" || host.startsWith("_");

      // Local/test-domain relays use self-signed TLS — skip verification.
      const fetchOpts: RequestInit & { tls?: { rejectUnauthorized: boolean } } = {
        method: "POST",
      };
      if (testRelay) fetchOpts.tls = { rejectUnauthorized: false };

      const resp = await fetch(url, fetchOpts);
      if (!resp.ok) {
        throw new Error(`POST ${url}: HTTP ${resp.status}`);
      }
      const result = (await resp.json()) as {
        email: string;
        password: string;
      };
      if (!result.email || !result.password) {
        throw new Error("chatmail /new returned empty credentials");
      }

      await rpc.setConfig(accountId, "addr", result.email);
      await rpc.setConfig(accountId, "mail_pw", result.password);
      await rpc.setConfig(accountId, "displayname", name);
      await rpc.setConfig(accountId, "bot", "1");

      if (testRelay) {
        // Override DC core's autoconfiguration to use the loopback-mapped ports
        // rather than DNS-resolving the _chatmail.test domain.  Set before
        // configure() so the connection test succeeds; re-apply after because
        // configure()'s autoconfig may reset the cert-check setting.
        const imapsPort = Number(process.env.RELAY_IMAPS_PORT ?? "10993");
        const smtpsPort = Number(process.env.RELAY_SMTPS_PORT ?? "10465");
        await rpc.setConfig(accountId, "mail_server", "127.0.0.1");
        await rpc.setConfig(accountId, "send_server", "127.0.0.1");
        await rpc.setConfig(accountId, "mail_port", String(imapsPort));
        await rpc.setConfig(accountId, "send_port", String(smtpsPort));
        // "3" = AcceptInvalidCertificates — accept self-signed test certs
        await rpc.setConfig(accountId, "imap_certificate_checks", "3");
        await rpc.setConfig(accountId, "smtp_certificate_checks", "3");
      }

      await rpc.configure(accountId);

      if (testRelay) {
        // Re-apply cert checks after configure() in case autoconfig reset them.
        await rpc.setConfig(accountId, "imap_certificate_checks", "3");
        await rpc.setConfig(accountId, "smtp_certificate_checks", "3");
      }

      await rpc.startIo(accountId);

      const [inviteLink] = await rpc.getChatSecurejoinQrCodeSvg(
        accountId,
        null,
      );

      this.accountId = accountId;
      this.contextEvents = this.dc!.getContextEvents(accountId);
      success = true;

      return {
        address: result.email,
        password: result.password,
        inviteLink,
      };
    } finally {
      if (!success) {
        await rpc.removeAccount(accountId).catch(() => {});
      }
    }
  }

  /**
   * Find a previously-configured account by its address.
   * Does NOT start IO — call startIO() after registering event handlers.
   */
  async startSavedAccount(address: string): Promise<void> {
    const rpc = this.ensureRpc();
    const ids = await rpc.getAllAccountIds();

    for (const id of ids) {
      const addr = await rpc.getConfig(id, "addr");
      if (addr === address) {
        this.accountId = id;
        this.contextEvents = this.dc!.getContextEvents(id);
        return;
      }
    }

    throw new Error(`No account found with address "${address}"`);
  }

  /**
   * Start IO for the account. Call this AFTER registering event handlers
   * to avoid missing queued messages.
   */
  async startIO(): Promise<void> {
    const { rpc, accountId } = this.ensureAccount();
    await rpc.startIo(accountId);
  }

  // ── Event handlers ──────────────────────────────────────────────────

  /**
   * Register a handler for incoming messages. Called immediately when
   * a message arrives (no polling). Register BEFORE calling startIO().
   */
  onIncomingMessage(handler: (msg: Message) => void): void {
    if (!this.contextEvents) throw new Error('Account not initialized');
    const { rpc, accountId } = this.ensureAccount();

    this.contextEvents.on('IncomingMsg', async (event: { msgId: number }) => {
      try {
        let snap = await rpc.getMessage(accountId, event.msgId);
        if (snap.fromId === CONTACT_SELF) return;
        await rpc.markseenMsgs(accountId, [event.msgId]).catch(() => {});

        // #45: track most-recent user msgId per chat for edit-as-interrupt
        // pre-filter, and cancel any pending edit-debounce timer for this
        // chat — newer messages always supersede pending edits to older
        // ones (Elena #1; otherwise the edit's restart would clobber the
        // newer message's response after the debounce expires).
        this.lastUserMsgId.set(snap.chatId, snap.id);
        const pendingEditTimer = this.pendingEditTimers.get(snap.chatId);
        if (pendingEditTimer) {
          clearTimeout(pendingEditTimer);
          this.pendingEditTimers.delete(snap.chatId);
          this.log('dc-client: incoming msg %d on chat %d cancelled pending edit', snap.id, snap.chatId);
        }

        // Auto-download attachments that aren't fully downloaded yet.
        this.log('dc-client: msg %d: viewType=%s downloadState=%s file=%s', snap.id, snap.viewType, snap.downloadState, snap.file ?? 'null');
        snap = await this.ensureDownloaded(snap, event.msgId);

        handler({
          id: snap.id,
          chatId: snap.chatId,
          senderName: snap.sender.displayName,
          text: snap.text,
          timestamp: new Date(snap.receivedTimestamp * 1000),
          file: snap.file ?? undefined,
          fileMime: snap.fileMime ?? undefined,
          fileBytes: snap.fileBytes ? Number(snap.fileBytes) : undefined,
          fileName: snap.fileName ?? undefined,
          viewType: snap.viewType ?? undefined,
          fromId: snap.fromId,
          systemMessageType: normalizeSystemMessageType(snap.systemMessageType),
        });
      } catch (err) {
        this.log('dc-client: incoming message error: %v', err);
      }
    });
  }

  /**
   * Register a handler for WebXDC status updates. Called immediately
   * when an app sends an update (no polling). Register BEFORE calling startIO().
   */
  onWebXDCUpdate(handler: (msgId: number, serial: number) => void): void {
    if (!this.contextEvents) throw new Error('Account not initialized');

    this.contextEvents.on('WebxdcStatusUpdate', (event: { msgId: number; statusUpdateSerial: number }) => {
      handler(event.msgId, event.statusUpdateSerial);
    });
  }

  /**
   * Register a handler for reaction changes on any message in the account.
   * Fires for both additions and removals. Self-reactions (from CONTACT_SELF)
   * are filtered out at this layer to avoid feedback loops with our own
   * outbound reactions (e.g. the cold-start spinner). Register BEFORE calling
   * startIO().
   */
  onReaction(handler: (ev: ReactionEvent) => void): void {
    if (!this.contextEvents) throw new Error('Account not initialized');
    const { rpc, accountId } = this.ensureAccount();

    this.contextEvents.on('ReactionsChanged', async (event: { chatId: number; msgId: number; contactId: number }) => {
      try {
        if (event.contactId === CONTACT_SELF) return;
        // Read the full reaction set for the message to discover what the
        // reactor's current reaction is (the event itself doesn't carry it).
        const reactions = await rpc.getMessageReactions(accountId, event.msgId);
        const byContact = (reactions?.reactionsByContact ?? {}) as Record<string, string[]>;
        const list = byContact[String(event.contactId)] ?? [];
        // DC stores an array per contact; in practice there's at most one
        // emoji per sender per message. Empty array = reactor cleared.
        const reaction = list.length > 0 ? list.join('') : '';
        const contact = await rpc.getContact(accountId, event.contactId).catch(() => null);
        handler({
          chatId: event.chatId,
          msgId: event.msgId,
          fromId: event.contactId,
          senderName: contact?.displayName ?? `contact:${event.contactId}`,
          reaction,
          timestamp: new Date(),
        });
      } catch (err) {
        this.log('dc-client: reaction event error: %v', err);
      }
    });
  }

  /**
   * Register a handler for message-edit events (#45). Subscribes to DC's
   * MsgsChanged event and filters down to actual edits of the most-recent
   * user message in each paired chat.
   *
   * Filter pipeline:
   *   1. Single-message dispatch only (chatId !== 0 && msgId !== 0).
   *   2. Cheap pre-filter: msgId === lastUserMsgId[chatId]. MsgsChanged is
   *      chatty (read receipts, delivery, etc.); this drops ~99% of fires
   *      without an RPC. Edits to non-most-recent messages are out of scope
   *      for v1 anyway.
   *   3. Debounce 5s per chat. Each fire resets the timer; deliverEdit runs
   *      after 5s of quiet on the chat. Coalesces typing-pause-typing storms.
   *   4. After debounce expires: getMessage RPC, check isEdited + not-self,
   *      dedupe by text (no editedTimestamp on the Message schema), fire
   *      handler.
   *
   * Pending timers are cancelled by the IncomingMsg handler when a newer
   * user message arrives — newer messages always supersede edits to older
   * ones. See onIncomingMessage().
   *
   * Register BEFORE calling startIO().
   */
  onMessageEdit(handler: (event: MessageEditEvent) => void): void {
    if (!this.contextEvents) throw new Error('Account not initialized');

    this.contextEvents.on('MsgsChanged', (event: { chatId: number; msgId: number }) => {
      // 1. single-message dispatch only
      if (event.chatId === 0 || event.msgId === 0) return;
      // 2. pre-filter: only most-recent user msg
      const lastMsg = this.lastUserMsgId.get(event.chatId);
      if (lastMsg !== event.msgId) return;
      // 3. debounce — reset timer on every fire
      const existing = this.pendingEditTimers.get(event.chatId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => this.deliverEdit(event.chatId, event.msgId, handler), DCClient.EDIT_DEBOUNCE_MS);
      this.pendingEditTimers.set(event.chatId, timer);
    });
  }

  /** After-debounce edit delivery: fetch message, validate, dedupe, fire. */
  private async deliverEdit(chatId: number, msgId: number, handler: (event: MessageEditEvent) => void): Promise<void> {
    this.pendingEditTimers.delete(chatId);
    try {
      const { rpc, accountId } = this.ensureAccount();
      const snap = await rpc.getMessage(accountId, msgId);
      // 4a. only fire on actual edits
      if (!snap.isEdited) return;
      // 4b. skip self-authored (DC only allows users to edit their own messages,
      // but defensive: bot's own outbound edits should never trigger restart)
      if (snap.fromId === CONTACT_SELF) return;
      // 4c. dedupe by text — DC's MsgsChanged can re-fire for the same edit;
      // we only want to fire once per distinct edited text
      const dedupeKey = `${chatId}:${msgId}`;
      const lastText = this.editLastFiredText.get(dedupeKey);
      if (lastText === snap.text) return;
      this.editLastFiredText.set(dedupeKey, snap.text);

      handler({
        chatId: snap.chatId,
        msgId: snap.id,
        fromId: snap.fromId,
        text: snap.text,
        timestamp: new Date(),
      });
    } catch (err) {
      this.log('dc-client: deliverEdit error chat=%d msg=%d: %v', chatId, msgId, err);
    }
  }

  /**
   * Backfill `lastUserMsgId` for the given chats from DC's local DB. Called
   * during dispatcher startup so the first edit after restart isn't silently
   * ignored (the cheap pre-filter in onMessageEdit needs lastUserMsgId
   * populated).
   */
  async backfillLastUserMsgIds(chatIds: number[]): Promise<void> {
    const { rpc, accountId } = this.ensureAccount();
    for (const chatId of chatIds) {
      try {
        // Get the message-id list (most recent last). We want the highest id
        // where fromId !== CONTACT_SELF.
        const ids = await rpc.getMessageIds(accountId, chatId, false, false);
        for (let i = ids.length - 1; i >= 0; i--) {
          const id = ids[i];
          const snap = await rpc.getMessage(accountId, id).catch(() => null);
          if (snap && snap.fromId !== CONTACT_SELF) {
            this.lastUserMsgId.set(chatId, snap.id);
            break;
          }
        }
      } catch (err) {
        this.log('dc-client: backfillLastUserMsgIds chat=%d failed: %v', chatId, err);
      }
    }
  }

  /**
   * Register a handler for chat modification events (membership changes,
   * renames, ephemeral timer changes, etc.). These fire for locally-generated
   * changes that don't come through IncomingMsg — specifically, when the chat
   * owner leaves a group from their own device. The bot's cleanup logic needs
   * this event path; the `IncomingMsg` path only fires when the bot is
   * notified remotely via email.
   */
  onChatModified(handler: (chatId: number) => void): void {
    if (!this.contextEvents) throw new Error('Account not initialized');

    this.contextEvents.on('ChatModified', (event: { chatId: number }) => {
      handler(event.chatId);
    });
  }

  /**
   * Register a handler for SecurejoinInviterProgress events at progress=1000
   * — the signal that a joiner has successfully completed the QR-scan
   * handshake against this bot's invite link. DC has already created the
   * 1:1 chat by the time we fire. Used by the pair-on-verified-contact
   * flow in server.ts to materialize a `Claude` chat and post the 5-letter
   * pairing code during the armed /deltachat:setup window.
   */
  onSecurejoinComplete(handler: (chatId: number, contactId: number) => void): void {
    if (!this.contextEvents) throw new Error('Account not initialized');

    this.contextEvents.on('SecurejoinInviterProgress', (event: { contactId: number; chatId: number; progress: number }) => {
      if (event.progress !== 1000) return;
      handler(event.chatId, event.contactId);
    });
  }

  // ── Existing API (unchanged) ────────────────────────────────────────

  async status(): Promise<BotStatus> {
    const { rpc, accountId } = this.ensureAccount();

    const address = (await rpc.getConfig(accountId, "addr")) ?? "";
    const connectivity = await rpc.getConnectivity(accountId);
    const connected = connectivity >= DC_CONNECTIVITY_CONNECTED;

    let inviteLink = "";
    try {
      const [qrText] = await rpc.getChatSecurejoinQrCodeSvg(accountId, null);
      inviteLink = qrText;
    } catch {
      // non-fatal
    }

    return { address, connected, inviteLink };
  }

  async inviteLink(): Promise<string> {
    const { rpc, accountId } = this.ensureAccount();
    const [qrText] = await rpc.getChatSecurejoinQrCodeSvg(accountId, null);
    return qrText;
  }

  async send(chatId: number, text: string): Promise<number> {
    const { rpc, accountId } = this.ensureAccount();
    await this.acquireSendToken();
    const msgId = await rpc.sendMsg(accountId, chatId, {
      text,
      html: null,
      viewtype: null,
      file: null,
      filename: null,
      location: null,
      overrideSenderName: null,
      quotedMessageId: null,
      quotedText: null,
    });
    return msgId;
  }

  /**
   * React to a message with an emoji. Pass an empty string to clear
   * our own reaction. DC reactions are per-contact; the last value
   * from us wins.
   */
  async sendReaction(messageId: number, emoji: string): Promise<void> {
    const { rpc, accountId } = this.ensureAccount();
    await this.acquireSendToken();
    await rpc.sendReaction(accountId, messageId, emoji ? [emoji] : []);
  }

  async sendWebXDC(chatId: number, xdcPath: string): Promise<number> {
    const { rpc, accountId } = this.ensureAccount();
    await this.acquireSendToken();
    const msgId = await rpc.sendMsg(accountId, chatId, {
      text: null,
      html: null,
      viewtype: "Webxdc",
      file: xdcPath,
      filename: null,
      location: null,
      overrideSenderName: null,
      quotedMessageId: null,
      quotedText: null,
    });
    return msgId;
  }

  async sendAttachment(chatId: number, filePath: string, caption?: string): Promise<number> {
    const { rpc, accountId } = this.ensureAccount();
    await this.acquireSendToken();
    const msgId = await rpc.sendMsg(accountId, chatId, {
      text: caption ?? null,
      html: null,
      viewtype: null,
      file: filePath,
      filename: null,
      location: null,
      overrideSenderName: null,
      quotedMessageId: null,
      quotedText: null,
    });
    return msgId;
  }

  async sendWebXDCUpdate(msgId: number, update: string): Promise<void> {
    const { rpc, accountId } = this.ensureAccount();
    await this.acquireSendToken();
    await rpc.sendWebxdcStatusUpdate(accountId, msgId, update, null);
  }

  async getWebXDCUpdates(
    msgId: number,
    lastSerial: number,
  ): Promise<WebXDCUpdate[]> {
    const { rpc, accountId } = this.ensureAccount();
    const raw = await rpc.getWebxdcStatusUpdates(accountId, msgId, lastSerial);
    if (!raw || raw === "[]") {
      return [];
    }
    return JSON.parse(raw) as WebXDCUpdate[];
  }

  async createGroup(name: string): Promise<number> {
    const { rpc, accountId } = this.ensureAccount();
    return await rpc.createGroupChat(accountId, name, true);
  }

  async addContactToChat(chatId: number, contactId: number): Promise<void> {
    const { rpc, accountId } = this.ensureAccount();
    await rpc.addContactToChat(accountId, chatId, contactId);
  }

  async getChatContacts(chatId: number): Promise<number[]> {
    const { rpc, accountId } = this.ensureAccount();
    return await rpc.getChatContacts(accountId, chatId);
  }

  /**
   * List every chat id known to the bot's account. Used by v1.3 startup
   * to walk membership and seed the in-memory allowlist cache.
   * Wraps `getChatlistEntries(accountId, null, null, null)` — no
   * filtering, every chat included.
   */
  async getChats(): Promise<number[]> {
    const { rpc, accountId } = this.ensureAccount();
    return await rpc.getChatlistEntries(accountId, null, null, null);
  }

  /**
   * Every contact in the bot's address book — paired or not. Wraps
   * `getContactIds(accountId, 0, null)` (no flags = no filtering: every
   * known contact, excluding blocked ones, excluding self by default).
   * Used by the contacts UI to surface unpaired contacts alongside
   * paired ones.
   */
  async getContactIds(): Promise<number[]> {
    const { rpc, accountId } = this.ensureAccount();
    return await rpc.getContactIds(accountId, 0, null);
  }

  async getFullChat(chatId: number): Promise<{
    id: number
    name: string
    chatType: string
    contactIds: number[]
    pastContactIds: number[]
    selfInGroup: boolean
    canSend: boolean
    archived: boolean
    freshMessageCounter: number
  }> {
    const { rpc, accountId } = this.ensureAccount();
    const fc = await rpc.getFullChatById(accountId, chatId);
    return {
      id: fc.id,
      name: fc.name,
      chatType: fc.chatType,
      contactIds: fc.contactIds,
      pastContactIds: fc.pastContactIds,
      selfInGroup: fc.selfInGroup,
      canSend: fc.canSend,
      archived: fc.archived,
      freshMessageCounter: fc.freshMessageCounter,
    }
  }

  /** True if chatId is a 1:1 ("Single") chat, false for groups/mailinglists/broadcasts. */
  async isSingleChat(chatId: number): Promise<boolean> {
    const { rpc, accountId } = this.ensureAccount();
    const info = await rpc.getBasicChatInfo(accountId, chatId);
    return info.chatType === 'Single';
  }

  async getChatName(chatId: number): Promise<string> {
    const { rpc, accountId } = this.ensureAccount();
    const info = await rpc.getBasicChatInfo(accountId, chatId);
    return info.name;
  }

  async setChatName(chatId: number, name: string): Promise<void> {
    const { rpc, accountId } = this.ensureAccount();
    await rpc.setChatName(accountId, chatId, name);
  }

  /** Set the bot's own avatar (selfavatar config key). */
  async setSelfAvatar(imagePath: string): Promise<void> {
    const { rpc, accountId } = this.ensureAccount();
    await rpc.setConfig(accountId, 'selfavatar', imagePath);
  }

  async setChatProfileImage(chatId: number, imagePath: string | null): Promise<void> {
    const { rpc, accountId } = this.ensureAccount();
    await rpc.setChatProfileImage(accountId, chatId, imagePath);
  }

  /** Delete a chat locally (does not affect other members). */
  async deleteChat(chatId: number): Promise<void> {
    const { rpc, accountId } = this.ensureAccount();
    await rpc.deleteChat(accountId, chatId);
  }

  /** Remove the bot (self, contact 1) from a group chat. */
  async leaveChat(chatId: number): Promise<void> {
    const { rpc, accountId } = this.ensureAccount();
    await rpc.removeContactFromChat(accountId, chatId, 1);
  }

  async getGroupInviteLink(chatId: number): Promise<string> {
    const { rpc, accountId } = this.ensureAccount();
    const [qrText] = await rpc.getChatSecurejoinQrCodeSvg(accountId, chatId);
    return qrText;
  }

  async getChatHistory(chatId: number, count: number = 20): Promise<Message[]> {
    const { rpc, accountId } = this.ensureAccount();
    const msgIds = await rpc.getMessageIds(accountId, chatId, false, false);
    // Take the last N message IDs (most recent)
    const recentIds = msgIds.slice(-count);
    if (recentIds.length === 0) return [];
    const snaps = await rpc.getMessages(accountId, recentIds);
    const messages: Message[] = [];
    for (const id of recentIds) {
      const result = snaps[id];
      if (!result || typeof result !== 'object' || !('id' in result)) continue;
      const snap = result as any;
      messages.push({
        id: snap.id,
        chatId: snap.chatId,
        senderName: snap.sender?.displayName ?? 'Unknown',
        text: snap.text ?? '',
        timestamp: new Date((snap.receivedTimestamp ?? snap.timestamp ?? 0) * 1000),
        file: snap.file ?? undefined,
        fileMime: snap.fileMime ?? undefined,
        fileBytes: snap.fileBytes ? Number(snap.fileBytes) : undefined,
        fileName: snap.fileName ?? undefined,
        viewType: snap.viewType ?? undefined,
        fromId: typeof snap.fromId === 'number' ? snap.fromId : undefined,
      });
    }
    return messages;
  }

  async downloadMessage(msgId: number): Promise<Message | null> {
    const { rpc, accountId } = this.ensureAccount();
    let snap = await rpc.getMessage(accountId, msgId);
    snap = await this.ensureDownloaded(snap, msgId);
    return {
      id: snap.id,
      chatId: snap.chatId,
      senderName: snap.sender?.displayName ?? 'Unknown',
      text: snap.text ?? '',
      timestamp: new Date((snap.receivedTimestamp ?? snap.timestamp ?? 0) * 1000),
      file: snap.file ?? undefined,
      fileMime: snap.fileMime ?? undefined,
      fileBytes: snap.fileBytes ? Number(snap.fileBytes) : undefined,
      fileName: snap.fileName ?? undefined,
      viewType: snap.viewType ?? undefined,
      fromId: typeof snap.fromId === 'number' ? snap.fromId : undefined,
    };
  }

  async lookupContactByAddr(addr: string): Promise<number | null> {
    const { rpc, accountId } = this.ensureAccount();
    return await rpc.lookupContactIdByAddr(accountId, addr);
  }

  async getContactName(contactId: number): Promise<string | null> {
    const { rpc, accountId } = this.ensureAccount();
    try {
      const contact = await rpc.getContact(accountId, contactId);
      return contact?.displayName ?? null;
    } catch {
      return null;
    }
  }

  /** Fetch a Delta Chat contact (display name, address, verification status). */
  async getContact(contactId: number): Promise<{
    displayName: string;
    name: string;
    address: string;
    isVerified: boolean;
    isBot: boolean;
  } | null> {
    const { rpc, accountId } = this.ensureAccount();
    try {
      const c = await rpc.getContact(accountId, contactId);
      if (!c) return null;
      return {
        displayName: c.displayName ?? '',
        name: c.name ?? '',
        address: c.address ?? '',
        isVerified: !!c.isVerified,
        isBot: !!c.isBot,
      };
    } catch {
      return null;
    }
  }

  /** Bot's own configured email address (from dc-core config). */
  async getSelfAddress(): Promise<string | null> {
    const { rpc, accountId } = this.ensureAccount();
    try {
      return await rpc.getConfig(accountId, "configured_addr");
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    if (this.rpc && this.accountId !== 0) {
      await this.rpc.stopIo(this.accountId).catch(() => {});
    }
    if (this.dc) {
      this.dc.close();
    }
    this.rpc = null;
    this.dc = null;
    this.contextEvents = null;
    this.accountId = 0;
  }
}
