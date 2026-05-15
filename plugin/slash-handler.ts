/**
 * Dispatcher-side handler for slash commands intercepted before subagent
 * dispatch. Pulled out of server.ts so confirmation copy and no-binding
 * paths are unit-testable without spinning up a full dispatcher.
 *
 * Production wires deps from main(): real DCClient.send, the active
 * SubagentCache.evictChat, and bindings.clearSessionId.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import * as agents from './agents.js'
import * as bindings from './bindings.js'
import type { SlashCommand } from './slash-router.js'
import {
  loadUsageEntries, aggregateEntries, aggregateByDay,
  formatUsageReport, lastNDays, renderDailyTokensSVG,
} from './usage-aggregator.js'
import { Resvg } from '@resvg/resvg-js'

export interface SlashDeps {
  send: (chatId: number, text: string) => Promise<unknown>
  evictChat: (chatId: number) => Promise<unknown>
  logf: (fmt: string, ...args: unknown[]) => void
  /** Best-effort badge refresh after model change. */
  refreshIcon?: (chatId: number, agentId: string) => void
  /** Send a file attachment (e.g. usage chart PNG). Optional — handler degrades to text-only when absent. */
  sendAttachment?: (chatId: number, filePath: string, caption?: string) => Promise<unknown>
  /** Overrides process.cwd() for tests and multi-project setups. */
  projectCwd?: string
  /** Directly overrides the resolved memory directory (tests only). */
  memoryDirOverride?: string
}

/**
 * Handle a classified slash command. Returns a string when the command should
 * be forwarded to the subagent as rewritten prose (pass-through); returns void
 * when the dispatcher handled it entirely (no subagent dispatch needed).
 */
export async function handleSlash(
  deps: SlashDeps,
  cmd: SlashCommand,
  chatId: number,
): Promise<string | void> {
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
      const memDir = deps.memoryDirOverride ?? resolveMemoryDir(deps.projectCwd ?? process.cwd())
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

    case 'model': {
      if (!cmd.tier) {
        await send(chatId, 'Usage: /model <haiku|sonnet|opus>').catch(() => {})
        return
      }
      const binding = bindings.getBinding(chatId)
      if (!binding?.agentId) {
        await send(chatId, "Not bound to an agent here — /model doesn't apply.").catch(() => {})
        return
      }
      try {
        agents.setAgentModel(binding.agentId, cmd.tier)
        await evictChat(chatId).catch((err) =>
          logf('slash: model evict failed chat=%d: %v', chatId, err),
        )
        await send(chatId, `Switched to ${cmd.tier}. Takes effect on the next message.`).catch(() => {})
        deps.refreshIcon?.(chatId, binding.agentId)
      } catch (err) {
        logf('slash: model failed chat=%d tier=%s: %v', chatId, cmd.tier, err)
        await send(chatId, `Couldn't switch to ${cmd.tier}: ${err instanceof Error ? err.message : 'unknown error'}`).catch(() => {})
      }
      return
    }

    case 'effort': {
      const binding = bindings.getBinding(chatId)
      if (!binding?.agentId) {
        await send(chatId, "Not bound to an agent here — /effort doesn't apply.").catch(() => {})
        return
      }
      const def = agents.getAgent(binding.agentId)
      if (!def) {
        await send(chatId, `Agent ${binding.agentId} not found.`).catch(() => {})
        return
      }

      // Bare /effort or unknown level → show current + usage.
      if (cmd.level === null) {
        const current = def.effort ?? 'not set (using CLI default)'
        const prefix = cmd.raw
          ? `Unknown effort level "${cmd.raw}". `
          : ''
        await send(
          chatId,
          `${prefix}Current effort: ${current}.\nUsage: /effort <low|medium|high|xhigh|max>, or /effort none to clear.`,
        ).catch(() => {})
        return
      }

      try {
        if (cmd.level === 'reset') {
          agents.setAgentEffort(binding.agentId, null)
          await evictChat(chatId).catch((err) =>
            logf('slash: effort evict failed chat=%d: %v', chatId, err),
          )
          await send(chatId, 'Cleared effort override. Takes effect on the next message.').catch(() => {})
        } else {
          agents.setAgentEffort(binding.agentId, cmd.level)
          await evictChat(chatId).catch((err) =>
            logf('slash: effort evict failed chat=%d: %v', chatId, err),
          )
          await send(chatId, `Switched effort to ${cmd.level}. Takes effect on the next message.`).catch(() => {})
        }
      } catch (err) {
        logf('slash: effort failed chat=%d level=%s: %v', chatId, cmd.level, err)
        await send(chatId, `Couldn't change effort: ${err instanceof Error ? err.message : 'unknown error'}`).catch(() => {})
      }
      return
    }

    case 'compact':
      return 'Compact our conversation: summarize the key context from this session so we can continue with a smaller context window.'

    case 'usage': {
      await handleUsage(deps, chatId)
      return
    }

    case 'think': {
      if (!cmd.prompt) {
        await send(chatId, 'Use /think <your question> to engage extended thinking.').catch(() => {})
        return
      }
      return `${cmd.prompt}\n\nThink hard before responding.`
    }

    case 'ultrathink': {
      if (!cmd.prompt) {
        await send(chatId, 'Use /ultrathink <your question> for maximum extended thinking.').catch(() => {})
        return
      }
      return `${cmd.prompt}\n\nUltrathink before responding.`
    }

    case 'plan':
      return cmd.prompt
        ? `Enter plan mode and plan: ${cmd.prompt}`
        : 'Enter plan mode.'

    case 'exit-plan':
      return 'Exit plan mode and proceed with the approved plan.'

    case 'blocked':
      await send(chatId, `/${cmd.cmd} isn't available in chat. Try /help.`).catch(() => {})
      return

    case 'unknown-slash':
      return cmd.args
        ? `Use the /${cmd.cmd} skill: ${cmd.args}`
        : `Use the /${cmd.cmd} skill.`
  }
}

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------

const HELP_TEXT = `Available commands:
/help — show this list
/stop — stop the current turn; resume on next message
/clear — stop + wipe session (next message starts completely fresh)
/model <haiku|sonnet|opus> — switch the bound agent's model
/compact — compact conversation context
/usage — show account token usage
/think <question> — engage extended thinking before responding
/ultrathink <question> — engage maximum extended thinking
/plan [task] — enter plan mode (no changes until you approve)
/exit-plan — exit plan mode and execute the approved plan
/memory — show memory index
/memory show <key> — show a specific memory entry
/mcp — list configured MCP servers
/plugin — list installed plugins
Other /commands are forwarded to Claude as skill invocations.`

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
  const resolved = join(memDir, filename)
  if (!resolved.startsWith(memDir + '/')) {
    await send(chatId, `Invalid memory key "${key}".`).catch(() => {})
    return
  }
  try {
    const content = await readFile(resolved, 'utf8')
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
// /usage
// ---------------------------------------------------------------------------

const USAGE_WINDOW_DAYS = 7

async function handleUsage(
  deps: SlashDeps,
  chatId: number,
): Promise<void> {
  const { send, logf } = deps
  const projectsDir = join(homedir(), '.claude', 'projects')
  const since = new Date(Date.now() - USAGE_WINDOW_DAYS * 86_400_000)

  // One walk feeds both the text report and the chart series.
  let entries
  try {
    entries = await loadUsageEntries(projectsDir, since)
  } catch (err: unknown) {
    logf('slash: usage read failed chat=%d: %v', chatId, err)
    await send(chatId, 'Could not read usage data.').catch(() => {})
    return
  }
  await send(chatId, formatUsageReport(aggregateEntries(entries, since))).catch(() => {})

  if (!deps.sendAttachment) return
  try {
    const series = lastNDays(aggregateByDay(entries, since), USAGE_WINDOW_DAYS)
    if (!series.length) return
    const svg = renderDailyTokensSVG(series)
    const png = new Resvg(svg).render().asPng()
    const pngPath = join(tmpdir(), `dc-usage-chart-${chatId}.png`)
    await writeFile(pngPath, png)
    await deps.sendAttachment(chatId, pngPath).catch(() => {})
  } catch (err) {
    logf('slash: usage chart failed chat=%d: %v', chatId, err)
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
