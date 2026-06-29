/**
 * Edit-form smoke (regression guard for the create-flow peel, epic #109).
 *
 * When the create flow was peeled out of the agent-setup monolith (Task 4),
 * the step2 create form + its catalog/wall JS were deleted, but the step3
 * EDIT form was KEPT — it's a Manage/increment-4 feature and shares several
 * scope-parameterized helpers ('create'|'edit') with the removed create
 * form (refreshLivePreview, wireSeg, wireCustomModelId, syncTrustCardFor,
 * syncMemoryCardFor, populateModelDropdowns, setBadgeSvg). Deleting the
 * create form removed the only harness test that exercised that form
 * machinery, so this test pins the edit path: a dispatcher `edit` reply
 * must render step3 with a populated form and ZERO page errors (a
 * half-deleted shared helper would throw a ReferenceError here).
 */
import { test, expect } from "@playwright/test";
import { readdirSync } from "node:fs"; import { join, dirname } from "node:path"; import { fileURLToPath } from "node:url";
import { createHarness, type HarnessHandle } from "./harness.js";
const PREBUILT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "webxdc-prebuilt");
const xdc = () => { const m = readdirSync(PREBUILT).filter(n => n.startsWith("agent-setup-v") && n.endsWith(".xdc")).sort(); return join(PREBUILT, m[m.length - 1]); };

const EDIT_UPDATE = {
  type: "edit",
  senderAddr: "server",
  draft: {
    id: "sleep-coach",
    name: "Sleep coach",
    model: "claude-sonnet-4-6",
    system: "You help people sleep better.",
    archetype: "role",
    skipPermissions: false,
    memoryBoost: false,
    allowedBuiltinTools: null,
    allowedMcpServers: null,
  },
  availableModels: [
    { id: "claude-sonnet-4-6", label: "Sonnet", tier: "sonnet" },
    { id: "claude-opus-4-8", label: "Opus", tier: "opus" },
  ],
  defaultModel: "claude-sonnet-4-6",
  availableBuiltinTools: [{ name: "Bash", description: "Run shell commands" }],
  availableMcpServers: [],
  connectedMcpServers: [],
};

test("dispatcher 'edit' reply renders step3 edit form with no page errors", async () => {
  const h: HarnessHandle = await createHarness(xdc());
  const errs: string[] = [];
  h.page.on("pageerror", e => errs.push(String(e)));

  // The card reveals its first screen only after an init push (the init
  // listener ends with show('step0')). Wake it, then deliver the edit reply.
  const appVersion = await h.getAppVersion();
  await h.push({
    type: "init",
    version: appVersion,
    senderAddr: "server",
    existingAgents: [],
    availableModels: EDIT_UPDATE.availableModels,
    defaultModel: EDIT_UPDATE.defaultModel,
    availableBuiltinTools: EDIT_UPDATE.availableBuiltinTools,
    availableMcpServers: [],
    connectedMcpServers: [],
    ownerEmail: "test@example.com",
  });
  await h.page.waitForSelector("#step0", { state: "visible", timeout: 4000 });
  await h.push(EDIT_UPDATE);

  // The edit form (step3) must become visible — proves the edit listener +
  // populateEditForm + populateModelDropdowns + populateEditToolPicker chain
  // and all the shared form helpers survived the create-flow removal.
  await h.page.waitForSelector("#step3", { state: "visible", timeout: 3000 });

  // The name field is populated from the draft (form wiring ran).
  const nameVal = await h.page.inputValue("#edit-name");
  expect(nameVal).toBe("Sleep coach");

  // No ReferenceError / TypeError from a half-deleted shared helper.
  expect(errs).toEqual([]);

  await h.close();
});
