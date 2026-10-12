/**
 * Build `lib/client.js` (the browser bundle DSH serves) from
 * `src/client.template.js` plus the shared usage core in `lib/usage.js`.
 *
 * Why this exists: a client bundle may only require platform seed words
 * (`react`, …) or another loaded package by its EXACT id — the browser module
 * table resolves through `stripClientSuffix`, which strips only a trailing
 * `/client`. `require('dsh-plugin-opencode-usage/usage')` therefore misses the
 * table and throws at materialization. The shipped bundles all inline their
 * helpers, so this does too.
 *
 * Inlining would normally risk the two halves drifting apart, so the inlined
 * text is not a copy: it is extracted from the one canonical `lib/usage.js`.
 * `test/client-bundle.test.mjs` additionally asserts the inlined formatter
 * agrees with the module on the reference sample.
 *
 * Usage: node scripts/build-client.mjs [--check]
 *   --check  verify lib/client.js is up to date; exit 1 if it is not
 *
 * Line endings: every read is normalized to LF and the bundle is emitted as LF,
 * so the output is identical on a CRLF checkout and an LF one.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const templatePath = join(root, 'src', 'client.template.js')
const usagePath = join(root, 'lib', 'usage.js')
const outputPath = join(root, 'lib', 'client.js')

const PLACEHOLDER = '//__USAGE_SOURCE__'

/**
 * Reduce CRLF/CR to LF, so every pattern below is defined in terms of `\n`.
 * @param text - raw file contents.
 */
function normalizeEol(text) {
  return text.replace(/\r\n?/g, '\n')
}

/**
 * Extract the pieces of the usage module a bundle can execute: the exported
 * constants and functions, without the JSDoc prose and without ESM `export`
 * keywords, since the bundle body is CommonJS-wrapped.
 * @param source - contents of lib/usage.js.
 * @returns executable source ready to inline.
 */
function extractUsageBody(source) {
  const withoutBanner = source.replace(/^\/\*\*[\s\S]*?\*\/\n/, '')
  const withoutDocs = withoutBanner.replace(/^\s*\/\*\*[\s\S]*?\*\/\n/gm, '')
  const lines = withoutDocs
    .split('\n')
    .filter((line) => !line.startsWith('@module'))
    .map((line) => line.replace(/^export\s+(?=(const|let|var|function|class|default)\b)/, ''))
    .map((line) => (line.startsWith('  ') ? line.slice(2) : line))

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

const template = normalizeEol(readFileSync(templatePath, 'utf8'))
if (!template.includes(PLACEHOLDER)) {
  throw new Error(`build-client: ${templatePath} has no ${PLACEHOLDER} marker`)
}

const usage = extractUsageBody(normalizeEol(readFileSync(usagePath, 'utf8')))
if (/^\s*export\b/m.test(usage)) {
  throw new Error('build-client: the extracted usage body still contains an `export` keyword')
}
const built = template.replaceAll(PLACEHOLDER, usage)

if (process.argv.includes('--check')) {
  const existing = normalizeEol(readFileSync(outputPath, 'utf8'))
  if (existing !== built) {
    console.error('build-client: lib/client.js is stale — run `npm run build`')
    process.exit(1)
  }
  console.log('build-client: lib/client.js is up to date')
  process.exit(0)
}

writeFileSync(outputPath, built)
console.log(`build-client: wrote ${outputPath} (${Buffer.byteLength(built)} bytes)`)
