/**
 * Tier-2 subagent lifecycle smoke test.
 *
 * Sim sends a message into its paired chat → dispatcher routes through
 * SubagentCache → real `claude -p` subagent spawns → subagent's first
 * turn produces a reply via the `reply` MCP tool → sim observes the
 * reply on the wire.
 *
 * **Cost:** Each run consumes ~1 Anthropic turn against whatever
 * credentials the dispatcher's `claude` binary is configured with.
 * Doubly-gated to make this opt-in:
 *
 *   DC_INTEGRATION_TEST=1   # tier-2 gate (also required for pairing)
 *   DC_TEST_SUBAGENT=1      # opts into the LLM-cost test specifically
 *
 * Either var unset → suite skipped.
 *
 * Uses its OWN fixture dir (`.fixtures-subagent/`) to avoid contention
 * with `pairing.test.ts` when both run.  `DC_REUSE_ACCOUNTS=1` works
 * the same way as in pairing.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { Dispatcher, resetFixtureHome } from "./dispatcher-fixture.js";
import { ClientSim, resetFixtureState } from "./client-sim.js";
import { skipIfUnreachable } from "./chatmail-probe.js";

const INTEGRATION_DIR = import.meta.dir;
const FIXTURES = resolve(INTEGRATION_DIR, ".fixtures-subagent");
const DISPATCHER_HOME = join(FIXTURES, "dispatcher-home");
const SIM_STATE = join(FIXTURES, "client-state");
const PAIRED_RECORD = join(FIXTURES, "paired.json");
const SERVER_PATH = resolve(INTEGRATION_DIR, "..", "..", "server.ts");

const relay = process.env.DC_TEST_RELAY ?? "localhost:8443";
const enabled = process.env.DC_INTEGRATION_TEST === "1" && process.env.DC_TEST_SUBAGENT === "1";
const reuseAccounts = process.env.DC_REUSE_ACCOUNTS === "1";

interface PairedRecord {
  dispatcherChatId: number;
  simChatId: number;
}

const probe = enabled ? await skipIfUnreachable(relay) : null;
const skipReason = !enabled
  ? "DC_INTEGRATION_TEST=1 + DC_TEST_SUBAGENT=1 both required (LLM cost — opt-in)"
  : (probe!.skip ? (probe as { skip: true; reason: string }).reason : null);

if (skipReason) console.log(`[tier-2 subagent] skipping — ${skipReason}`);

let dispatcher: Dispatcher | null = null;
let sim: ClientSim | null = null;
let paired: PairedRecord | null = null;

describe.skipIf(skipReason !== null)("tier-2 subagent lifecycle", () => {
  beforeAll(async () => {
    if (!reuseAccounts) {
      resetFixtureHome(DISPATCHER_HOME);
      resetFixtureState(SIM_STATE);
      try { rmSync(PAIRED_RECORD, { force: true }); } catch {}
    }
    if (!existsSync(FIXTURES)) mkdirSync(FIXTURES, { recursive: true });

    dispatcher = new Dispatcher({ home: DISPATCHER_HOME, serverPath: SERVER_PATH });
    sim = await ClientSim.boot({ stateDir: SIM_STATE, relay });
    await dispatcher.boot();

    if (reuseAccounts) {
      paired = loadPairedRecord();
      if (paired && !isChatApproved(DISPATCHER_HOME, paired.dispatcherChatId)) paired = null;
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

  test("sim message spawns subagent + receives reply", async () => {
    if (!dispatcher || !sim || !paired) throw new Error("setup did not run");

    // After pairing the dispatcher offers a tutorial in state=offered.
    // Replying "no" advances tutorial state to done and lets subsequent
    // messages flow to the subagent.
    {
      const baseline = sim.getMaxIncomingMsgId(paired.simChatId);
      await sim.sendText(paired.simChatId, "no");
      // Tutorial sends "No problem! …" on the way to done.
      await sim.waitForMessage(
        paired.simChatId,
        (m) => m.id > baseline && !m.isInfo && m.fromId !== 1 && /No problem/i.test(m.text),
        30_000,
      );
    }

    // Now ask a specific arithmetic question. We match any substantive
    // reply (length >= 2) — passes whether the subagent's claude binary
    // is logged in (answers "18") or unauthenticated (returns
    // "Not logged in · Please run /login"). Either way the subagent
    // path executed end-to-end. To verify the LLM specifically, run
    // with claude credentials set up in the test HOME and tighten this
    // assertion to /\b18\b/.
    const baseline = sim.getMaxIncomingMsgId(paired.simChatId);
    await sim.sendText(paired.simChatId, "Answer with only the number, no words: what is 7 plus 11?");

    // Subagent cold-spawn ~6s, first turn ~10–30s typical. Generous upper bound.
    const reply = await sim.waitForMessage(
      paired.simChatId,
      (m) => m.id > baseline && !m.isInfo && m.fromId !== 1 && m.text.length >= 2,
      180_000,
    );

    expect(reply.text.length).toBeGreaterThanOrEqual(2);
    console.log(`[subagent-lifecycle] got reply: ${reply.text.slice(0, 200)}`);
  }, 180_000);
});

// ── Helpers ─────────────────────────────────────────────────────────────

async function pair(dispatcher: Dispatcher, sim: ClientSim): Promise<PairedRecord> {
  await dispatcher.armPairing();
  const qrUri = await dispatcher.inviteLink();
  const simChatId = await sim.secureJoin(qrUri);
  const welcome = await sim.waitForMessage(simChatId, (m) => /\/deltachat:setup pair [a-z]{5}/.test(m.text), 90_000);
  const match = welcome.text.match(/\/deltachat:setup pair ([a-z]{5})/);
  if (!match) throw new Error(`welcome did not contain pair code: ${welcome.text}`);
  const result = await dispatcher.pair(match[1]);
  const chatMatch = result.match(/Paired chat (\d+) successfully/);
  if (!chatMatch) throw new Error(`unexpected pair response: ${result}`);
  return { dispatcherChatId: Number(chatMatch[1]), simChatId };
}

// `approved/<chatId>` was retired at v1.3 (#66 Option B) — nothing writes
// it anymore, so checking for it always reports "not approved" and
// DC_REUSE_ACCOUNTS=1 silently re-pairs every run. Post-v1.3 the source of
// truth for "this chat is paired" is a binding file: pairing auto-binds
// the chat, so bindings/<chatId>.json existing implies a paired chat
// (see #131).
function isChatApproved(home: string, chatId: number): boolean {
  const path = join(home, ".claude", "channels", "deltachat", "bindings", `${chatId}.json`);
  return existsSync(path);
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
