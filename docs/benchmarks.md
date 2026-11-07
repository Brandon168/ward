# Ward vs the Bitwarden extension: speed, memory and CPU

Measured with [`scripts/bench.mjs`](../scripts/bench.mjs) on 2026-11-07. Raw numbers:
[benchmark-results.json](benchmark-results.json).

| | Ward 0.6.1 | Bitwarden 2026.10.2 |
|---|---:|---:|
| **Popup: open to list** (median of 10) | **75 ms** | 924 ms |
| **Login: "Log in" click to list** (key derivation, login, full sync; 1 run) | **0.6 s** | 4.2 s |
| **Code added to every page** | **23 KB** | 1,834 KB |
| **Script time added per page load** | **+2.6 ms** | +112 ms |
| **Main-thread time added per page load** | **+8 ms** | +179 ms |
| **Browser memory added** (whole browser, idle, unlocked) | **+20 MB** | +127 MB |
| **Extension process memory** (idle, unlocked) | **47 MB** | 131 MB |
| **Background worker JS heap** (after garbage collection) | **1.1 MB** | 19 MB |
| **Popup JS heap** | **5.0 MB** | 46 MB |
| **CPU per popup open** (extension process) | **0.09 s** | 2.3 s |
| **CPU while idle for 2 min** (extension process) | **0.05 s** | 0.13 s |
| **Download size** (unpacked) | **0.9 MB**, 31 files | 89 MB, 200 files |

As an image: [light](ward-vs-bitwarden-light.png), [dark](ward-vs-bitwarden-dark.png)
(`node scripts/compare-image.mjs`, from [benchmark-results.json](benchmark-results.json)).

"Added" figures are compared with the same browser with no extension (page script time 0 ms, main-thread time
24.8 ms per load, browser memory 458 MB).

## Attack surface

Read from each extension's `manifest.json` and shipped files (`surface` in benchmark-results.json).

| | Ward | Bitwarden |
|---|---|---|
| Browser permissions requested | **9** | 16 + 2 optional |
| Files any website can load from the extension (`web_accessible_resources`) | **0** | 8 |
| Runs inside local files (`file://`) | **No** | Yes |
| Code injected into every page | **23 KB** | 1,834 KB |
| What ships | **Its readable source, no build step, plus 1 vendored library** (hash-wasm, checked against npm in CI) | 33 MB of minified JS and WebAssembly (built from open source) |

Bitwarden has independent security audits; Ward has had its own reviews ([security-review.md](security-review.md)).
Less code is not proof of safety, but it is less to attack and less to review.

## Setup

- One throwaway [Vaultwarden](https://github.com/dani-garcia/vaultwarden) 1.37.5 account (PBKDF2, 600,000 iterations)
  with 500 logins, behind a local TLS proxy (Bitwarden only accepts https servers). Every other host is blocked, so
  neither extension reaches the internet.
- Chromium 151 headless (Debian), a fresh profile per extension, one extension at a time. Each extension is logged
  in through its own UI. Machine: a 4-vCPU Linux VM, so absolute numbers are slower than a laptop and somewhat noisy.
  The ratios are the point.
- **Popup**: the extension's popup page opened in a tab (headless Chromium has no toolbar), timed from navigation
  to the first rows of the vault list, vault unlocked.
- **Per page**: a plain sign-in page (email and password field), loaded 10 times. "Code added" is every script the
  extension parsed in that page; script and main-thread time come from Chromium's performance counters.
- **Memory**: proportional set size (PSS) from `/proc`, median of samples every 10 s during 2 idle minutes with the
  vault unlocked. CPU is user + system time from `/proc`.

## What this does and doesn't say

- Bitwarden does more: a password generator, Send, an inline autofill menu with many more form heuristics, SSO,
  organisations, and more. Part of its weight is features Ward doesn't have. Ward's aim is to do the everyday things
  (search, fill, copy, save) with as little as possible on every page and in the background.
- One machine, one run. Expect different absolute numbers on yours; rerun it to check.

## Reproduce

```sh
docker run -d --name ward-vw -p 127.0.0.1:8099:80 -e I_REALLY_WANT_VOLATILE_STORAGE=true \
  -e LOGIN_RATELIMIT_MAX_BURST=100 -e LOGIN_RATELIMIT_SECONDS=1 vaultwarden/server:1.37.5
# The Chrome Web Store build of Bitwarden, unpacked into its own folder
mkdir -p ~/bitwarden-ext && curl -sSL -o ~/bitwarden.crx 'https://clients2.google.com/service/update2/crx?response=redirect&prodversion=151.0&acceptformat=crx2,crx3&x=id%3Dnngceckbapebfimnlniiiahkandclblb%26uc'
(cd ~/bitwarden-ext && unzip -q ../bitwarden.crx)   # warns about the CRX header; that's fine
node scripts/bench.mjs --bitwarden ~/bitwarden-ext     # about 15 minutes; CHROMIUM=/path/to/chromium if needed
```

Options: `--items 500`, `--runs 10`, `--idle 120` (seconds), `--only ward|bitwarden|none`, `--debug` (screenshots
in `bench/`). Restart the Vaultwarden container between runs if registration starts returning 429.
