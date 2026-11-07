#!/usr/bin/env node
// Renders docs/ward-vs-bitwarden-{light,dark}.png: speed, weight and attack surface, Ward vs the Bitwarden extension;
// docs/social-preview.png (1280x640, for GitHub's social preview: Settings > General, uploaded by hand); and the same
// numbers as a text table in README.md between the compare:start/end markers, so search engines and screen readers
// get what the image shows.
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
const ROWS = [
  ['Popup opens', 'to the vault list, median of 10', W.popup.listMs, B.popup.listMs, 'ms', 0, 'faster'],
  ['Log in and sync', `${R.items} items, from the Log in click`, W.loginToListMs / 1000, B.loginToListMs / 1000, 's', 1, 'faster'],
  ['Code added to every page', 'scripts the extension puts in each site', W.page.scriptKB, B.page.scriptKB, 'KB', 0, 'less'],
  ['Script time per page load', 'added to a sign-in page, median of 10', W.page.scriptMs - N.page.scriptMs, B.page.scriptMs - N.page.scriptMs, 'ms', 1, 'less'],
  ['CPU per popup open', 'extension process', W.popup.extCpuMsPerOpen / 1000, B.popup.extCpuMsPerOpen / 1000, 's', 2, 'less'],
  ['Browser memory added', 'idle, vault unlocked', W.idle.browserPssMB - N.idle.browserPssMB, B.idle.browserPssMB - N.idle.browserPssMB, 'MB', 0, 'less'],
  ['Download size', 'unpacked', P.ward.totalKB / 1024, P.bitwarden.totalKB / 1024, 'MB', 1, 'smaller'],
];
// The four numbers that make the case at a glance (all from ROWS, so they can't disagree with the chart).
const HERO = [[0, 'faster popup'], [2, 'less code in every page you visit'], [5, 'less browser memory'], [6, 'smaller download']]
  .map(([i, what]) => { const [, , w, b, unit, d] = ROWS[i]; return { x: ratio(w, b), what, detail: `${fmt(w, d)} vs ${fmt(b, d)} ${unit}` }; });
const yes = (b) => (b ? 'Yes' : 'No');
const SURFACE = [
  ['Browser permissions requested', `${S.ward.permissions}`, `${S.bitwarden.permissions}${S.bitwarden.optionalPermissions ? ` + ${S.bitwarden.optionalPermissions} optional` : ''}`],
  ['Files any website can load from the extension', `${S.ward.webAccessibleResources}`, `${S.bitwarden.webAccessibleResources}`],
  ['Runs inside local files (file://)', yes(S.ward.fileUrls), yes(S.bitwarden.fileUrls)],
  ['What ships', S.ward.minified ? 'Minified JS' : 'Its readable source, no build step',
    `${fmt((P.bitwarden.jsKB + P.bitwarden.wasmKB) / 1024)} MB of ${S.bitwarden.minified ? 'minified JS' : 'JS'} and WebAssembly`],
];
// Every claim here is checkable in the repository (LICENSE, PRIVACY.md, scripts/guard.mjs, the files themselves).
const WHY = [
  ['Free and open source', 'MIT licensed. No paid tier, no account with us.'],
  ['Nothing phones home', 'No analytics, tracking or telemetry. CI pins every network call: your server, and a site\'s passkey settings when you use one.'],
  ['Your server, your vault', 'Vaultwarden or any Bitwarden-compatible server; your vault works with the official apps too.'],
  ['Read every line', 'Plain JavaScript, no bundler, no npm dependencies: what you install is the source.'],
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
  font:15px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; width:960px; padding:40px 40px 28px; }
.kicker { display:flex; align-items:center; gap:10px; font-size:13px; color:var(--muted); margin-bottom:14px; }
.kicker b { color:var(--fg); font-size:15px; letter-spacing:.02em; } .kicker i { width:10px; height:10px; border-radius:3px; background:var(--ward); display:inline-block; }
.pill { border:1px solid var(--line); border-radius:999px; padding:2px 10px; }
h1 { font-size:40px; line-height:1.1; margin:0; letter-spacing:-.02em; max-width:760px; }
.sub { color:var(--muted); font-size:16.5px; margin:12px 0 24px; max-width:820px; }
.hero { display:grid; grid-template-columns:repeat(4, 1fr); gap:12px; margin-bottom:8px; }
.tile { background:var(--panel); border-radius:12px; padding:16px 16px 14px; border-top:3px solid var(--ward); }
.tile .x { font-size:38px; font-weight:750; letter-spacing:-.02em; text-align:left; line-height:1; }
.tile .what { font-size:14px; margin:8px 0 6px; font-weight:600; } .tile .detail { color:var(--muted); font-size:12.5px; font-variant-numeric:tabular-nums; }
.legend { display:flex; gap:22px; font-size:14px; margin:4px 0 0; } .legend i { display:inline-block; width:14px; height:14px; border-radius:4px; vertical-align:-2px; margin-right:7px; }
h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:28px 0 6px; font-weight:650; }
.row { display:grid; grid-template-columns:240px 1fr 110px; gap:18px; align-items:center; padding:10px 0; border-top:1px solid var(--line); }
.lab b { display:block; font-size:15px; } .lab small { color:var(--muted); font-size:12.5px; }
.bar { display:grid; grid-template-columns:72px 1fr 92px; align-items:center; gap:10px; height:21px; }
.who { font-size:12.5px; color:var(--muted); } .val { font-size:13.5px; font-variant-numeric:tabular-nums; white-space:nowrap; }
.track { height:13px; } .fill { display:block; height:13px; border-radius:0 4px 4px 0; } .ward { background:var(--ward); } .bw { background:var(--bw); }
.row .x { font-size:24px; font-weight:700; text-align:right; font-variant-numeric:tabular-nums; } .row .x small { display:block; font-size:12px; font-weight:500; color:var(--muted); }
.cols { display:grid; grid-template-columns:1.15fr 1fr; gap:32px; }
table { width:100%; border-collapse:collapse; font-size:13.5px; } td, th { text-align:left; padding:8px 10px 8px 0; border-top:1px solid var(--line); vertical-align:top; }
th { font-size:12.5px; color:var(--muted); font-weight:600; border-top:0; } td.w { font-weight:650; }
.why { display:grid; gap:10px; } .why div { border-top:1px solid var(--line); padding-top:8px; } .why b { display:block; font-size:14.5px; } .why span { color:var(--muted); font-size:13px; }
.foot { color:var(--muted); font-size:11.5px; margin-top:24px; line-height:1.5; border-top:1px solid var(--line); padding-top:12px; }
.foot b { color:var(--fg); font-weight:600; }
</style></head><body>
<div class="kicker"><i></i><b>Ward</b><span class="pill">Free</span><span class="pill">Open source · MIT</span><span class="pill">For Vaultwarden &amp; Bitwarden servers</span></div>
<h1>Your vault, instantly.</h1>
<div class="sub">Ward is a free browser extension for your own Vaultwarden or Bitwarden server. Same vault, the everyday features
you use (search, fill, one-time codes, passkeys, cards, save prompts, a generator, two-step login), at a fraction of
the official extension's weight.</div>
<div class="hero">${HERO.map((h) => `<div class="tile"><div class="x">${h.x}×</div><div class="what">${h.what}</div><div class="detail">${h.detail}</div></div>`).join('')}</div>
<h2>Measured side by side</h2>
<div class="legend"><span><i class="ward"></i>Ward ${R.versions.ward}</span><span><i class="bw"></i>Bitwarden extension ${R.versions.bitwarden}</span>
<span style="color:var(--muted)">Shorter bars are better.</span></div>
${ROWS.map(row).join('')}
<div class="cols">
<div><h2>Smaller attack surface</h2>
<table><tr><th></th><th>Ward</th><th>Bitwarden</th></tr>
${SURFACE.map(([l, w, b]) => `<tr><td>${l}</td><td class="w">${w}</td><td>${b}</td></tr>`).join('')}</table></div>
<div><h2>Why Ward</h2><div class="why">${WHY.map(([t, d]) => `<div><b>${t}</b><span>${d}</span></div>`).join('')}</div></div>
</div>
<div class="foot"><b>github.com/Brandon168/ward</b> · The Bitwarden extension is free too and does more (Send, SSO, organisation
management, a fuller generator), and it has independent security audits; Ward has had its own reviews (docs/security-review.md).
Less code is not proof of safety, but it is less to attack and less to review. Measured ${R.date.slice(0, 10)} with scripts/bench.mjs,
same ${R.items}-item vault, headless ${R.chromium.split(' ').slice(0, 2).join(' ')} on a 4-vCPU Linux VM; one run, so expect different
absolute numbers on your machine. Method and raw data: docs/benchmarks.md.</div>
</body></html>`;

// The social preview: the pitch and three numbers, sized for link previews (dark reads best in most feeds).
const social = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><style>
:root { --bg:#14171c; --panel:#1b1f26; --fg:#e8ebf0; --muted:#8b93a1; --line:#2a303a; --ward:#4f8cff; }
* { box-sizing:border-box; } body { margin:0; width:1280px; height:640px; background:var(--bg); color:var(--fg); padding:64px 72px;
  font:20px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; display:flex; flex-direction:column; }
.kicker { display:flex; align-items:center; gap:12px; font-size:20px; color:var(--muted); }
.kicker b { color:var(--fg); font-size:24px; } .kicker i { width:14px; height:14px; border-radius:4px; background:var(--ward); display:inline-block; }
.pill { border:1px solid var(--line); border-radius:999px; padding:3px 14px; }
h1 { font-size:76px; line-height:1.05; margin:28px 0 14px; letter-spacing:-.025em; }
.sub { color:var(--muted); font-size:26px; max-width:1050px; }
.hero { display:grid; grid-template-columns:repeat(3, 1fr); gap:18px; margin-top:auto; }
.tile { background:var(--panel); border-radius:16px; padding:20px 22px; border-top:4px solid var(--ward); }
.tile .x { font-size:54px; font-weight:750; letter-spacing:-.02em; line-height:1; } .tile .what { font-size:21px; margin-top:8px; }
</style></head><body>
<div class="kicker"><i></i><b>Ward</b><span class="pill">Free</span><span class="pill">Open source</span><span class="pill">github.com/Brandon168/ward</span></div>
<h1>Your vault, instantly.</h1>
<div class="sub">A fast, lightweight browser extension for Vaultwarden and Bitwarden servers.</div>
<div class="hero">${HERO.filter((h, i) => i !== 2).map((h) => `<div class="tile"><div class="x">${h.x}×</div><div class="what">${h.what}</div></div>`).join('')}</div>
</body></html>`;

// The README table: the same rows as the image, as text.
const readme = join(root, 'README.md');
const lower = (t) => (/^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t); // "Popup" -> "popup", "CPU" stays
// The alt text says what the image shows, numbers included (it is all a screen reader or a crawler sees of it).
const alt = `Ward ${R.versions.ward} vs the Bitwarden browser extension ${R.versions.bitwarden} on the same ${R.items}-item vault: `
  + ROWS.map(([label, , w, b, unit, d, word]) => `${lower(label)} ${fmt(w, d)} ${unit} vs ${fmt(b, d)} ${unit} (${ratio(w, b)} times ${word})`).join('; ')
  + `. Attack surface: ${SURFACE.slice(0, 3).map(([l, w, b]) => `${lower(l)} ${w} vs ${b}`).join('; ')}.`;
const table = [
  `<!-- compare:start: generated by scripts/compare-image.mjs from docs/benchmark-results.json; edit there, not here -->`,
  '<picture>',
  '<source media="(prefers-color-scheme: dark)" srcset="docs/ward-vs-bitwarden-dark.png">',
  `<img src="docs/ward-vs-bitwarden-light.png" width="720" alt="${alt.replace(/"/g, '&quot;')}">`,
  '</picture>',
  '',
  `| Measured on the same ${R.items}-item vault | Ward ${R.versions.ward} | Bitwarden extension ${R.versions.bitwarden} | |`,
  '|---|---:|---:|---:|',
  ...ROWS.map(([label, , w, b, unit, d, word]) => `| ${label} | **${fmt(w, d)} ${unit}** | ${fmt(b, d)} ${unit} | ${ratio(w, b)}× ${word} |`),
  ...SURFACE.slice(0, 3).map(([label, w, b]) => `| ${label} | **${w}** | ${b} | |`),
  '<!-- compare:end -->',
].join('\n');
const md = readFileSync(readme, 'utf8');
const at = md.indexOf('<!-- compare:start'), to = md.indexOf('<!-- compare:end -->');
if (at < 0 || to < 0) throw new Error('README.md has no <!-- compare:start --> ... <!-- compare:end --> markers');
writeFileSync(readme, md.slice(0, at) + table + md.slice(to + '<!-- compare:end -->'.length));
console.log('README.md comparison table');

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
  const p = await b.newPage(null, { before: (s) => s.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 640, deviceScaleFactor: 1, mobile: false }) });
  await p.goto(`data:text/html;base64,${Buffer.from(social).toString('base64')}`);
  await sleep(300);
  writeFileSync(join(root, 'docs', 'social-preview.png'), await p.screenshot({ x: 0, y: 0, width: 1280, height: 640 }));
  console.log('docs/social-preview.png');
} finally { await b.close(); }
