#!/usr/bin/env bun
/**
 * Build script: assembles markdown-viewer.html with inlined Prism.js.
 *
 * Reads the HTML template, injects the Prism.js bundle and theme CSS,
 * and writes the final file. Run with: bun plugin/scripts/build-viewer-html.ts
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PLUGIN_DIR = join(import.meta.dir, '..')
const PRISM_DIR = join(PLUGIN_DIR, 'node_modules', 'prismjs')

// Read Prism components in dependency order
const prismJS = [
  'components/prism-core.min.js',
  'components/prism-clike.min.js',
  'components/prism-markup.min.js',
  'components/prism-css.min.js',
  'components/prism-javascript.min.js',
  'components/prism-typescript.min.js',
  'components/prism-json.min.js',
  'components/prism-python.min.js',
  'components/prism-bash.min.js',
].map(f => readFileSync(join(PRISM_DIR, f), 'utf-8')).join('\n')

const prismCSS = readFileSync(join(PRISM_DIR, 'themes', 'prism-okaidia.css'), 'utf-8')

// Read the template
const template = readFileSync(join(PLUGIN_DIR, 'webxdc', 'markdown-viewer.template.html'), 'utf-8')

// Inject. Use function replacers to avoid $-sequence interpretation
// in the replacement string (Prism JS contains $ characters that
// String.replace treats as special patterns like $', $`, $&).
const output = template
  .replace('/* %%PRISM_CSS%% */', () => prismCSS)
  .replace('/* %%PRISM_JS%% */', () => prismJS)

writeFileSync(join(PLUGIN_DIR, 'webxdc', 'markdown-viewer.html'), output)
console.log(`Built markdown-viewer.html (${output.length} bytes)`)
