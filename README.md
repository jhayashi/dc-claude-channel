# Delta Chat Channel for Claude Code

Talk to and code securely with Claude from your phone. A Claude Code channel plugin that bridges Delta Chat to Claude Code — end-to-end encrypted, open source, with helper WebXDC applets to enable simpler GUI ingteraction (tap and swipe vs. text chat when that is easier).

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- [Bun](https://bun.sh/) (v1.1+)
- [deltachat-rpc-server](https://github.com/deltachat/deltachat-core-rust) — the Delta Chat core binary (`pipx install deltachat-rpc-server`)
- `zip` — for building WebXDC apps (`sudo apt install zip` on Ubuntu)
- [Delta Chat](https://delta.chat/) on your phone (Android, iOS, or desktop) with a [chatmail](https://chatmail.at/) account

## Installation

### 1. Clone and install

```bash
git clone https://github.com/jhayashi/dc-claude-channel.git
cd dc-claude-channel
./install.sh
```

The install script checks prerequisites, installs dependencies, and registers the plugin in `~/.claude/plugins/installed_plugins.json`. If you've already installed, re-running the script safely updates the registration.

### 2. Launch Claude Code with the channel

The install script prints the launch command at the end. It looks like:

```bash
claude --plugin-dir /path/to/dc-claude-channel/plugin \
  --dangerously-load-development-channels plugin:deltachat@inline
```

## First-Time Setup

On first launch, the plugin auto-provisions a bot account on a chatmail server. On subsequent launches, it resumes the saved account.

### 1. Get the bot's invite link

In Claude Code, run:

```
/deltachat:configure invite
```

This prints a QR code link.

### 2. Add the bot in Delta Chat

Open the invite link in a browser on the same machine running the terminal. On the web page that loads, tap the **triangle icon** to reveal the QR code. Scan the QR code from your Delta Chat app to add Claude as a verified contact.

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
- **Trivial bot setup** — run `./install.sh`, scan a QR code, and pair with a 5-letter code. No tokens, no API keys, no cloud dashboards, no bot portals. The plugin auto-provisions an encrypted chatmail account on first run. A guided tutorial walks you through permissions, file review, and building your first WebXDC app — all in under 2 minutes.
- **Tap and swipe Permissions** — interactive WebXDC app for Allow/Deny decisions, sent to the chat that triggered the action. Owner-verified — only the chat owner can approve.
- **Mobile friendly File Reviewer** — send code and documents as interactive WebXDC apps with syntax highlighting (TypeScript, Python, Go, Bash, and more) and inline commenting. Long-press a line to leave feedback, Claude reads your comments and makes changes.
- **WebXDC apps** — Claude can build single and multiplayer games, tools, and interactive apps as self-contained WebXDC bundles. Share them with friends by forwarding.
- **Screenshots** — send photos and screenshots from your phone. Claude sees them and can fix visual bugs.
- **Group chats** — create groups with behavior prompts (e.g., "Summarize any links shared"). Only the owner can command Claude in groups — other members' messages are silently ignored.
- **Attachments** — send and receive images, PDFs, and files. Large files auto-download.
- **Access control** — pairing codes, owner tracking, stranger lockout. Once paired, unknown contacts can't even trigger a pairing prompt.

## How It Compares

|  | Delta Chat | Telegram | Discord |
|--|-----------|----------|---------|
| **Encryption** | E2E encrypted (Autocrypt) | Server-side only (no E2E for bots) | None |
| **Chat-native apps** | WebXDC apps (games, tools, GUIs) | Inline keyboards only | Slash commands only | 
| **Permission UX** | Interactive WebXDC app (tap Allow/Deny) | Text-based numbered replies | Text-based |
| **File review** | Syntax-highlighted viewer + inline commenting | Plain file attachment | Plain file attachment |
| **Bot setup** | One script + QR scan + guided tutorial | BotFather token + config | Bot portal + config |
| **Self-hosted** | Fully (client + server + plugin) | No (Telegram servers) | No (Discord servers) |
| **Open source** | Client + server + plugin | Client only | No |

## Note

Only one Claude Code session can use the Delta Chat channel at a time — the underlying database uses file locking.

## Development

```bash
cd plugin
bun install
bun test
```

## License

MIT — see [LICENSE](LICENSE).
