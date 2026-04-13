# Delta Chat Channel for Claude Code

Talk to and code securely with Claude from your phone. A Claude Code channel plugin that bridges Delta Chat to Claude Code — end-to-end encrypted, open source, with helper WebXDC applets to enable simpler GUI ingteraction (tap and swipe vs. text chat when that is easier).

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) v2.1.80 or later
- [Bun](https://bun.sh/) (v1.1+) on your `$PATH`
- [Delta Chat](https://delta.chat/) on your phone (Android, iOS, or desktop) with a [chatmail](https://chatmail.at/) account

## Installation

### Install via marketplace (recommended)

In any Claude Code session:

```
/plugin marketplace add jhayashi/dc-claude-channel
/plugin install deltachat@dc-claude-channel
```

Then launch Claude Code with the research-preview channel flag:

```bash
claude --dangerously-load-development-channels plugin:deltachat@dc-claude-channel
```

> **Why the `--dangerously-load-development-channels` flag?** During the Claude Code channels research preview, third-party channel plugins must be either on the official Anthropic allowlist or loaded with this flag. We're working toward allowlist approval — see [issue #8](https://github.com/jhayashi/dc-claude-channel/issues/8) for status. Team and Enterprise admins can alternatively add this plugin to their org's `allowedChannelPlugins` in managed settings to skip the flag.

### Updating

```
/plugin marketplace update
```

Then restart your Claude Code session to pick up the new version.

### Development install

If you want to hack on the plugin itself, see the [Development](#development) section below.

## First-Time Setup

On first launch, the plugin auto-provisions a bot account on a chatmail server. On subsequent launches, it resumes the saved account.

### 1. Get the bot's invite link

In Claude Code, run:

```
/deltachat:configure invite
```

This prints a QR code link.

### 2. Add the bot in Delta Chat

Open the link in a browser on the same machine running the terminal. On the web page that loads, tap the **triangle icon** to reveal the QR code. Scan the QR code from your Delta Chat app to add Claude as a verified contact.

### 3. Pair your chat

Once you've added Claude as a contact, send any message. Claude will reply with a command to type into your terminal:

> Pairing required — run in Claude Code:
> /deltachat:access pair abcde

Type that command into your Claude Code terminal to establish the link between your Delta Chat account and Claude. This ensures no one else can command your Claude agent.

### 4. Tutorial

After pairing, the bot sends two WebXDC apps (Permission Prompt and File Reviewer) and offers a guided tour. The tutorial walks you through:

- **Permission prompts** — how to tap the centered message to Allow or Deny
- **File Reviewer** — syntax-highlighted code/doc viewer with inline commenting
- **App building** — optionally build a WebXDC app right in the chat

Reply "yes" to start, or "no" to skip. You can start using Claude immediately either way.

## Features

- **End-to-end encrypted** — all messages, files, and app data encrypted via Autocrypt. Your code never passes through a third-party server in readable form.
- **Trivial bot setup** — two lines in Claude Code (`/plugin marketplace add` + `/plugin install`), scan a QR code, and pair with a 5-letter code. No tokens, no API keys, no cloud dashboards, no bot portals, no Rust toolchain, no separate `deltachat-rpc-server` install. The plugin auto-provisions an encrypted chatmail account on first run. A guided tutorial walks you through permissions, file review, and building your first WebXDC app — all in under 2 minutes.
- **Tap-and-swipe permission control** — every built-in tool call (Bash, Edit, Write, WebFetch…) pauses the agent and sends an interactive WebXDC Allow/Deny card to the chat that triggered the action. Owner-verified — only the chat owner can approve. You stay in the loop from your phone without ever typing a command.
- **Voice messages** — send a voice message and Claude transcribes it locally using prebuilt native whisper.cpp bindings — fully offline, no API calls, no system dependencies. Just `bun install` and it works. The transcript is echoed back to the chat and forwarded to the agent as text. Speech models auto-download from Hugging Face on first use. Configurable model size and echo mode via environment variables.
- **Timers, reminders, and scheduled jobs** — ask Claude to "remind me to stretch every hour" or "check the build at 9am weekdays" and it sets up a real cron-backed schedule via `dc_schedule`. Jobs persist to disk and are owned by the dispatcher's in-process scheduler, so they survive subagent eviction, idle timeout, and restarts — no reliance on Claude's own in-session timers. Recurring and one-shot both supported; list with `dc_schedule_list`, cancel with `dc_schedule_delete`.
- **Trusted agents with emoji progress + audit log** — for agents you trust (marked as skip-permissions in the setup card), tool calls run without prompting and the dispatcher reacts to your message with a live emoji showing what Claude is doing: 🔍 reading, ✏️ editing, ⚙️ running commands, 🌐 web, 🤝 delegating, ✍️ planning. `TodoWrite` progresses through 1️⃣–9️⃣ then 🇦–🇿 so you can see which step of the plan it's on. Every auto-approved tool call is appended to a per-chat audit log; ask "what did you run?" and Claude sends the log back via the file reviewer.
- **Custom apps with AI backend (Familiar)** — Claude can build interactive WebXDC apps with a live server-side handler powered by Claude itself. The handler runs in a sandboxed eval with access to persistent state, push updates, and LLM requests. Apps can be ephemeral or persistent (surviving restarts). Import apps by sending a `.familiar.yaml` file into any chat.
- **Mobile friendly File Reviewer** — send code and documents as interactive WebXDC apps with syntax highlighting (TypeScript, Python, Go, Bash, and more) and inline commenting. Long-press a line to leave feedback, Claude reads your comments and makes changes.
- **Slide presentations** — ask Claude to make a slide deck and it renders Marp-format slides as an interactive WebXDC presentation you can swipe through on your phone.
- **WebXDC apps** — Claude can build single and multiplayer games, tools, and interactive apps as self-contained WebXDC bundles. Share them with friends by forwarding.
- **Screenshots** — send photos and screenshots from your phone. Claude sees them and can fix visual bugs.
- **Custom agents** — create specialized Claude agents, each with its own model (Opus for deep coding, Sonnet for general work, Haiku for quick Q&A), system prompt, and isolated conversation context. Agent definitions are YAML files compatible with the [Claude Managed Agents API](https://docs.anthropic.com/en/docs/agents-and-tools/managed-agents) schema. Manage everything from your phone via an interactive setup card — create, edit, delete, or reuse the same agent across multiple chats. Export agents as `.yaml` files and import them by sending the file into any chat. Sessions persist across restarts so Claude picks up where you left off.
- **Per-agent tool access** — control what each agent can do. Built-in tools (Bash, Read, Edit, WebSearch, etc.) have fine-grained per-tool checkboxes. MCP servers (DC Tools, Gmail, Google Calendar, Slack, Telegram, etc.) are all-or-nothing toggles. Configure everything from the agent setup card's collapsible tool picker. An agent with only Read and Grep can explore code but never modify it; one with Gmail enabled can check your inbox while another can't.
- **Parallel subagent architecture** — each chat runs as an independent subagent process, so a long coding task in one chat never blocks a quick question in another. Claude stays responsive across all your conversations. An LRU cache keeps recently active chats warm for sub-second response times while idle agents gracefully exit to free resources.
- **Attachments** — send and receive images, PDFs, and files. Large files auto-download.
- **Access control** — pairing codes, owner tracking, stranger lockout. Once paired, unknown contacts can't even trigger a pairing prompt.

> **Beyond the channels research preview:** The Claude Code channels API provides the messaging transport — this plugin builds substantially on top of it. Features like multi-agent with per-agent tool restrictions, cron-backed scheduled jobs, interactive WebXDC permission cards (vs. text-based), the Familiar app runtime, local voice transcription, live activity emoji reactions, the file reviewer with inline commenting, and slide presentations are all implemented in this plugin and are not part of the base channels API. The official channels research preview provides message routing and basic tool proxying; everything above that is custom.

## Screenshots

<p align="center">
  <img src="screenshots/chat-list.jpg" width="250" alt="Chat list with agent chats">
  &nbsp;&nbsp;
  <img src="screenshots/agent-setup.jpg" width="250" alt="Agent setup card">
</p>
<p align="center">
  <em>Multiple agents, each with their own chat and model</em>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <em>Agent setup and management in a WebXDC app</em>
</p>

<p align="center">
  <img src="screenshots/permission-prompt.jpg" width="250" alt="Permission prompt">
  &nbsp;&nbsp;
  <img src="screenshots/file-reviewer.jpg" width="250" alt="File reviewer">
</p>
<p align="center">
  <em>Tap to Allow or Deny tool permissions</em>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <em>Review and comment on code from your phone</em>
</p>

## How the Delta Chat Channel Stacks Up

|  | Delta Chat | Telegram | Discord |
|--|-----------|----------|---------|
| **Encryption** | E2E encrypted (Autocrypt) | Server-side only (no E2E for bots) | None |
| **Custom agents** | Per-chat model, prompt, tool access, and isolated context; import/export as YAML | Single bot config | Single bot config |
| **Per-agent tool access** | Fine-grained per-tool and per-MCP-server restrictions | No | No |
| **Parallelism** | Independent subagent per chat — long tasks never block other chats | Single event loop | Single event loop |
| **Voice messages** | Local whisper.cpp transcription (offline, zero config) | No built-in STT | No built-in STT |
| **Scheduled jobs** | Cron-backed scheduler, persists across restarts | No | No |
| **Chat-native apps** | WebXDC apps (games, tools, GUIs) + Familiar apps with AI backend | Inline keyboards only | Slash commands only | 
| **Permission UX** | Interactive WebXDC app (tap Allow/Deny) | Text-based numbered replies | Text-based |
| **File review** | Syntax-highlighted viewer + inline commenting | Plain file attachment | Plain file attachment |
| **Bot setup** | Two slash commands + QR scan + guided tutorial | BotFather token + config | Bot portal + config |
| **Self-hosted** | Fully (client + server + plugin) | No (Telegram servers) | No (Discord servers) |
| **Open source** | Client + server + plugin | Client only | No |

## Development

To hack on the plugin itself:

```bash
git clone https://github.com/jhayashi/dc-claude-channel.git
cd dc-claude-channel/plugin
bun install
bun test
```

Then add your local clone as a marketplace and install from it so your edits take effect in place:

```
/plugin marketplace add /absolute/path/to/dc-claude-channel
/plugin install deltachat@dc-claude-channel
```

Launch Claude Code with `--dangerously-load-development-channels plugin:deltachat@dc-claude-channel`. After each edit, run `/plugin marketplace update` and restart the session to pick up changes. See [CLAUDE.md](CLAUDE.md) for architecture notes and development gotchas.

## License

MIT — see [LICENSE](LICENSE).
