/**
 * Pure frontmatter ↔ markdown helpers for Claude Code agent definition
 * files. CC's on-disk format is YAML frontmatter (delimited by `---`)
 * followed by a markdown body that serves as the agent's system prompt.
 *
 * No filesystem I/O lives in this module — `agents.ts` reads/writes the
 * files; the migration script reads/writes them too. Both call into
 * these helpers.
 */

import YAML from 'yaml'

export interface AgentMarkdown {
  /** Parsed YAML frontmatter as a plain object. Field types are caller-validated. */
  frontmatter: Record<string, unknown>
  /** Markdown body after the closing `---`. Stored verbatim (no trim). */
  body: string
}

/**
 * Split a Claude Code agent definition file into its frontmatter and
 * markdown body. Throws on malformed input — caller is responsible for
 * file-not-found and IO errors.
 */
export function parseAgentMarkdown(text: string): AgentMarkdown {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    throw new Error('agent file is missing frontmatter (must start with ---)')
  }
  // Locate the closing delimiter. Match `\n---\n` or `\n---\r\n` or
  // `\n---` at end-of-file. Skip the opening 4 characters so we don't
  // re-match the opening delimiter.
  const afterOpen = text.slice(4)
  const closeMatch = afterOpen.match(/\n---(\r?\n|$)/)
  if (!closeMatch) {
    throw new Error('agent file is missing closing --- delimiter')
  }
  const closeIdx = closeMatch.index! // position within afterOpen
  const yamlStr = afterOpen.slice(0, closeIdx)
  const parsed = YAML.parse(yamlStr)
  const frontmatter =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  const bodyStart = 4 + closeIdx + closeMatch[0].length
  let body = text.slice(bodyStart)
  // Strip a single leading blank line if present — `serializeAgentMarkdown`
  // emits one for readability and we want round-trips to be tight.
  if (body.startsWith('\n')) body = body.slice(1)
  else if (body.startsWith('\r\n')) body = body.slice(2)
  return { frontmatter, body }
}

/**
 * Serialize frontmatter + body back to a single string. Field order in
 * the output follows the insertion order of the input object (relies on
 * YAML.stringify's stable iteration). Always emits a trailing newline.
 */
export function serializeAgentMarkdown(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const yamlStr = YAML.stringify(frontmatter)
  // Body separator: blank line after the closing delimiter for legibility,
  // unless the body is empty (in which case just the delimiter + trailing newline).
  if (body.length === 0) return `---\n${yamlStr}---\n`
  // Ensure body ends with a single newline.
  const normalisedBody = body.endsWith('\n') ? body : body + '\n'
  return `---\n${yamlStr}---\n\n${normalisedBody}`
}
