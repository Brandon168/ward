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
| L5 | Low | Save window doesn't name the site or target login | Open |
| L6 | Low | Firefox fallback could answer a passkey to a navigated frame | Open (Firefox is not a target yet) |
| L7 | Low | Logout doesn't revoke the refresh token | Open (same as common Bitwarden practice) |
| Info | | Every https page sees a platform authenticator (extension detectable); upstream extension key | Key replaced with Ward's own |
