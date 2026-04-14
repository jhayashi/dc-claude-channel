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
import {
  startDeltaChat,
  type DeltaChatOverJsonRpcServer,
} from "@deltachat/stdio-rpc-server";
import type { RawClient } from "@deltachat/jsonrpc-client";

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

export class DCClient {
  private dc: DeltaChatOverJsonRpcServer | null = null;
  private rpc: RawClient | null = null;
  private accountId: number = 0;
  private contextEvents: ReturnType<DeltaChatOverJsonRpcServer['getContextEvents']> | null = null;
  private logFn: ((format: string, ...args: unknown[]) => void) | null = null;

  /** Set a logger for internal error reporting. */
  setLogger(fn: (format: string, ...args: unknown[]) => void): void {
    this.logFn = fn;
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
    this.dc = await startDeltaChat(DC_DATA_DIR, { muteStdErr: true });
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
      const resp = await fetch(url, { method: "POST" });
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

      await rpc.configure(accountId);
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
    await rpc.sendReaction(accountId, messageId, emoji ? [emoji] : []);
  }

  async sendWebXDC(chatId: number, xdcPath: string): Promise<number> {
    const { rpc, accountId } = this.ensureAccount();
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

  /** True if chatId is a 1:1 ("Single") chat, false for groups/mailinglists/broadcasts. */
  async isSingleChat(chatId: number): Promise<boolean> {
    const { rpc, accountId } = this.ensureAccount();
    const info = await rpc.getBasicChatInfo(accountId, chatId);
    return info.chatType === 'Single';
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
