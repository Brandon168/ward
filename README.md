# Ward

A fast, lean browser extension for a self-hosted [Vaultwarden](https://github.com/dani-garcia/vaultwarden)
(or any Bitwarden-compatible) server. The goal is 1Password-style speed and polish on a server you own:
instant search and fill, offline use, Touch ID unlock, and live sync.

Ward is plain JavaScript with no framework, no bundler and no npm dependencies. The files in this repository
are exactly what the browser runs, so a release can be reviewed line by line.

Initial target: **Vivaldi on macOS** (any Chromium browser should work).

## Status

Private, pre-release. See [ROADMAP.md](ROADMAP.md) for what's done and next, and
[docs/security-review.md](docs/security-review.md) for the review of the seed code.

## Install (unpacked)

1. Clone this repository (or download a CI artifact) somewhere permanent.
2. Open `vivaldi://extensions` (or `chrome://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and pick the repository folder (the one that contains `manifest.json`).

The unpacked extension ID is always `nnejaecbmnadljdpinaljbdpfcoocain` (pinned by `key` in `manifest.json`).
Loading from a specific commit means nothing changes until you pull and reload on purpose.

## What it does today

- Logins: search, fill (popup, in-page menu under the login field, Cmd+Shift+L), copy, add, edit, delete
- TOTP codes, passkeys (stored in Bitwarden's format, so the official apps can use them), save/update prompts
- Several vaults in one list (Vaultwarden, bitwarden.com, bitwarden.eu)
- Offline: unlock and fill from an encrypted local copy; syncs when the popup opens (if older than 5 minutes)
- Matching follows Bitwarden's per-URL match setting and equivalent domains, with the Public Suffix List

Secure notes, cards and identities are not shown yet.

## Security model

The master password never leaves the popup. Unlock happens locally against the protected key saved at login.
The vault key and decrypted list live in the browser's memory-only session storage and are gone when you lock or
quit the browser. "Never lock" keeps the key on disk instead (like Bitwarden's Never timeout). Cached vault data on
disk is encrypted. Nothing is filled without a click or the shortcut.

CI enforces guard rails on every change, including upstream cherry-picks: manifest permissions are pinned,
network calls may only go to the configured server (plus well-known passkey endpoints), dynamic code is
forbidden, vendored files must match pinned hashes, and per-page code stays inside a size budget.
See `scripts/guard.mjs`.

## Development

```sh
node test.mjs                       # offline checks
docker run -d --name ward-vw -p 127.0.0.1:8099:80 -e I_REALLY_WANT_VOLATILE_STORAGE=true \
  -e LOGIN_RATELIMIT_MAX_BURST=100 -e LOGIN_RATELIMIT_SECONDS=1 vaultwarden/server:1.37.5
node test.mjs --integration         # against the disposable Vaultwarden above
node scripts/guard.mjs              # security guard rails
./pack.sh                           # dist/ward-<version>.zip
```

## Upstream

Ward is built on [BW Lite](https://github.com/yowmamasita/bw-lite) by Ben Adrian Sarmiento (MIT), seeded from
commit `1d77b9e`. The git remote `upstream` points there (push disabled). A weekly workflow reports new upstream
commits; fixes are cherry-picked on purpose and go through the same CI guards. Small fixes that fit BW Lite's
scope are offered back upstream.

Internal message keys still use the `bwlite` prefix so upstream fixes cherry-pick cleanly.

Not affiliated with Bitwarden, Inc. or the Vaultwarden project. MIT licensed. `vendor/argon2.umd.min.js` is
[hash-wasm](https://github.com/Daninet/hash-wasm) 4.12.0 (MIT). `vendor/public_suffix_list.*` is the
[Public Suffix List](https://publicsuffix.org/list/) (MPL 2.0).
