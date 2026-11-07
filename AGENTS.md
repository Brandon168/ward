# Ward: notes for coding agents

Ward is a lean, 1Password-style browser extension for Vaultwarden/Bitwarden servers, built as its own product from
BW Lite (github.com/yowmamasita/bw-lite, MIT, seeded at 1d77b9e). It is not a long-lived fork: upstream fixes are
cherry-picked on purpose and must pass the same CI guards. Small in-scope fixes may be offered upstream (security
findings privately). Start with README.md, ROADMAP.md, docs/security-review.md and docs/TESTING.md.

## Repo

- Plain JavaScript, Manifest V3, no build step and no dependencies. Keep it that way unless asked.
- Remotes: `origin` is Brandon168/ward; `upstream` is BW Lite with push disabled. `gh repo set-default`
  is Brandon168/ward (otherwise gh resolves the `upstream` remote).
- Version lives in `manifest.json`; bump it with user-visible changes and mention it in the commit subject, e.g. `(0.4.1)`.
  ROADMAP.md lists shipped versions; update README "What it does today" and docs/TESTING.md when behaviour changes.
- Commit or push only when the user asks. Never tag or release unless asked.

## Checks

```sh
node test.mjs                 # offline checks
node scripts/guard.mjs        # security guard rails (permissions, size budgets); update scripts/guard-lock.json deliberately
node test.mjs --integration   # against a throwaway Vaultwarden on 127.0.0.1:8099 (container `ward-vw`, see README)
MAILPIT=http://localhost:8025 node test.mjs --integration   # adds email two-step (Vaultwarden mailing to Mailpit, docs/TESTING.md)
node scripts/e2e-twostep.mjs  # security key two-step through the real popup in Chromium; run after touching that flow
```

CI (.github/workflows/ci.yml) runs all three plus `./pack.sh` in one job on every push, except pushes that only change
Markdown or docs/.

## UI work

**The UI must stay consistent across every surface**: the toolbar popup, the windows Ward opens for a page (passkey,
save offers, Touch ID) and the in-page menu and save bar. `docs/design/SYSTEM.md` is the design system (tokens,
components, patterns, copy, the checklist) and is binding for every UI change:

- Read it before touching UI. Use its tokens and components; no hard-coded colours, one-off styles or new button
  kinds. If something is missing, extend SYSTEM.md in the same change instead of improvising.
- A new view or window ships with a preview entry (`VIEWS` in `scripts/preview.mjs`, sample hand-off in
  `scripts/preview-shim.js`). Check it in light and dark next to the popup before calling the work done.
- `node test.mjs` checks that inpage.js's copied tokens and avatar palette match popup.css/popup.js.

Preview:

- `node scripts/preview.mjs` builds, in `preview/` (git-ignored): `ward-popup.html` (the real popup with sample data
  from `scripts/preview-shim.js`), one file per extension window (`ward-passkey*.html`, `ward-save*.html`) and
  `ward-inpage.html` (a sample sign-in page running the real inpage.js: field menu, save bar). Rebuild after every UI
  change. It must keep working in a sandboxed HTML preview panel: inline scripts and blob: modules only, no network,
  storage, clipboard or Web Locks.
- `node scripts/screenshots.mjs` regenerates the README screenshots (`docs/screenshots/`) from those previews. Rerun
  it when a change alters what they show.
- `docs/ward-vs-bitwarden-{light,dark}.png` (README "How it compares") come from `node scripts/compare-image.mjs`,
  which reads `docs/benchmark-results.json`; rerun it after a new `scripts/bench.mjs` run. Keep every claim in it
  measured or read from the manifests.
- docs/design/ holds SYSTEM.md, the original UI mockups (option E was chosen) and 0.4.0 screenshots.
- The popup refuses to run framed; only the generated preview drops that check. Never weaken it in popup.js.
