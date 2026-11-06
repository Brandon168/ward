# Testing Ward in Vivaldi (macOS)

Use a **throwaway Vaultwarden account** first (create one in the web vault at https://vault.example.com, or use
an existing test account), with a few copied logins. Switch to your real account once this checklist passes.

## Install

```sh
git clone git@github.com:Brandon168/ward.git ~/ward   # or: cd ~/ward && git pull
```

1. `vivaldi://extensions` → turn on **Developer mode** → **Load unpacked** → pick `~/ward`.
2. Check the ID is `nnejaecbmnadljdpinaljbdpfcoocain`.
3. Pin Ward to the toolbar. If Cmd+Shift+L does nothing, Vivaldi's own shortcut may win: set it in
   `vivaldi://extensions/shortcuts` (or change Vivaldi's conflicting keyboard shortcut).
4. To keep testing the official Bitwarden extension side by side, leave it installed but turn off its
   autofill/inline menu, so you know which one filled.

After `git pull`, click the reload arrow on Ward's card in `vivaldi://extensions`.

## Checklist

1. **Log in**: server `https://vault.example.com`. An `http://` address must be refused.
2. **Speed**: open the popup on a site with a saved login. Note how long until the list shows, compared with Bitwarden.
3. **Fill**: popup Fill; Cmd+Shift+L; click into the username field and pick from the menu under it.
   - The menu should NOT appear when the page focuses the field by itself (no click/Tab from you).
4. **Save**: sign in somewhere with a new password → "Ward found a login to save" → Review save.
5. **Offline**: turn Wi-Fi off, lock (lock button), unlock with the master password, fill. Turn Wi-Fi back on.
6. **Live sync**: with Ward unlocked, change a password for a login on your phone or in the web vault.
   Within a few seconds the popup (reopened) shows the new password, without pressing sync.
7. **Auto-lock**: footer setting, try "5 min idle", then lock the Mac screen (Ctrl+Cmd+Q): Ward should be locked
   when you come back.
8. **Touch ID (experimental)**: footer → Touch ID → Set up Touch ID. A small window opens and asks for Touch ID
   (maybe twice). Then lock and use **Unlock with Touch ID**.
   - If it fails, press **Copy report** and paste the report back to the assistant: it says whether Vivaldi
     supports WebAuthn PRF for extensions, which decides between this approach and a small native helper.
9. **Passkeys**: optional; sign in to a site with a passkey stored in your vault.
10. **Cards / Identities / Notes** (tabs under the toolbar):
    - Add a test card (e.g. `4111 1111 1111 1111`, any future expiry, `123`) and an identity; open a secure note.
    - On a real checkout page, open Ward (it opens on Cards when the page looks like checkout and has no logins),
      press **Fill**: number, name, expiry (dropdowns or `MM/YY`) and security code should fill, including Stripe's
      embedded card box. Don't submit anything.
    - On a shipping/address form, Fill an identity: name, address lines, city, state (dropdown), ZIP, country, phone, email.
    - Items set to "Master password re-prompt" in Bitwarden ask for it before Fill or copying the number/code.

## What's not there yet

No in-page menu for card fields yet (use the popup). No clipboard clearing. Touch ID covers the vaults that were open
when you set it up. See ROADMAP.md.
