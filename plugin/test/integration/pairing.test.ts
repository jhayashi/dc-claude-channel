/**
 * Tier-2 pair-and-message smoke test.
 *
 * Boots a real dispatcher subprocess + a real "phone-side" client
 * simulator, pairs them via the production /deltachat:setup flow,
 * and asserts a text message round-trips in both directions.
 *
 * Gated by `DC_INTEGRATION_TEST=1` AND a reachable relay. Both must be
 * true or the suite is skipped with an actionable hint.
 *
 * Relay configuration (env vars):
 *   DC_TEST_RELAY       relay host:port for HTTPS /new API
 *                       (default: "localhost:8443" — local Docker relay)
 *   DC_REUSE_ACCOUNTS=1 reuse .fixtures/ across runs (default: wipe on each run)
 *   RELAY_IMAPS_PORT    IMAP port (default 10993)
 *   RELAY_SMTPS_PORT    SMTP port (default 10465)
 *   DC_INTEGRATION_TEST must be "1" for the suite to run at all
 *
 * Account state persists in `plugin/test/integration/.fixtures/` when
 * DC_REUSE_ACCOUNTS=1 is set.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join, resolve } from "node:path";
import { existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { Dispatcher, defaultFixtureHome, resetFixtureHome } from "./dispatcher-fixture.js";
import { ClientSim, resetFixtureState } from "./client-sim.js";
import { skipIfUnreachable } from "./chatmail-probe.js";

const INTEGRATION_DIR = import.meta.dir;
const FIXTURES = resolve(INTEGRATION_DIR, ".fixtures");
const DISPATCHER_HOME = defaultFixtureHome(INTEGRATION_DIR);
const SIM_STATE = join(FIXTURES, "client-state");
const PAIRED_RECORD = join(FIXTURES, "paired.json");
const SERVER_PATH = resolve(INTEGRATION_DIR, "..", "..", "server.ts");

const relay = process.env.DC_TEST_RELAY ?? "localhost:8443";
const enabled = process.env.DC_INTEGRATION_TEST === "1";
const reuseAccounts = process.env.DC_REUSE_ACCOUNTS === "1";

interface PairedRecord {
  dispatcherChatId: number;
  simChatId: number;
}

// ── Skip gate ────────────────────────────────────────────────────────────────
// Evaluate at module load time. If the gate closes, describe.skipIf signals
// honest "skipped" output (not a silent green). The probe has a 3s timeout so
// it doesn't hold up the runner when the relay is down.
const skipReason = !enabled
  ? "DC_INTEGRATION_TEST not set"
  : ((await skipIfUnreachable(relay)).skip
    ? (await skipIfUnreachable(relay) as { skip: true; reason: string }).reason
    : null);

if (skipReason) console.log(`[tier-2] skipping — ${skipReason}`);

let dispatcher: Dispatcher | null = null;
let sim: ClientSim | null = null;
let paired: PairedRecord | null = null;

describe.skipIf(skipReason !== null)("tier-2 pairing", () => {
  beforeAll(async () => {
    // Fresh by default — wipe .fixtures/ unless DC_REUSE_ACCOUNTS=1.
    if (!reuseAccounts) {
      resetFixtureHome(DISPATCHER_HOME);
      resetFixtureState(SIM_STATE);
      try { rmSync(PAIRED_RECORD, { force: true }); } catch {}
    }

    if (!existsSync(FIXTURES)) mkdirSync(FIXTURES, { recursive: true });

    dispatcher = new Dispatcher({ home: DISPATCHER_HOME, serverPath: SERVER_PATH });
    sim = await ClientSim.boot({ stateDir: SIM_STATE, relay });
    await dispatcher.boot();

    // If reusing accounts and we have a valid saved pairing, reuse it.
    if (reuseAccounts) {
      paired = loadPairedRecord();
      if (paired) {
        const stillApproved = isChatApproved(DISPATCHER_HOME, paired.dispatcherChatId);
        if (!stillApproved) paired = null;
      }
    }

    if (!paired) {
      paired = await pair(dispatcher, sim);
      savePairedRecord(paired);
    }
  }, 600_000);

  afterAll(async () => {
    try { await sim?.close(); } catch {}
    try { await dispatcher?.kill(); } catch {}
  });

  test("dispatcher → sim text delivery", async () => {
    if (!dispatcher || !sim || !paired) throw new Error("setup did not run");

    const stamp = `dispatch-${Date.now()}`;
    await dispatcher.sendText(paired.dispatcherChatId, `ping ${stamp}`);
    const m = await sim.waitForMessage(paired.simChatId, (msg) => msg.text.includes(stamp), 60_000);
    expect(m.text).toContain(stamp);
  }, 90_000);

  test("sim → dispatcher text delivery", async () => {
    if (!dispatcher || !sim || !paired) throw new Error("setup did not run");

    const stamp = `phone-${Date.now()}`;
    await sim.sendText(paired.simChatId, `pong ${stamp}`);

    // Poll the dispatcher's chat history until the message shows up.
    const deadline = Date.now() + 60_000;
    let history = "";
    while (Date.now() < deadline) {
      history = await dispatcher.chatHistory(paired.dispatcherChatId, 20);
      if (history.includes(stamp)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(history).toContain(stamp);
  }, 90_000);
});

// ── Helpers ─────────────────────────────────────────────────────────────

async function pair(dispatcher: Dispatcher, sim: ClientSim): Promise<PairedRecord> {
  console.log("[pair] arming dispatcher pairing window");
  await dispatcher.armPairing();
  const qrUri = await dispatcher.inviteLink();
  console.log(`[pair] got QR URI: ${qrUri.slice(0, 80)}...`);
  console.log(`[pair] sim address: ${await sim.getAddress()}`);
  const simChatId = await sim.secureJoin(qrUri);
  console.log(`[pair] sim secureJoin returned simChatId=${simChatId}; waiting for welcome message...`);

  const welcome = await sim.waitForMessage(simChatId, (m) => /\/deltachat:setup pair [a-z]{5}/.test(m.text), 90_000);
  const match = welcome.text.match(/\/deltachat:setup pair ([a-z]{5})/);
  if (!match) throw new Error(`welcome message did not contain a pair code: ${welcome.text}`);
  const code = match[1];

  const result = await dispatcher.pair(code);
  const chatMatch = result.match(/Paired chat (\d+) successfully/);
  if (!chatMatch) throw new Error(`unexpected dc_access_pair response: ${result}`);
  const dispatcherChatId = Number(chatMatch[1]);

  return { dispatcherChatId, simChatId };
}

function isChatApproved(home: string, chatId: number): boolean {
  // v1.3+: approved/ is retired to approved.legacy/ at first boot. The
  // principal record + dc-core membership is the live source of truth,
  // but for the reuse-the-fixture optimization we just need a hint that
  // a previous pair existed — either dir is enough.
  const root = join(home, ".claude", "channels", "deltachat");
  for (const dir of [join(root, "approved"), join(root, "approved.legacy")]) {
    if (!existsSync(dir)) continue;
    if (readdirSync(dir).some((f) => f === String(chatId))) return true;
  }
  // Final fallback: principal record exists. If the dispatcher booted
  // and re-derived the allowlist from membership, neither approved/
  // nor approved.legacy/ may be present at all — but the principal
  // is.
  const principalsDir = join(root, "principals", "humans");
  return existsSync(principalsDir) && readdirSync(principalsDir).length > 0;
}

function loadPairedRecord(): PairedRecord | null {
  if (!existsSync(PAIRED_RECORD)) return null;
  try {
    return JSON.parse(readFileSync(PAIRED_RECORD, "utf8")) as PairedRecord;
  } catch {
    return null;
  }
}

function savePairedRecord(r: PairedRecord): void {
  writeFileSync(PAIRED_RECORD, JSON.stringify(r, null, 2));
}
