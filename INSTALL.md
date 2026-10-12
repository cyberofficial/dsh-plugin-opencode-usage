# Install `dsh-plugin-opencode-usage`

Manual install. Nothing below has been run for you — this machine's DSH server is
the session that produced this file, so it must not be disturbed by an agent.

## 1. Plugin path

```
D:\github\dsh-plugins\dsh-plugin-opencode-usage
```

`lib/client.js` ships prebuilt, so there is no compile step.

## 2. Install command

```powershell
dsh plugin --profile web add "link:D:/github/dsh-plugins/dsh-plugin-opencode-usage"
```

If `dsh` is not recognized in your shell, invoke the built CLI directly:

```powershell
node D:\github\deepseek-harness\apps\cli\lib\bin.js plugin --profile web add "link:D:/github/dsh-plugins/dsh-plugin-opencode-usage"
```

**Use `add`, not `install`.** `dsh plugin` forwards its arguments verbatim to pnpm,
and `pnpm install` accepts no package names — see [Command validation](#6-command-validation).

## 3. Restart `dsh web`

Stop and start `dsh web` as you normally do, then start this GUI again.

Why it is required: the install adds a **profile dependency**, and a profile
dependency change is not hot-reloaded. Until the restart, the new row is not in
the running loader and neither half of the plugin exists in the live process —
the browser bundle will not be served and the host route will not be registered.
A page reload alone is not enough.

## 4. Reload the page

Reload the DSH Web page (hard reload — `Ctrl`+`Shift`+`R`) so the browser picks up
the newly served client bundle.

## 5. Uninstall / revert

```powershell
dsh plugin --profile web remove dsh-plugin-opencode-usage
```

Then restart `dsh web` and reload the page, exactly as in steps 3–4 — removal is
also a profile dependency change. This leaves your stored OpenCode keys untouched;
the plugin never writes a credential, it only reads the ones DSH already holds.

To confirm what the profile currently has (read-only, safe to run any time):

```powershell
dsh plugin --profile web why dsh-plugin-opencode-usage
```

## 6. What "working" looks like

After the restart and reload, a pill appears in the composer dock — the ambient
row under the chat input, below the session-stats strip — reading:

```
OpenCode   Rolling usage  9% used    Resets in 0h 10m
           Weekly usage   17% used   Resets in 6d 1h
           Monthly usage  9% used    Resets in 30d 13h
```

The numbers are yours and will differ; the **format** is what to check:

| Row | Label | Percent | Reset |
|---|---|---|---|
| 5-hour window | `Rolling usage` | `<n>% used` | `Resets in <h>h <m>m` under a day, e.g. `Resets in 0h 10m` |
| weekly window | `Weekly usage` | `<n>% used` | `Resets in <d>d <h>h`, e.g. `Resets in 6d 1h` |
| monthly window | `Monthly usage` | `<n>% used` | `Resets in <d>d <h>h`, e.g. `Resets in 30d 13h` |

`0h` in the rolling row is correct, not a bug: a reset under an hour always shows
`0h <m>m`. The three rows appear as soon as the host answers; the pill refreshes
on mount, when the tab regains focus, and by one 60-second poll, so the countdown
updates on its own.

While it is still loading, or if it has nothing to show, the pill reads
`OpenCode usage…` (loading), `No OpenCode API key` (no key stored for provider
`opencode-go` / `opencode`), or the error message from the host.

### If the pill is absent

1. **Did `dsh web` actually restart after the install?** This is the usual cause —
   without it, neither half is loaded.
2. Hard-reload the page (`Ctrl`+`Shift`+`R`) to drop the cached bundle.
3. Confirm the dependency is really in the profile:
   `dsh plugin --profile web why dsh-plugin-opencode-usage`
4. Ask the host half directly — same origin as the GUI, substitute your port:
   <http://127.0.0.1:3080/plugins/dsh-plugin-opencode-usage/api/usage>
   - `{"status":"ok","payload":{…}}` — the host works, so the problem is the
     browser half or the page cache.
   - `{"status":"no-key",…}` — no key is stored for provider `opencode-go` or
     `opencode`. Add one in Settings > Models.
   - `{"status":"error","error":{"kind":"auth",…}}` — see the residual risk below.
5. In the browser console, the pill element is
   `div.dshOpencodeUsage[data-slot-entry="opencode-usage"]` inside
   `[data-slot="conversation.composer.dock"]`. Its `data-status` attribute carries
   the current state: `loading`, `ok`, `no-key`, or `error`.

## 7. Residual risk

- **The endpoint is official but undocumented.** `GET https://opencode.ai/zen/go/v1/usage`
  is implemented by OpenCode and absent from their docs, so it may change without
  notice. If it stops answering in the expected shape, the pill shows an error
  state rather than breaking the chat UI.
- **A 401 *with* a key present is reported, not masked.** If the pill shows an
  auth error, look for `"kind":"auth"` in the route JSON **first**: that is the
  signal that the key DSH stores for `opencode-go` is not the Bearer token this
  endpoint wants, which is the open question from recon. It is not a pill bug,
  and reporting it is more useful than working around it.
- **Percent can read up to ~1 point lower than the OpenCode dashboard.** The API
  floors `percent` to a whole integer while the dashboard shows one decimal, and
  the response carries no raw usage/limit to recover it. Expected, by design.
- **Not yet proven end to end.** No install was run and the pill has never been
  rendered against the live server — task-3 verified it offline (unit + built-bundle
  tests) and this document for the install path only.

## 8. Command validation

Run read-only while writing this document; nothing was installed or restarted.

`dsh plugin --help` (and `dsh plugin --profile web --help`, which printed the same):

```
Usage: dsh plugin [options] [args...]

manage a profile's plugins by forwarding the remaining arguments to pnpm in the
profile directory

Arguments:
  args              pnpm arguments, forwarded verbatim (add <pkg>, remove <pkg>,
                    why <pkg>, ...)

Options:
  --profile <name>  the profile whose plugins to manage (initialized on first
                    use)
  -h, --help        show this help
```

`pnpm --version` → `12.11.2`; `pnpm install --help` → `Usage: pnpm install [OPTIONS]`;
`pnpm remove --help` → `Usage: pnpm remove [OPTIONS] [PACKAGE_NAMES]...`.

| Command | Status |
|---|---|
| `dsh plugin` subcommand | **VALIDATED** — help output above |
| `--profile <name>` flag | **VALIDATED** — help output above |
| `add <pkg>` / `remove <pkg>` / `why <pkg>` forwarding | **VALIDATED** — help output above |
| `add "link:D:/…"` (the `link:` specifier) | **PARTLY VALIDATED** — `link:` is a standard pnpm protocol and is the form used by the sibling `dsh-plugin-dock-collapse`, but pnpm's help text does not enumerate protocols |
| `install "link:…"` | **REFUTED** — `pnpm install [OPTIONS]` accepts no package names. The earlier recon note and the sibling README's `install "link:$PWD"` would not add the package |
| The install itself, and the pill rendering | **UNVALIDATED** — deliberately not executed |

Package name pairing (this is what the client module host matches on):

```
package.json  "name": "dsh-plugin-opencode-usage"
cordis.patch.yml row   name: dsh-plugin-opencode-usage
```

They match exactly.
