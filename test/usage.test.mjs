/**
 * Self-test for the pure usage core. No DSH, no network, no credentials.
 *
 * Run: node test/usage.test.mjs
 * Exit code 0 = all assertions passed.
 */
import {
  STATE,
  USAGE_WINDOWS,
  formatPercentText,
  formatResetText,
  formatUsageRows,
  initialState,
  reduceError,
  reduceLoading,
  reduceNoKey,
  reduceOk,
} from '../lib/usage.js'

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

// ---- Fixed inputs -----------------------------------------------------------
// One frozen "now" for every case, so the whole test is deterministic.
const NOW = Date.parse('2026-03-01T00:00:00.000Z')

// The user's literal sample, as fixed ISO instants.
const SAMPLE = {
  rolling: { percent: 9, resetsAt: '2026-03-01T00:10:00.000Z' }, // +10m
  weekly: { percent: 17, resetsAt: '2026-03-07T01:00:00.000Z' }, // +6d 1h
  monthly: { percent: 9, resetsAt: '2026-03-31T13:00:00.000Z' }, // +30d 13h
}

// ---- 1. The three sample rows ----------------------------------------------
const rows = formatUsageRows(SAMPLE, NOW)
ok(Array.isArray(rows), 'sample payload yields rows')
eq(rows?.length, 3, 'exactly three rows')
eq(rows?.[0]?.label, 'Rolling usage', 'row 0 label')
eq(rows?.[1]?.label, 'Weekly usage', 'row 1 label')
eq(rows?.[2]?.label, 'Monthly usage', 'row 2 label')
eq(rows?.[0]?.percentText, '9% used', 'row 0 percentText')
eq(rows?.[1]?.percentText, '17% used', 'row 1 percentText')
eq(rows?.[2]?.percentText, '9% used', 'row 2 percentText')

console.log('sample rows (exact output):')
for (const row of rows ?? []) {
  console.log(`${row.label} | ${row.percentText} | ${row.resetText}`)
}

eq(rows?.[0]?.resetText, 'Resets in 0h 10m', 'row 0 resetText')
eq(rows?.[1]?.resetText, 'Resets in 6d 1h', 'row 1 resetText')
eq(rows?.[2]?.resetText, 'Resets in 30d 13h', 'row 2 resetText')

// The three literal strings the acceptance check greps for.
ok(`${rows?.[0]?.resetText}`.includes('Resets in 0h 10m'), 'contains literal "Resets in 0h 10m"')
ok(`${rows?.[1]?.resetText}`.includes('Resets in 6d 1h'), 'contains literal "Resets in 6d 1h"')
ok(`${rows?.[2]?.resetText}`.includes('Resets in 30d 13h'), 'contains literal "Resets in 30d 13h"')

// ---- 2. Relative-time edge cases -------------------------------------------
eq(formatResetText('2026-03-01T00:00:00.000Z', NOW), 'Resets in 0h 0m', 'exact now -> 0h 0m')
eq(formatResetText('2026-02-28T00:00:00.000Z', NOW), 'Resets in 0h 0m', 'past instant clamps, never negative')
eq(formatResetText('2026-03-01T00:00:59.000Z', NOW), 'Resets in 0h 0m', 'sub-minute floors to 0h 0m')
eq(formatResetText('2026-03-02T00:00:00.000Z', NOW), 'Resets in 1d 0h', 'exactly 1 day uses the day form')
eq(formatResetText('2026-03-01T23:59:00.000Z', NOW), 'Resets in 23h 59m', 'just under a day uses the h/m form')

// ---- 3. Percent formatting --------------------------------------------------
eq(formatPercentText(0), '0% used', 'zero percent')
eq(formatPercentText(100), '100% used', 'full percent')
eq(formatPercentText(140), '100% used', 'over 100 clamps')
eq(formatPercentText(-4), '0% used', 'negative clamps')
eq(formatPercentText('9'), null, 'numeric string is not a number')
eq(formatPercentText(Number.NaN), null, 'NaN percent')

// ---- 4. Malformed / absent payload -> null, never a throw -------------------
const MALFORMED = [
  ['null', null],
  ['undefined', undefined],
  ['string', 'not-a-payload'],
  ['number', 42],
  ['empty object', {}],
  ['missing monthly', { rolling: SAMPLE.rolling, weekly: SAMPLE.weekly }],
  ['percent as string', { ...SAMPLE, rolling: { percent: '9', resetsAt: SAMPLE.rolling.resetsAt } }],
  ['percent NaN', { ...SAMPLE, weekly: { percent: Number.NaN, resetsAt: SAMPLE.weekly.resetsAt } }],
  ['resetsAt missing', { ...SAMPLE, monthly: { percent: 9 } }],
  ['resetsAt not ISO', { ...SAMPLE, monthly: { percent: 9, resetsAt: 'soon' } }],
  ['window is null', { ...SAMPLE, rolling: null }],
  ['Array payload', []],
]
for (const [label, payload] of MALFORMED) {
  let result
  let threw = false
  try {
    result = formatUsageRows(payload, NOW)
  } catch {
    threw = true
  }
  ok(!threw, `malformed (${label}) does not throw`)
  eq(result, null, `malformed (${label}) returns null`)
}
eq(formatUsageRows(SAMPLE, Number.NaN), null, 'non-finite nowMs returns null')

// ---- 5. State machine -------------------------------------------------------
let state = initialState()
eq(state.status, 'loading', 'initial state is loading')

state = reduceLoading(state)
eq(state.status, STATE.LOADING, 'reduceLoading -> loading')

state = reduceOk(state, SAMPLE, NOW)
eq(state.status, STATE.OK, 'well-formed payload -> ok')
eq(state.rows?.length, 3, 'ok state carries three rows')
eq(state.error, null, 'ok state has no error')

state = reduceNoKey(state)
eq(state.status, STATE.NO_KEY, 'missing credential -> no-key')
eq(state.rows?.length, 3, 'no-key keeps last-known-good rows visible')
eq(state.lastGood?.weekly?.percent, 17, 'no-key carries the last-known-good payload')

state = reduceOk(state, { rolling: SAMPLE.rolling }, NOW)
eq(state.status, STATE.ERROR, 'malformed payload -> error, not a throw')
eq(state.error, 'malformed usage payload', 'error explains itself')
eq(state.lastGood?.monthly?.percent, 9, 'error carries the last-known-good payload')
eq(state.rows?.length, 3, 'error keeps last-known-good rows renderable')

state = reduceOk(state, null, NOW)
eq(state.status, STATE.ERROR, 'null payload -> error')
eq(state.lastGood?.weekly?.percent, 17, 'last-known-good survives repeated errors')

state = reduceOk(state, SAMPLE, NOW)
eq(state.status, STATE.OK, 'recovery after error -> ok')
eq(state.error, null, 'recovery clears the error')

// A reducer must survive hostile inputs without throwing.
const HOSTILE = [
  ['undefined state', undefined],
  ['null state', null],
  ['state without rows', { status: 'ok' }],
  ['rows not an array', { rows: 'nope' }],
]
for (const [label, previous] of HOSTILE) {
  for (const [name, reducer] of [
    ['reduceLoading', () => reduceLoading(previous)],
    ['reduceNoKey', () => reduceNoKey(previous)],
    ['reduceError', () => reduceError(previous, new Error('boom'))],
    ['reduceOk', () => reduceOk(previous, SAMPLE, NOW)],
  ]) {
    let threw = false
    try {
      const next = reducer()
      ok(typeof next?.status === 'string', `${name}(${label}) returns a state`)
    } catch {
      threw = true
    }
    ok(!threw, `${name}(${label}) does not throw`)
  }
}

// A throwing getter must not escape the pure layer either.
const hostilePayload = {}
Object.defineProperty(hostilePayload, 'rolling', {
  enumerable: true,
  get() {
    throw new Error('hostile getter')
  },
})
let hostileThrew = false
try {
  formatUsageRows(hostilePayload, NOW)
} catch {
  hostileThrew = true
}
ok(!hostileThrew, 'throwing getter does not escape formatUsageRows')

let hostileStateThrew = false
try {
  reduceOk(hostilePayload, hostilePayload, NOW)
} catch {
  hostileStateThrew = true
}
ok(!hostileStateThrew, 'throwing getter does not escape reduceOk')

// ---- 6. No credential-shaped value can reach the client half ----------------
const smuggled = formatUsageRows({ ...SAMPLE, apiKey: 'SHOULD-NOT-SURVIVE' }, NOW)
eq(JSON.stringify(smuggled).includes('SHOULD-NOT-SURVIVE'), false, 'unknown payload fields are dropped')
eq(Object.keys(smuggled?.[0] ?? {}).join(','), 'label,percentText,resetText', 'rows expose exactly three fields')
eq(USAGE_WINDOWS.length, 3, 'three usage windows are defined')

// ---- Result -----------------------------------------------------------------
if (failures === 0) {
  console.log(`\nPASS: ${checks} assertions, ${MALFORMED.length} malformed cases, 0 failures`)
  process.exit(0)
}
console.error(`\nFAIL: ${failures}/${checks} assertions failed`)
process.exit(1)
