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
```

CI (.github/workflows/ci.yml) runs all three plus `./pack.sh` in one job on every push, except pushes that only change
Markdown or docs/.

## UI work

- `node scripts/preview.mjs` builds `preview/ward-popup.html` (git-ignored): the real popup with sample data
  (`scripts/preview-shim.js`) in one self-contained file, and `preview/ward-inpage.html`: a sample sign-in page running
  the real inpage.js (field menu, save bar). The in-page UI reuses the popup's colours and avatars; keep them in step.
  Rebuild it after every UI change. It must keep working in a sandboxed HTML preview panel: inline scripts and blob:
  modules only, no network, storage, clipboard or Web Locks.
- docs/design/ holds the original UI mockups (option E was chosen) and 0.4.0 screenshots.
- The popup refuses to run framed; only the generated preview drops that check. Never weaken it in popup.js.
