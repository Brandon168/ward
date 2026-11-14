# Testing Ward by hand

The automated checks are in `test.mjs` (see the README). This checklist covers what they can't: the real browser UI.
It was written on Vivaldi on macOS; in Chrome use `chrome://extensions`, and on Windows or Linux read Cmd as Ctrl.

Use a **throwaway Vaultwarden account** first (create one in your server's web vault, here `https://vault.example.com`),
with a few copied logins. Switch to your real account once this checklist passes.

## Install

```sh
git clone https://github.com/Brandon168/ward.git ~/ward   # or: cd ~/ward && git pull
```

1. `vivaldi://extensions` → turn on **Developer mode** → **Load unpacked** → pick `~/ward`.
2. Check the ID is `nnejaecbmnadljdpinaljbdpfcoocain`.
3. Pin Ward to the toolbar. If Cmd+Shift+L does nothing, the browser's own shortcut may win: set it in
   `vivaldi://extensions/shortcuts` (or change the browser's conflicting keyboard shortcut).
4. To keep testing the official Bitwarden extension side by side, leave it installed but turn off its
   autofill/inline menu, so you know which one filled.

After `git pull`, click the reload arrow on Ward's card in `vivaldi://extensions`.

## Checklist

1. **Log in**: server `https://vault.example.com`. An `http://` address must be refused.
2. **Speed**: open the popup on a site with a saved login. Note how long until the list shows, compared with Bitwarden.
3. **Fill**: popup Fill; Cmd+Shift+L; click into the username field and pick from the menu under it.
   - The menu should NOT appear when the page focuses the field by itself (no click/Tab from you).
   - It should look like the popup: rounded, system font, letter avatars, item name over the username; light/dark
     follows the system (Settings > Appearance applies to the popup only).
4. **Save**: sign in somewhere with a new password → "Ward found a login to save" → Review save.
5. **Offline**: turn Wi-Fi off, lock (lock button), unlock with the master password, fill. Turn Wi-Fi back on.
6. **Live sync**: with Ward unlocked, change a password for a login on your phone or in the web vault.
   Within a few seconds the popup (reopened) shows the new password, without pressing sync.
7. **Auto-lock**: Settings (popup footer) → Locking, try "5 min idle", then lock the screen (macOS: Ctrl+Cmd+Q; Windows: Win+L): Ward
   should be locked when you come back.
8. **Touch ID (experimental)**: Settings → Touch ID… → Set up Touch ID. A small window opens and asks for Touch ID
   (maybe twice; on Windows, Windows Hello). Then lock and use **Unlock with Touch ID**.
   - If it fails, press **Copy report** and include it in an issue: it says whether the browser and authenticator
     support WebAuthn PRF for extensions.
9. **Passkeys**: optional; sign in to a site with a passkey stored in your vault. Ward's window says "Sign in to <site>"
   and lists your passkeys for it; **Sign in** answers, **Use device or security key** hands the request to the browser.
   - **Passkey autofill (0.7.0)**: on a site that offers passkeys on its username field (e.g. a site where you saved a
     passkey with Ward), click the username field: Ward's menu shows "Passkey · <you>" first, with no browser
     passkey list on top. Click it: you are signed in, no window. **Use device or security key** at the bottom opens
     the browser's prompt (phone, security key); cancel it and click the field again: Ward's passkey is back.
   - On a site where Ward has only passwords and the passkey is in the browser or on your phone (e.g. chase.com):
     only Ward's menu shows; **Use device or security key** opens the browser's prompt with that passkey.
   - The site's own "sign in with passkey" button still opens Ward's window. Lock Ward and click the field again: the
     browser's passkey list shows instead. Settings → Passkeys off: the browser's list, as before 0.7.0.
10. **Cards / Identities / Notes** (tabs under the toolbar):
    - Add a test card (e.g. `4111 1111 1111 1111`, any future expiry, `123`) and an identity; open a secure note.
    - On a real checkout page, open Ward (it opens on Cards when the page looks like checkout and has no logins),
      press **Fill**: number, name, expiry (dropdowns or `MM/YY`) and security code should fill, including Stripe's
      embedded card box. Don't submit anything.
    - On a shipping/address form, Fill an identity: name, address lines, city, state (dropdown), ZIP, country, phone, email.
    - Items set to "Master password re-prompt" in Bitwarden ask for it before Fill or copying the number/code.
11. **Saving cards and addresses**:
    - On a checkout/address form, type a test card and an address yourself, then submit (a test/sandbox shop, or a
      form that fails safely). Ward's bar says "Ward found a card and an address to save" → Review save → both
      ticked, security code unticked → Save. They appear under Cards / Identities.
    - Submitting the same card/address again offers nothing. Values a page fills in by itself are never offered.
    - **from page** (Cards/Identities tab, on a page with the form filled in) opens a pre-filled new item to review.
12. **Settings → Saving**: turn off "Offer to save cards and addresses" and repeat 11: no bar appears. Turn off
    "Offer to save new and changed logins" and sign in somewhere new: no bar. Sites you pressed **Never** on are
    listed there and can be removed.
13. **New list (0.4.0)**: on github.com (or any site with a login) the site's login is selected with its icons
    visible; click 👤/🔑/code to copy (the icon turns into ✓), Fill to fill. Click another row: it becomes selected,
    nothing is filled. Hover any row for its icons. Copy a password, wait 30 s, paste: empty. The code button is a pie with no
    digits; it empties as the code runs out and turns red for the last 5 s. In a long vault, scrolling to the end of
    the list (or arrowing past the last row) draws the next rows; typing in the search stays instant.
14. **Right-click** a username or password field: Ward → your login → Fill / Copy ….
15. **Settings → Account → Log out** removes the vault (asks "Sure?" first). **Appearance** follows the system unless set.
16. **Generator (0.5.0)**: the dice button in the toolbar → Password: change the length and sets; New gives another;
    Copy, wait 30 s, paste: empty. Passphrase: 5 words by default, separator and Capitalize apply. Username: random word,
    Email with a +tag (defaults to your vault email), Catch-all (asks for a domain). Close and reopen: your choices
    are kept. In Add login, Gen fills with those settings; the dice next to Password or Username opens the generator
    and Use puts the value back into the form.

17. **Two-step login (0.6.0)**: on a test account, turn on email or a security key in the web vault (Settings →
    Security → Two-step login), then add the vault in Ward. Email: "Enter the code sent to …"; close the popup, get the
    code from your mail, reopen Ward: it is still waiting; enter it. Security key: Use security key opens a small window
    on your server with the browser's prompt; touch the key; the window closes and Ward opens the vault. "Or use"
    switches between the methods the account has. Cancel goes back to the login form.

18. **Match detection (0.7.1)**: save logins for two subdomains of one site (a.example.com, b.example.com). On
    a.example.com both are offered (base domain). Settings → Matching → Host: only a.example.com's login is offered
    there. Edit b.example.com's login, set its URL to Base domain, save: it is offered on a.example.com again, and the
    web vault shows the same match detection. Add URL adds a row, × removes one; an invalid regular expression is
    refused on Save.

19. **Item details and custom fields (0.8.0)**: select a login and press › (or Enter on an item Ward can't fill here):
    every value shows without the edit form. Password, one-time code and hidden fields read •••• until the eye (or a
    click on the dots) shows them; each copy button turns ✓, and a copied password or hidden field is cleared after
    30 s. The launch icon opens the website in a new tab. Edit opens the form; Cancel comes back to the details, Save
    comes back with the new values. In the form, Add field: name, kind (Text, Hidden, Checkbox, Linked) and value;
    save, then check the web vault (or the Bitwarden app) shows the same fields. Remove one with ×. Do the same on a
    card, an identity and a note. An item shared with "Hide passwords" shows its hidden fields as "Hidden by your
    organization" and an edit keeps them.

20. **Locked menu and window placement (0.7.4)**: lock Ward, click a login field: the menu shows "Ward is
    locked" (no logins, no usernames); clicking it opens Ward's popup (or a small Ward window) to unlock. With no
    vault added it says "Sign in to Ward". Unlocked again, the field shows the logins as before. Start a passkey
    sign-in or a save offer: Ward's window opens at the top right of the browser window, not the screen's corner;
    with the browser window across two displays it still opens (where Chrome puts it).
    Unlock with Touch ID from there (0.7.5): close the popup at once and click the field: the logins show, not "Ward
    is locked".

21. **Item details in a window (0.8.1)**: open a login's details and press the window button at the top right: a Ward
    window opens with the same details (brand bar, Edit and Close, no Fill), titled with its name ("GitHub · Ward") in
    the window switcher, and the popup closes. Copy the username, click into a page and paste, switch back (Alt+Tab or
    Cmd+\`) and copy the password: the window is still there. The launch icon opens the site in the browser window and
    the Ward window stays. Edit the login in the toolbar popup (or let a sync change it): the window shows the new
    values. Move the window, close it, open another: it opens where you left it. Lock Ward (or let it auto-lock): the
    window closes. A re-prompt login asks for the master password in the popup only, not again in the window. Reloading
    the window closes it.

### Automated two-step checks

- Email: run Vaultwarden with mail going to [Mailpit](https://mailpit.axllent.org/) and pass `MAILPIT`:

  ```sh
  docker network create ward-test
  docker run -d --name ward-mail --network ward-test -p 127.0.0.1:8025:8025 axllent/mailpit:v1.33.0
  docker run -d --name ward-vw --network ward-test -p 127.0.0.1:8099:80 -e I_REALLY_WANT_VOLATILE_STORAGE=true \
    -e LOGIN_RATELIMIT_MAX_BURST=100 -e LOGIN_RATELIMIT_SECONDS=1 -e DOMAIN=https://vault.test \
    -e SMTP_HOST=ward-mail -e SMTP_PORT=1025 -e SMTP_SECURITY=off -e SMTP_FROM=vault@vault.test vaultwarden/server:1.37.5
  MAILPIT=http://localhost:8025 node test.mjs --integration
  ```
- Security key: with that container (`DOMAIN=https://vault.test` matters), `node scripts/e2e-twostep.mjs` logs in through
  Ward's real popup in headless Chromium with a virtual authenticator.
- Passkey autofill: with the same container, `node scripts/e2e-passkey.mjs` signs in on a test page from Ward's in-page
  menu (and checks the signature), checks the page's abort and "Use device or security key" (a virtual authenticator).

## What's not there yet

No in-page menu for card fields yet (use the popup). Touch ID covers the vaults that were open when you set it up.
See ROADMAP.md.
