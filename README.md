# Delta Chat Channel for Claude Code

Talk to Claude from your phone. A Claude Code channel plugin that bridges Delta Chat to Claude Code — end-to-end encrypted, open source, no cloud middleman.

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- [Bun](https://bun.sh/) (v1.1+)
- [deltachat-rpc-server](https://github.com/deltachat/deltachat-core-rust) — the Delta Chat core binary (`pipx install deltachat-rpc-server`)
- [Delta Chat](https://delta.chat/) on your phone (Android or iOS)

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

Open Delta Chat on your phone and scan the QR code (or tap the link). This adds Claude as a verified contact.

### 3. Pair your chat

Send any message to the bot in Delta Chat. It replies with a pairing code:

> Pairing required — run in Claude Code:
> /deltachat:access pair abcde

Back in Claude Code, run:

```
/deltachat:access pair abcde
```

### 4. Tutorial

After pairing, the bot sends two WebXDC apps (Permission Prompt and File Reviewer) and offers a guided tour. The tutorial walks you through:

- **Permission prompts** — how to tap the centered message to Allow or Deny
- **File Reviewer** — syntax-highlighted code/doc viewer with inline commenting
- **Game building** — optionally build a WebXDC game right in the chat

Reply "yes" to start, or "no" to skip. You can start using Claude immediately either way.

## Features

- **End-to-end encrypted** — all messages, files, and app data encrypted via Autocrypt. Your code never passes through a third-party server in readable form.
- **Permission prompts** — interactive WebXDC app for Allow/Deny decisions, sent to the chat that triggered the action. Owner-verified — only the chat owner can approve.
- **File Reviewer** — send code and documents as interactive WebXDC apps with syntax highlighting (TypeScript, Python, Go, Bash, and more) and inline commenting. Long-press a line to leave feedback, Claude applies your changes.
- **WebXDC apps** — Claude can build single and multiplayer games, tools, and interactive apps as self-contained WebXDC bundles. Share them with friends by forwarding.
- **Screenshots** — send photos and screenshots from your phone. Claude sees them and can fix visual bugs.
- **Group chats** — create groups with behavior prompts (e.g., "Summarize any links shared"). Only the owner can command Claude in groups — other members' messages are silently ignored.
- **Attachments** — send and receive images, PDFs, and files. Large files auto-download.
- **Access control** — pairing codes, owner tracking, stranger lockout. Once paired, unknown contacts can't even trigger a pairing prompt.

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
