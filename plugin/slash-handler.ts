/**
 * Dispatcher-side handler for slash commands intercepted before subagent
 * dispatch. Pulled out of server.ts so confirmation copy and no-binding
 * paths are unit-testable without spinning up a full dispatcher.
 *
 * Production wires deps from main(): real DCClient.send, the active
 * SubagentCache.evictChat, and bindings.clearSessionId.
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import * as bindings from './bindings.js'
import type { SlashCommand } from './slash-router.js'

export interface SlashDeps {
  send: (chatId: number, text: string) => Promise<unknown>
  evictChat: (chatId: number) => Promise<unknown>
  logf: (fmt: string, ...args: unknown[]) => void
  /** Overrides process.cwd() for tests and multi-project setups. */
  projectCwd?: string
}

export async function handleSlash(
  deps: SlashDeps,
  cmd: SlashCommand,
  chatId: number,
): Promise<void> {
  const { send, evictChat, logf } = deps

  switch (cmd.kind) {
    case 'help': {
      await send(chatId, HELP_TEXT).catch(() => {})
      return
    }

    case 'stop': {
      await evictChat(chatId).catch((err) =>
        logf('slash: stop evict failed chat=%d: %v', chatId, err),
      )
      await send(chatId, 'Stopped. Send your next message to continue.').catch(() => {})
      return
    }

    case 'clear': {
      await evictChat(chatId).catch((err) =>
        logf('slash: clear evict failed chat=%d: %v', chatId, err),
      )
      try {
        bindings.clearSessionId(chatId)
      } catch (err) {
        logf('slash: clear session failed chat=%d: %v', chatId, err)
      }
      await send(chatId, 'Session cleared. Next message starts fresh.').catch(() => {})
      return
    }

    case 'memory': {
      const memDir = resolveMemoryDir(deps.projectCwd ?? process.cwd())
      if (!cmd.subcommand) {
        await handleMemoryList(send, chatId, memDir, logf)
      } else {
        await handleMemoryShow(send, chatId, memDir, cmd.key!, logf)
      }
      return
    }

    case 'mcp': {
      await handleMcp(send, chatId, logf)
      return
    }

    case 'plugin': {
      await handlePlugin(send, chatId, logf)
      return
    }
  }
}

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------

const HELP_TEXT = `Available commands:
/help — show this list
/stop — stop the current turn; resume on next message
/clear — stop + wipe session (next message starts completely fresh)
/memory — show memory index
/memory show <key> — show a specific memory entry
/mcp — list configured MCP servers
/plugin — list installed plugins`

// ---------------------------------------------------------------------------
// /memory
// ---------------------------------------------------------------------------

/** Derives the Claude Code projects dir entry for a given absolute cwd. */
function resolveMemoryDir(cwd: string): string {
  const projectKey = cwd.replace(/\//g, '-')
  return join(homedir(), '.claude', 'projects', projectKey, 'memory')
}

async function handleMemoryList(
  send: SlashDeps['send'],
  chatId: number,
  memDir: string,
  logf: SlashDeps['logf'],
): Promise<void> {
  try {
    const index = await readFile(join(memDir, 'MEMORY.md'), 'utf8')
    await send(chatId, index).catch(() => {})
  } catch (err: unknown) {
    if (isEnoent(err)) {
      await send(chatId, 'No memory found for this project.').catch(() => {})
    } else {
      logf('slash: memory list failed chat=%d: %v', chatId, err)
      await send(chatId, 'Could not read memory index.').catch(() => {})
    }
  }
}

async function handleMemoryShow(
  send: SlashDeps['send'],
  chatId: number,
  memDir: string,
  key: string,
  logf: SlashDeps['logf'],
): Promise<void> {
  const filename = key.endsWith('.md') ? key : `${key}.md`
  try {
    const content = await readFile(join(memDir, filename), 'utf8')
    await send(chatId, content).catch(() => {})
  } catch (err: unknown) {
    if (isEnoent(err)) {
      await send(chatId, `No memory entry found for "${key}".`).catch(() => {})
    } else {
      logf('slash: memory show failed chat=%d key=%s: %v', chatId, key, err)
      await send(chatId, `Could not read memory entry "${key}".`).catch(() => {})
    }
  }
}

// ---------------------------------------------------------------------------
// /mcp
// ---------------------------------------------------------------------------

interface McpServerEntry {
  type?: string
  command?: string
  url?: string
  disabled?: boolean
}

async function handleMcp(
  send: SlashDeps['send'],
  chatId: number,
  logf: SlashDeps['logf'],
): Promise<void> {
  try {
    const claudeJson = await readFile(join(homedir(), '.claude.json'), 'utf8')
    const config = JSON.parse(claudeJson) as { mcpServers?: Record<string, McpServerEntry> }
    const servers = config.mcpServers ?? {}
    const entries = Object.entries(servers)

    if (entries.length === 0) {
      await send(chatId, 'No MCP servers configured.').catch(() => {})
      return
    }

    const lines = entries.map(([name, s]) => {
      const status = s.disabled ? 'disabled' : 'enabled'
      const kind = s.type ?? (s.url ? 'sse' : 'stdio')
      return `• ${name} [${kind}] — ${status}`
    })
    await send(chatId, `MCP servers:\n${lines.join('\n')}`).catch(() => {})
  } catch (err: unknown) {
    if (isEnoent(err)) {
      await send(chatId, 'No MCP servers configured.').catch(() => {})
    } else {
      logf('slash: mcp list failed chat=%d: %v', chatId, err)
      await send(chatId, 'Could not read MCP configuration.').catch(() => {})
    }
  }
}

// ---------------------------------------------------------------------------
// /plugin
// ---------------------------------------------------------------------------

interface InstalledPlugin {
  scope: string
  installPath: string
  version: string
}

interface PluginsJson {
  version?: number
  plugins?: Record<string, InstalledPlugin[]>
}

async function handlePlugin(
  send: SlashDeps['send'],
  chatId: number,
  logf: SlashDeps['logf'],
): Promise<void> {
  try {
    const pluginsPath = join(homedir(), '.claude', 'plugins', 'installed_plugins.json')
    const settingsPath = join(homedir(), '.claude', 'settings.json')

    const [pluginsRaw, settingsRaw] = await Promise.all([
      readFile(pluginsPath, 'utf8').catch(() => '{}'),
      readFile(settingsPath, 'utf8').catch(() => '{}'),
    ])

    const pluginsJson = JSON.parse(pluginsRaw) as PluginsJson
    const settings = JSON.parse(settingsRaw) as { enabledPlugins?: Record<string, boolean> }
    const enabled = settings.enabledPlugins ?? {}
    const installed = pluginsJson.plugins ?? {}

    const pluginIds = Object.keys(installed)
    if (pluginIds.length === 0) {
      await send(chatId, 'No plugins installed.').catch(() => {})
      return
    }

    const lines = pluginIds.map((id) => {
      const versions = installed[id]
      const latest = versions?.[versions.length - 1]
      const version = latest?.version ?? '?'
      const status = enabled[id] ? 'enabled' : 'disabled'
      return `• ${id} v${version} — ${status}`
    })
    await send(chatId, `Installed plugins:\n${lines.join('\n')}`).catch(() => {})
  } catch (err) {
    logf('slash: plugin list failed chat=%d: %v', chatId, err)
    await send(chatId, 'Could not read plugin list.').catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
