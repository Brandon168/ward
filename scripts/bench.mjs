#!/usr/bin/env node
// Ward vs the official Bitwarden extension: speed, memory and CPU in the same headless Chromium, against the same
// throwaway Vaultwarden vault. Results go to bench/results.json and a Markdown table on stdout (see docs/benchmarks.md).
//
//   docker run -d --name ward-vw -p 127.0.0.1:8099:80 -e I_REALLY_WANT_VOLATILE_STORAGE=true \
//     -e LOGIN_RATELIMIT_MAX_BURST=100 -e LOGIN_RATELIMIT_SECONDS=1 vaultwarden/server:1.37.5
//   node scripts/bench.mjs --bitwarden <unpacked Bitwarden extension dir> [--items 500] [--runs 10] [--idle 120]
//
// Nothing here ships or runs in CI. Each browser gets a fresh profile with one extension (or none, the baseline).
// All other hosts are blocked, so only the vault (https://vault.test, a local TLS proxy in front of Vaultwarden)
// and the sample sign-in page (https://login.test) are reachable.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bw from '../bw.js';
import { launch, sleep } from './cdp.mjs';
import { startFront, register, VAULT, PAGE } from './testfront.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const BITWARDEN = arg('bitwarden');
const ITEMS = +arg('items', 500), RUNS = +arg('runs', 10), IDLE = +arg('idle', 120);
const UPSTREAM = arg('server', 'http://localhost:8099'), PORT = +arg('port', 8443);
const ONLY = arg('only'); // none | ward | bitwarden, for debugging one browser
const DEBUG = process.argv.includes('--debug');
if (!BITWARDEN && ONLY !== 'ward' && ONLY !== 'none') throw new Error('--bitwarden <dir> is required (an unpacked copy of the Chrome Web Store build)');
const PASSWORD = 'correct horse battery staple 42';
const log = (...a) => console.error(...a);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

// --- TLS front (scripts/testfront.mjs): https://vault.test in front of Vaultwarden, https://login.test a sign-in page
const front = await startFront({ upstream: UPSTREAM, port: PORT });
const ARGS = front.args;

// --- The vault: one PBKDF2 account with ITEMS logins, the same for every extension ---------------------------------
async function makeVault() {
  const email = `bench-${Date.now()}@example.com`;
  await register(UPSTREAM, email, PASSWORD);
  const l = await bw.login(UPSTREAM, email, PASSWORD, crypto.randomUUID());
  const s = { server: UPSTREAM, tokens: l.tokens };
  const words = ['mail', 'bank', 'shop', 'news', 'cloud', 'photo', 'music', 'travel', 'health', 'forum', 'games', 'work'];
  await bw.saveCipher(s, l.userKey, null, { name: 'Login Test', username: 'me@example.com', password: 'hunter2-bench', uris: [PAGE] });
  for (let i = 1; i < ITEMS; i++) {
    const w = words[i % words.length], n = String(i).padStart(3, '0');
    await bw.saveCipher(s, l.userKey, null, {
      name: `${w[0].toUpperCase()}${w.slice(1)} ${n}`, username: `user${n}@example.com`, password: bw.b64(crypto.getRandomValues(new Uint8Array(12))),
      uris: [`https://${w}${n}.example.com/login`], ...(i % 10 === 0 && { totp: 'JBSWY3DPEHPK3PXP' }), ...(i % 7 === 0 && { notes: 'Security questions: first pet, street.' }),
    });
    if (i % 100 === 0) log(`  ${i} items`);
  }
  return email;
}

// --- Processes: memory (PSS) and CPU time from /proc, for the browser's whole tree or its extension processes ------
const hz = 100; // USER_HZ on Linux
function tree(pid) {
  const kids = new Map();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try { const ppid = +readFileSync(`/proc/${d}/stat`, 'utf8').split(') ')[1].split(' ')[1]; (kids.get(ppid) || kids.set(ppid, []).get(ppid)).push(+d); } catch {}
  }
  const out = [], todo = [pid];
  while (todo.length) { const p = todo.pop(); out.push(p); todo.push(...(kids.get(p) || [])); }
  return out;
}
function procInfo(pid) {
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    const pss = +(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8')) || [])[1] || 0; // kB
    const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return { pid, extension: cmd.includes('--extension-process'), pss, cpu: (+f[11] + +f[12]) / hz };
  } catch { return null; }
}
const snapshot = (b) => tree(b.proc.pid).map(procInfo).filter(Boolean);
const sum = (ps, k, pred = () => true) => ps.filter(pred).reduce((s, p) => s + p[k], 0);
const MB = (kb) => Math.round(kb / 1024 * 10) / 10;

// --- Logging in through each extension's own UI ---------------------------------------------------------------------
const POPUP = { ward: 'popup.html', bitwarden: 'popup/index.html' };
// When the vault list has rendered: Ward's rows are .item; Bitwarden's are buttons inside its list items.
const LISTED = { ward: `document.querySelectorAll('.item').length > 3`, bitwarden: `document.querySelectorAll('bit-item').length > 3` };
const clickText = (p, t, ms = 10000) => p.waitFor(`(() => { const e = [...document.querySelectorAll('button,a,[role=menuitem],[role=option],bit-option')]
  .find((e) => e.innerText.trim() === ${JSON.stringify(t)} && e.getBoundingClientRect().width); if (!e) return false; e.click(); return true; })()`, ms);
// Click into the field like a user and type; check the text landed there (dialogs move focus while they open).
async function fill(p, sel, text) {
  const q = `document.querySelector(${JSON.stringify(sel)})`;
  for (let i = 0; i < 10; i++) {
    await p.clickSel(sel);
    if (await p.eval(`document.activeElement === ${q}`)) {
      await p.eval(`${q}.select()`);
      await p.type(text);
      if (await p.eval(`${q}.value === ${JSON.stringify(text)}`)) return;
    }
    await sleep(300);
  }
  throw new Error(`could not fill ${sel}`);
}
async function shot(p, name) { if (DEBUG) writeFileSync(join(root, 'bench', `debug-${name}.png`), await p.screenshot()); }

async function loginWard(p, email) {
  await p.waitFor(`document.querySelectorAll('form input').length >= 3`);
  await fill(p, 'form input:not([type])', VAULT);
  await fill(p, 'form input[type=email]', email);
  await fill(p, 'form input[type=password]', PASSWORD);
  const t0 = Date.now();
  await clickText(p, 'Log in');
  return t0;
}
// Bitwarden's first-run screens (onboarding, "make Bitwarden your default password manager") come in varying order,
// so each step clicks whatever leads on until the next field it needs is there.
async function until(p, ready, texts, ms = 30000) {
  const click = `(() => { const all = [...document.querySelectorAll('button,a,[role=menuitem],[role=option]')];
    for (const t of ${JSON.stringify(texts)}) { const e = all.find((e) => e.innerText.trim() === t && e.getBoundingClientRect().width); if (e) return e.click(); } })()`;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(400)) {
    if (await p.eval(ready).catch(() => false)) return;
    await p.eval(click).catch(() => {});
  }
  await shot(p, 'bitwarden-stuck');
  throw new Error(`bitwarden: stuck before ${ready}`);
}
async function loginBitwarden(p, email) {
  await until(p, `!!document.querySelector('#email')`, ['Skip', 'Log in']);
  // The region menu ("bitwarden.com") opens a list with "self-hosted", which opens the server dialog.
  await until(p, `!!document.querySelector('#self_hosted_env_settings_form_input_base_url')`, ['self-hosted', 'bitwarden.com']);
  await fill(p, '#self_hosted_env_settings_form_input_base_url', VAULT);
  for (let i = 0; await p.eval(`!!document.querySelector('#self_hosted_env_settings_form_input_base_url')`); i++) {
    if (i > 20) { await shot(p, 'bitwarden-env'); throw new Error('bitwarden: the server dialog did not close'); }
    await clickText(p, 'Save', 2000).catch(() => {}); // the form validates asynchronously; Save can be early
    await sleep(500);
  }
  await fill(p, '#email', email);
  await clickText(p, 'Continue');
  await fill(p, '#masterPassword', PASSWORD);
  const t0 = Date.now();
  await clickText(p, 'Log in');
  return t0;
}
// After login, click through any one-time screens (default password manager, nudges) until the list shows.
async function untilListed(p, kind, ms = 90000) {
  const dismiss = kind === 'bitwarden' ? `[...document.querySelectorAll('button')].find((e) => /^(Skip|Skip for now|Not now|Dismiss)$/.test(e.innerText.trim()))?.click()` : '0';
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    if (await p.eval(`${LISTED[kind]} || void ${dismiss}`).catch(() => false)) return;
  }
  await shot(p, `${kind}-stuck`);
  throw new Error(`${kind}: the vault list did not appear`);
}

// --- One browser: none (baseline), ward or bitwarden ---------------------------------------------------------------
async function measure(kind, email) {
  const ext = { ward: root, bitwarden: BITWARDEN }[kind];
  const b = await launch({ extensions: ext ? [ext] : [], args: ARGS });
  const out = { kind };
  try {
    await sleep(3000);
    for (const t of await b.targets()) if (t.type === 'page' && !t.url.startsWith('about:')) await b.send('Target.closeTarget', { targetId: t.targetId }); // welcome tabs
    let id;
    if (ext) {
      id = new URL((await b.waitTarget((t) => t.type === 'service_worker')).url).host;
      const p = await b.newPage(null, { before: (s) => s.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 600, deviceScaleFactor: 1, mobile: false }) });
      await p.goto(`chrome-extension://${id}/${POPUP[kind]}`);
      // Timed from the final "Log in" click (master password key derivation, login, full sync) to the list.
      const t0 = await (kind === 'ward' ? loginWard : loginBitwarden)(p, email);
      await untilListed(p, kind);
      out.loginToListMs = Date.now() - t0;
      await shot(p, `${kind}-list`);
      await sleep(5000); // let any follow-up sync and caching finish
      await p.close();
    }
    await sleep(5000);
    // Idle with the vault unlocked and only a blank tab: background memory and CPU.
    // Memory is sampled every 10 s and the median kept: garbage collection makes single readings jumpy.
    const a = snapshot(b), extPss = [], allPss = [];
    let z = a;
    for (let t = 0; t < IDLE; t += 10) {
      await sleep(10000);
      z = snapshot(b);
      extPss.push(sum(z, 'pss', (p) => p.extension)); allPss.push(sum(z, 'pss'));
    }
    out.idle = { seconds: IDLE, extCpuMs: Math.round((sum(z, 'cpu', (p) => p.extension) - sum(a, 'cpu', (p) => p.extension)) * 1000),
      browserCpuMs: Math.round((sum(z, 'cpu') - sum(a, 'cpu')) * 1000), extPssMB: MB(median(extPss)), browserPssMB: MB(median(allPss)) };
    if (ext) {
      const sw = await b.attach((await b.waitTarget((t) => t.type === 'service_worker')).targetId);
      await sw.send('HeapProfiler.collectGarbage').catch(() => {});
      out.idle.workerHeapMB = MB((await sw.send('Runtime.getHeapUsage')).usedSize / 1024);
      await b.send('Target.detachFromTarget', { sessionId: sw.sessionId }).catch(() => {});
    }
    // Popup: time from navigation to the first list rows, and its JS heap.
    if (ext) {
      const times = [], heaps = [], c0 = snapshot(b);
      for (let i = 0; i < RUNS; i++) {
        const p = await b.newPage(null, { before: async (s) => {
          await s.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 600, deviceScaleFactor: 1, mobile: false });
          await s.send('Performance.enable');
          await s.send('Page.addScriptToEvaluateOnNewDocument', { source: `new MutationObserver((m, o) => { if (${LISTED[kind]}) { window.__listedAt = performance.now(); o.disconnect(); } }).observe(document, { childList: true, subtree: true });` });
        } });
        await p.goto(`chrome-extension://${id}/${POPUP[kind]}`);
        times.push(await p.waitFor('window.__listedAt', 30000));
        await sleep(1000);
        heaps.push((await p.send('Performance.getMetrics')).metrics.find((m) => m.name === 'JSHeapUsedSize').value / 1048576);
        if (i === 0) await shot(p, `${kind}-popup`);
        await p.close();
        await sleep(500);
      }
      const c1 = snapshot(b);
      out.popup = { listMs: Math.round(median(times)), listMsAll: times.map(Math.round), heapMB: Math.round(median(heaps) * 10) / 10,
        extCpuMsPerOpen: Math.round((sum(c1, 'cpu', (p) => p.extension) - sum(c0, 'cpu', (p) => p.extension)) * 1000 / RUNS) };
    }
    // A sign-in page: what the extension adds to every page load.
    const loads = [], scripts = [], heaps = [], tasks = [], c0 = snapshot(b);
    for (let i = 0; i < RUNS; i++) {
      let bytes = 0;
      const p = await b.newPage(null, { before: async (s) => {
        await s.send('Performance.enable');
        if (i === 0) {
          await s.send('Debugger.enable');
          s.on('Debugger.scriptParsed', (e) => { if (e.url.startsWith('chrome-extension://')) bytes += e.length; });
        }
      } });
      const t0 = Date.now();
      await p.goto(PAGE);
      loads.push(Date.now() - t0);
      await sleep(2000); // extensions inject more after load (Bitwarden's inline menu bootstrap)
      const m = Object.fromEntries((await p.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
      scripts.push(m.ScriptDuration * 1000); tasks.push(m.TaskDuration * 1000); heaps.push(m.JSHeapUsedSize / 1048576);
      if (i === 0) { out.pageScriptKB = Math.round(bytes / 102.4) / 10; await shot(p, `${kind}-page`); }
      await p.close();
    }
    const c1 = snapshot(b);
    out.page = { loadMs: Math.round(median(loads)), scriptMs: Math.round(median(scripts) * 10) / 10, taskMs: Math.round(median(tasks) * 10) / 10,
      heapMB: Math.round(median(heaps) * 100) / 100, scriptKB: out.pageScriptKB ?? 0,
      browserCpuMsPerLoad: Math.round((sum(c1, 'cpu') - sum(c0, 'cpu')) * 1000 / RUNS) };
    delete out.pageScriptKB;
    return out;
  } finally { await b.close(); }
}

// --- Package size (what is downloaded and parsed) -------------------------------------------------------------------
function pkg(dir, files) {
  const all = (p) => statSync(p).isDirectory() ? readdirSync(p).flatMap((n) => all(join(p, n))) : [p];
  const list = files ? files.flatMap((f) => all(join(dir, f))) : all(dir).filter((f) => !f.includes('/_metadata/'));
  const by = (re) => list.filter((f) => re.test(f)).reduce((s, f) => s + statSync(f).size, 0);
  return { files: list.length, totalKB: Math.round(by(/./) / 1024), jsKB: Math.round(by(/\.js$/) / 1024), wasmKB: Math.round(by(/\.wasm$/) / 1024) };
}
const wardFiles = readFileSync(join(root, 'pack.sh'), 'utf8').match(/cp -R (manifest\.json[^\n]*?) dist\/ward\//)[1].split(/\s+/);

mkdirSync(join(root, 'bench'), { recursive: true });
const results = { date: new Date().toISOString(), chromium: execFileSync(process.env.CHROMIUM || '/usr/bin/chromium', ['--version'], { encoding: 'utf8' }).trim(),
  vaultwarden: UPSTREAM, items: ITEMS, runs: RUNS, versions: {
    ward: JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version,
    ...(BITWARDEN && { bitwarden: JSON.parse(readFileSync(join(BITWARDEN, 'manifest.json'), 'utf8')).version }) },
  package: { ward: pkg(root, wardFiles), ...(BITWARDEN && { bitwarden: pkg(BITWARDEN) }) }, browsers: {} };
try {
  log(`creating a vault with ${ITEMS} logins…`);
  const email = await makeVault();
  for (const kind of ONLY ? [ONLY] : ['none', 'ward', 'bitwarden']) {
    log(`measuring ${kind}…`);
    results.browsers[kind] = await measure(kind, email);
    log(JSON.stringify(results.browsers[kind]));
  }
} finally {
  front.close();
}
writeFileSync(join(root, 'bench', 'results.json'), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
process.exit(0);
