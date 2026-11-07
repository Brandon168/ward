# Security review of the seed (BW Lite 1d77b9e)

Independent read-only review, 2026-11-06, of every shipped file. Each claim below was re-checked against the code
before fixing. Status reflects the current `main`.

## Sound (checked, no change needed)

- **Network:** only `fetch` to the configured server (bitwarden.com/.eu map to their api/identity hosts) and the
  passkey `.well-known/webauthn` lookup. No URLs come from server data. No XHR, WebSocket, beacon or telemetry.
  Now pinned by `scripts/guard.mjs`.
- **Crypto:** only EncString type 2 (AES-CBC + HMAC-SHA256), MAC verified with constant-time `subtle.verify`
  before decrypting. Type 4 (RSA-OAEP) is used only for org keys. HKDF-Expand stretch, Argon2 salt, per-item keys,
  CSPRNG IVs, password generation (~121 bits) and TOTP bounds are correct.
- **Page boundary:** no `externally_connectable`, no `web_accessible_resources`, no `onMessageExternal`. Session
  storage stays trusted-only. `bridge.js` copies allow-listed fields only. Passkey origin comes from
  `sender.origin`; the rpId must be the host or a registrable parent, never a public suffix.
- **Filling:** always needs a user action. Frames are re-checked from the content-script side by `documentIds`.
  The login is chosen from the top-level URL, so a bank iframe inside evil.com is never filled.
- **XSS:** no `innerHTML`/eval/`new Function`. The `h()` helper sets properties and text nodes. In-page UI uses
  closed shadow roots. CSP `script-src 'self' 'wasm-unsafe-eval'`.
- **Lock/remove:** drops `persistKey` before clearing session storage, under one Web Lock, with version checks.
- **Vendor:** `vendor/argon2.umd.min.js` is byte-identical to `hash-wasm@4.12.0` `dist/argon2.umd.min.js` on npm
  (SHA-256 `dcec617a…3094`; checked in CI on every run). Its WASM is instantiated with an empty import object.

## Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| H1 | High | Server-chosen KDF parameters were used without bounds, so a hostile or spoofed server could ask for 1 PBKDF2 iteration and crack the captured password hash offline | **Fixed**: `bw.checkKdf` (PBKDF2 100k–2M, Argon2id 2–10 passes, 16–1024 MiB, parallelism 1–16) at login and unlock; `bw.kdfWeaker` refuses a weaker KDF on re-login to a known vault |
| H2 | High | https logins matched http pages (domain/host match ignored scheme), so an on-path attacker could inject `http://x.bank.com` and have the bank login offered there | **Fixed**: plain-http pages only match URIs saved with explicit `http://`, or schemeless local hosts (IPs, localhost, .local/.lan/.home.arpa/.internal) |
| M1 | Medium | In-page menu opened on script-made focus, and the decoy check could be bypassed (`filter: opacity(0)`, `pointer-events:none` overlay) | **Fixed**: opens only after a trusted pointer press on the field (or its label) or Tab/arrow key; a click fills only if IntersectionObserver v2 reports the menu visible and unoccluded, the menu was shown ≥400 ms, and computed styles don't hide it |
| M2 | Medium | Save prompt let a page test password guesses (scripted submits; no offer when the guess equals the saved password) | **Mitigated**: capture needs `navigator.userActivation.isActive` and trusted Enter, and is limited to one per 2 s, so each guess costs a real user action |
| M3 | Medium | `http://` server URLs accepted | **Fixed** for new logins: https required except localhost/127.x/[::1]. Existing accounts are not touched |
| M4 | Medium | Server-controlled equivalent domains, per-URI match types and org keys can route a real password to another site without breaking crypto | **Open**. Plan: ship the global equivalent-domain list, confirm server custom equivalents locally, flag match-type changes without a revision change, label org logins |
| M5 | Medium | No auto-lock; clipboard never cleared | **Auto-lock fixed**: `chrome.idle` locks on screen lock/sleep and after 5/15/30/60/240 min idle (default 30), unless Never lock. **Clipboard clear open** (needs an offscreen document) |
| M6 | Medium | "Never lock" stores the raw vault key on disk | **Open**: to be replaced by Touch ID (WebAuthn PRF-wrapped key). Until then the option stays, with its warning |
| L1 | Low | "Starts with" match compared raw strings (`https://bank.com` matched `https://bank.com.evil.net`) | **Fixed**: origin must match first |
| L2 | Low | Regex match type can hang the service worker with a catastrophic pattern | Open |
| L3 | Low | A page could make Ward fetch `https://<any host or IP>/.well-known/webauthn` before any vault check | **Fixed**: vault check first; IP and dotless rpIds never fetched |
| L4 | Low | Passkey windows can open without a user gesture; UV flag always set; re-prompt ignored for passkeys | Open |
| L5 | Low | Save window doesn't name the site or target login | **Fixed** (0.4.4): the title names the site; the row shows the login to save or update |
| L6 | Low | Firefox fallback could answer a passkey to a navigated frame | Open (Firefox is not a target yet) |
| L7 | Low | Logout doesn't revoke the refresh token | Open (same as common Bitwarden practice) |
| Info | | Every https page sees a platform authenticator (extension detectable); upstream extension key | Key replaced with Ward's own |

## Passkey autofill (0.7.0)

- `page.js` no longer passes `mediation: 'conditional'` sign-in requests straight to the browser. They take the same
  path as other passkey requests (`bridge.js` allowlist, `validPasskeyOptions`, rpId from `sender.origin`, vault check
  before any `.well-known/webauthn` fetch), plus: top frame only, and held only when Settings → Passkeys is on and
  Ward's menu would show on the page (an open vault has a matching passkey or a login for the site). Otherwise,
  after 5 s without an answer, or when the extension is gone, the browser gets the request unchanged.
- The held request (`cpk:<tab>` in session storage) is bound to the tab, the document (`documentId`) and the origin.
  Only the menu of that document's top frame gets passkey rows or can pick one; a pick re-checks that the vault key
  and state did not change while signing, answers once and goes to that document only. Child frames and other
  documents get nothing.
- The click goes through the same `genuine()` check as Fill (trusted event, IntersectionObserver v2 visibility, 400 ms,
  untouched menu). The assertion is bound to the page's origin and rpId, so it is worth no more to the page than the
  password Fill would give it. As in the passkey window (L4), the UV flag means "unlocked vault plus this click";
  re-prompt logins are not offered in the menu.
- The page's AbortSignal ends the request in Ward too (`wardCondEnd`, accepted only from that document). A held
  request Ward has nothing left to show for (vault locked, setting off) is handed back to the browser the next time
  the menu opens. "Use device or security key" hands it to the browser as a modal request; if that is cancelled,
  Ward holds it again.
- Known, accepted: the page can tell whether Ward held its request (Ward's answer passes through the page's own
  window messages), so a site can learn that this browser's Ward has a passkey or login for that same site. The modal path
  already shows the same thing (Ward's window vs the browser's prompt), and every page can see Ward is installed (Info).

## Speed work that touches matching (0.6.1)

- Base domains for saved URIs are computed by `decryptVault` and stored with the cached list (`d`), tagged with the
  Public Suffix List version (`dv`). Matching uses them only when the tag is the current list's and there is one per
  URI; otherwise it recomputes. BW Lite once stored derived domains made without the suffix list and stopped
  trusting them (480efd3); untagged ones, like those, are still never used. They live in the same trusted storage as
  the URIs themselves, so they add no new way to influence matching.
- `domainOf`/`normalizeHost` skip `URL` for plain ASCII hosts that `URL` would only lowercase (no punycode, no
  numeric last label, no port or user info); `test.mjs` checks the result equals `URL`'s on tricky and 30,000 random
  inputs.
- `vendor/public_suffix_list.js` is generated in lookup form by `vendor/psl.sh`; `test.mjs` checks it against the
  `.dat`.

## Two-step login (0.6.0)

No new permissions. Ward now finishes logins that need an email code, a YubiKey OTP or a security key, besides an
authenticator app (Duo is refused with a pointer to the web vault).

- **A login waiting for its second step** is kept in session storage (`twostep`) so the popup can close while you read
  an email or touch a key. It holds the server password hash and the stretched master key (what opens the vault key),
  never the password; that is no more than the vault key Ward already keeps there. Session storage is memory only and
  trusted contexts only (content scripts can't read it); the entry expires after 10 minutes and is removed on
  success, Cancel, and by any lock.
- **Security keys** are registered for the vault server's own address, so the prompt can't run on an extension page.
  The service worker opens a small window on the server (`/alive`), waits for it to load, refuses if it ended up on
  another origin, and runs `twostep.js` there in Ward's isolated world: the page's own scripts can't see or change the
  challenge or the answer. Only https servers (or localhost) qualify. Only Ward's own extension pages can start it.
  The answer goes back into `twostep`, and the popup sends it as the two-step token.
- **Email codes** are requested explicitly (`/two-factor/send-email-login` with the password hash, as the web vault
  does); Vaultwarden doesn't send them on its own.
- The "remember this device" token works as before for every method.

Tests: `test.mjs` (bw.js parsing and requests, the popup flow, the key prompt in a sandbox), the email method against
Vaultwarden + Mailpit in CI, and `scripts/e2e-twostep.mjs` (Ward's real popup and service worker in Chromium with a
virtual authenticator).

## Clipboard and right-click menu (0.4.0)

New permissions: `contextMenus` (the Ward menu on page fields), `offscreen` and `clipboardWrite` (the service worker
copies from the menu and clears the clipboard through a short-lived offscreen document). The menu lists only this
site's logins that don't require a master-password re-prompt, and every click re-checks that the login still matches
the tab's page before filling or copying. Only Ward's own pages (no tab) can ask for a clipboard clear. The clear is
unconditional after 30 s (Ward has no clipboard-read permission), so it is a setting.

## Card and address capture (0.3.0)

Design constraints, all covered by tests: only values from trusted input/change events (`bwliteTyped`, shared by
inpage.js and formfill.js in the extension's isolated world) are captured; capture starts only after typing into a
card/address-looking field on an https page; card values are accepted only from same-site or known payment-provider
frames, identity values only from same-site frames; drafts are memory-only (session storage), merged per tab, offered
once after a submit, dropped after 15 min, on tab close and on lock; nothing is saved without Save in the extension's
own window, and the security code is unticked by default. A page can learn whether a card it saw you type is already
saved (the bar appears or not); it already saw the number.

## Second review: Ward's own changes (2026-11-06)

A second independent review covered everything changed since the seed (`1d77b9e..HEAD`). It found no deadlocks,
and no way for background sync or Touch ID to reopen a locked or removed vault.

| ID | Severity | Finding | Status |
|---|---|---|---|
| W-H1 | High | `hasInvocation` hung on a crafted varint (sign wrap, so the loop ran from about -2^31), freezing the service worker, auto-lock included | **Fixed**: arithmetic varint, at most 5 bytes, every frame must fit; regression tests |
| W-M1 | Medium | Locking while a live connection was still fetching its token leaked a socket | **Fixed**: `closed` is checked after the await |
| W-M2 | Medium | A slow background sync could overwrite a newer list stored meanwhile | **Fixed**: skipped if the session list changed during the download |
| W-M3 | Medium | Every background sync rewrote storage even when nothing changed (cache and badge churn) | **Fixed**: an unchanged list only records a session-storage timestamp |
| W-M4 | Medium | The popup and the service worker can each refresh the same token | **Mitigated**: the worker refreshes 5 min early under a per-account lock. The popup still uses `bw.api`; Vaultwarden reuses refresh tokens, so impact is low. Open |
| W-M5 | Medium | After 400 ms the page could move the menu under the cursor | **Fixed**: a MutationObserver closes the menu on any attribute change, and the click re-checks the menu's position |
| W-L1 | Low | Early or unconfirmed clicks closed the menu | **Fixed**: they are ignored instead |
| W-L2/L3 | Low | Wrapped labels didn't count as a press on the field; arrow keys let the page pop the menu | **Fixed**: label ancestors count; only Tab counts as keyboard focus |
| W-L4 | Low | The save oracle stayed open while the user typed; incidental buttons dropped the real submit | **Fixed**: only passwords typed via trusted input are offered; identical values are deduplicated instead of rate-limited |
| W-L5/L6 | Low | Re-enrolling Touch ID reset the 14-day password timer; a stale record could be written back | **Fixed**: one `passwordAt` timestamp, set only by login or password unlock; the Touch ID record is never rewritten |
| W-L7 | Low | Related-origin fetches could still target LAN names | **Fixed**: IPs, single-label and local suffixes are refused |
| W-L8/L9 | Low | No reconnect backoff; concurrent hub refreshes could race | **Fixed**: 1→30 min backoff, an expired session stops reconnecting until the next unlock; refreshes are serialized |
| W-L10 | Low | The http gate drops regex URIs and single-label intranet hosts on http pages | Accepted (save those with an explicit `http://`) |
| W-L11 | Info | A synced passkey provider syncs the PRF secret too | Documented in `touch.js` |
