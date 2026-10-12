/**
 * Client-bundle test: materialize the BUILT bundle the way DSH's browser module
 * host does, with a `window.__ModuleLoader__` stub and a React stub, and prove
 * that the shipped bundle registers the dock entry and carries the inlined
 * formatter.
 *
 * Offline and browserless: no network, no real DOM, no real React.
 *
 * Run: node test/client-bundle.test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let failures = 0
let checks = 0

/**
 * @param condition - must be truthy.
 * @param label - assertion label.
 */
function ok(condition, label) {
  checks += 1
  if (!condition) {
    failures += 1
    console.error(`FAIL: ${label}`)
  }
}

/**
 * @param actual - observed value.
 * @param expected - required value.
 * @param label - assertion label.
 */
function eq(actual, expected, label) {
  checks += 1
  if (actual !== expected) {
    failures += 1
    console.error(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`)
  }
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bundlePath = join(root, 'lib', 'client.js')
const bundleText = readFileSync(bundlePath, 'utf8')

// ---- 1. The bundle is self-contained (inlining worked) ----------------------
ok(!/from\s+['"]\.\/usage\.js['"]/.test(bundleText), 'the bundle does not import ./usage.js')
ok(!/require\(\s*['"]\.\//.test(bundleText), 'the bundle does not require a relative path')
ok(!/^\s*import\s/m.test(bundleText), 'the bundle has no top-level ESM import')
ok(bundleText.includes('__ModuleLoader__.load'), 'the bundle registers through the module loader')

// ---- 2. Materialize it the way the module host does -------------------------
const loaded = []
globalThis.window = { __ModuleLoader__: { load: (mod) => loaded.push(mod) } }

await import('../lib/client.js')

eq(loaded.length, 1, 'the bundle calls __ModuleLoader__.load exactly once')
const loadedModule = loaded[0]
eq(loadedModule.id, 'dsh-plugin-opencode-usage', 'the registered module id is the package name')
eq(typeof loadedModule.factory, 'function', 'the registered module exposes a factory')

const requiredIds = []
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  useEffect: () => {},
}
const exported = loadedModule.factory((id) => {
  requiredIds.push(id)
  if (id === 'react') return reactStub
  throw new Error(`the bundle required an unexpected module: ${id}`)
})
eq(requiredIds.join(','), 'react', 'the bundle requires only the react platform seed')

// ---- 3. Export surface and dock registration --------------------------------
eq(typeof exported.apply, 'function', 'the module exports apply')
eq(exported.inject.join(','), 'slots', 'the module declares inject = [slots]')
eq(typeof exported.UsagePill, 'function', 'the module exports the pill component')

const injected = []
const registrations = []
const fakeCtx = {
  effect(fn) {
    fn()
    return () => {}
  },
  slots: {
    inject(slot, fn) {
      injected.push(slot)
      return fn()
    },
    register(contract, Component) {
      registrations.push({ contract, Component })
      return () => {}
    },
  },
}
exported.apply(fakeCtx)
eq(injected.join(','), 'conversation.composer.dock', 'apply injects the composer dock slot')
eq(registrations.length, 1, 'apply registers exactly one dock entry')
eq(registrations[0]?.contract?.name, 'conversation.composer.dock', 'the registered slot name is the dock contract')
eq(registrations[0]?.contract?.id, 'opencode-usage', 'the registered entry id is opencode-usage')
ok(registrations[0]?.contract?.order >= 10, 'the entry sorts after the built-in dock entries')
eq(registrations[0]?.Component, exported.UsagePill, 'the dock entry renders the pill component')

// ---- 4. The inlined formatter agrees with the reference sample --------------
const NOW = Date.parse('2026-03-01T00:00:00.000Z')
const SAMPLE = {
  rolling: { percent: 9, resetsAt: '2026-03-01T00:10:00.000Z' },
  weekly: { percent: 17, resetsAt: '2026-03-07T01:00:00.000Z' },
  monthly: { percent: 9, resetsAt: '2026-03-31T13:00:00.000Z' },
}
const rows = exported.formatUsageRows(SAMPLE, NOW)
eq(rows?.length, 3, 'the inlined formatter yields three rows')
eq(rows?.[0]?.label, 'Rolling usage', 'inlined label 0')
eq(rows?.[0]?.percentText, '9% used', 'inlined percentText 0')
eq(rows?.[0]?.resetText, 'Resets in 0h 10m', 'inlined resetText 0')
eq(rows?.[1]?.resetText, 'Resets in 6d 1h', 'inlined resetText 1')
eq(rows?.[2]?.resetText, 'Resets in 30d 13h', 'inlined resetText 2')

// Host bodies map onto the state machine exactly as the pill expects.
const okState = exported.applyHostBody(exported.initialState(), { status: 'ok', payload: SAMPLE }, NOW)
eq(okState.status, 'ok', 'a host ok body yields the ok state')
eq(okState.rows?.length, 3, 'the ok state carries three rows')
eq(exported.applyHostBody(okState, { status: 'no-key' }, NOW).status, 'no-key', 'a host no-key body yields no-key')
const errorState = exported.applyHostBody(okState, { status: 'error', error: { kind: 'auth', message: 'HTTP 401' }, lastGood: SAMPLE }, NOW)
eq(errorState.status, 'error', 'a host error body yields the error state')
eq(errorState.rows?.length, 3, 'the error state still renders the last-known-good rows')
eq(errorState.error, 'HTTP 401', 'the error message is carried through')
eq(exported.applyHostBody(exported.initialState(), { status: 'nonsense' }, NOW).status, 'error', 'an unknown host status yields error')

// ---- 5. Render + refresh lifecycle -----------------------------------------
// A minimal document so the component's effect path is exercised for real.
const timers = new Set()
const listeners = { document: [], window: [] }
const styleNode = { setAttribute: () => {}, textContent: '' }
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
const realFetch = globalThis.fetch
const realDocument = globalThis.document

globalThis.setInterval = (fn, ms) => {
  const id = { fn, ms }
  timers.add(id)
  return id
}
globalThis.clearInterval = (id) => {
  timers.delete(id)
}
globalThis.document = {
  visibilityState: 'visible',
  head: { appendChild: () => {} },
  createElement: () => styleNode,
  querySelector: () => null,
  addEventListener: (type, fn) => listeners.document.push({ type, fn }),
  removeEventListener: (type, fn) => {
    const index = listeners.document.findIndex((entry) => entry.type === type && entry.fn === fn)
    if (index >= 0) listeners.document.splice(index, 1)
  },
}
globalThis.window.addEventListener = (type, fn) => listeners.window.push({ type, fn })
globalThis.window.removeEventListener = (type, fn) => {
  const index = listeners.window.findIndex((entry) => entry.type === type && entry.fn === fn)
  if (index >= 0) listeners.window.splice(index, 1)
}

const fetchedUrls = []
globalThis.fetch = async (url) => {
  fetchedUrls.push(url)
  return { ok: true, status: 200, json: async () => ({ status: 'ok', payload: SAMPLE }) }
}

// Capture the effect the pill registers, then run it like React would.
let effectFn
const lifecycleReact = { ...reactStub, useEffect: (fn) => { effectFn = fn } }
const lifecycleModule = loadedModule.factory((id) => {
  if (id === 'react') return lifecycleReact
  throw new Error(`unexpected require(${id})`)
})

const rendered = lifecycleModule.UsagePill()
eq(rendered?.type, 'div', 'the pill renders a container element')
eq(rendered?.props?.['data-slot-entry'], 'opencode-usage', 'the pill is tagged for the dock')
/** Flatten an element tree to text. Arrays are valid React children, so recurse. */
const textOf = (node) => {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return (node?.children ?? []).map(textOf).join(' ')
}
ok(textOf(rendered).includes('OpenCode'), 'the pill labels itself')
ok(textOf(rendered).includes('usage'), 'the pill shows a loading note before data arrives')

eq(typeof effectFn, 'function', 'the pill registers an effect')
const cleanup = effectFn()
await new Promise((resolve) => realSetInterval(resolve, 0))
eq(fetchedUrls.length >= 1, true, 'mounting triggers a read')
eq(fetchedUrls[0], lifecycleModule.ROUTE, 'the pill reads the host route')
ok(!String(fetchedUrls[0]).includes('key'), 'the pill request carries no credential')
eq(timers.size, 1, 'mounting starts exactly one poll timer')
ok(listeners.document.some((entry) => entry.type === 'visibilitychange'), 'mounting listens for visibility changes')
ok(listeners.window.some((entry) => entry.type === 'focus'), 'mounting listens for focus')

eq(typeof cleanup, 'function', 'the effect returns a cleanup')
cleanup()
eq(timers.size, 0, 'cleanup clears the poll timer')
eq(listeners.document.length, 0, 'cleanup removes the document listener')
eq(listeners.window.filter((entry) => entry.type === 'focus').length, 0, 'cleanup removes the focus listener')

// ---- 6. Restore globals -----------------------------------------------------
globalThis.setInterval = realSetInterval
globalThis.clearInterval = realClearInterval
globalThis.fetch = realFetch
if (realDocument === undefined) delete globalThis.document
else globalThis.document = realDocument

// ---- 7. No credential-shaped material in the shipped bundle ----------------
for (const pattern of [/sk-[A-Za-z0-9]{8,}/, /Bearer\s+[A-Za-z0-9_\-.]{12,}/, /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i]) {
  ok(!pattern.test(bundleText), `the bundle matches no ${pattern} pattern`)
}

// ---- Result ------------------------------------------------------------------
if (failures === 0) {
  console.log(`PASS: ${checks} assertions, 0 failures`)
  process.exit(0)
}
console.error(`\nFAIL: ${failures}/${checks} assertions failed`)
process.exit(1)
