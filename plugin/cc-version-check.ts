/**
 * Claude Code version compatibility check.
 *
 * v1.4 of dc-claude-channel requires:
 *   - `claude -p --agent <name>` flag (CC reads the .md for prompt /
 *     model / tools / permissionMode / memory).
 *   - `memory: user` field auto-injection in the subagent system prompt.
 *   - frontmatter support for `permissionMode` and `effort` fields.
 *
 * The minimum CC version that satisfies all three is recorded in
 * `MINIMUM_CLAUDE_VERSION`. The dispatcher refuses to start if `claude
 * --version` reports something older.
 *
 * Pin determined by smoke-testing at v1.4.0 release time. If a newer
 * version is required later, bump the pin here and document why.
 */

import { execFileSync } from 'node:child_process'

export const MINIMUM_CLAUDE_VERSION: [number, number, number] = [2, 1, 100]

export type Version = [number, number, number]

/**
 * Extract the first dotted "MAJOR.MINOR.PATCH" sequence from arbitrary
 * `claude --version` output. Returns null if no such sequence is found.
 * Pre-release suffixes (e.g. "-beta.3") are dropped — the dotted core
 * is enough for the version gate.
 */
export function parseClaudeVersion(stdout: string): Version | null {
  const m = stdout.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)]
}

/** Lexicographic compare on the three components — actual >= required. */
export function isVersionAtLeast(actual: Version, required: Version): boolean {
  for (let i = 0; i < 3; i++) {
    if (actual[i]! > required[i]!) return true
    if (actual[i]! < required[i]!) return false
  }
  return true
}

/**
 * Run `claude --version` and verify against MINIMUM_CLAUDE_VERSION.
 * Throws with a chat- / log-friendly message if the version is too old
 * or `claude` is not on the PATH. Returns the parsed version on success.
 */
export function assertSupportedClaudeVersion(): Version {
  let stdout: string
  try {
    stdout = execFileSync('claude', ['--version'], { encoding: 'utf-8', timeout: 5000 })
  } catch (err) {
    throw new Error(
      `dc-claude-channel v1.4 requires the 'claude' CLI on PATH; ` +
      `\`claude --version\` failed: ${(err as Error).message}`,
    )
  }
  const parsed = parseClaudeVersion(stdout)
  if (!parsed) {
    throw new Error(
      `dc-claude-channel v1.4: could not parse \`claude --version\` output: ${JSON.stringify(stdout)}`,
    )
  }
  if (!isVersionAtLeast(parsed, MINIMUM_CLAUDE_VERSION)) {
    throw new Error(
      `dc-claude-channel v1.4 requires Claude Code ${MINIMUM_CLAUDE_VERSION.join('.')} or later; ` +
      `found ${parsed.join('.')}. Upgrade with 'npm i -g @anthropic-ai/claude-code' or follow ` +
      `the install instructions at https://code.claude.com/docs/.`,
    )
  }
  return parsed
}
