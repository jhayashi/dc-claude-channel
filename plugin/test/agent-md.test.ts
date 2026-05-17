import { describe, test, expect } from 'bun:test'
import { parseAgentMarkdown, serializeAgentMarkdown } from '../agent-md'

describe('parseAgentMarkdown', () => {
  test('extracts frontmatter and body from a well-formed file', () => {
    const text = `---
name: foo
model: claude-sonnet-4-6
tools: Read, Bash
---

You are foo.
`
    const { frontmatter, body } = parseAgentMarkdown(text)
    expect(frontmatter).toEqual({
      name: 'foo',
      model: 'claude-sonnet-4-6',
      tools: 'Read, Bash',
    })
    expect(body).toBe('You are foo.\n')
  })

  test('handles a body with multiple blank lines and markdown headings', () => {
    const text = `---
name: foo
---

# Heading

Paragraph one.

Paragraph two.
`
    const { body } = parseAgentMarkdown(text)
    expect(body).toBe('# Heading\n\nParagraph one.\n\nParagraph two.\n')
  })

  test('handles an empty body', () => {
    const text = `---
name: foo
---
`
    const { frontmatter, body } = parseAgentMarkdown(text)
    expect(frontmatter).toEqual({ name: 'foo' })
    expect(body).toBe('')
  })

  test('throws when no closing --- delimiter is found', () => {
    expect(() => parseAgentMarkdown(`---\nname: foo\nbody without delim`)).toThrow(
      /missing closing/i,
    )
  })

  test('throws when the file does not start with ---', () => {
    expect(() => parseAgentMarkdown(`name: foo\nno delim`)).toThrow(/missing frontmatter/i)
  })

  test('throws on unparseable YAML', () => {
    // Unclosed flow sequence — yaml package raises ParseError.
    expect(() => parseAgentMarkdown(`---\nfoo: [unclosed\n---\nbody`)).toThrow()
  })
})

describe('serializeAgentMarkdown', () => {
  test('round-trips a parsed file byte-for-byte (modulo trailing newline)', () => {
    const text = `---
name: foo
model: claude-sonnet-4-6
tools: Read, Bash
---

You are foo.
`
    const { frontmatter, body } = parseAgentMarkdown(text)
    const out = serializeAgentMarkdown(frontmatter, body)
    // Reparse — round-trip must yield equal structure.
    expect(parseAgentMarkdown(out)).toEqual({ frontmatter, body })
  })

  test('emits frontmatter with --- delimiters and a blank line before body', () => {
    const out = serializeAgentMarkdown({ name: 'foo' }, 'Hello.')
    expect(out.startsWith('---\n')).toBe(true)
    expect(out).toContain('\n---\n\nHello.')
  })

  test('preserves field order from input frontmatter', () => {
    // We rely on YAML.stringify which uses insertion order for plain objects.
    const fm = { name: 'foo', description: 'bar', model: 'claude-sonnet-4-6' }
    const out = serializeAgentMarkdown(fm, '')
    const nameIdx = out.indexOf('name:')
    const descIdx = out.indexOf('description:')
    const modelIdx = out.indexOf('model:')
    expect(nameIdx).toBeLessThan(descIdx)
    expect(descIdx).toBeLessThan(modelIdx)
  })

  test('empty body emits trailing newline after closing delimiter', () => {
    const out = serializeAgentMarkdown({ name: 'foo' }, '')
    expect(out.endsWith('---\n')).toBe(true)
  })
})
