#!/usr/bin/env node
// Security guard rails for every change, including upstream cherry-picks.
//
//   node scripts/guard.mjs           check the working tree against scripts/guard-lock.json
//   node scripts/guard.mjs --update  rewrite the lock from the working tree (review the lock diff!)
//
// The lock pins everything that widens what Ward can reach or run: manifest permissions and content scripts,
// every network API call site, every URL literal, dynamic-code sinks, the shipped file list and vendored file
// hashes. A change to any of them fails CI until the lock is updated in the same commit, so the risky part of a
// diff is always visible in one small file. Size budgets keep the per-page code lean.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const LOCK = join(root, 'scripts/guard-lock.json');
const update = process.argv.includes('--update');

// Files the extension ships (keep in step with pack.sh).
const SHIPPED = ['manifest.json', 'popup.html', 'popup.css', 'popup.js', 'theme.js', 'bw.js', 'background.js', 'bridge.js',
  'page.js', 'inpage.js', 'autofill.js', 'coord.js', 'touch.js', 'sync.js', 'gen.js', 'twostep.js', 'formfill.js', 'offscreen.html', 'offscreen.js', 'icons', 'vendor', 'LICENSE'];
const NOT_SHIPPED = new Set(['vendor/psl.sh', 'vendor/public_suffix_list.dat', 'vendor/wordlist.sh', 'vendor/eff_large_wordlist.txt']);
// Scripts injected into web pages: they run on every site, so they get the tightest budget.
const PAGE_SCRIPTS = ['page.js', 'bridge.js', 'inpage.js'];
// pageScriptsBytes is what every page pays and stays strict. firstPartyJsBytes is a sanity cap: popup.js parses in
// ~1.4 ms (measured 2026-11-06), so the popup is not split; raise this only with a reason in the commit.
// 230 -> 240 KB (2026-11-07): two-step login, the generator and the speed work (chunked list, caches, fast paths).
// 240 -> 245 KB (2026-11-06): passkey autofill in the in-page menu (0.7.0).
// 245 -> 246 KB (2026-11-08): the in-page menu hides presses from the page so popovers stay open (0.7.3).
// 246 -> 249 KB (2026-11-08): the locked row in the in-page menu, Ward's windows placed under the toolbar icon (0.7.4).
const BUDGET = { pageScriptsBytes: 30_000, firstPartyJsBytes: 249_000 };

const read = (f) => readFileSync(join(root, f), 'utf8');
const sha256 = (f) => createHash('sha256').update(readFileSync(join(root, f))).digest('hex');
const walk = (p) => statSync(join(root, p)).isDirectory()
  ? readdirSync(join(root, p)).sort().flatMap((n) => walk(join(p, n))) : [relative(root, join(root, p))];
const files = SHIPPED.flatMap(walk).filter((f) => !NOT_SHIPPED.has(f)).sort();
const firstPartyJs = files.filter((f) => f.endsWith('.js') && !f.startsWith('vendor/'));

// Network and code-loading APIs. Each match is pinned by file and API with a count, so a new call site anywhere
// (or a moved one into a new file) fails until it is reviewed.
const NETWORK = {
  fetch: /\bfetch\s*\(/g,
  XMLHttpRequest: /\bXMLHttpRequest\b/g,
  WebSocket: /\bWebSocket\b/g,
  EventSource: /\bEventSource\b/g,
  sendBeacon: /\bsendBeacon\b/g,
  importScripts: /\bimportScripts\b/g,
  dynamicImport: /\bimport\s*\(/g,
  imageLoad: /\bnew\s+Image\s*\(|\.(src|srcset|href)\s*=(?!=)/g,
  openWindow: /\bwindow\.open\s*\(|chrome\.(tabs|windows)\.create\s*\(/g,
  nativeMessaging: /\bconnectNative\b|\bsendNativeMessage\b/g,
  externalMessaging: /\bonMessageExternal\b|\bonConnectExternal\b/g,
};
// Never allowed in first-party code.
const FORBIDDEN = {
  eval: /\beval\s*\(/g,
  newFunction: /\bnew\s+Function\s*\(/g,
  stringTimer: /\bset(Timeout|Interval)\s*\(\s*['"`]/g,
  htmlSink: /\.(innerHTML|outerHTML)\s*=|\binsertAdjacentHTML\s*\(|\bdocument\.write(ln)?\s*\(|\bcreateContextualFragment\b/g,
  remoteScript: /<script[^>]+src\s*=\s*["']?https?:/gi,
};
const URL_LITERAL = /\bhttps?:\/\/[a-z0-9.*${}\-[\]]+/gi;

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1'); // comments only explain; ignore them

function snapshot() {
  const m = JSON.parse(read('manifest.json'));
  const manifest = {
    permissions: m.permissions || [], optional_permissions: m.optional_permissions || [],
    host_permissions: m.host_permissions || [], optional_host_permissions: m.optional_host_permissions || [],
    content_scripts: m.content_scripts || [], web_accessible_resources: m.web_accessible_resources || [],
    externally_connectable: m.externally_connectable || null, content_security_policy: m.content_security_policy || null,
    background: m.background || null, key: m.key || null,
  };
  const network = {}, urls = new Set();
  for (const f of files.filter((x) => x.endsWith('.js') || x.endsWith('.html'))) {
    const src = f.startsWith('vendor/') ? read(f) : strip(read(f));
    for (const [api, re] of Object.entries(NETWORK)) {
      const n = (src.match(re) || []).length;
      if (n) (network[f] ||= {})[api] = n;
    }
    if (!f.startsWith('vendor/')) for (const u of src.match(URL_LITERAL) || []) urls.add(u.toLowerCase());
  }
  const vendor = Object.fromEntries(files.filter((f) => f.startsWith('vendor/')).map((f) => [f, sha256(f)]));
  return { manifest, network, urls: [...urls].sort(), files, vendor };
}

const problems = [];
const now = snapshot();

for (const f of firstPartyJs.concat(files.filter((f) => f.endsWith('.html')))) {
  const src = strip(read(f));
  for (const [what, re] of Object.entries(FORBIDDEN)) {
    const n = (src.match(re) || []).length;
    if (n) problems.push(`${f}: forbidden ${what} (${n}x)`);
  }
}
const pageBytes = PAGE_SCRIPTS.reduce((s, f) => s + statSync(join(root, f)).size, 0);
const jsBytes = firstPartyJs.reduce((s, f) => s + statSync(join(root, f)).size, 0);
if (pageBytes > BUDGET.pageScriptsBytes) problems.push(`per-page scripts are ${pageBytes} bytes, budget ${BUDGET.pageScriptsBytes}`);
if (jsBytes > BUDGET.firstPartyJsBytes) problems.push(`first-party JS is ${jsBytes} bytes, budget ${BUDGET.firstPartyJsBytes}`);

if (update) {
  writeFileSync(LOCK, JSON.stringify(now, null, 2) + '\n');
  console.log(`wrote ${relative(root, LOCK)}; review its diff before committing`);
} else {
  if (!existsSync(LOCK)) problems.push('scripts/guard-lock.json is missing: run node scripts/guard.mjs --update and review it');
  else {
    const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    for (const k of Object.keys(now.manifest)) if (!same(now.manifest[k], lock.manifest?.[k]))
      problems.push(`manifest.${k} changed:\n    lock: ${JSON.stringify(lock.manifest?.[k])}\n    now:  ${JSON.stringify(now.manifest[k])}`);
    const keys = new Set([...Object.keys(now.network), ...Object.keys(lock.network || {})]);
    for (const f of keys) if (!same(now.network[f] || {}, lock.network?.[f] || {}))
      problems.push(`network/code-loading call sites changed in ${f}: lock ${JSON.stringify(lock.network?.[f] || {})} now ${JSON.stringify(now.network[f] || {})}`);
    const added = now.urls.filter((u) => !lock.urls?.includes(u));
    if (added.length) problems.push(`new URL literals: ${added.join(', ')}`);
    const newFiles = now.files.filter((f) => !lock.files?.includes(f)), gone = (lock.files || []).filter((f) => !now.files.includes(f));
    if (newFiles.length || gone.length) problems.push(`shipped files changed: +[${newFiles.join(', ')}] -[${gone.join(', ')}]`);
    for (const [f, h] of Object.entries(now.vendor)) if (lock.vendor?.[f] !== h) problems.push(`vendored file changed: ${f} (${h})`);
  }
}

console.log(`per-page scripts ${pageBytes} / ${BUDGET.pageScriptsBytes} bytes, first-party JS ${jsBytes} / ${BUDGET.firstPartyJsBytes} bytes`);
if (problems.length) {
  console.error(`\nguard: ${problems.length} problem(s)\n- ${problems.join('\n- ')}`);
  console.error('\nIf a change is intended, run `node scripts/guard.mjs --update` and commit the lock with a note on why.');
  process.exit(1);
}
console.log('guard ok');
