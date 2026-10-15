# dsh-plugin-opencode-usage

OpenCode usage in the DSH Web composer dock: rolling, weekly and monthly quota
rows, plus the prepaid console credit, rendered under the chat input.

## Halves

| File | Half | Responsibility |
|---|---|---|
| `lib/index.js` | host | Reads the OpenCode credential and performs the usage and credit requests. The API key exists only here and never crosses to the browser. |
| `lib/client.js` | browser | Renders the dock pill from the usage numbers. |
| `lib/usage.js` | shared, pure | Formats rows and holds the render state machine. No imports at all: no DSH, no React, no network, no credential access. |

The only thing that travels from host to browser is usage/credit NUMBERS:
`{rolling, weekly, monthly}` each `{percent, resetsAt}`, plus the optional
`credit: {availableMicroCents}` (or `credit: null` when the credit row is
hidden). `toNormalizedPayload` whitelists exactly those four and drops every
other field, so nothing credential-shaped can ride along.

## Rows

| Window | Label | `percentText` | `resetText` |
|---|---|---|---|
| rolling | `Rolling usage` | `9% used` | `Resets in 0h 10m` |
| weekly | `Weekly usage` | `17% used` | `Resets in 6d 1h` |
| monthly | `Monthly usage` | `9% used` | `Resets in 30d 13h` |

`resetText` rule: `days >= 1` renders `"<d>d <h>h"`; under a day renders
`"<h>h <m>m"`, so a sub-hour reset is `"0h 10m"` (`0h` is intentional).
An instant already in the past clamps to `0h 0m` rather than going negative.

Optional fourth row when the billing route accepts the key:

| Label | value |
|---|---|
| `Available credit` | `$4.54` |

## Credit row (`Available credit`)

Backed by the console billing API, probed live on 2026-10-15:

```
GET https://opencode.ai/console/api/billing/status        → availableMicroCents
GET https://opencode.ai/console/api/orgs                  → x-org-id for the retry
Authorization: Bearer <the same opencode-go key>
```

- Scale verified against the rendered billing page: **dollars = microCents ÷
  100,000,000** (page showed `$4.54` for `454030592`).
- Flow: a bare bearer attempt first (the key implies one workspace); only on
  `400 org_required` does the host discover the workspace id through
  `/console/api/orgs`, cache it for the process, and retry once.
- ANY failure hides the row (`credit: null`); the usage rows never change. The
  upstream status, whether the endpoint accepts a Bearer API key at all, and the
  org-id timing could not be proven without the real key — all degrade to a
  hidden row at runtime.
- These console routes sit OUTSIDE the `/zen/go/*` surface whose mapping is
  verified in the OpenCode repo (`inference-proxy.ts`); they belong to the newer
  console platform and may change without notice, with the same hidden-row
  degradation.
- Plugin config `credit: false` opts out and makes no billing request at all.

## States

`loading` | `ok` | `no-key` | `error`.

- `no-key` is decided on the host half when no credential is configured. It is a
  normal state, not a failure.
- `error` carries `lastGood` — the last well-formed payload — and keeps its rows
  renderable, so the pill can show stale numbers instead of blanking.
- Nothing in `lib/usage.js` throws for any input. Malformed or absent payloads
  return `null` / `error`, and a payload with a throwing getter is caught too.

## Test

```sh
node test/usage.test.mjs
```

Pure and offline: fixed instants, no network, no credential access.

## Status

Implemented (task-3; credit row added v0.2.0). The plugin is complete and installable:

1. Dock wiring lives in `lib/client.js`, built from `src/client.template.js`.
2. `lib/index.js` reads the credential, calls the usage/billing endpoints,
   caches both for 60s (one cache, both ride the same payload).
3. The host serves numbers on `/plugins/dsh-plugin-opencode-usage/api/usage`;
   `?refresh=1` bypasses the cache.
4. `npm run build` regenerates `lib/client.js`; `npm run check:build` fails when
   the bundle is stale.

```sh
npm test   # check:build + usage + host + client-bundle, all offline
```

The host test injects the transport and a fake credential service, so it never
touches the network or a real key.

## Install

Install (corrected command — `install` is not a pnpm verb; `add` is):

```sh
dsh plugin --profile web add "link:D:/github/dsh-plugins/dsh-plugin-opencode-usage"
```

then reload the page. In this DSH build a NEW plugin hot-loaded without a
server restart; an EXISTING plugin's host-half code change (like this credit
row) is only picked up on the next `dsh web` restart, which also guarantees the
final scrubbing hardening. Uninstall:

```sh
dsh plugin --profile web remove dsh-plugin-opencode-usage
```

`dsh.client.inject` is `["@deepseek-ai/dsh-client-ui-conversation"]` only,
matching `dsh-plugin-dock-collapse` — the other sibling that mounts a
composer-dock entry. Balance's extra entries serve its own client features and
are not needed here.

## Residual risk

`GET https://opencode.ai/zen/go/v1/usage` is official but undocumented, so it may
change without notice. If it returns 401 while a key **is** stored, the state is
reported as `auth` rather than masked — that is the finding to chase, not a pill
bug. The API floors `percent` to a whole integer while the OpenCode dashboard
shows one decimal, so the pill can read up to ~1 point lower by design.

The credit endpoints are even less contractual (undocumented console routes);
their whole failure mode is a hidden row. If the credit row never appears while
usage works, the honest reading is: the console billing API does not accept this
key class on the bare-bearer attempt (or its org requirement needs a
session-bound credential the plugin does not hold).
