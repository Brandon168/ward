# Performance

Ward should feel instant. `scripts/perf.mjs` measures the moments a user feels, in headless Chromium against a
throwaway Vaultwarden with a 2,000-item vault: the real toolbar popup opened over a sign-in page that has a saved
login, each search keystroke, the in-page menu after a click (with the service worker awake and asleep), Fill from
that menu, and unlocking.

```sh
docker run -d --name ward-vw -p 127.0.0.1:8099:80 -e I_REALLY_WANT_VOLATILE_STORAGE=true \
  -e LOGIN_RATELIMIT_MAX_BURST=1000 -e LOGIN_RATELIMIT_SECONDS=1 vaultwarden/server:1.37.5
node scripts/perf.mjs --items 2000 --runs 9      # results in bench/perf-2000.json (about 6 minutes)
```

## Results (0.6.1, 2026-11-07)

0.6.0 and 0.6.1 measured back to back on the same 4-vCPU Linux VM. A laptop is several times faster in absolute terms.

| | 0.6.0 | 0.6.1 |
|---|---:|---:|
| Search: work per keystroke (script + layout), worst | 76–110 ms, 151 ms | **5.5 ms, 9 ms** |
| In-page menu after a click, service worker awake | 52 ms | **16 ms** |
| In-page menu, service worker asleep (it starts) | 188 ms | **86 ms** |
| Fill from the in-page menu | 8.8 ms | **8.5 ms** |
| Popup: list in the page, from the popup's start | 150 ms | **79 ms** |
| Popup: first paint, from the popup's start | 172 ms | **104 ms** |
| Popup: click to first paint (an empty popup: ~320 ms) | 445 ms | **374 ms** |
| Elements in the popup | 944 | **204** |
| Unlock with the master password (600,000 PBKDF2 iterations) | 142 ms | 142 ms |

Most of a popup open is now the browser's: creating the popup takes ~265 ms on this machine before any of Ward's
code runs, and an empty extension popup paints 52 ms after it starts. Ward adds about 50 ms on top: loading its
modules (~17 ms, mostly bytes: `bw.js` and the suffix list), storage and the startup lock (~14 ms), and drawing.

## What made the difference

- **Matching a page against the vault** no longer parses every saved URL: base domains are worked out when the vault
  is decrypted and stored with each cached login (tagged with the suffix list version; anything else is recomputed),
  the page is parsed once per lookup, plain `https://host/` URLs skip `URL` (fuzz-tested against it), and lookups
  are cached. Equivalent-domain groups are stored as base domains at sync.
- **The Public Suffix List** ships in lookup form (ASCII, split by rule kind) and is built on first use: from
  ~7–14 ms per popup or worker start to ~2 ms.
- **The list** draws 30 rows, then more as you scroll; a row's buttons are built when it is hovered or selected.
  This site's logins, recent items and search text are worked out once per view, not per keystroke.
- **Startup** reads only what it needs inside the startup lock, and creates `Intl.Collator` (locale data, ~9 ms in a
  fresh service worker) and the generator's word list only when they're used.

## Tried and dropped (measured)

- `<link rel="modulepreload">` for the popup's modules: no gain (A/B, 10 rounds).
- Loading the generator and its word list only when opened: ~3.5 ms, but needs a dynamic `import()` exception in the
  guard rails. Not worth it.
- Splitting the suffix list out of the startup path: it's needed to find this site's logins, which the popup shows first.

## Budgets for changes

Run `scripts/perf.mjs` before and after a change to the popup's start, the list, matching (`bw.js`), or the service
worker's menu path. On the reference VM: a search keystroke stays under 8 ms of work, the warm in-page menu under
20 ms, and the popup's first paint doesn't move by more than a few ms. A regression needs a reason in the commit.
