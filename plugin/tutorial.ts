/**
 * Onboarding tutorial state machine.
 *
 * Tracks per-chat tutorial progress and returns actions for server.ts
 * to execute (send messages, trigger demos, hand off to Claude).
 *
 * Flow:
 *   startTutorial → send all three apps + explanation → offered
 *   offered + yes → permissions_explain (guide them to tap the message)
 *   permissions_explain + any → file_explain (guide them to the file reviewer)
 *   file_explain + any → agent_offered (offer agent creation)
 *   agent_offered + yes → agent_wait (send setup card, wait for interaction)
 *   agent_offered + no → phase2_offered (skip to game building)
 *   agent_wait + any → phase2_offered
 *   phase2_offered + yes → game_choice → done (handoff to Claude)
 */

export type TutorialState =
  | "offered"
  | "permissions_explain"
  | "file_explain"
  | "agent_offered"
  | "agent_wait"
  | "phase2_offered"
  | "game_choice"
  | "voice_offered"
  | "done";

export interface TutorialAction {
  messages: string[];
  /** Send bare .xdc apps (no content) — just the app cards in the chat. */
  sendApps?: boolean;
  /** Send a test permission prompt (triggers the centered info message). */
  sendTestPermission?: boolean;
  /** Send a sample file to the file reviewer (triggers the centered info message). */
  sendSampleFile?: boolean;
  /** Send the agent setup card in create mode. */
  sendAgentSetup?: boolean;
  /** Run STT dependency check and report results. */
  checkVoiceDeps?: boolean;
  passThrough?: boolean;
  handoffToClaud?: boolean;
  gameChoice?: string;
}

const states = new Map<number, TutorialState>();

const AFFIRMATIVES = new Set([
  "yes", "y", "yeah", "yep", "sure", "ok", "let's go", "lets go", "tour",
]);
const NEGATIVES = new Set([
  "no", "n", "nah", "nope", "skip", "later",
]);

function isYes(text: string): boolean {
  return AFFIRMATIVES.has(text.trim().toLowerCase());
}

function isNo(text: string): boolean {
  return NEGATIVES.has(text.trim().toLowerCase());
}

/**
 * Start the tutorial for a newly paired chat.
 * Sends both apps immediately + explanation, then waits for yes/no.
 */
export function startTutorial(chatId: number): TutorialAction {
  states.set(chatId, "offered");
  return {
    messages: [
      "Welcome! I'm Claude, your AI coding assistant on Delta Chat.\n\n" +
      "You see I just sent you three WebXDC apps — these are interactive mini-apps that run right inside our chats " +
      "and give your interactions with Claude simple GUIs to make working with Claude easier, more interactive, and fun!\n\n" +
      "You can find all apps, files, and images in this chat anytime by tapping the four-boxes icon (\u229e) in the upper right.\n\n" +
      "You don't need to do anything with those apps right now, but I wanted you to know that they are here in this chat and get loaded when we need them.\n\n" +
      "Do you want a super quick tour of how they work? (yes/no)",
    ],
    sendApps: true,
  };
}

export function handleMessage(chatId: number, text: string): TutorialAction {
  const state = states.get(chatId);

  if (!state || state === "done") {
    return { messages: [], passThrough: true };
  }

  switch (state) {
    case "offered": {
      if (isYes(text)) {
        states.set(chatId, "permissions_explain");
        return {
          messages: [
            "Let's start with the **Permission Prompt**.\n\n" +
            "When I need to do something sensitive (run a command, edit a file), I'll ask for your permission. " +
            "I'm sending a demo permission now — you should see a new centered message appear at the bottom of the chat.\n\n" +
            "Tap that centered message (not the app icon above) to open it, then try tapping Allow or Deny!\n\n" +
            "Reply here when you're done.",
          ],
          sendTestPermission: true,
        };
      }
      if (isNo(text)) {
        states.set(chatId, "done");
        return {
          messages: [
            "No problem! The apps are in the chat whenever you want to explore them. Just message me anytime.",
          ],
        };
      }
      return { messages: [], passThrough: true };
    }

    case "permissions_explain": {
      states.set(chatId, "file_explain");
      return {
        messages: [
          "Nice! That's how permissions work — you stay in control of what I can do.\n\n" +
          "Now let's look at the **File Reviewer**. I'm sending a sample document now — " +
          "you'll see another centered message appear at the bottom of the chat.\n\n" +
          "Tap that centered message to open it. Inside you'll see a rendered document with syntax highlighting. " +
          "Try long-pressing on any line to leave an inline comment!\n\n" +
          "Reply here when you're done exploring.",
        ],
        sendSampleFile: true,
      };
    }

    case "file_explain": {
      states.set(chatId, "agent_offered");
      return {
        messages: [
          "That's the File Reviewer! When I send you code or documents to review, " +
          "you can read them with syntax highlighting and leave comments right on specific lines. " +
          "I'll apply your feedback and send back the updated file.\n\n" +
          "Next up: **Agents & Chat settings**. You can of course have as many agents and " +
          "chats with those agents as you want. Each chat is an isolated conversation with " +
          "an agent. But you can have more than a single chat with each agent.\n\n" +
          "Want to create another chat with a different agent? (yes/no)",
        ],
      };
    }

    case "agent_offered": {
      if (isYes(text)) {
        states.set(chatId, "agent_wait");
        return {
          messages: [
            "Tap below to open the **Agent & Chat setup**. There's a lot to explore " +
            "in there, but creating a new chat is the first item — you can pick from " +
            "a template, reuse an existing agent, or create a custom agent from scratch. " +
            "Try it now.",
          ],
          sendAgentSetup: true,
        };
      }
      if (isNo(text)) {
        states.set(chatId, "phase2_offered");
        return {
          messages: [
            "No worries! You can always create agents later by asking me to " +
            "\"create a new agent\" or \"manage agents\" in any chat.\n\n" +
            "One more thing — I can also **build interactive apps and games** as WebXDC apps " +
            "that you can share with friends. Want to try building a simple game together? (yes/no)",
          ],
        };
      }
      return { messages: [], passThrough: true };
    }

    case "agent_wait": {
      states.set(chatId, "phase2_offered");
      return {
        messages: [
          "You can just say \"open settings\" or just \"settings\" to bring back this app " +
          "any time.\n\n" +
          "Last thing: these mini apps are one of Delta Chat's cool features — **WebXDC apps**. " +
          "And of course you can have Claude make your own. You can even share the apps you've " +
          "made with your friends.\n\n" +
          "Want to try building a simple single-player game together right now? (yes/no)",
        ],
      };
    }

    case "phase2_offered": {
      if (isYes(text)) {
        states.set(chatId, "game_choice");
        return {
          messages: [
            "What kind of game would you like? Some ideas:\n\n" +
            "\u2022 Tetris\n\u2022 Snake\n\u2022 Tic-tac-toe\n\u2022 Memory card matching\n\u2022 A quiz game\n\u2022 Something else?\n\n" +
            "Just tell me what sounds fun!",
          ],
        };
      }
      if (isNo(text)) {
        states.set(chatId, "done");
        return {
          messages: [
            "That's the end of the tour. Remember that you can use Delta Chat to send " +
            "voice messages if you don't like to type. Feel free to send screenshots of " +
            "your apps, or docs, or whatever.\n\n" +
            "Naturally you can use Delta Chat to message people too. If you love Delta " +
            "Chat, be sure to tell your friends. It's open source, has end-to-end encryption, " +
            "and is built on web tech, like WebXDC.\n\n" +
            "Have fun!",
          ],
        };
      }
      return { messages: [], passThrough: true };
    }

    case "game_choice": {
      const gameType = text.trim();
      states.set(chatId, "done");
      return {
        messages: [
          `Great choice! I'll build you a ${gameType} game as a WebXDC app right here in this chat.\n\nOpen source, end-to-end encryption, web tech, and frontier AI FTW!\n\nOne moment...`,
        ],
        handoffToClaud: true,
        gameChoice: gameType,
      };
    }
  }
}

/**
 * Handle a WebXDC app interaction (e.g., Allow/Deny tap, comment submission).
 * Advances the tutorial the same way a text reply would for states that are
 * waiting for the user to interact with an app.
 */
export function handleAppResponse(chatId: number): TutorialAction {
  const state = states.get(chatId);
  if (state === "permissions_explain" || state === "file_explain" || state === "agent_wait") {
    return handleMessage(chatId, "ok");
  }
  return { messages: [], passThrough: true };
}

export function getState(chatId: number): TutorialState | null {
  return states.get(chatId) ?? null;
}

export function clearTutorial(chatId: number): void {
  states.delete(chatId);
}
