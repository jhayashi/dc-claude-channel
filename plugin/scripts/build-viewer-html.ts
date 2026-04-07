#!/usr/bin/env bun
/**
 * Build script: assembles file-reviewer.html with inlined Prism.js.
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
  'components/prism-c.min.js',
  'components/prism-cpp.min.js',
  'components/prism-java.min.js',
  'components/prism-kotlin.min.js',
  'components/prism-go.min.js',
  'components/prism-rust.min.js',
  'components/prism-swift.min.js',
  'components/prism-sql.min.js',
  'components/prism-yaml.min.js',
  'components/prism-toml.min.js',
  'components/prism-diff.min.js',
  'components/prism-markup.min.js',
  'components/prism-markdown.min.js',
  'components/prism-css.min.js',
  'components/prism-javascript.min.js',
  'components/prism-typescript.min.js',
  'components/prism-json.min.js',
  'components/prism-python.min.js',
  'components/prism-bash.min.js',
  'components/prism-docker.min.js',
  'components/prism-makefile.min.js',
  'components/prism-ruby.min.js',
  // prism-php depends on prism-markup-templating. Without it, php registers
  // a global after-tokenize hook that unconditionally dereferences
  // Prism.languages['markup-templating'].tokenizePlaceholders — which throws
  // on EVERY highlight() call for EVERY language, breaking the whole viewer.
  'components/prism-markup-templating.min.js',
  'components/prism-php.min.js',
  'components/prism-csharp.min.js',
  'components/prism-powershell.min.js',
  'components/prism-graphql.min.js',
  'components/prism-lua.min.js',
  'components/prism-r.min.js',
].map(f => readFileSync(join(PRISM_DIR, f), 'utf-8')).join('\n')

const prismCSS = readFileSync(join(PRISM_DIR, 'themes', 'prism-okaidia.css'), 'utf-8')

// Read the template
const template = readFileSync(join(PLUGIN_DIR, 'webxdc', 'file-reviewer.template.html'), 'utf-8')

// Inject. Use function replacers to avoid $-sequence interpretation
// in the replacement string (Prism JS contains $ characters that
// String.replace treats as special patterns like $', $`, $&).
const output = template
  .replace('/* %%PRISM_CSS%% */', () => prismCSS)
  .replace('/* %%PRISM_JS%% */', () => prismJS)

writeFileSync(join(PLUGIN_DIR, 'webxdc', 'file-reviewer.html'), output)
console.log(`Built file-reviewer.html (${output.length} bytes)`)
