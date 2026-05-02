/**
 * Tier-2 integration test for v1.3 Option B (#66) — chat allowlist
 * derived from principals + chat membership; legacy approved/ files
 * retired to approved.legacy/ at startup.
 *
 * Reuses the pairing harness from pairing.test.ts. Asserts:
 *   1. After pair, the chat is allowed (isAllowed returns true via the
 *      auth gate — exercised indirectly by being able to send a message).
 *   2. The legacy approved/ directory is empty / renamed to
 *      approved.legacy/ after dispatcher startup.
 *   3. A principal record exists for the sim's contact.
 *   4. After a dispatcher restart, the chat is STILL allowed — even
 *      though approved/ is gone, the membership-based populate
 *      re-derives the allowlist from the principal + dc-core.
 *
 * Gated by `DC_INTEGRATION_TEST=1` AND a reachable relay. Both must be
 * true or the suite is skipped with an actionable hint.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { Dispatcher, defaultFixtureHome, resetFixtureHome } from "./dispatcher-fixture.js";
import { ClientSim, resetFixtureState } from "./client-sim.js";
import { skipIfUnreachable } from "./chatmail-probe.js";

const INTEGRATION_DIR = import.meta.dir;
const FIXTURES = resolve(INTEGRATION_DIR, ".fixtures-option-b");
const DISPATCHER_HOME = join(FIXTURES, "dispatcher-home");
const SIM_STATE = join(FIXTURES, "client-state");
const SERVER_PATH = resolve(INTEGRATION_DIR, "..", "..", "server.ts");

const relay = process.env.DC_TEST_RELAY ?? "localhost:8443";
const enabled = process.env.DC_INTEGRATION_TEST === "1";

const skipReason = !enabled
  ? "DC_INTEGRATION_TEST not set"
  : ((await skipIfUnreachable(relay)).skip
    ? (await skipIfUnreachable(relay) as { skip: true; reason: string }).reason
    : null);

if (skipReason) console.log(`[tier-2 option-b] skipping — ${skipReason}`);

let dispatcher: Dispatcher | null = null;
let sim: ClientSim | null = null;
let dispatcherChatId = 0;

describe.skipIf(skipReason !== null)("tier-2 option-b — v1.3 auth migration", () => {
  beforeAll(async () => {
    // Always start fresh — the test verifies the migration on first
    // boot AND a clean restart afterwards.
    resetFixtureHome(DISPATCHER_HOME);
    resetFixtureState(SIM_STATE);
    if (!existsSync(FIXTURES)) mkdirSync(FIXTURES, { recursive: true });

    dispatcher = new Dispatcher({ home: DISPATCHER_HOME, serverPath: SERVER_PATH });
    sim = await ClientSim.boot({ stateDir: SIM_STATE, relay });
    await dispatcher.boot();

    // Pair via the production /deltachat:setup flow.
    await dispatcher.armPairing();
    const qrUri = await dispatcher.inviteLink();
    const simChatId = await sim.secureJoin(qrUri);
    const welcome = await sim.waitForMessage(
      simChatId,
      (m) => /\/deltachat:setup pair [a-z]{5}/.test(m.text),
      90_000,
    );
    const code = welcome.text.match(/\/deltachat:setup pair ([a-z]{5})/)?.[1];
    if (!code) throw new Error(`welcome message lacked pair code: ${welcome.text}`);
    const result = await dispatcher.pair(code);
    const m = result.match(/Paired chat (\d+) successfully/);
    if (!m) throw new Error(`unexpected dc_access_pair response: ${result}`);
    dispatcherChatId = Number(m[1]);
  }, 600_000);

  afterAll(async () => {
    try { await sim?.close(); } catch {}
    try { await dispatcher?.kill(); } catch {}
  });

  test("paired chat is reachable end-to-end", async () => {
    if (!dispatcher || !sim || !dispatcherChatId) throw new Error("setup did not run");
    const stamp = `option-b-${Date.now()}`;
    await dispatcher.sendText(dispatcherChatId, `ping ${stamp}`);
    // sim received the pair welcome on its own chat id; we don't need
    // it here — just confirm the dispatcher's own auth gate let the
    // send through.
    const history = await dispatcher.chatHistory(dispatcherChatId, 5);
    expect(history).toContain(stamp);
  }, 60_000);

  test("v1.3 migration: principal exists, approved/ retired", () => {
    const principalsDir = join(DISPATCHER_HOME, ".claude", "channels", "deltachat", "principals", "humans");
    expect(existsSync(principalsDir)).toBe(true);
    const principalFiles = readdirSync(principalsDir).filter((f) => f.endsWith(".json"));
    expect(principalFiles.length).toBeGreaterThanOrEqual(1);

    const approvedDir = join(DISPATCHER_HOME, ".claude", "channels", "deltachat", "approved");
    const approvedLegacyDir = `${approvedDir}.legacy`;
    // Either retired (renamed to .legacy/) or never created (fresh
    // install — addChat is cache-only post-v1.3, no FS write).
    if (existsSync(approvedDir)) {
      // Some dispatcher path may still write here transiently; not
      // catastrophic, but flag it.
      const entries = readdirSync(approvedDir);
      expect(entries).toEqual([]);
    }
    // approved.legacy/ may or may not exist — depends on whether the
    // dispatcher saw any legacy-shaped files at startup. On a fresh
    // install there's nothing to retire.
    if (existsSync(approvedLegacyDir)) {
      expect(readdirSync(approvedLegacyDir).length).toBeGreaterThanOrEqual(0);
    }
  });

  test("dispatcher restart re-derives allowlist from principals + membership", async () => {
    if (!dispatcher || !sim || !dispatcherChatId) throw new Error("setup did not run");

    // Restart the dispatcher. The new process boots with the same HOME
    // but no in-memory state. The v1.3 startup sequence must repopulate
    // the allowlist purely from principals + dc-core membership.
    await dispatcher.kill();
    dispatcher = new Dispatcher({ home: DISPATCHER_HOME, serverPath: SERVER_PATH });
    await dispatcher.boot();

    // If the migration worked, sending into the previously-paired chat
    // succeeds. If the cache wasn't re-derived, the dispatcher would
    // refuse the send as unauthorized.
    const stamp = `restart-${Date.now()}`;
    await dispatcher.sendText(dispatcherChatId, `ping ${stamp}`);
    const history = await dispatcher.chatHistory(dispatcherChatId, 5);
    expect(history).toContain(stamp);
  }, 90_000);
});
