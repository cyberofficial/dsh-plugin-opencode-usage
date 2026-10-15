/**
 * Browser half of the OpenCode usage plugin — TEMPLATE.
 *
 * Built into `lib/client.js` by `scripts/build-client.mjs`; never edit the built
 * bundle by hand. The emitted bundle only REGISTERS a factory
 * (`window.__ModuleLoader__.load`); every side effect lives inside the factory
 * and runs when the module is materialized.
 *
 * The pill mounts in `conversation.composer.dock`, the ambient dock below the
 * composer card, and reads the host route
 * `/plugins/dsh-plugin-opencode-usage/api/usage`. The OpenCode API key is not
 * available here and must never become available here: the host half sends
 * usage numbers only.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-opencode-usage',
  factory: (require) => {
    const React = require('react')

    /* ── BEGIN GENERATED: usage core ──────────────────────────────────────
     * Verbatim from lib/usage.js, woven in by scripts/build-client.mjs. The
     * browser module table resolves a require by EXACT package id, so a bundle
     * cannot require a subpath of its own package — inlining is the shipped
     * pattern. Never edit this block by hand: edit lib/usage.js, rebuild.
     */
//__USAGE_SOURCE__
    /* ── END GENERATED: usage core ──────────────────────────────────────── */

    /** Host route carrying usage numbers only. */
    const ROUTE = '/plugins/dsh-plugin-opencode-usage/api/usage'

    /** Safety poll while the tab is visible; the host cache absorbs it. */
    const POLL_MS = 60_000

    /** Inject the pill's stylesheet once per document. */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-dsh-opencode-usage]') !== null) return
      const style = document.createElement('style')
      style.setAttribute('data-dsh-opencode-usage', '')
      style.textContent = [
        '.dshOpencodeUsage{display:flex;flex-wrap:wrap;gap:2px 14px;align-items:baseline;font-size:11px;line-height:1.5;color:var(--dsh-text-secondary,#8a8f98)}',
        '.dshOpencodeUsageRow{display:inline-flex;gap:6px;align-items:baseline;white-space:nowrap}',
        '.dshOpencodeUsageLabel{opacity:.75}',
        '.dshOpencodeUsagePercent{font-variant-numeric:tabular-nums;color:var(--dsh-text-primary,#e6e6e6)}',
        '.dshOpencodeUsageReset{opacity:.6}',
        '.dshOpencodeUsageNote{opacity:.6}',
      ].join('\n')
      document.head.appendChild(style)
    }

    /** Read the host route. Same-origin, so no credential or CORS is involved. */
    async function readUsage(force) {
      const response = await fetch(force === true ? `${ROUTE}?refresh=1` : ROUTE, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      })
      const body = await response.json().catch(() => undefined)
      if (!response.ok) {
        return {
          status: 'error',
          error: { kind: 'http', message: `Usage request failed (HTTP ${response.status}).` },
          lastGood: body?.lastGood ?? null,
        }
      }
      return body
    }

    /**
     * Fold one host response into the shared state machine.
     * @param previous - previous state.
     * @param body - host response body.
     * @param nowMs - current epoch milliseconds.
     * @returns the next state. Never throws.
     */
    function applyHostBody(previous, body, nowMs) {
      try {
        const status = body?.status
        if (status === 'ok') return reduceOk(previous, body?.payload, nowMs)
        if (status === 'no-key') return reduceNoKey(previous)
        if (status === 'error') {
          // Seed the last-known-good numbers so a failed read still renders a
          // figure instead of blanking the pill.
          const seeded =
            body?.lastGood === null || body?.lastGood === undefined
              ? previous
              : reduceOk(previous, body.lastGood, nowMs)
          return reduceError(seeded, body?.error?.message ?? 'OpenCode usage is unavailable.')
        }
        return reduceError(previous, 'OpenCode usage returned an unexpected response.')
      } catch {
        return reduceError(previous, 'OpenCode usage returned an unexpected response.')
      }
    }

    /** Text shown while there are no rows to render. */
    function noteFor(state) {
      if (state.status === STATE.NO_KEY) return 'No OpenCode API key'
      if (state.status === STATE.ERROR) return state.error ?? 'OpenCode usage unavailable'
      return 'OpenCode usage…'
    }

    /**
     * The dock pill: the three usage rows, refreshed on mount, on the tab
     * regaining focus, and by one slow safety poll. Every timer and listener is
     * released on unmount, so an unload or HMR swap leaves nothing running.
     */
    function UsagePill() {
      const [state, setState] = React.useState(() => initialState())
      const mounted = React.useRef(false)
      const generation = React.useRef(0)

      const load = React.useCallback((force) => {
        const mine = (generation.current += 1)
        setState((previous) => (mounted.current ? reduceLoading(previous) : previous))
        readUsage(force)
          .then((body) => {
            if (!mounted.current || mine !== generation.current) return
            setState((previous) => applyHostBody(previous, body, Date.now()))
          })
          .catch((error) => {
            if (!mounted.current || mine !== generation.current) return
            setState((previous) => reduceError(previous, error))
          })
      }, [])

      React.useEffect(() => {
        mounted.current = true
        load(false)
        const timer = setInterval(() => {
          if (typeof document === 'undefined' || document.visibilityState !== 'hidden') load(false)
        }, POLL_MS)
        const onVisibility = () => {
          if (typeof document === 'undefined' || document.visibilityState === 'visible') load(false)
        }
        const onFocus = () => load(false)
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
        if (typeof window !== 'undefined') window.addEventListener('focus', onFocus)
        return () => {
          mounted.current = false
          generation.current += 1
          clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
          if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus)
        }
      }, [load])

      const rows = state.rows
      const children = [React.createElement('span', { className: 'dshOpencodeUsageTitle', key: 'title' }, 'OpenCode')]
      if (Array.isArray(rows)) {
        for (const row of rows) {
          children.push(
            React.createElement(
              'span',
              { className: 'dshOpencodeUsageRow', key: row.label },
              React.createElement('span', { className: 'dshOpencodeUsageLabel' }, row.label),
              React.createElement('span', { className: 'dshOpencodeUsagePercent' }, row.percentText),
              React.createElement('span', { className: 'dshOpencodeUsageReset' }, row.resetText),
            ),
          )
        }
      } else {
        children.push(
          React.createElement('span', { className: 'dshOpencodeUsageNote', key: 'note' }, noteFor(state)),
        )
      }
      // Optional fourth row: prepaid console credit. The host attaches it only
      // when the billing route accepted the key, so its absence is a hidden
      // row, not an error; the same last-known-good persistence as the usage
      // rows applies (state.credit is null while none is known).
      const creditText = formatCreditDollarsText(state.credit)
      if (creditText !== null) {
        children.push(
          React.createElement(
            'span',
            { className: 'dshOpencodeUsageRow', key: 'credit' },
            React.createElement('span', { className: 'dshOpencodeUsageLabel' }, 'Available credit'),
            React.createElement('span', { className: 'dshOpencodeUsagePercent' }, creditText),
          ),
        )
      }

      return React.createElement(
        'div',
        { className: 'dshOpencodeUsage', 'data-status': state.status, 'data-slot-entry': 'opencode-usage' },
        children,
      )
    }

    /** Services required before the dock entry can register. */
    const inject = ['slots']

    /**
     * Client plugin body: contribute the dock entry.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ensureStyles()
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.composer.dock', () =>
            ctx.slots.register(
              {
                name: 'conversation.composer.dock',
                id: 'opencode-usage',
                // After the session-stats strip, which sits at order 0.
                order: 10,
              },
              UsagePill,
            ),
          ),
        'dsh-plugin-opencode-usage: composer dock entry',
      )
    }

    return {
      apply,
      inject,
      UsagePill,
      applyHostBody,
      readUsage,
      ROUTE,
      POLL_MS,
      initialState,
      reduceError,
      reduceLoading,
      reduceNoKey,
      reduceOk,
      formatUsageRows,
      formatCreditDollarsText,
      normalizeCredit,
      toNormalizedPayload,
      STATE,
    }
  },
})
