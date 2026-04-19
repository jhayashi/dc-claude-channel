export type Frontmatter = Record<string, string>

export type MarpDetection = {
  isSlides: boolean
  frontmatter: Frontmatter | null
  body: string
}

export function parseYamlSubset(src: string): Frontmatter {
  const out: Frontmatter = {}
  const lines = String(src || '').split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim()
    let val = line.slice(colon + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (key) out[key] = val
  }
  return out
}

export function detectMarp(raw: string): MarpDetection {
  const text = typeof raw === 'string' ? raw : ''
  let fm: Frontmatter | null = null
  let body = text

  // Look for leading YAML frontmatter: --- on line 1, then key:value lines, then --- alone on a line.
  // Only treat it as frontmatter if the inner block parses as YAML (≥1 key extracted); otherwise
  // the opening `---` is a slide separator, not frontmatter.
  if (/^---\r?\n/.test(text)) {
    const firstNewline = text.indexOf('\n')
    const closeMatch = text.slice(firstNewline + 1).match(/(^|\r?\n)---\r?\n/)
    if (closeMatch && closeMatch.index !== undefined) {
      const fmStart = firstNewline + 1
      const fmEnd = firstNewline + 1 + closeMatch.index + (closeMatch[1]?.length ?? 0)
      const fmRaw = text.slice(fmStart, fmEnd)
      const parsed = parseYamlSubset(fmRaw)
      if (Object.keys(parsed).length > 0) {
        fm = parsed
        const after = firstNewline + 1 + closeMatch.index + closeMatch[0].length
        body = text.slice(after)
      }
    }
  }

  let isSlides = false
  if (fm) {
    const v = (fm.marp || '').toLowerCase()
    isSlides = v === 'true' || v === 'yes'
  } else if (/^---\r?\n/.test(text)) {
    const stripped = text.replace(/^---\r?\n/, '')
    const parts = stripped.split(/\r?\n---\r?\n/).map(s => s.trim()).filter(Boolean)
    if (parts.length >= 2) isSlides = true
  }

  return { isSlides, frontmatter: fm, body }
}
