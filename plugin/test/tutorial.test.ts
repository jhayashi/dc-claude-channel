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
