# dsh-plugin-opencode-usage

OpenCode usage in the DSH Web composer dock: rolling, weekly and monthly quota
rows rendered under the chat input.

## Halves

| File | Half | Responsibility |
|---|---|---|
| `lib/index.js` | host | Reads the OpenCode credential and performs the usage request. The API key exists only here and never crosses to the browser. |
| `lib/client.js` | browser | Renders the dock pill from the usage numbers. |
| `lib/usage.js` | shared, pure | Formats rows and holds the render state machine. No imports at all: no DSH, no React, no network, no credential access. |

The only thing that travels from host to browser is the usage numbers:
`{rolling, weekly, monthly}`, each `{percent, resetsAt}`. `toNormalizedPayload`
copies those three windows and drops every other field, so nothing
credential-shaped can ride along.

## Rows

| Window | Label | `percentText` | `resetText` |
|---|---|---|---|
| rolling | `Rolling usage` | `9% used` | `Resets in 0h 10m` |
| weekly | `Weekly usage` | `17% used` | `Resets in 6d 1h` |
| monthly | `Monthly usage` | `9% used` | `Resets in 30d 13h` |

`resetText` rule: `days >= 1` renders `"<d>d <h>h"`; under a day renders
`"<h>h <m>m"`, so a sub-hour reset is `"0h 10m"` (`0h` is intentional).
An instant already in the past clamps to `0h 0m` rather than going negative.

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

Implemented (task-3). The plugin is complete and installable:

1. Dock wiring lives in `lib/client.js`, built from `src/client.template.js`.
2. `lib/index.js` reads the credential, calls the usage endpoint, caches for 60s.
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

The same way sibling plugins are installed:

```sh
dsh plugin --profile web install "link:<absolute path to this directory>"
```

then restart `dsh web` (a profile dependency change is not hot-reloaded) and
reload the page. This directory is **not installed yet** — installing and
enabling it against the live server is task-6.

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
