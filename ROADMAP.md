# Roadmap

## Done (2026-11-06)
- Seeded from BW Lite 1d77b9e; own extension ID, name, icon
- CI: guard rails (`scripts/guard.mjs`: permissions, network call sites, URL literals, dynamic code, vendor
  hashes, size budgets), vendored argon2 checked byte-for-byte against npm, Actions pinned by SHA,
  Vaultwarden 1.37.5 integration tests, weekly upstream-watch issue
- Security review of the seed (docs/security-review.md); fixed H1, H2, M1, M3, M5 (auto-lock), L1, L3; mitigated M2
- Auto-lock on screen lock/sleep and after idle
- Touch ID unlock (experimental, WebAuthn PRF), with in-window diagnostics
- Background sync every 5 min and live sync over Vaultwarden's notification hub
- Cards, identities and secure notes: browse, edit, copy, fill checkout and address forms (0.2.0)
- Save offers for typed cards and addresses after a submit; "from page" (0.3.0)
- Settings switches for save offers (0.3.1)
- New UI (option E, inline icons): one list, selection rule, one-click copy; right-click menu; clipboard clearing;
  Settings > Account / Copying / Appearance (0.4.0)
- One-time code button shows only a countdown pie (red for the last 5 s), no digits (0.4.1)
- The in-page login menu and save bar match the popup: system font, letter avatars, name over username (0.4.2)
- Fix: no more console error on every click on pages without a password field (0.4.3)
- The passkey and save windows match the popup: Ward bar, a title that names the site, account rows with avatars (0.4.4)
- Generator: passwords with options, passphrases (EFF word list), usernames; remembered options; Use from the login form (0.5.0)
- Two-step login: email codes, YubiKey, security keys/passkeys (window on the server), method picker, resumes after the popup closes (0.6.0)
- Speed: search ~15x less work per keystroke, in-page menu 3x faster, popup paints ~40% sooner; docs/performance.md (0.6.1)
- Passkey autofill: Ward answers a site's passkey autofill request from its own menu under the field (passkeys first,
  one click signs in, "Use device or security key" hands it to the browser); honours the site's abort; setting (0.7.0)

## Next
1. Touch ID works on macOS (Vivaldi, WebAuthn PRF). Polish: prompt automatically when the popup opens locked, cover
   vaults unlocked later, and name the button for the platform ("Windows Hello" on Windows). Try Windows Hello
   (Windows 11 25H2 and Chrome 147 or newer are needed for PRF).
2. Offline edit queue (edits made offline are sent on reconnect; the server's `lastKnownRevisionDate` refuses
   conflicts).
3. Security review leftovers: M4 (server-controlled equivalent domains and match types), L2, L4, L5, M6
   (replace Never lock with Touch ID).
4. Cards and identities: in-page menu on card/address fields; custom fields; card fill in more payment
   providers' frames as they turn up.
5. Browser behaviour test in CI: headless Chromium with the extension, a local https test site and an
   egress-logging proxy that fails on any request to an unexpected host.
6. Faster per-page code: a tiny loader that pulls in the menu only when a login field appears.
