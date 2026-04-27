import { describe, test, expect, beforeEach } from "bun:test";
import * as tutorial from "../tutorial";

const CHAT_ID = 12345;

beforeEach(() => {
  tutorial.clearTutorial(CHAT_ID);
});

describe("tutorial state machine", () => {
  test("startTutorial sends bare apps and offer message", () => {
    const action = tutorial.startTutorial(CHAT_ID);
    expect(tutorial.getState(CHAT_ID)).toBe("offered");
    expect(action.messages.length).toBeGreaterThan(0);
    expect(action.sendApps).toBe(true);
    expect(action.sendTestPermission).toBeFalsy();
    expect(action.sendSampleFile).toBeFalsy();
  });

  test("offered + 'yes' → permissions_explain with sendTestPermission", () => {
    tutorial.startTutorial(CHAT_ID);
    const action = tutorial.handleMessage(CHAT_ID, "yes");
    expect(tutorial.getState(CHAT_ID)).toBe("permissions_explain");
    expect(action.sendTestPermission).toBe(true);
    expect(action.messages.length).toBeGreaterThan(0);
    expect(action.messages[0]).toContain("centered message");
  });

  test("offered + 'no' → done with skip message", () => {
    tutorial.startTutorial(CHAT_ID);
    const action = tutorial.handleMessage(CHAT_ID, "no");
    expect(tutorial.getState(CHAT_ID)).toBe("done");
    expect(action.messages.length).toBeGreaterThan(0);
    expect(action.passThrough).toBeFalsy();
  });

  test("offered + unrelated text → passThrough, stays in offered", () => {
    tutorial.startTutorial(CHAT_ID);
    const action = tutorial.handleMessage(CHAT_ID, "what's the weather like?");
    expect(tutorial.getState(CHAT_ID)).toBe("offered");
    expect(action.passThrough).toBe(true);
    expect(action.messages.length).toBe(0);
  });

  test("permissions_explain + any → file_explain with sendSampleFile", () => {
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "yes"); // → permissions_explain
    const action = tutorial.handleMessage(CHAT_ID, "got it");
    expect(tutorial.getState(CHAT_ID)).toBe("file_explain");
    expect(action.sendSampleFile).toBe(true);
    expect(action.messages.length).toBeGreaterThan(0);
    expect(action.messages[0]).toContain("centered message");
  });

  test("file_explain + any → agent_offered with agent mention", () => {
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "yes");       // → permissions_explain
    tutorial.handleMessage(CHAT_ID, "got it");    // → file_explain
    const action = tutorial.handleMessage(CHAT_ID, "cool");
    expect(tutorial.getState(CHAT_ID)).toBe("agent_offered");
    expect(action.messages.length).toBeGreaterThan(0);
    expect(action.messages.join(" ").toLowerCase()).toMatch(/agent/);
  });

  test("agent_offered + 'yes' → agent_wait with sendAgentSetup", () => {
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "yes");       // → permissions_explain
    tutorial.handleMessage(CHAT_ID, "ok");        // → file_explain
    tutorial.handleMessage(CHAT_ID, "ok");        // → agent_offered
    const action = tutorial.handleMessage(CHAT_ID, "yes");
    expect(tutorial.getState(CHAT_ID)).toBe("agent_wait");
    expect(action.sendAgentSetup).toBe(true);
    expect(action.messages.length).toBeGreaterThan(0);
  });

  test("agent_offered + 'no' → phase2_offered", () => {
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "yes");       // → permissions_explain
    tutorial.handleMessage(CHAT_ID, "ok");        // → file_explain
    tutorial.handleMessage(CHAT_ID, "ok");        // → agent_offered
    const action = tutorial.handleMessage(CHAT_ID, "no");
    expect(tutorial.getState(CHAT_ID)).toBe("phase2_offered");
    expect(action.messages.join(" ").toLowerCase()).toMatch(/game|app/);
  });

  test("agent_wait + any → phase2_offered", () => {
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "yes");       // → permissions_explain
    tutorial.handleMessage(CHAT_ID, "ok");        // → file_explain
    tutorial.handleMessage(CHAT_ID, "ok");        // → agent_offered
    tutorial.handleMessage(CHAT_ID, "yes");       // → agent_wait
    const action = tutorial.handleMessage(CHAT_ID, "done");
    expect(tutorial.getState(CHAT_ID)).toBe("phase2_offered");
    expect(action.messages.join(" ").toLowerCase()).toMatch(/game|app/);
  });

  test("phase2_offered + 'yes' → game_choice", () => {
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "yes");       // → permissions_explain
    tutorial.handleMessage(CHAT_ID, "ok");        // → file_explain
    tutorial.handleMessage(CHAT_ID, "ok");        // → agent_offered
    tutorial.handleMessage(CHAT_ID, "no");        // → phase2_offered (skip agent)
    const action = tutorial.handleMessage(CHAT_ID, "yeah");
    expect(tutorial.getState(CHAT_ID)).toBe("game_choice");
    expect(action.messages.length).toBeGreaterThan(0);
  });

  test("phase2_offered + 'no' → done", () => {
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "yes");       // → permissions_explain
    tutorial.handleMessage(CHAT_ID, "ok");        // → file_explain
    tutorial.handleMessage(CHAT_ID, "ok");        // → agent_offered
    tutorial.handleMessage(CHAT_ID, "no");        // → phase2_offered (skip agent)
    const action = tutorial.handleMessage(CHAT_ID, "nope");
    expect(tutorial.getState(CHAT_ID)).toBe("done");
    expect(action.messages.length).toBeGreaterThan(0);
  });

  test("game_choice + game type → done with handoffToClaud and gameChoice", () => {
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "sure");      // → permissions_explain
    tutorial.handleMessage(CHAT_ID, "ok");        // → file_explain
    tutorial.handleMessage(CHAT_ID, "ok");        // → agent_offered
    tutorial.handleMessage(CHAT_ID, "no");        // → phase2_offered (skip agent)
    tutorial.handleMessage(CHAT_ID, "let's go");  // → game_choice
    const action = tutorial.handleMessage(CHAT_ID, "snake");
    expect(tutorial.getState(CHAT_ID)).toBe("done");
    expect(action.handoffToClaud).toBe(true);
    expect(action.gameChoice).toBe("snake");
  });

  test("handleAppResponse advances permissions_explain → file_explain", () => {
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "yes"); // → permissions_explain
    const action = tutorial.handleAppResponse(CHAT_ID);
    expect(tutorial.getState(CHAT_ID)).toBe("file_explain");
    expect(action.sendSampleFile).toBe(true);
  });

  test("handleAppResponse advances file_explain → agent_offered", () => {
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "yes"); // → permissions_explain
    tutorial.handleMessage(CHAT_ID, "ok");  // → file_explain
    const action = tutorial.handleAppResponse(CHAT_ID);
    expect(tutorial.getState(CHAT_ID)).toBe("agent_offered");
    expect(action.messages.join(" ").toLowerCase()).toMatch(/agent/);
  });

  test("handleAppResponse advances agent_wait → phase2_offered", () => {
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "yes"); // → permissions_explain
    tutorial.handleMessage(CHAT_ID, "ok");  // → file_explain
    tutorial.handleMessage(CHAT_ID, "ok");  // → agent_offered
    tutorial.handleMessage(CHAT_ID, "yes"); // → agent_wait
    const action = tutorial.handleAppResponse(CHAT_ID);
    expect(tutorial.getState(CHAT_ID)).toBe("phase2_offered");
    expect(action.messages.join(" ").toLowerCase()).toMatch(/game|app/);
  });

  test("handleAppResponse is passThrough for non-app states", () => {
    tutorial.startTutorial(CHAT_ID); // → offered
    const action = tutorial.handleAppResponse(CHAT_ID);
    expect(action.passThrough).toBe(true);
  });

  test("no tutorial state → passThrough", () => {
    // Never called startTutorial — no state
    const action = tutorial.handleMessage(CHAT_ID, "hello");
    expect(action.passThrough).toBe(true);
    expect(action.messages.length).toBe(0);
  });

  test("done state → passThrough", () => {
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "no"); // → done
    const action = tutorial.handleMessage(CHAT_ID, "hello");
    expect(action.passThrough).toBe(true);
    expect(action.messages.length).toBe(0);
  });
});

describe("tutorial state machine — passThrough on yes/no states with unrelated text", () => {
  // Branches not previously covered: when the state expects yes/no and gets
  // neither, the message should passThrough so the LLM (or whatever) can
  // handle it; the state stays put.
  test("agent_offered + unrelated text → passThrough, stays in agent_offered", () => {
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "yes");       // → permissions_explain
    tutorial.handleMessage(CHAT_ID, "ok");        // → file_explain
    tutorial.handleMessage(CHAT_ID, "ok");        // → agent_offered
    const action = tutorial.handleMessage(CHAT_ID, "tell me a joke");
    expect(tutorial.getState(CHAT_ID)).toBe("agent_offered");
    expect(action.passThrough).toBe(true);
    expect(action.messages.length).toBe(0);
  });

  test("phase2_offered + unrelated text → passThrough, stays in phase2_offered", () => {
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "yes");       // → permissions_explain
    tutorial.handleMessage(CHAT_ID, "ok");        // → file_explain
    tutorial.handleMessage(CHAT_ID, "ok");        // → agent_offered
    tutorial.handleMessage(CHAT_ID, "no");        // → phase2_offered
    const action = tutorial.handleMessage(CHAT_ID, "what's your favourite colour");
    expect(tutorial.getState(CHAT_ID)).toBe("phase2_offered");
    expect(action.passThrough).toBe(true);
    expect(action.messages.length).toBe(0);
  });
});

describe("tutorial state machine — yes/no parsing", () => {
  // The AFFIRMATIVES / NEGATIVES sets in tutorial.ts list the user
  // utterances that count as yes/no. These tests pin the contract so a
  // refactor doesn't silently shrink the alias set.
  const AFFIRMATIVES = ["yes", "y", "yeah", "yep", "sure", "ok", "let's go", "lets go", "tour"];
  const NEGATIVES = ["no", "n", "nah", "nope", "skip", "later"];

  for (const word of AFFIRMATIVES) {
    test(`AFFIRMATIVE: "${word}" advances offered → permissions_explain`, () => {
      tutorial.startTutorial(CHAT_ID);
      tutorial.handleMessage(CHAT_ID, word);
      expect(tutorial.getState(CHAT_ID)).toBe("permissions_explain");
    });
  }

  for (const word of NEGATIVES) {
    test(`NEGATIVE: "${word}" advances offered → done`, () => {
      tutorial.startTutorial(CHAT_ID);
      tutorial.handleMessage(CHAT_ID, word);
      expect(tutorial.getState(CHAT_ID)).toBe("done");
    });
  }

  test("yes/no matching is case-insensitive", () => {
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "YES");
    expect(tutorial.getState(CHAT_ID)).toBe("permissions_explain");

    tutorial.clearTutorial(CHAT_ID);
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "Yes");
    expect(tutorial.getState(CHAT_ID)).toBe("permissions_explain");

    tutorial.clearTutorial(CHAT_ID);
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "NO");
    expect(tutorial.getState(CHAT_ID)).toBe("done");
  });

  test("yes/no matching trims surrounding whitespace", () => {
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "  yes  ");
    expect(tutorial.getState(CHAT_ID)).toBe("permissions_explain");

    tutorial.clearTutorial(CHAT_ID);
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "\tno\n");
    expect(tutorial.getState(CHAT_ID)).toBe("done");
  });

  test("yes/no matching requires whole-word; trailing chars don't match", () => {
    // "yes please" / "yes!" are NOT in AFFIRMATIVES — they passThrough.
    // This is intentional: the yes/no gate is a *strict* affirmation set.
    tutorial.startTutorial(CHAT_ID);
    const a = tutorial.handleMessage(CHAT_ID, "yes please");
    expect(tutorial.getState(CHAT_ID)).toBe("offered");
    expect(a.passThrough).toBe(true);

    tutorial.clearTutorial(CHAT_ID);
    tutorial.startTutorial(CHAT_ID);
    const b = tutorial.handleMessage(CHAT_ID, "yes!");
    expect(tutorial.getState(CHAT_ID)).toBe("offered");
    expect(b.passThrough).toBe(true);
  });
});

describe("tutorial state machine — handleAppResponse for inactive states", () => {
  // handleAppResponse must only advance for the three "waiting on app
  // interaction" states. Every other state must passThrough so app
  // updates from prior tutorial demos don't accidentally fast-forward
  // the flow.
  test("offered → passThrough", () => {
    tutorial.startTutorial(CHAT_ID);
    const action = tutorial.handleAppResponse(CHAT_ID);
    expect(action.passThrough).toBe(true);
    expect(tutorial.getState(CHAT_ID)).toBe("offered");
  });

  test("agent_offered → passThrough", () => {
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "yes"); // → permissions_explain
    tutorial.handleMessage(CHAT_ID, "ok");  // → file_explain
    tutorial.handleMessage(CHAT_ID, "ok");  // → agent_offered
    const action = tutorial.handleAppResponse(CHAT_ID);
    expect(action.passThrough).toBe(true);
    expect(tutorial.getState(CHAT_ID)).toBe("agent_offered");
  });

  test("phase2_offered → passThrough", () => {
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "yes"); // → permissions_explain
    tutorial.handleMessage(CHAT_ID, "ok");  // → file_explain
    tutorial.handleMessage(CHAT_ID, "ok");  // → agent_offered
    tutorial.handleMessage(CHAT_ID, "no");  // → phase2_offered
    const action = tutorial.handleAppResponse(CHAT_ID);
    expect(action.passThrough).toBe(true);
    expect(tutorial.getState(CHAT_ID)).toBe("phase2_offered");
  });

  test("game_choice → passThrough", () => {
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "yes"); // → permissions_explain
    tutorial.handleMessage(CHAT_ID, "ok");  // → file_explain
    tutorial.handleMessage(CHAT_ID, "ok");  // → agent_offered
    tutorial.handleMessage(CHAT_ID, "no");  // → phase2_offered
    tutorial.handleMessage(CHAT_ID, "yes"); // → game_choice
    const action = tutorial.handleAppResponse(CHAT_ID);
    expect(action.passThrough).toBe(true);
    expect(tutorial.getState(CHAT_ID)).toBe("game_choice");
  });

  test("done → passThrough", () => {
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "no"); // → done
    const action = tutorial.handleAppResponse(CHAT_ID);
    expect(action.passThrough).toBe(true);
    expect(tutorial.getState(CHAT_ID)).toBe("done");
  });

  test("no state → passThrough", () => {
    // Never started; no entry in the states map.
    const action = tutorial.handleAppResponse(CHAT_ID);
    expect(action.passThrough).toBe(true);
    expect(tutorial.getState(CHAT_ID)).toBeNull();
  });
});

describe("tutorial state machine — game_choice text handling", () => {
  test("preserves game name verbatim, including spaces and case", () => {
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "yes");
    tutorial.handleMessage(CHAT_ID, "ok");
    tutorial.handleMessage(CHAT_ID, "ok");
    tutorial.handleMessage(CHAT_ID, "no");
    tutorial.handleMessage(CHAT_ID, "yes");
    const action = tutorial.handleMessage(CHAT_ID, "Tic-Tac-Toe with AI");
    expect(action.gameChoice).toBe("Tic-Tac-Toe with AI");
    expect(action.handoffToClaud).toBe(true);
    expect(tutorial.getState(CHAT_ID)).toBe("done");
  });

  test("trims surrounding whitespace from game name", () => {
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "yes");
    tutorial.handleMessage(CHAT_ID, "ok");
    tutorial.handleMessage(CHAT_ID, "ok");
    tutorial.handleMessage(CHAT_ID, "no");
    tutorial.handleMessage(CHAT_ID, "yes");
    const action = tutorial.handleMessage(CHAT_ID, "  snake  ");
    expect(action.gameChoice).toBe("snake");
  });
});

describe("tutorial state machine — per-chat state isolation", () => {
  // Two chats running the tutorial concurrently must not see each
  // other's state. Tutorials are owned by chatId.
  const CHAT_A = 700001;
  const CHAT_B = 700002;

  beforeEach(() => {
    tutorial.clearTutorial(CHAT_A);
    tutorial.clearTutorial(CHAT_B);
  });

  test("advancing chat A does not affect chat B", () => {
    tutorial.startTutorial(CHAT_A);
    tutorial.startTutorial(CHAT_B);
    tutorial.handleMessage(CHAT_A, "yes"); // A → permissions_explain
    expect(tutorial.getState(CHAT_A)).toBe("permissions_explain");
    expect(tutorial.getState(CHAT_B)).toBe("offered");
  });

  test("clearing chat A does not affect chat B", () => {
    tutorial.startTutorial(CHAT_A);
    tutorial.startTutorial(CHAT_B);
    tutorial.handleMessage(CHAT_B, "yes"); // B → permissions_explain
    tutorial.clearTutorial(CHAT_A);
    expect(tutorial.getState(CHAT_A)).toBeNull();
    expect(tutorial.getState(CHAT_B)).toBe("permissions_explain");
  });
});

describe("tutorial state machine — clearTutorial", () => {
  test("clears state from any active state", () => {
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "yes");
    tutorial.handleMessage(CHAT_ID, "ok");
    expect(tutorial.getState(CHAT_ID)).toBe("file_explain");
    tutorial.clearTutorial(CHAT_ID);
    expect(tutorial.getState(CHAT_ID)).toBeNull();
  });

  test("clears state from done", () => {
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "no");
    expect(tutorial.getState(CHAT_ID)).toBe("done");
    tutorial.clearTutorial(CHAT_ID);
    expect(tutorial.getState(CHAT_ID)).toBeNull();
  });

  test("is idempotent (no-op on missing state)", () => {
    expect(() => tutorial.clearTutorial(CHAT_ID)).not.toThrow();
    expect(tutorial.getState(CHAT_ID)).toBeNull();
  });

  test("subsequent handleMessage after clear is passThrough", () => {
    tutorial.startTutorial(CHAT_ID);
    tutorial.handleMessage(CHAT_ID, "yes");
    tutorial.clearTutorial(CHAT_ID);
    const action = tutorial.handleMessage(CHAT_ID, "anything");
    expect(action.passThrough).toBe(true);
    expect(action.messages.length).toBe(0);
  });
});

describe("tutorial state machine — voice_offered (declared, unreachable)", () => {
  // `voice_offered` exists in the TutorialState union but no transition
  // sets it and no case handles it. This test pins that contract — if a
  // future change adds a transition into voice_offered, the test fails
  // and the author has to either add a case or update this test.
  test("no transition path leads to voice_offered", () => {
    // Walk every reachable state combination and assert state is never
    // voice_offered.
    const probes: string[] = ["yes", "no", "y", "n", "tour", "skip", "anything", ""];
    function recurse(visited: Set<string>, path: string[]): void {
      const state = tutorial.getState(CHAT_ID);
      if (state === "voice_offered" as never) {
        throw new Error(`reached voice_offered via path: ${path.join(" -> ")}`);
      }
      const key = state ?? "null";
      if (visited.has(key)) return;
      visited.add(key);
      if (state === "done" || state === null) return;
      for (const probe of probes) {
        tutorial.clearTutorial(CHAT_ID);
        tutorial.startTutorial(CHAT_ID);
        // Replay the path then send the probe.
        for (const step of path) tutorial.handleMessage(CHAT_ID, step);
        tutorial.handleMessage(CHAT_ID, probe);
        recurse(visited, [...path, probe]);
      }
    }
    tutorial.startTutorial(CHAT_ID);
    expect(() => recurse(new Set(), [])).not.toThrow();
  });
});
