# Ward design system

Ward must look and behave like one product everywhere it shows up. This file is the reference for every UI change.
If a change needs something this file doesn't cover, add it here in the same change, rather than inventing a
one-off. The chosen direction is mockup option E (`ward-ui-mockups.html`); `ward-0.4.0-*.png` show it shipped.

## Surfaces

| Surface | Where | Styles |
| --- | --- | --- |
| Toolbar popup: vault list, edit, settings, vaults, unlock | `popup.js` views | `popup.css` |
| Extension windows background.js opens for a page: passkey sign-in and save, login/card save offers, Touch ID | `popup.js` (`#pk=`, `#save=`, `#touch=`), `body.window` | `popup.css` |
| In-page UI: login menu under fields, "found a login to save" bar | `inpage.js`, closed shadow roots | `THEME` in `inpage.js`, a copy of the popup's tokens |

All of them use the same tokens, type, avatars, rows and buttons. There is no third look.

## Tokens

Defined once in `popup.css` `:root` (dark) and `:root[data-theme="light"]`. Use the variables; never hard-code a
colour in a view. The only literal colours are the avatar palette and the vault colours below.

- Colour: `--bg`, `--panel` (inputs, hovered rows), `--raised` (buttons, selected rows), `--fg`, `--muted`, `--line`,
  `--accent` (the one accent; primary buttons, focus), `--on-accent`, `--ok`, `--err`.
- Shape: `--radius` 8px for controls; 10px for rows and the search field; 12px for the in-page boxes; 7px avatars.
- Type: system font, 13px/1.4 body; h1 15px/650; small and labels 11.5px; section and group headers 10.5 to 11px
  uppercase, letter-spaced, muted.
- Spacing: 12px window padding; 6, 8 or 10px gaps.
- Avatars: 28px rounded squares, white initial on `PALETTE[hue(name)]` (`popup.js`); cards, identities and notes use
  their icon. A new login's avatar uses the name it will be saved under, so it matches the vault later.
- Vault colours: `COLORS` in `popup.js`, one per vault by order.
- Light and dark are both first-class. Check every change in both.

`inpage.js` can't load `popup.css` (it renders inside the page), so it carries a copy of the colour tokens and
`PALETTE`. `node test.mjs` fails if the copies drift ("design tokens in step").

## Components (`popup.css`)

- Buttons: default (`--raised`), `.primary` (at most one per view, the expected action), `.link` (quiet text action),
  `.quiet` (icon or small text, no border), `.danger` (destructive, pushed right). Icon-only buttons need a `title`.
- Action rows: `.inline`. Order is primary first, then secondary, then the way out ("Cancel", "Not now"); a `.link`
  escape hatch or `.danger` goes last, pushed right (`.link.end` or `.danger`). Use `.inline.wrap` where labels can
  overflow 380px.
- Lists: `.list` of `.item` rows: avatar, `.info` (`b` name, `small` detail), then actions. In the vault list the
  actions float in `.acts` and show on hover or selection; in prompts (`.item.choice`) they are always visible.
- Views: one `h1` title (`title()`), optional `h2` sections, `.muted` helper text, `.err` under the form.
- Other ways to do the same step (two-step methods): one `p.muted.switch` line, "Or use" followed by `.link` buttons.
- Generated values: `.genout`, a monospace panel box (`--panel`, `--line`, 10px radius) that selects as a whole. Tab
  rows that switch a view's mode reuse the vault list's chips (`nav.kinds`, `button.on`).
- Forms: `label` wraps its input (`field()`); checkboxes are `label.check`. A field with several controls (a login's URLs)
  is a `div.field` (same look as a label): its caption in a `span`, one `.inline` row per entry (input, then a `select`
  with an `ariaLabel`, then a `.quiet` remove icon), then a `.link` add button ("Add URL").
- The brand bar `.bar .brand` ("Ward") tops the main list and every extension window.

## Patterns

- Extension windows (passkey, save offers) use `promptHead()`, `choice()` and `promptActions()` in `popup.js`: brand
  bar, a title that names the site ("Sign in to github.com", "Save this login for news.example?"), the choices as
  rows, one action row, and `fitWindow()` to size the window to the content. A prompt that acts for a page always
  names that page's site: that is both consistency and security.
  They open at the top right of the browser window, under the toolbar icon (`wardWindow()` in background.js; the
  Touch ID window from popup.js does the same).
- In-page UI stays minimal and points to Ward's own windows for anything sensitive; it reuses the row, avatar and
  primary-button look from the popup. Its rows act on a genuine click only (`genuine()` in `inpage.js`): a login row
  fills, a passkey row signs in to the page's own site (like Fill; no window). When Ward holds the page's passkey
  autofill request, passkey rows come first (their detail line starts with "Passkey · ") and the menu ends with one
  `.link` row, "Use device or security key", the same escape hatch as the passkey window.
  While a vault is locked and nothing can be filled, the menu has one row instead: a grey lock avatar, "Ward is
  locked", "Unlock to fill your logins" ("Sign in to Ward" with no vault), which opens Ward.
- Feedback goes on the control that caused it (a copied button turns `--ok`), not in toasts.

## Copy

- Sentence case. Buttons are short verbs: Save, Update, Sign in, Fill, Not now, Cancel.
- Say what will happen and for which site or account. No exclamation marks, no jargon (say "passkey", not "WebAuthn
  credential"), no blame in errors: say what to do next.

## Accessibility

- Every control is reachable by keyboard and shows `:focus-visible` (2px accent outline).
- Text keeps readable contrast on both themes; muted text is for secondary information only.
- Truncated text (`text-overflow: ellipsis`) carries the full value in `title`.

## Every UI change

1. Use existing tokens and components; extend this file first if something new is needed.
2. Every window a user can see has a preview: add new ones to `VIEWS` in `scripts/preview.mjs` with sample data in
   `scripts/preview-shim.js`.
3. `node scripts/preview.mjs`, then look at the affected previews in light and dark next to the popup.
4. `node test.mjs` (includes the token check) and `node scripts/guard.mjs`.
5. Update screenshots in this folder when a surface changes noticeably.
