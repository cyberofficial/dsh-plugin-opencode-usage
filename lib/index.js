/**
 * Host half of the OpenCode usage plugin.
 *
 * This half is the ONLY place the OpenCode API key is ever read or used. It
 * resolves the credential DSH already stores for the `opencode-go` / `opencode`
 * providers, calls the (official but undocumented) usage endpoint, caches the
 * result, and serves NUMBERS ONLY over a read-only same-origin route:
 *
 *   GET /plugins/dsh-plugin-opencode-usage/api/usage[?refresh=1]
 *
 * The browser half never sees the credential — it receives
 * `{rolling, weekly, monthly}` and nothing else.
 *
 * Endpoint: `GET https://opencode.ai/zen/go/v1/usage`, `Authorization: Bearer
 * <key>`. It is implemented by OpenCode but absent from their docs, so it may
 * change without notice; every failure degrades to a state instead of a throw.
 *
 * @module dsh-plugin-opencode-usage
 */
import { toNormalizedPayload } from './usage.js'

export {
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
} from './usage.js'

/** The plugin name, matching the package name and the `cordis.patch.yml` row. */
export const name = 'dsh-plugin-opencode-usage'

/** The HTTP route table this half registers into. */
export const inject = ['webServer']

/** Same-origin route the browser half polls. */
export const ROUTE_PATH = '/plugins/dsh-plugin-opencode-usage/api/usage'

/** Official-but-undocumented usage endpoint. */
export const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

/** Provider ids to try, most specific first. */
export const PROVIDER_IDS = ['opencode-go', 'opencode']

/** Credential reference names to try, most specific first. */
export const REF_NAMES = ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY']

/** pi-ai owns its credential records under this scope. */
export const RECORD_SCOPE = 'llm-pi-ai'

/** A usage reading is cheap but upstream-limited; never re-fetch inside this. */
export const DEFAULT_CACHE_MS = 60_000

/** Upstream deadline. The chat UI must never wait on this. */
export const DEFAULT_TIMEOUT_MS = 10_000

/**
 * @param value - any value.
 * @returns true when it is a non-empty string.
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

/**
 * The credential helpers are optional: a composition may not ship them, and a
 * plugin that failed to load over a missing import helper would be far worse
 * than one that falls back to the documented literal forms.
 * @returns the module, or null when it is not resolvable.
 */
let helpersPromise
async function credentialHelpers() {
  if (helpersPromise === undefined) {
    helpersPromise = import('@deepseek-ai/dsh-credentials').catch(() => null)
  }
  return helpersPromise
}

/**
 * @param values - candidate refs/keys.
 * @returns the same list without duplicates.
 */
function dedupe(values) {
  return [...new Set(values)]
}

/**
 * Candidate reference values for one env-style name: the helper's branded value
 * when the package resolves, plus the plain name that the credential service
 * provably accepts.
 * @param refName - e.g. `OPENCODE_GO_API_KEY`.
 */
async function credentialRefCandidates(refName) {
  const helpers = await credentialHelpers()
  const refs = []
  try {
    if (typeof helpers?.credentialRef === 'function') refs.push(helpers.credentialRef(refName))
  } catch {
    // Fall through to the literal form.
  }
  refs.push(refName)
  return dedupe(refs)
}

/**
 * Candidate record keys for one provider: the helper's branded value when the
 * package resolves, plus the documented `scope/provider` literal.
 * @param providerId - e.g. `opencode-go`.
 */
async function credentialKeyCandidates(providerId) {
  const helpers = await credentialHelpers()
  const keys = []
  try {
    if (typeof helpers?.credentialKey === 'function') keys.push(helpers.credentialKey(RECORD_SCOPE, providerId))
  } catch {
    // Fall through to the literal form.
  }
  keys.push(`${RECORD_SCOPE}/${providerId}`)
  return dedupe(keys)
}

/**
 * Resolve the OpenCode key, trying both credential routes the recon proved:
 *   (i)  reference route — what Settings > Models writes for the provider;
 *   (ii) record route    — what a pi-ai login/authorization flow writes.
 * The value is returned to the caller and never logged, cached, or serialized.
 * @param ctx - host plugin context.
 * @returns the key, or undefined when no route supplies one.
 */
export async function resolveUsageKey(ctx) {
  try {
    let credentials
    try {
      credentials = ctx?.get?.('credentials')
    } catch {
      credentials = undefined
    }
    if (credentials === undefined || credentials === null) return undefined

    if (typeof credentials.resolve === 'function') {
      for (const refName of REF_NAMES) {
        for (const ref of await credentialRefCandidates(refName)) {
          try {
            const hit = await credentials.resolve(ref)
            if (hit !== undefined && hit !== null && isNonEmptyString(hit.value)) return hit.value
          } catch {
            // Try the next candidate shape.
          }
        }
      }
    }

    if (typeof credentials.readRecord === 'function') {
      for (const providerId of PROVIDER_IDS) {
        for (const key of await credentialKeyCandidates(providerId)) {
          try {
            const record = await credentials.readRecord(key)
            if (record !== undefined && record !== null && record.kind === 'api-key' && isNonEmptyString(record.key)) {
              return record.key
            }
          } catch {
            // Try the next candidate shape.
          }
        }
      }
    }

    return undefined
  } catch {
    return undefined
  }
}

/**
 * Map the upstream body onto the three-window payload, reusing the shared
 * validator so a surprising shape becomes a state rather than a throw.
 * @param body - parsed upstream JSON.
 * @returns `{rolling, weekly, monthly}` or null.
 */
export function normalizeUsage(body) {
  try {
    if (!body || typeof body !== 'object') return null
    const usage = body.usage
    if (!usage || typeof usage !== 'object') return null
    const window = (key) => {
      const entry = usage[key]
      if (!entry || typeof entry !== 'object') return undefined
      return { percent: entry.percent, resetsAt: entry.resetsAt }
    }
    return toNormalizedPayload({ rolling: window('rolling'), weekly: window('weekly'), monthly: window('monthly') })
  } catch {
    return null
  }
}

/**
 * @param status - upstream HTTP status.
 * @returns a message describing the failure. Never includes request material.
 */
function describeStatus(status) {
  if (status === 401) return 'OpenCode rejected the stored key (HTTP 401). The key may be invalid or belong to a different provider.'
  if (status === 403) return 'The stored key has no OpenCode Go subscription (HTTP 403).'
  return `OpenCode usage request failed (HTTP ${status}).`
}

/**
 * Fetch and normalize the usage reading.
 *
 * The key is read into a local and used only as the `Authorization` header: it
 * is never put in the URL, the body, a thrown message, or a log line.
 *
 * @param options - `apiKey`, `url`, `fetchImpl`, `timeoutMs`.
 * @returns the normalized payload.
 * @throws {Error} with a `kind` of `no-key` | `auth` | `entitlement` | `http` |
 *   `shape` | `timeout` | `transport`, and a message carrying no key material.
 */
export async function fetchUsage(options = {}) {
  const {
    apiKey,
    url = USAGE_URL,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options

  if (!isNonEmptyString(apiKey)) {
    const error = new Error('No OpenCode API key is stored for provider opencode-go or opencode.')
    error.kind = 'no-key'
    throw error
  }
  // Registered before any request is made: whatever the transport throws, this
  // exact value can no longer be echoed by a message.
  registerSecret(apiKey)

  if (typeof fetchImpl !== 'function') {
    const error = new Error('OpenCode usage: no fetch implementation is available.')
    error.kind = 'transport'
    throw error
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response || response.ok !== true) {
      const status = typeof response?.status === 'number' ? response.status : 0
      const error = new Error(describeStatus(status))
      error.kind = status === 401 ? 'auth' : status === 403 ? 'entitlement' : 'http'
      error.status = status
      throw error
    }
    const body = await response.json()
    const payload = normalizeUsage(body)
    if (payload === null) {
      const error = new Error('OpenCode returned an unexpected usage shape.')
      error.kind = 'shape'
      throw error
    }
    return payload
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeout = new Error(`OpenCode usage request timed out after ${timeoutMs} ms.`)
      timeout.kind = 'timeout'
      throw timeout
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolved secrets seen by this process, so that a message carrying one can be
 * scrubbed without the caller having the key in hand. Pattern-matching alone is
 * not enough: an upstream or transport error can embed the BARE key, with no
 * `Bearer` prefix to recognise it by.
 */
const activeSecrets = new Set()

/** The generic line served when no safe diagnostic survives the secret gates. */
const GENERIC_MESSAGE = 'OpenCode usage request failed.'

/**
 * Remember a resolved secret so no later message can echo it.
 * @param secret - the raw credential value.
 */
export function registerSecret(secret) {
  try {
    if (isNonEmptyString(secret)) activeSecrets.add(secret)
  } catch {
    // Unreadable input is simply not registered.
  }
}

/**
 * The spellings one secret can take in a message: as-is, plus the
 * percent-encoded and JSON-escaped forms, which differ only when the token
 * contains an escapable character.
 * @param secret - the raw credential value.
 * @returns distinct spellings to look for.
 */
function secretVariants(secret) {
  const variants = new Set([secret])
  try {
    variants.add(encodeURIComponent(secret))
    variants.add(encodeURI(secret))
    variants.add(JSON.stringify(secret).slice(1, -1))
  } catch {
    // The raw form is still covered.
  }
  return variants
}

/**
 * Replace every literal occurrence of a known secret, then any token-shaped
 * `Bearer <token>` form.
 *
 * Matching the secret itself is case-SENSITIVE: a credential is not
 * case-insensitive, and lowercasing would both miss the real value and mangle
 * unrelated text.
 *
 * The fallback `Bearer` rule requires a token shape (12+ token characters), not
 * the old `\S+`: prose such as "no Bearer prefix" must survive, and a rule that
 * eats the word after "Bearer" corrupts the very message it is protecting.
 *
 * @param text - the message to scrub.
 * @param secret - one extra secret to scrub beyond the registered ones.
 * @returns the scrubbed text.
 */
export function scrubSecrets(text, secret) {
  try {
    let out = typeof text === 'string' ? text : String(text)
    const secrets = new Set(activeSecrets)
    if (isNonEmptyString(secret)) secrets.add(secret)
    for (const value of secrets) {
      for (const variant of secretVariants(value)) {
        if (variant.length === 0) continue
        out = out.split(variant).join('<redacted>')
      }
    }
    return out.replace(/Bearer\s+[A-Za-z0-9_\-.=+/]{12,}/g, 'Bearer <redacted>')
  } catch {
    return 'OpenCode usage request failed.'
  }
}

/**
 * Project a value down to letters and digits, dropping every other character.
 *
 * This is the comparison projection for split secrets. Enumerating separator
 * ranges (whitespace, U+200B, U+00AD, U+FEFF, U+2028/2029, U+2060, …) is
 * whack-a-mole: one projection through a single character class closes the whole
 * family at once, because anything inserted BETWEEN the characters of a secret
 * disappears from both sides of the comparison.
 *
 * @param value - the text to project.
 * @returns the letters and digits of `value`, in order.
 */
function projectAlphanumeric(value) {
  return String(value).replace(/[^A-Za-z0-9]/g, '')
}

/**
 * True when a known secret is present in `text` once both sides are projected
 * down to letters and digits — the split-token case, where ANY character
 * separates the secret's characters so the literal replacement cannot see it.
 * That covers a newline, a space, a zero-width space, a soft hyphen, a BOM, a
 * line separator, punctuation, or anything else an upstream inserts.
 *
 * The projections are compared whole, so this matches nothing an ordinary error
 * message contains: no fuzzy matching, no partial redaction.
 *
 * @param text - the message to test.
 * @param secret - one extra secret to test beyond the registered ones.
 * @returns true when a whole secret is present, contiguous or split.
 */
export function carriesSecret(text, secret) {
  try {
    const projected = projectAlphanumeric(text)
    const secrets = new Set(activeSecrets)
    if (isNonEmptyString(secret)) secrets.add(secret)
    for (const value of secrets) {
      for (const variant of secretVariants(value)) {
        const projectedVariant = projectAlphanumeric(variant)
        // An empty projection would match every message; skip it.
        if (projectedVariant.length > 0 && projected.includes(projectedVariant)) return true
      }
    }
    return false
  } catch {
    // Unreadable input is treated as carrying a secret: fail closed.
    return true
  }
}

/**
 * Reduce anything thrown to a short message safe to serve and to render.
 *
 * Walks the `cause` chain, because a transport wrapper commonly carries the
 * upstream text there.
 *
 * Two stages, in order:
 *   1. Literal scrub — every occurrence of a known secret, plus token-shaped
 *      `Bearer <token>` forms.
 *   2. Split-token gate — if a whole secret is still present once whitespace is
 *      ignored, the literal pass could not see it because a newline or space
 *      split the key. Partial redaction would still emit both halves, so the
 *      entire diagnostic is dropped for a generic line instead.
 *
 * The length bound is applied LAST, so the gate sees the whole message rather
 * than a prefix. Ordinary errors keep their text: the gate only fires when a
 * registered secret is genuinely present.
 *
 * @param error - any thrown value.
 * @param secret - the resolved key for this request, when the caller has it.
 * @returns a bounded message with every secret and bearer token scrubbed.
 */
export function safeMessage(error, secret) {
  try {
    const parts = []
    let current = error
    for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
      if (typeof current === 'string') {
        parts.push(current)
        break
      }
      if (typeof current.message === 'string' && current.message.length > 0) parts.push(current.message)
      current = current.cause
    }
    if (parts.length === 0) return GENERIC_MESSAGE
    const scrubbed = scrubSecrets(parts.join(' '), secret)
    // A secret that survives the literal pass is one the pass could not see,
    // because whitespace split it. Drop the diagnostic entirely.
    if (carriesSecret(scrubbed, secret)) return GENERIC_MESSAGE
    return scrubbed.slice(0, 300)
  } catch {
    return GENERIC_MESSAGE
  }
}

/**
 * Write a JSON response. Never throws.
 * @param res - Node response.
 * @param status - HTTP status.
 * @param body - JSON-serializable body.
 */
function sendJson(res, status, body) {
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  } catch {
    try {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end('{"status":"error"}')
    } catch {
      // The response object is already gone; nothing left to do.
    }
  }
}

/**
 * Apply the host half: resolve, fetch, cache, serve.
 * @param ctx - host plugin context.
 * @param config - optional `cacheMs`, `fetchImpl`, `url` overrides.
 */
export function apply(ctx, config = {}) {
  const cacheMs = Number.isFinite(config.cacheMs) ? Number(config.cacheMs) : DEFAULT_CACHE_MS
  const fetchOptions = {
    url: typeof config.url === 'string' ? config.url : USAGE_URL,
    ...(typeof config.fetchImpl === 'function' ? { fetchImpl: config.fetchImpl } : {}),
  }

  /** Last successful payload, so a failure can still render numbers. */
  let cache

  /**
   * @param force - bypass the cache (the pill's explicit refresh).
   * @returns a response body containing numbers and state, never key material.
   */
  async function readUsage(force) {
    if (force !== true && cache !== undefined && Date.now() - cache.at < cacheMs) {
      return { status: 'ok', payload: cache.payload, fetchedAt: cache.at, cached: true }
    }

    const apiKey = await resolveUsageKey(ctx)
    if (apiKey === undefined) {
      return {
        status: 'no-key',
        error: { kind: 'no-key', message: 'No OpenCode API key is stored for provider opencode-go or opencode.' },
        lastGood: cache?.payload ?? null,
        fetchedAt: cache?.at ?? null,
      }
    }

    registerSecret(apiKey)

    try {
      const payload = await fetchUsage({ apiKey, ...fetchOptions })
      cache = { at: Date.now(), payload }
      return { status: 'ok', payload, fetchedAt: cache.at, cached: false }
    } catch (error) {
      // A 401 while a key IS present is the documented risk: report it as an
      // auth failure rather than hiding it behind a generic error.
      const kind = typeof error?.kind === 'string' ? error.kind : 'error'
      // One scrubbed message, shared by BOTH sinks — the host log line and the
      // served payload. The raw message reaches neither.
      const message = safeMessage(error, apiKey)
      ctx.logger?.warn?.(`dsh-plugin-opencode-usage: usage read failed (${kind}): ${message}`)
      return {
        status: 'error',
        error: { kind, message },
        lastGood: cache?.payload ?? null,
        fetchedAt: cache?.at ?? null,
      }
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: async (req, res) => {
          try {
            const url = new URL(req?.url ?? ROUTE_PATH, 'http://localhost')
            sendJson(res, 200, await readUsage(url.searchParams.get('refresh') === '1'))
          } catch (error) {
            // A route handler must never throw, and must never answer with
            // anything but a message.
            sendJson(res, 200, {
              status: 'error',
              error: { kind: 'internal', message: safeMessage(error) },
              lastGood: null,
              fetchedAt: null,
            })
          }
        },
      }),
    'dsh-plugin-opencode-usage: usage route',
  )
}
