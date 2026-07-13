/**
 * T2 live smoke — real subagent turn per help-card phrase (#138).
 *
 * Drives every t2-tier journey annotated in `help-content.ts`'s `verify`
 * field through the real dispatcher + a real `claude -p` subagent: sim
 * sends the journey's phrase (or its `smokePhrase` override) into the
 * paired chat, and we confirm the expected tool call landed in
 * `events/tools-*.log` (or, for `expect: 'reply'`, that any substantive
 * reply arrived).
 *
 * **Cost:** each case consumes ~1 Anthropic turn. Triple-gated:
 *
 *   DC_INTEGRATION_TEST=1   # tier-2 gate (also required for pairing)
 *   DC_TEST_SUBAGENT=1      # opts into LLM-cost tests generally
 *   DC_HELP_SMOKE=1         # opts into this specific (multi-turn) smoke
 *
 * Any of the three unset (or the chatmail relay unreachable) → suite
 * skipped, 0 failures — this is the only CI-visible behavior.
 *
 * `DC_HELP_SMOKE_FILTER=<substring>` narrows to matching case ids, e.g.
 * `DC_HELP_SMOKE_FILTER=list-agents` for a single-case paid probe.
 *
 * Uses its OWN fixture dir (`.fixtures-help/`) to avoid contention with
 * `pairing.test.ts` / `subagent-lifecycle.test.ts`. `DC_REUSE_ACCOUNTS=1`
 * works the same way as in those suites.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join, resolve } from "node:path";
import {
  existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync, rmSync,
} from "node:fs";
import { HELP_TOPICS } from "../../help-content.js";
import { Dispatcher, resetFixtureHome } from "./dispatcher-fixture.js";
import { ClientSim, resetFixtureState } from "./client-sim.js";
import { skipIfUnreachable } from "./chatmail-probe.js";

const INTEGRATION_DIR = import.meta.dir;
const FIXTURES = resolve(INTEGRATION_DIR, ".fixtures-help");
const DISPATCHER_HOME = join(FIXTURES, "dispatcher-home");
const SIM_STATE = join(FIXTURES, "client-state");
const PAIRED_RECORD = join(FIXTURES, "paired.json");
const SERVER_PATH = resolve(INTEGRATION_DIR, "..", "..", "server.ts");
// `bun server.ts` spawns with HOME=DISPATCHER_HOME, so events.ts's
// DEFAULT_DIR (no DC_EVENT_DIR / DC_STATE_DIR override in the child env)
// resolves to exactly this path — see plugin/events.ts's `homedir()`
// fallback, computed inside the spawned child process at its own
// module-load time.
const EVENTS_DIR = join(DISPATCHER_HOME, ".claude", "channels", "deltachat", "events");

const relay = process.env.DC_TEST_RELAY ?? "localhost:8443";
const enabled =
  process.env.DC_INTEGRATION_TEST === "1" &&
  process.env.DC_TEST_SUBAGENT === "1" &&
  process.env.DC_HELP_SMOKE === "1";
const reuseAccounts = process.env.DC_REUSE_ACCOUNTS === "1";

interface PairedRecord {
  dispatcherChatId: number;
  simChatId: number;
}

const skipReason = !enabled
  ? "DC_INTEGRATION_TEST=1 + DC_TEST_SUBAGENT=1 + DC_HELP_SMOKE=1 required"
  : ((await skipIfUnreachable(relay)).skip
    ? (await skipIfUnreachable(relay) as { skip: true; reason: string }).reason
    : null);

if (skipReason) console.log(`[help-smoke] skipping — ${skipReason}`);

const FILTER = process.env.DC_HELP_SMOKE_FILTER ?? "";

interface SmokeCase { id: string; phrase: string; expect: string }

const cases: SmokeCase[] = HELP_TOPICS.flatMap(t => t.journeys)
  .filter(j => j.verify?.tier === "t2")
  .map(j => ({ id: j.id, phrase: j.verify!.smokePhrase ?? j.phrases[0], expect: j.verify!.expect }))
  .filter(c => c.id.includes(FILTER));

// Destructive last: teleport-out unbinds the fixture chat — force it to
// the end so every other phrase runs against a live binding. `schedules`
// (writes "goodnight" via dc_schedule's smokePhrase) already precedes
// `chat-search` (searches for "goodnight") in topic-declaration order in
// help-content.ts, so no extra sort is needed for that pair.
cases.sort((a, b) => Number(a.id === "teleport-out") - Number(b.id === "teleport-out"));

let dispatcher: Dispatcher | null = null;
let sim: ClientSim | null = null;
let paired: PairedRecord | null = null;

describe.skipIf(skipReason !== null)("t2 help-phrase live smoke (#138)", () => {
  beforeAll(async () => {
    if (!reuseAccounts) {
      resetFixtureHome(DISPATCHER_HOME);
      resetFixtureState(SIM_STATE);
      try { rmSync(PAIRED_RECORD, { force: true }); } catch {}
    }
    if (!existsSync(FIXTURES)) mkdirSync(FIXTURES, { recursive: true });

    // Seed a real referent for the switch-agent / delete-agent phrases
    // before the dispatcher boots, so its every-boot DC-tool-allowlist
    // reconcile (agents.migrateAgentDcTools) expands our bare `mcp__dc`
    // into the full mcp__dc__* set for this agent too.
    seedSmokeTargetAgent(DISPATCHER_HOME);

    dispatcher = new Dispatcher({ home: DISPATCHER_HOME, serverPath: SERVER_PATH });
    sim = await ClientSim.boot({ stateDir: SIM_STATE, relay });
    await dispatcher.boot();

    let freshlyPaired = false;
    if (reuseAccounts) {
      paired = loadPairedRecord();
      if (paired && !isChatApproved(DISPATCHER_HOME, paired.dispatcherChatId)) paired = null;
    }
    if (!paired) {
      paired = await pair(dispatcher, sim);
      savePairedRecord(paired);
      freshlyPaired = true;
    }

    if (freshlyPaired) {
      // Fresh pairing arms the onboarding tutorial (state=offered) in this
      // dispatcher process — its state lives in an in-memory Map
      // (tutorial.ts), never on disk, so it only needs clearing when we
      // just paired in *this* process. On a reused pair the fresh process
      // never called dc_access_pair (and therefore never startTutorial),
      // so tutorial.getState(chatId) is already null/passthrough and
      // every message already reaches the subagent directly.
      const baseline = sim.getMaxIncomingMsgId(paired.simChatId);
      await sim.sendText(paired.simChatId, "no");
      await sim.waitForMessage(
        paired.simChatId,
        (m) => m.id > baseline && !m.isInfo && m.fromId !== 1 && /No problem/i.test(m.text),
        30_000,
      );
    }
  }, 600_000);

  afterAll(async () => {
    try { await sim?.close(); } catch {}
    try { await dispatcher?.kill(); } catch {}
  });

  for (const c of cases) {
    test(`${c.id}: "${c.phrase}" -> ${c.expect}`, async () => {
      if (!dispatcher || !sim || !paired) throw new Error("setup did not run");

      const baseline = sim.getMaxIncomingMsgId(paired.simChatId);
      const sentAtMs = Date.now();
      await sim.sendText(paired.simChatId, c.phrase);

      const found = c.expect === "reply"
        ? await pollReply(sim, paired.simChatId, baseline)
        : await pollToolLog(EVENTS_DIR, c.expect.slice("tool:".length), paired.dispatcherChatId, sentAtMs);

      console.log(`[help-smoke] ${found ? "PASS" : "FAIL"} ${c.id} → ${c.expect}`);
      expect(found, `${c.id}: "${c.phrase}" did not produce ${c.expect}`).toBe(true);
    }, 120_000);
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────

/** Write `<home>/.claude/agents/smoke-target.md` directly (cross-process — agents.setAgentsDir can't reach the dispatcher subprocess). */
function seedSmokeTargetAgent(home: string): void {
  const dir = join(home, ".claude", "agents");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "smoke-target.md");
  if (existsSync(path)) return; // already seeded (DC_REUSE_ACCOUNTS=1 run)
  writeFileSync(
    path,
    "---\n" +
    "name: smoke-target\n" +
    "model: claude-haiku-4-5\n" +
    "tools: mcp__dc\n" +
    "---\n" +
    "\n" +
    "You are a smoke-test target.\n",
  );
}

/**
 * Poll `<eventsDir>/tools-*.log` (up to `timeoutMs`) for a `tool ===
 * toolName` line from `chatId` timestamped at or after `sinceMs`.
 */
async function pollToolLog(
  eventsDir: string,
  toolName: string,
  chatId: number,
  sinceMs: number,
  timeoutMs = 90_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (scanToolLog(eventsDir, toolName, chatId, sinceMs)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(r => setTimeout(r, 1_000));
  }
}

function scanToolLog(eventsDir: string, toolName: string, chatId: number, sinceMs: number): boolean {
  if (!existsSync(eventsDir)) return false;
  const files = readdirSync(eventsDir).filter(f => f.startsWith("tools-") && f.endsWith(".log"));
  for (const f of files) {
    let text: string;
    try { text = readFileSync(join(eventsDir, f), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let ev: { tool?: unknown; callerChatId?: unknown; ts?: unknown };
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.tool !== toolName) continue;
      if (ev.callerChatId !== chatId) continue;
      const ts = typeof ev.ts === "string" ? Date.parse(ev.ts) : NaN;
      if (Number.isNaN(ts) || ts < sinceMs) continue;
      return true;
    }
  }
  return false;
}

/** For `expect: 'reply'` journeys — any substantive inbound message counts. */
async function pollReply(sim: ClientSim, chatId: number, baselineMsgId: number, timeoutMs = 90_000): Promise<boolean> {
  try {
    await sim.waitForMessage(
      chatId,
      (m) => m.id > baselineMsgId && !m.isInfo && m.fromId !== 1 && m.text.length >= 2,
      timeoutMs,
    );
    return true;
  } catch {
    return false;
  }
}

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

function isChatApproved(home: string, chatId: number): boolean {
  const dir = join(home, ".claude", "channels", "deltachat", "approved");
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((f) => f === String(chatId));
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
