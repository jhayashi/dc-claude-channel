import { describe, test, expect } from 'bun:test'
import { detectMarp, parseYamlSubset } from '../marp-detect'

describe('parseYamlSubset', () => {
  test('extracts simple key: value pairs', () => {
    expect(parseYamlSubset('marp: true\ntitle: Hello')).toEqual({ marp: 'true', title: 'Hello' })
  })

  test('trims whitespace and strips surrounding quotes', () => {
    expect(parseYamlSubset('  title:   "My Deck"  ')).toEqual({ title: 'My Deck' })
    expect(parseYamlSubset("title: 'quoted'")).toEqual({ title: 'quoted' })
  })

  test('ignores blank and commented lines', () => {
    expect(parseYamlSubset('# leading comment\nmarp: true\n\n# another\n')).toEqual({ marp: 'true' })
  })

  test('empty input returns empty object', () => {
    expect(parseYamlSubset('')).toEqual({})
  })
})

describe('detectMarp', () => {
  test('frontmatter with marp: true triggers slide mode', () => {
    const doc = '---\nmarp: true\ntitle: Deck\n---\n# Slide 1\n\n---\n\n# Slide 2'
    const r = detectMarp(doc)
    expect(r.isSlides).toBe(true)
    expect(r.frontmatter?.marp).toBe('true')
  })

  test('frontmatter without marp does NOT trigger slide mode', () => {
    const doc = '---\ntitle: Just a Doc\nauthor: Joe\n---\n# Heading\n\nsome content'
    const r = detectMarp(doc)
    expect(r.isSlides).toBe(false)
  })

  test('no frontmatter but doc starts with --- and has 2+ sections → slide mode', () => {
    const doc = '---\n# Slide A\n\ncontent\n\n---\n\n# Slide B\n\nmore'
    const r = detectMarp(doc)
    expect(r.isSlides).toBe(true)
  })

  test('no frontmatter and single --- block → not slides', () => {
    const doc = '---\njust one section\nno separator'
    const r = detectMarp(doc)
    expect(r.isSlides).toBe(false)
  })

  test('regular markdown with mid-document --- horizontal rule → not slides', () => {
    const doc = '# Title\n\nIntro paragraph.\n\n---\n\nSection two.'
    const r = detectMarp(doc)
    expect(r.isSlides).toBe(false)
  })

  test('empty input → not slides, no crash', () => {
    expect(detectMarp('').isSlides).toBe(false)
    expect(detectMarp(undefined as unknown as string).isSlides).toBe(false)
  })

  test('CRLF line endings work', () => {
    const doc = '---\r\nmarp: true\r\n---\r\n# Slide 1\r\n---\r\n# Slide 2'
    const r = detectMarp(doc)
    expect(r.isSlides).toBe(true)
  })

  test('frontmatter with marp: false does not trigger', () => {
    const doc = '---\nmarp: false\n---\n# Content\n\n---\n\n# More'
    const r = detectMarp(doc)
    expect(r.isSlides).toBe(false)
  })

  test('body is stripped of frontmatter on return', () => {
    const doc = '---\nmarp: true\n---\n# Slide 1\n---\n# Slide 2'
    const r = detectMarp(doc)
    expect(r.body.startsWith('# Slide 1')).toBe(true)
  })
})
