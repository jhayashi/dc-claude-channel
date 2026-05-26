import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface McpServerInfo {
  prefix: string
  label: string
  connected: boolean
  /** Tool count — set only when known (the dc server); omitted otherwise. */
  toolCount?: number
}

/** Pretty labels for well-known prefixes; non-curated servers derive a label. */
const KNOWN_LABELS: Record<string, string> = {
  dc: 'DC Tools',
  claude_ai_Gmail: 'Gmail',
  claude_ai_Google_Calendar: 'Google Calendar',
  claude_ai_Google_Drive: 'Google Drive',
  claude_ai_Slack: 'Slack',
  claude_ai_Notion: 'Notion',
  claude_ai_Asana: 'Asana',
  claude_ai_Zoom_for_Claude: 'Zoom',
}

/**
 * claude.ai integrations we always surface. The needs-auth cache only lists
 * servers NEEDING auth, so an authed integration would otherwise vanish from
 * the picker; this set guarantees the common ones always appear (connected).
 */
const CURATED_CLAUDE_AI = Object.keys(KNOWN_LABELS).filter(p => p.startsWith('claude_ai_'))

/** `claude_ai_Google_Drive` → `claude.ai Google Drive` (the needs-auth cache key). */
export function prefixToDisplayName(prefix: string): string | null {
  if (!prefix.startsWith('claude_ai_')) return null
  return `claude.ai ${prefix.slice('claude_ai_'.length).replace(/_/g, ' ')}`
}

/** `claude.ai Google Drive` → `claude_ai_Google_Drive`. Null for non-claude.ai names. */
export function displayNameToPrefix(display: string): string | null {
  const marker = 'claude.ai '
  if (!display.startsWith(marker)) return null
  return `claude_ai_${display.slice(marker.length).replace(/ /g, '_')}`
}

function labelFor(prefix: string): string {
  if (KNOWN_LABELS[prefix]) return KNOWN_LABELS[prefix]
  if (prefix.startsWith('claude_ai_')) return prefix.slice('claude_ai_'.length).replace(/_/g, ' ')
  return prefix
}

export interface CatalogSources {
  /** claude.ai prefixes to always show. */
  curatedClaudeAi: readonly string[]
  /** Display names from ~/.claude/mcp-needs-auth-cache.json (servers needing auth). */
  needsAuthDisplayNames: ReadonlySet<string>
  /** User-configured servers from ~/.claude.json `mcpServers`. */
  configuredServers: ReadonlyArray<{ prefix: string; disabled: boolean }>
}

/**
 * Pure union, deduped by prefix (first writer wins):
 *   dc (always connected)
 *   ∪ curated claude.ai (connected iff not awaiting auth)
 *   ∪ needs-auth-only claude.ai servers (not connected)
 *   ∪ configured servers (connected iff not disabled)
 */
export function buildCatalog(sources: CatalogSources): McpServerInfo[] {
  const byPrefix = new Map<string, McpServerInfo>()

  byPrefix.set('dc', { prefix: 'dc', label: labelFor('dc'), connected: true })

  for (const prefix of sources.curatedClaudeAi) {
    if (byPrefix.has(prefix)) continue
    const display = prefixToDisplayName(prefix)
    const connected = !(display !== null && sources.needsAuthDisplayNames.has(display))
    byPrefix.set(prefix, { prefix, label: labelFor(prefix), connected })
  }

  for (const display of sources.needsAuthDisplayNames) {
    const prefix = displayNameToPrefix(display)
    if (!prefix || byPrefix.has(prefix)) continue
    byPrefix.set(prefix, { prefix, label: labelFor(prefix), connected: false })
  }

  for (const { prefix, disabled } of sources.configuredServers) {
    if (byPrefix.has(prefix)) continue
    byPrefix.set(prefix, { prefix, label: labelFor(prefix), connected: !disabled })
  }

  return [...byPrefix.values()]
}

// ── best-effort fs readers ──

function readNeedsAuthDisplayNames(): Set<string> {
  try {
    const raw = readFileSync(join(homedir(), '.claude', 'mcp-needs-auth-cache.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return new Set(Object.keys(parsed))
  } catch {
    // Missing file or bad JSON — treat as nothing needs auth.
  }
  return new Set()
}

function readConfiguredServers(): Array<{ prefix: string; disabled: boolean }> {
  try {
    const raw = readFileSync(join(homedir(), '.claude.json'), 'utf-8')
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, { disabled?: boolean }> }
    return Object.entries(parsed.mcpServers ?? {}).map(([prefix, s]) => ({
      prefix,
      disabled: s?.disabled === true,
    }))
  } catch {
    // Missing file or bad JSON — no user-configured servers.
  }
  return []
}

/** The unified MCP server catalog with connection status. */
export function listMcpServers(): McpServerInfo[] {
  return buildCatalog({
    curatedClaudeAi: CURATED_CLAUDE_AI,
    needsAuthDisplayNames: readNeedsAuthDisplayNames(),
    configuredServers: readConfiguredServers(),
  })
}

/**
 * Available servers for the agent-setup picker. `dcToolCount` annotates the dc
 * entry; external servers have no enumerable count so `toolCount` is omitted.
 */
export function getAvailableMcpServers(
  dcToolCount: number,
): Array<{ prefix: string; label: string; toolCount?: number }> {
  return listMcpServers().map(s =>
    s.prefix === 'dc'
      ? { prefix: s.prefix, label: s.label, toolCount: dcToolCount }
      : { prefix: s.prefix, label: s.label },
  )
}

/** Connected server prefixes — used by the picker's "needs auth" badge. */
export function getConnectedMcpServers(): string[] {
  return listMcpServers().filter(s => s.connected).map(s => s.prefix)
}
