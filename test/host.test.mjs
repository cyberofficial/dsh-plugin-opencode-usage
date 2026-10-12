/**
 * Host-half test. Offline: the transport is injected, the credential service is
 * faked, and no real key exists anywhere in this file or in the process.
 *
 * Run: node test/host.test.mjs
 */
import {
  ROUTE_PATH,
  USAGE_URL,
  apply,
  carriesSecret,
  fetchUsage,
  normalizeUsage,
  registerSecret,
  resolveUsageKey,
  safeMessage,
  scrubSecrets,
} from '../lib/index.js'

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

/**
 * The value used wherever a credential value is needed. It is assembled at
 * runtime and deliberately does not look like key material, so no credential
 * literal exists in this repository. It doubles as the leak canary.
 */
const CANARY = ['not', 'a', 'real', 'credential'].join('-')

const NOW = Date.parse('2026-03-01T00:00:00.000Z')

const SAMPLE_BODY = {
  usage: {
    rolling: { status: 'ok', percent: 9, resetsAt: '2026-03-01T00:10:00.000Z' },
    weekly: { status: 'ok', percent: 17, resetsAt: '2026-03-07T01:00:00.000Z' },
    monthly: { status: 'ok', percent: 9, resetsAt: '2026-03-31T13:00:00.000Z' },
  },
}

/**
 * @param status - HTTP status.
 * @param body - parsed body.
 */
function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

/**
 * A credentials service standing in for the real one.
 * @param options - `resolve` and `readRecord` implementations.
 */
function fakeCredentials(options = {}) {
  return {
    resolve: options.resolve ?? (async () => undefined),
    readRecord: options.readRecord ?? (async () => undefined),
  }
}

/**
 * A host context with the two services this plugin uses.
 * @param options - `credentials`, `fetchImpl`, `cacheMs`, `getThrows`.
 */
function fakeContext(options = {}) {
  const routes = []
  const ctx = {
    logger: { warn: () => {} },
    get(name) {
      if (options.getThrows === true) throw new Error('get exploded')
      return name === 'credentials' ? options.credentials : undefined
    },
    effect(fn) {
      fn()
      return () => {}
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  return { ctx, routes }
}

/** A Node response that records what was written. */
function fakeRes() {
  const out = { status: 0, headers: null, body: '' }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers
    },
    end(text) {
      out.body += text ?? ''
    },
  }
}

// ---- 1. normalizeUsage ------------------------------------------------------
const normalized = normalizeUsage(SAMPLE_BODY)
eq(normalized?.rolling?.percent, 9, 'normalizeUsage rolling percent')
eq(normalized?.weekly?.resetsAt, '2026-03-07T01:00:00.000Z', 'normalizeUsage weekly resetsAt')
eq(Object.keys(normalized ?? {}).join(','), 'rolling,weekly,monthly', 'normalizeUsage yields exactly three windows')
for (const [label, body] of [
  ['null', null],
  ['string', 'nope'],
  ['no usage key', {}],
  ['usage not an object', { usage: 7 }],
  ['missing monthly', { usage: { rolling: SAMPLE_BODY.usage.rolling, weekly: SAMPLE_BODY.usage.weekly } }],
  ['percent as string', { usage: { ...SAMPLE_BODY.usage, rolling: { percent: '9', resetsAt: SAMPLE_BODY.usage.rolling.resetsAt } } }],
  ['resetsAt missing', { usage: { ...SAMPLE_BODY.usage, monthly: { percent: 9 } } }],
]) {
  let result
  let threw = false
  try {
    result = normalizeUsage(body)
  } catch {
    threw = true
  }
  ok(!threw, `normalizeUsage(${label}) does not throw`)
  eq(result, null, `normalizeUsage(${label}) returns null`)
}

// ---- 2. fetchUsage: the key is only ever the Authorization header ------------
let observedUrl
let observedInit
const okFetch = async (url, init) => {
  observedUrl = url
  observedInit = init
  return jsonResponse(200, SAMPLE_BODY)
}
const payload = await fetchUsage({ apiKey: CANARY, fetchImpl: okFetch })
eq(payload?.rolling?.percent, 9, 'fetchUsage returns the normalized payload')
eq(observedUrl, USAGE_URL, 'fetchUsage calls the documented endpoint')
eq(observedInit?.method, 'GET', 'fetchUsage uses GET')
eq(observedInit?.headers?.Authorization, `Bearer ${CANARY}`, 'fetchUsage sends the key as a Bearer header')
ok(!String(observedUrl).includes(CANARY), 'the key is not in the URL')
ok(!JSON.stringify(observedInit?.body ?? null).includes(CANARY), 'the key is not in the body')
ok(observedInit?.headers?.Accept === 'application/json', 'fetchUsage sends Accept: application/json')

// ---- 3. fetchUsage error semantics -----------------------------------------
for (const [status, kind] of [
  [401, 'auth'],
  [403, 'entitlement'],
  [500, 'http'],
]) {
  let error
  try {
    await fetchUsage({ apiKey: CANARY, fetchImpl: async () => jsonResponse(status, {}) })
  } catch (caught) {
    error = caught
  }
  eq(error?.kind, kind, `fetchUsage maps HTTP ${status} to kind ${kind}`)
  ok(!String(error?.message).includes(CANARY), `fetchUsage HTTP ${status} message carries no key`)
}

let noKeyError
try {
  await fetchUsage({ apiKey: undefined, fetchImpl: okFetch })
} catch (caught) {
  noKeyError = caught
}
eq(noKeyError?.kind, 'no-key', 'fetchUsage with no key reports no-key')
eq(noKeyError?.message, 'No OpenCode API key is stored for provider opencode-go or opencode.', 'no-key message is the documented one')

let shapeError
try {
  await fetchUsage({ apiKey: CANARY, fetchImpl: async () => jsonResponse(200, { usage: {} }) })
} catch (caught) {
  shapeError = caught
}
eq(shapeError?.kind, 'shape', 'fetchUsage with an unexpected shape reports shape')

let transportError
try {
  await fetchUsage({ apiKey: CANARY, fetchImpl: async () => { throw new Error('socket closed') } })
} catch (caught) {
  transportError = caught
}
eq(transportError?.message, 'socket closed', 'fetchUsage rethrows transport failures')

// A token-shaped value that is NOT the registered secret. Assembled at runtime so
// no key-shaped literal exists in this repository for the no-leak grep to find.
const FOREIGN_TOKEN = ['zz', 'not', 'a', 'real', 'credential'].join('') + '0123456789'
eq(safeMessage(new Error(`Bearer ${FOREIGN_TOKEN}`)), 'Bearer <redacted>', 'safeMessage scrubs a token-shaped Bearer form')
eq(safeMessage(new Error('no Bearer prefix here')), 'no Bearer prefix here', 'safeMessage leaves the English word "Bearer" in prose alone')
eq(safeMessage(undefined), 'OpenCode usage request failed.', 'safeMessage survives undefined')

// ---- 4. resolveUsageKey -----------------------------------------------------
eq(await resolveUsageKey(undefined), undefined, 'resolveUsageKey(undefined) is undefined')
eq(await resolveUsageKey({ get: () => undefined }), undefined, 'resolveUsageKey without a credentials service is undefined')
eq(await resolveUsageKey({ get: () => ({}) }), undefined, 'resolveUsageKey with an empty service is undefined')
eq(
  await resolveUsageKey({ get: () => fakeCredentials({ resolve: async () => ({ value: CANARY, source: 'test' }) }) }),
  CANARY,
  'resolveUsageKey reads the reference route',
)
eq(
  await resolveUsageKey({
    get: () =>
      fakeCredentials({
        resolve: async () => undefined,
        readRecord: async (key) => (String(key).includes('opencode-go') ? { kind: 'api-key', key: CANARY } : undefined),
      }),
  }),
  CANARY,
  'resolveUsageKey falls back to the record route for opencode-go',
)
eq(
  await resolveUsageKey({
    get: () =>
      fakeCredentials({
        readRecord: async (key) => (String(key).includes('opencode') && !String(key).includes('go') ? { kind: 'api-key', key: CANARY } : undefined),
      }),
  }),
  CANARY,
  'resolveUsageKey falls back to provider opencode',
)
eq(await resolveUsageKey({ get: () => fakeCredentials() }), undefined, 'resolveUsageKey with no stored key is undefined')
eq(await resolveUsageKey({ get: () => fakeCredentials({ resolve: async () => { throw new Error('nope') } }) }), undefined, 'a throwing resolve does not escape')
eq(
  await resolveUsageKey({
    get: () =>
      fakeCredentials({
        resolve: async () => ({ value: '' }),
        readRecord: async () => ({ kind: 'env', key: CANARY }),
      }),
  }),
  undefined,
  'an empty value and a non-api-key record both fall through',
)
eq(await resolveUsageKey({ get: () => { throw new Error('boom') } }), undefined, 'a throwing ctx.get does not escape')

// ---- 5. The route ------------------------------------------------------------
/** @param config - plugin config. @param credentials - fake service. */
function routeFor(config, credentials) {
  const { ctx, routes } = fakeContext({ credentials })
  apply(ctx, config)
  eq(routes.length, 1, 'apply registers exactly one route')
  eq(routes[0].kind, 'exact', 'route kind is exact')
  eq(routes[0].path, ROUTE_PATH, 'route path is the documented one')
  return routes[0]
}

let upstreamCalls = 0
const countingFetch = async () => {
  upstreamCalls += 1
  return jsonResponse(200, SAMPLE_BODY)
}
const okRoute = routeFor({ fetchImpl: countingFetch, cacheMs: 60_000 }, fakeCredentials({ resolve: async () => ({ value: CANARY }) }))

const firstRes = fakeRes()
await okRoute.handler({ url: ROUTE_PATH }, firstRes)
eq(firstRes.out.status, 200, 'ok route responds 200')
const firstBody = JSON.parse(firstRes.out.body)
eq(firstBody.status, 'ok', 'ok route reports status ok')
eq(firstBody.payload.weekly.percent, 17, 'ok route carries the numbers')
eq(upstreamCalls, 1, 'ok route fetched upstream once')
ok(!firstRes.out.body.includes(CANARY), 'THE RESPONSE BODY DOES NOT CONTAIN THE CREDENTIAL VALUE')
ok(!JSON.stringify(firstRes.out.headers).includes(CANARY), 'the response headers do not contain the credential value')

const secondRes = fakeRes()
await okRoute.handler({ url: ROUTE_PATH }, secondRes)
eq(upstreamCalls, 1, 'a second read inside the cache window does not re-fetch')
eq(JSON.parse(secondRes.out.body).cached, true, 'the cached read is marked cached')

const forcedRes = fakeRes()
await okRoute.handler({ url: `${ROUTE_PATH}?refresh=1` }, forcedRes)
eq(upstreamCalls, 2, '?refresh=1 bypasses the cache')

// A 401 while a key IS present must surface as auth, not as a generic error.
const authRoute = routeFor({ fetchImpl: async () => jsonResponse(401, {}), cacheMs: 60_000 }, fakeCredentials({ resolve: async () => ({ value: CANARY }) }))
const authRes = fakeRes()
await authRoute.handler({ url: ROUTE_PATH }, authRes)
const authBody = JSON.parse(authRes.out.body)
eq(authBody.status, 'error', 'a 401 with a key present is an error state')
eq(authBody.error.kind, 'auth', 'a 401 with a key present is reported as auth, not masked')
ok(authBody.error.message.includes('401'), 'the auth message keeps the upstream status')
ok(!authRes.out.body.includes(CANARY), 'the auth error body carries no credential value')

// No key at all -> no-key state, not an error and not a throw.
const noKeyRoute = routeFor({ fetchImpl: async () => { throw new Error('must not be called') } }, fakeCredentials())
const noKeyRes = fakeRes()
await noKeyRoute.handler({ url: ROUTE_PATH }, noKeyRes)
eq(JSON.parse(noKeyRes.out.body).status, 'no-key', 'a missing key yields the no-key state')
eq(JSON.parse(noKeyRes.out.body).error.kind, 'no-key', 'the no-key state is labelled')
ok(!noKeyRes.out.body.includes(CANARY), 'the no-key body carries no credential value')

// Failure after a success -> error that still carries the last-known-good numbers.
let flaky = true
const flakyRoute = routeFor(
  { fetchImpl: async () => (flaky ? jsonResponse(200, SAMPLE_BODY) : jsonResponse(500, {})), cacheMs: 0 },
  fakeCredentials({ resolve: async () => ({ value: CANARY }) }),
)
await flakyRoute.handler({ url: ROUTE_PATH }, fakeRes())
flaky = false
const degradedRes = fakeRes()
await flakyRoute.handler({ url: ROUTE_PATH }, degradedRes)
const degradedBody = JSON.parse(degradedRes.out.body)
eq(degradedBody.status, 'error', 'a failed read after a success is an error state')
eq(degradedBody.lastGood?.monthly?.percent, 9, 'the error carries the last-known-good payload')
ok(!degradedRes.out.body.includes(CANARY), 'the degraded body carries no credential value')

// The handler never throws, even when the context and the response object do.
let survived = true
try {
  await routeFor({ fetchImpl: countingFetch }, fakeCredentials()).handler({ url: ROUTE_PATH }, fakeRes())
} catch {
  survived = false
}
ok(survived, 'a normal handler call does not throw')

const hostileRes = {
  writeHead() {
    throw new Error('headers already sent')
  },
  end() {
    throw new Error('socket gone')
  },
}
let hostileSurvived = true
try {
  await okRoute.handler({ url: ROUTE_PATH }, hostileRes)
} catch {
  hostileSurvived = false
}
ok(hostileSurvived, 'a throwing response object does not escape the handler')

// A context whose `get` throws: the route must still answer, as no-key.
const captured = []
const hostileCtx = {
  logger: { warn: () => {} },
  get() {
    throw new Error('get exploded')
  },
  effect(fn) {
    fn()
  },
  webServer: {
    register(route) {
      captured.push(route)
      return () => {}
    },
  },
}
apply(hostileCtx, { fetchImpl: countingFetch })
const hostileCtxRes = fakeRes()
await captured[0].handler({ url: ROUTE_PATH }, hostileCtxRes)
eq(JSON.parse(hostileCtxRes.out.body).status, 'no-key', 'a throwing ctx.get degrades to no-key')

// ---- 6. scrubbing covers the BARE key, the cause chain, and BOTH sinks ------
// By here the canary has been resolved and used, so it is registered. This is
// the V15 case: an upstream/transport error embedding the raw key with no
// `Bearer` prefix for a pattern to recognise.
eq(
  safeMessage(new Error(`upstream rejected credential ${CANARY} (no Bearer prefix)`)),
  'upstream rejected credential <redacted> (no Bearer prefix)',
  'safeMessage scrubs the bare registered secret and keeps the prose intact',
)
eq(safeMessage(new Error(`Bearer ${CANARY}`)), 'Bearer <redacted>', 'safeMessage scrubs a bearer-prefixed registered secret')
eq(
  safeMessage({ message: 'outer transport failure', cause: new Error(`inner carried ${CANARY}`) }),
  'outer transport failure inner carried <redacted>',
  'safeMessage scrubs a secret found in the cause chain',
)
eq(safeMessage(new Error(`post https://x.test/?key=${CANARY}&y=1`)), 'post https://x.test/?key=<redacted>&y=1', 'safeMessage scrubs a secret embedded in a URL')
eq(safeMessage(`a thrown string carrying ${CANARY}`), 'a thrown string carrying <redacted>', 'safeMessage scrubs a thrown string')
eq(scrubSecrets(`{"key":"${CANARY}"}`), '{"key":"<redacted>"}', 'scrubSecrets scrubs a quoted/JSON spelling')
ok(!safeMessage(new Error(`x ${CANARY} y`)).includes(CANARY), 'no scrubbed message still contains the secret')

// ---- 7. Split tokens: whitespace inside the key ---------------------------
// A newline or space inside the key defeats literal replacement. The two halves
// must never be emitted together, so the whole diagnostic is dropped instead.
const SPLIT_HEAD = CANARY.slice(0, 9)
const SPLIT_TAIL = CANARY.slice(9)
eq(SPLIT_HEAD + SPLIT_TAIL, CANARY, 'the split halves reassemble to the secret')
eq(
  safeMessage(new Error(`upstream rejected credential ${SPLIT_HEAD}\n${SPLIT_TAIL}`)),
  'OpenCode usage request failed.',
  'a key split by a newline drops the diagnostic',
)
eq(
  safeMessage(new Error(`upstream rejected credential ${SPLIT_HEAD} ${SPLIT_TAIL}`)),
  'OpenCode usage request failed.',
  'a key split by a space drops the diagnostic',
)
eq(
  safeMessage({ message: 'transport failure', cause: new Error(`inner ${SPLIT_HEAD}\n${SPLIT_TAIL}`) }),
  'OpenCode usage request failed.',
  'a key split inside the cause chain drops the diagnostic',
)
eq(
  safeMessage(new Error(`${SPLIT_HEAD}\r\n${SPLIT_TAIL} rejected`)),
  'OpenCode usage request failed.',
  'a key split by CRLF drops the diagnostic',
)

// ---- 8. Invisible splitters: the whole class, one projection rule -----------
// A separator that is neither space nor newline defeats whitespace collapsing
// (R1: U+200B emitted the ENTIRE key). Both sides are projected to letters and
// digits instead, so every member of the family is covered without enumerating
// ranges. The probe secret is assembled at runtime, never a literal.
const SPLIT_KEY = ['FAKE', 'SPLIT', 'KEY', '4c1d9e27z'].join('-')
registerSecret(SPLIT_KEY)
const splitKeyWith = (separator) => `${SPLIT_KEY.slice(0, 9)}${separator}${SPLIT_KEY.slice(9)}`
for (const [name, separator] of [
  ['U+200B zero-width space', '\u200b'],
  ['U+00AD soft hyphen', '\u00ad'],
  ['U+FEFF BOM', '\ufeff'],
  ['U+2028 line separator', '\u2028'],
  ['U+2029 paragraph separator', '\u2029'],
  ['U+2060 word joiner', '\u2060'],
  ['punctuation "."', '.'],
  ['newline', '\n'],
  ['space', ' '],
]) {
  const message = `upstream echoed ${splitKeyWith(separator)} end`
  ok(!message.includes(SPLIT_KEY), `the probe is genuinely split (${name})`)
  const surfaced = safeMessage(new Error(message))
  eq(surfaced, 'OpenCode usage request failed.', `a split by ${name} drops the diagnostic`)
  ok(!surfaced.includes(SPLIT_KEY.slice(9)) && !surfaced.includes(SPLIT_KEY.slice(0, 9)), `no half survives a split by ${name}`)
}

// Unicode and punctuation alone are not a secret: those diagnostics stay verbatim.
const UNICODE_NO_SECRET = 'upstream echoed \u200b nothing \u00ad secretish text \ufeff'
eq(safeMessage(new Error(UNICODE_NO_SECRET)), UNICODE_NO_SECRET, 'Unicode without a secret stays verbatim')
eq(safeMessage(new Error('socket closed')), 'socket closed', 'a plain transport error stays verbatim')
ok(safeMessage(new Error(UNICODE_NO_SECRET)).length > 0, 'a Unicode-only diagnostic is not blanked')
ok(!safeMessage(new Error(`x ${SPLIT_HEAD}\n${SPLIT_TAIL}`)).includes(SPLIT_TAIL), 'no half of a split key survives the gate')
ok(carriesSecret(`x ${SPLIT_HEAD}\n${SPLIT_TAIL}`, CANARY), 'carriesSecret sees a split secret')
ok(!carriesSecret('upstream rejected the credential outright', CANARY), 'carriesSecret does not fire on ordinary prose')

// The gate must NOT regress diagnostics for ordinary errors.
eq(
  safeMessage(new Error('OpenCode rejected the stored key (HTTP 401). The key may be invalid or belong to a different provider.')),
  'OpenCode rejected the stored key (HTTP 401). The key may be invalid or belong to a different provider.',
  'an ordinary 401 diagnostic is preserved verbatim',
)
eq(
  safeMessage(new Error('OpenCode usage request timed out after 10000 ms.')),
  'OpenCode usage request timed out after 10000 ms.',
  'an ordinary timeout diagnostic is preserved verbatim',
)
eq(
  safeMessage(new Error('The stored key has no OpenCode Go subscription (HTTP 403).')),
  'The stored key has no OpenCode Go subscription (HTTP 403).',
  'an ordinary 403 diagnostic is preserved verbatim',
)

// Both sinks must carry the scrubbed text: the host log line and the served payload.
const leakLogs = []
let leakCalls = 0
const leakCtx = {
  logger: { warn: (...args) => leakLogs.push(args.join(' ')) },
  get: (name) => (name === 'credentials' ? fakeCredentials({ resolve: async () => ({ value: CANARY }) }) : undefined),
  effect: (fn) => {
    fn()
    return () => {}
  },
  webServer: {
    register: (route) => {
      leakCtx.route = route
      return () => {}
    },
  },
}
apply(leakCtx, {
  cacheMs: 0,
  fetchImpl: async () => {
    leakCalls += 1
    throw new Error(`transport echoed ${CANARY} (no Bearer prefix)`)
  },
})
const leakRes = fakeRes()
await leakCtx.route.handler({ url: ROUTE_PATH }, leakRes)
eq(leakCalls, 1, 'the leaking transport was exercised')
ok(!leakRes.out.body.includes(CANARY), 'the SERVED PAYLOAD carries no key material')
ok(!leakLogs.join('\n').includes(CANARY), 'the HOST LOG carries no key material')
eq(JSON.parse(leakRes.out.body).error.message, 'transport echoed <redacted> (no Bearer prefix)', 'the payload carries the scrubbed message')

// ---- Result ------------------------------------------------------------------
if (failures === 0) {
  console.log(`PASS: ${checks} assertions, 0 failures`)
  process.exit(0)
}
console.error(`\nFAIL: ${failures}/${checks} assertions failed`)
process.exit(1)
