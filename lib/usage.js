/**
 * Pure usage formatting and render state for the OpenCode usage pill.
 *
 * This module is the shared core of both halves of the plugin. It has NO
 * imports at all: no DSH API, no React, no `fetch`, no credential access. It is
 * therefore safe to run on the host half, on the browser half, and in a plain
 * `node test/…` process.
 *
 * The browser half receives USAGE NUMBERS ONLY. The OpenCode API key is read
 * and used exclusively on the host half and must never reach this module or any
 * value it returns.
 *
 * Nothing in this module throws for any input, malformed or absent. Callers
 * branch on the `null` / state results instead of catching.
 *
 * @module dsh-plugin-opencode-usage/usage
 */

/** The four render states of the pill. Exactly these strings. */
export const STATE = Object.freeze({
  LOADING: 'loading',
  OK: 'ok',
  NO_KEY: 'no-key',
  ERROR: 'error',
})

/** The three usage windows, in display order. */
export const USAGE_WINDOWS = Object.freeze(['rolling', 'weekly', 'monthly'])

/** Row labels. Exactly these strings. */
const LABELS = Object.freeze({
  rolling: 'Rolling usage',
  weekly: 'Weekly usage',
  monthly: 'Monthly usage',
})

const MS_PER_MINUTE = 60000
const MS_PER_HOUR = 3600000
const MINUTES_PER_DAY = 1440
const MINUTES_PER_HOUR = 60

/** Micro-cents per dollar, verified against the console billing page (2026-10-15). */
export const MICRO_CENTS_PER_DOLLAR = 100_000_000

/**
 * @param value - any value.
 * @returns true when it is a finite `number`.
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Read one window of a payload, validating percent and reset instant.
 * @param payload - candidate normalized payload.
 * @param key - one of {@link USAGE_WINDOWS}.
 * @returns {{percent: number, resetsAt: string}} or `null` when unusable.
 */
function readWindow(payload, key) {
  const window = payload[key]
  if (!window || typeof window !== 'object') return null
  if (!isFiniteNumber(window.percent)) return null
  if (typeof window.resetsAt !== 'string') return null
  if (!Number.isFinite(Date.parse(window.resetsAt))) return null
  return { percent: window.percent, resetsAt: window.resetsAt }
}

/**
 * Percent text for one window. Clamped to 0..100 and rounded to whole percent,
 * matching the displayed sample ("9% used", "17% used").
 * @param percent - any value.
 * @returns {string|null} e.g. `"9% used"`, or `null` when not a finite number.
 */
export function formatPercentText(percent) {
  try {
    if (!isFiniteNumber(percent)) return null
    const clamped = Math.min(100, Math.max(0, percent))
    return `${Math.round(clamped)}% used`
  } catch {
    return null
  }
}

/**
 * Reset text for one window, relative to `nowMs`.
 *
 * Rule (derived from the reference sample):
 *   days >= 1 -> "<d>d <h>h"   e.g. "6d 1h", "30d 13h"
 *   days == 0 -> "<h>h <m>m"   e.g. "0h 10m"   (`0h` is correct for <1h)
 * An instant already in the past renders as "0h 0m" rather than going negative.
 *
 * @param resetsAt - ISO-8601 instant string.
 * @param nowMs - current epoch milliseconds.
 * @returns {string|null} e.g. `"Resets in 6d 1h"`, or `null` when not parseable.
 */
export function formatResetText(resetsAt, nowMs) {
  try {
    if (typeof resetsAt !== 'string') return null
    if (!isFiniteNumber(nowMs)) return null
    const targetMs = Date.parse(resetsAt)
    if (!Number.isFinite(targetMs)) return null
    const remainingMs = Math.max(0, targetMs - nowMs)
    const totalMinutes = Math.floor(remainingMs / MS_PER_MINUTE)
    const days = Math.floor(totalMinutes / MINUTES_PER_DAY)
    const hours = Math.floor((totalMinutes % MINUTES_PER_DAY) / MINUTES_PER_HOUR)
    const minutes = totalMinutes % MINUTES_PER_HOUR
    const relative = days >= 1 ? `${days}d ${hours}h` : `${hours}h ${minutes}m`
    return `Resets in ${relative}`
  } catch {
    return null
  }
}

/**
 * Credits cross to the browser as MICRO-CENTS — integers, no float rounding
 * through a "dollars" field. Scale verified 2026-10-15: the console page renders
 * "AvailableMicroCents" 454030592 as "$4.54 left", i.e. 1 µ¢ = $1e-8.
 */

/**
 * Validate one credit reading from the console billing API shape.
 * @param credit - candidate `credit` entry (null is a valid "hide" marker).
 * @returns {{availableMicroCents: number}|null} `null` hides the row.
 */
export function normalizeCredit(credit) {
  try {
    if (credit === null || credit === undefined) return null
    if (!credit || typeof credit !== 'object') return null
    const raw = credit.availableMicroCents
    const value = typeof raw === 'string' ? Number(raw) : raw
    if (!isFiniteNumber(value) || value < 0) return null
    // Integers only: an upstream that starts sending cents-in-float still lands.
    if (!Number.isSafeInteger(Math.round(value))) return null
    return { availableMicroCents: Math.round(value) }
  } catch {
    return null
  }
}

/**
 * Balance text for the credit row, matching the console ("$4.54").
 * @param availableMicroCents - a validated micro-cent reading.
 * @returns {string|null} e.g. `"$4.54"`, or `null` for malformed input.
 */
export function formatCreditDollarsText(availableMicroCents) {
  try {
    if (!isFiniteNumber(availableMicroCents) || availableMicroCents < 0) return null
    const dollars = availableMicroCents / MICRO_CENTS_PER_DOLLAR
    // Two decimals, half-away rounding like a currency formatter; a genuine
    // zero still renders "$0.00" on purpose — balance zero is information.
    return `$${dollars.toFixed(2)}`
  } catch {
    return null
  }
}



/**
 * Map a normalized payload to the three dock rows.
 * @param payload - `{rolling:{percent,resetsAt}, weekly:…, monthly:…}`.
 * @param nowMs - current epoch milliseconds.
 * @returns {Array<{label: string, percentText: string, resetText: string}>|null}
 *   exactly three rows, or `null` for malformed input (never a throw).
 */
export function formatUsageRows(payload, nowMs) {
  try {
    if (!isFiniteNumber(nowMs)) return null
    const normalized = toNormalizedPayload(payload)
    if (!normalized) return null
    const rows = []
    for (const key of USAGE_WINDOWS) {
      const { percent, resetsAt } = normalized[key]
      const percentText = formatPercentText(percent)
      const resetText = formatResetText(resetsAt, nowMs)
      if (percentText === null || resetText === null) return null
      rows.push({ label: LABELS[key], percentText, resetText })
    }
    return rows
  } catch {
    return null
  }
}

/**
 * Validate and copy a payload into the canonical `{rolling, weekly, monthly}`
 * shape. Extra fields are dropped so a host response cannot smuggle anything
 * (notably anything credential-shaped) across to the browser half.
 *
 * `credit` is the one QUESTIONED extension: a whitelisted, numbers-only
 * `{availableMicroCents}` reading, or `null`/absent to hide the row. A credit
 * value that does not validate HIDES the row rather than failing the usage
 * payload — a billing hiccup must never blank the usage meters.
 *
 * @param payload - candidate payload.
 * @returns {{rolling: object, weekly: object, monthly: object, credit?: (null|{availableMicroCents: number})}|null}
 */
export function toNormalizedPayload(payload) {
  try {
    if (!payload || typeof payload !== 'object') return null
    const normalized = {}
    for (const key of USAGE_WINDOWS) {
      const window = readWindow(payload, key)
      if (!window) return null
      normalized[key] = { percent: window.percent, resetsAt: window.resetsAt }
    }
    if (payload.credit !== undefined) normalized.credit = normalizeCredit(payload.credit)
    return normalized
  } catch {
    return null
  }
}

/**
 * @param state - any previous state value.
 * @returns the previous payload when it is still a normalized payload, else null.
 */
function lastGoodOf(state) {
  try {
    if (!state || typeof state !== 'object') return null
    return state.lastGood && typeof state.lastGood === 'object' ? state.lastGood : null
  } catch {
    return null
  }
}

/**
 * @param state - any previous state value.
 * @returns the previous credit reading as a NUMBER, else `null` (hide the row).
 */
function creditOf(state) {
  try {
    const lastGood = lastGoodOf(state)
    if (lastGood === null) return null
    return normalizeCredit(lastGood.credit)?.availableMicroCents ?? null
  } catch {
    return null
  }
}

/**
 * @param state - any previous state value.
 * @returns the previous rows array, else null.
 */
function rowsOf(state) {
  try {
    if (!state || typeof state !== 'object') return null
    return Array.isArray(state.rows) ? state.rows : null
  } catch {
    return null
  }
}

/**
 * @param error - any thrown value.
 * @returns a short display string; never throws.
 */
function describeError(error) {
  try {
    if (typeof error === 'string') return error
    if (error && typeof error.message === 'string') return error.message
    return 'usage unavailable'
  } catch {
    return 'usage unavailable'
  }
}

/**
 * @returns the initial `loading` state.
 */
export function initialState() {
  return { status: STATE.LOADING, rows: null, lastGood: null, error: null, credit: null }
}

/**
 * Enter `loading`, keeping the last-known-good rows visible if there are any.
 * @param state - previous state.
 */
export function reduceLoading(state) {
  return { status: STATE.LOADING, rows: rowsOf(state), lastGood: lastGoodOf(state), error: null, credit: creditOf(state) }
}

/**
 * Enter `no-key` — no credential is configured on the host half. This is a
 * normal state, not an error, and it is decided on the HOST half; the browser
 * half only ever sees the resulting state name.
 * @param state - previous state.
 */
export function reduceNoKey(state) {
  return { status: STATE.NO_KEY, rows: rowsOf(state), lastGood: lastGoodOf(state), error: null, credit: creditOf(state) }
}

/**
 * Enter `error`, carrying the last-known-good payload when one exists.
 * @param state - previous state.
 * @param error - any thrown value or message.
 */
export function reduceError(state, error) {
  return {
    status: STATE.ERROR,
    rows: rowsOf(state),
    lastGood: lastGoodOf(state),
    error: describeError(error),
    credit: creditOf(state),
  }
}

/**
 * Accept a payload. A malformed payload becomes `error` (carrying the
 * last-known-good payload) rather than throwing.
 * @param state - previous state.
 * @param payload - candidate payload from the host half.
 * @param nowMs - current epoch milliseconds.
 */
export function reduceOk(state, payload, nowMs) {
  try {
    const normalized = toNormalizedPayload(payload)
    if (!normalized) {
      return reduceError(state, payload === null || payload === undefined ? 'no usage payload' : 'malformed usage payload')
    }
    const rows = formatUsageRows(normalized, nowMs)
    if (!rows) return reduceError(state, 'malformed usage payload')
    // state.credit is the NUMBER (not the spine object) — the exact value the
    // dollars formatter takes.
    const credit = normalizeCredit(normalized.credit)?.availableMicroCents ?? null
    return { status: STATE.OK, rows, lastGood: normalized, error: null, credit }
  } catch (error) {
    return reduceError(state, error)
  }
}
