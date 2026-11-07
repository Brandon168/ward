#!/usr/bin/env node
// Renders docs/ward-vs-bitwarden-{light,dark}.png: speed, weight and attack surface, Ward vs the Bitwarden extension.
// Numbers come from docs/benchmark-results.json (scripts/bench.mjs). The attack-surface facts are read from both
// manifests; pass --bitwarden <unpacked dir> to (re)record Bitwarden's, otherwise the recorded ones are used.
//   node scripts/compare-image.mjs [--bitwarden <dir>]        (needs a local Chromium, like scripts/screenshots.mjs)
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const resultsFile = join(root, 'docs', 'benchmark-results.json');
const R = JSON.parse(readFileSync(resultsFile, 'utf8'));
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null; };

// --- Attack surface, from each manifest and the shipped files ---------------------------------------------------
function surface(dir) {
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const all = (p) => statSync(p).isDirectory() ? readdirSync(p).flatMap((n) => all(join(p, n))) : [p];
  // Ward's own code; its one vendored library (hash-wasm, checked byte for byte against npm in CI) is listed apart.
  const js = all(dir).filter((f) => f.endsWith('.js') && !/\/(_metadata|vendor|scripts|node_modules)\//.test(f) && !/\/test\.mjs$/.test(f));
  const longest = Math.max(...js.map((f) => Math.max(...readFileSync(f, 'utf8').split('\n').map((l) => l.length))));
  return {
    permissions: (m.permissions || []).length, optionalPermissions: (m.optional_permissions || []).length,
    webAccessibleResources: (m.web_accessible_resources || []).reduce((s, w) => s + (w.resources || []).length, 0),
    fileUrls: (m.content_scripts || []).some((c) => (c.matches || []).some((x) => x.startsWith('file:') || x === '<all_urls>')),
    minified: longest > 2000, // a line longer than this is a bundler's output, not hand-written source
  };
}
R.surface = { ward: surface(root), bitwarden: arg('bitwarden') ? surface(arg('bitwarden')) : R.surface?.bitwarden };
if (!R.surface.bitwarden) throw new Error('No recorded Bitwarden manifest facts: pass --bitwarden <unpacked dir> once');
writeFileSync(resultsFile, JSON.stringify(R, null, 2) + '\n');

const W = R.browsers.ward, B = R.browsers.bitwarden, N = R.browsers.none, P = R.package;
const S = R.surface;
const fmt = (v, d = 0) => v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const ratio = (a, b) => { const r = b / a; return r >= 10 ? fmt(r) : fmt(r, 1); };
// [label, note, ward, bitwarden, unit text, decimals, callout word]
const FASTER = [
  ['Popup opens', 'to the vault list, median of 10', W.popup.listMs, B.popup.listMs, 'ms', 0, 'faster'],
  ['Log in and sync', '500 items, from the Log in click', W.loginToListMs / 1000, B.loginToListMs / 1000, 's', 1, 'faster'],
  ['CPU per popup open', 'extension process', W.popup.extCpuMsPerOpen / 1000, B.popup.extCpuMsPerOpen / 1000, 's', 2, 'less'],
];
const LIGHTER = [
  ['Code added to every page', 'scripts the extension puts in each site', W.page.scriptKB, B.page.scriptKB, 'KB', 0, 'less'],
  ['Script time per page load', 'added to a sign-in page, median of 10', W.page.scriptMs - N.page.scriptMs, B.page.scriptMs - N.page.scriptMs, 'ms', 1, 'less'],
  ['Browser memory added', 'idle, vault unlocked', W.idle.browserPssMB - N.idle.browserPssMB, B.idle.browserPssMB - N.idle.browserPssMB, 'MB', 0, 'less'],
  ['Install size', 'unpacked', P.ward.totalKB / 1024, P.bitwarden.totalKB / 1024, 'MB', 1, 'smaller'],
];
const yes = (b) => (b ? 'Yes' : 'No');
const SURFACE = [
  ['Browser permissions requested', `${S.ward.permissions}`, `${S.bitwarden.permissions}${S.bitwarden.optionalPermissions ? ` + ${S.bitwarden.optionalPermissions} optional` : ''}`],
  ['Files any website can load from the extension', `${S.ward.webAccessibleResources}`, `${S.bitwarden.webAccessibleResources}`],
  ['Runs inside local files (file://)', yes(S.ward.fileUrls), yes(S.bitwarden.fileUrls)],
  ['What ships', S.ward.minified ? 'Minified JS' : 'Its readable source, no build step, plus 1 vendored library',
    `${fmt((P.bitwarden.jsKB + P.bitwarden.wasmKB) / 1024)} MB of ${S.bitwarden.minified ? 'minified JS' : 'JS'} and WebAssembly`],
];

function row([label, note, w, b, unit, d, word]) {
  const max = Math.max(w, b);
  const bar = (v, cls, name) => `<div class="bar"><span class="who">${name}</span><span class="track"><span class="fill ${cls}"
    style="width:max(3px, ${(v / max) * 100}%)"></span></span><span class="val">${fmt(v, d)} ${unit}</span></div>`;
  return `<div class="row"><div class="lab"><b>${label}</b><small>${note}</small></div>
    <div class="bars">${bar(w, 'ward', 'Ward')}${bar(b, 'bw', 'Bitwarden')}</div>
    <div class="x">${ratio(w, b)}× <small>${word}</small></div></div>`;
}
const html = (theme) => `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><style>
:root { --bg:#fff; --panel:#f6f7f9; --fg:#14171c; --muted:#6b7280; --line:#e3e6ea; --ward:#2f6fec; --bw:#eb6834; }
:root[data-theme=dark] { --bg:#14171c; --panel:#1b1f26; --fg:#e8ebf0; --muted:#8b93a1; --line:#2a303a; --ward:#4f8cff; --bw:#d95926; }
* { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--fg);
  font:15px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; width:960px; padding:36px 40px 28px; }
h1 { font-size:30px; margin:0; letter-spacing:-.01em; } .sub { color:var(--muted); margin:6px 0 18px; }
.legend { display:flex; gap:22px; font-size:14px; margin-bottom:6px; } .legend i { display:inline-block; width:14px; height:14px; border-radius:4px; vertical-align:-2px; margin-right:7px; }
h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:26px 0 4px; font-weight:650; }
.row { display:grid; grid-template-columns:250px 1fr 120px; gap:18px; align-items:center; padding:12px 0; border-top:1px solid var(--line); }
.lab b { display:block; font-size:15px; } .lab small { color:var(--muted); font-size:12.5px; }
.bar { display:grid; grid-template-columns:72px 1fr 92px; align-items:center; gap:10px; height:22px; }
.who { font-size:12.5px; color:var(--muted); } .val { font-size:13.5px; font-variant-numeric:tabular-nums; white-space:nowrap; }
.track { height:14px; } .fill { display:block; height:14px; border-radius:0 4px 4px 0; } .ward { background:var(--ward); } .bw { background:var(--bw); }
.x { font-size:26px; font-weight:700; text-align:right; font-variant-numeric:tabular-nums; } .x small { display:block; font-size:12px; font-weight:500; color:var(--muted); }
table { width:100%; border-collapse:collapse; font-size:14px; } td, th { text-align:left; padding:10px 12px 10px 0; border-top:1px solid var(--line); vertical-align:top; }
th { font-size:12.5px; color:var(--muted); font-weight:600; border-top:0; } td:first-child { width:300px; } td.w { font-weight:650; }
.foot { color:var(--muted); font-size:12px; margin-top:22px; line-height:1.5; border-top:1px solid var(--line); padding-top:12px; }
</style></head><body>
<h1>Ward vs the Bitwarden extension</h1>
<div class="sub">Same Vaultwarden vault (500 logins), same browser, the everyday features both have: search, fill, copy,
one-time codes, passkeys, cards and identities, save prompts, password generation.</div>
<div class="legend"><span><i class="ward"></i>Ward ${R.versions.ward}</span><span><i class="bw"></i>Bitwarden ${R.versions.bitwarden}</span>
<span style="color:var(--muted)">Shorter bars are better.</span></div>
<h2>Faster</h2>${FASTER.map(row).join('')}
<h2>Lighter</h2>${LIGHTER.map(row).join('')}
<h2>Smaller attack surface</h2>
<table><tr><th></th><th>Ward</th><th>Bitwarden</th></tr>
${SURFACE.map(([l, w, b]) => `<tr><td>${l}</td><td class="w">${w}</td><td>${b}</td></tr>`).join('')}</table>
<div class="foot">Bitwarden also offers Send, SSO, organisation management and a fuller generator (passphrases, usernames), and has
independent security audits; Ward has had its own security reviews (docs/security-review.md). Less code is not proof of safety, but it is less to attack and less to review.
Measured ${R.date.slice(0, 10)} with scripts/bench.mjs in headless ${R.chromium.split(' ').slice(0, 2).join(' ')} on a 4-vCPU Linux VM; one run, so
expect different absolute numbers on your machine. Method and raw data: docs/benchmarks.md.</div>
</body></html>`;

const b = await launch({ width: 1100, height: 1600 });
try {
  for (const theme of ['light', 'dark']) {
    const p = await b.newPage(null, { before: (s) => s.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 1600, deviceScaleFactor: 2, mobile: false }) });
    await p.goto(`data:text/html;base64,${Buffer.from(html(theme)).toString('base64')}`);
    await sleep(300);
    const h = await p.eval('Math.ceil(document.body.getBoundingClientRect().height)');
    writeFileSync(join(root, 'docs', `ward-vs-bitwarden-${theme}.png`), await p.screenshot({ x: 0, y: 0, width: 960, height: h }));
    console.log(`docs/ward-vs-bitwarden-${theme}.png`);
    await p.close();
  }
} finally { await b.close(); }
