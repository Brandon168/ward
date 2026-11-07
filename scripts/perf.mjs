#!/usr/bin/env node
// Ward's speed, measured where it is felt: popup open, each search keystroke, the in-page menu after a click (with
// the service worker awake and asleep), and unlocking. Headless Chromium against a throwaway Vaultwarden through
// scripts/testfront.mjs (a throwaway Vaultwarden on :8099, see docs/performance.md). Results: bench/perf-<n>.json.
//   node scripts/perf.mjs [--items 2000] [--runs 7] [--profile]   (--profile: top functions while the popup opens)
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bw from '../bw.js';
import { launch, sleep } from './cdp.mjs';
import { startFront, register, VAULT, PAGE } from './testfront.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const ITEMS = +arg('items', 2000), RUNS = +arg('runs', 7), PROFILE = process.argv.includes('--profile');
const UPSTREAM = arg('server', 'http://localhost:8099'), PASSWORD = 'correct horse battery staple 42';
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[s.length >> 1] * 10) / 10; };
const log = (...a) => console.error(...a);

async function makeVault() {
  const email = `perf-${Date.now()}@example.com`;
  await register(UPSTREAM, email, PASSWORD);
  const l = await bw.login(UPSTREAM, email, PASSWORD, crypto.randomUUID());
  const s = { server: UPSTREAM, tokens: l.tokens };
  const words = ['mail', 'bank', 'shop', 'news', 'cloud', 'photo', 'music', 'travel', 'health', 'forum', 'games', 'work'];
  const items = [{ name: 'Login Test', username: 'me@example.com', password: 'hunter2-perf', uris: [PAGE] }];
  for (let i = 1; i < ITEMS; i++) {
    const w = words[i % words.length], n = String(i).padStart(4, '0');
    items.push({ name: `${w[0].toUpperCase()}${w.slice(1)} ${n}`, username: `user${n}@example.com`, password: `pw-${n}-${Math.random()}`,
      uris: [`https://${w}${n}.example.com/login`], ...(i % 10 === 0 && { totp: 'JBSWY3DPEHPK3PXP' }) });
  }
  for (let i = 0; i < items.length; i += 8) {
    await Promise.all(items.slice(i, i + 8).map((it) => bw.saveCipher(s, l.userKey, null, it)));
    if (i % 500 === 0) log(`  ${i} items`);
  }
  return email;
}

const POPUP_OBSERVER = `window.__t = {};
new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') __t.fcp = e.startTime; }).observe({ type: 'paint', buffered: true });
new MutationObserver((m, o) => { if (document.querySelectorAll('.item').length > 3) { __t.listed = performance.now(); o.disconnect();
  requestAnimationFrame(() => setTimeout(() => (__t.painted = performance.now()))); } }).observe(document, { childList: true, subtree: true });`;

async function main() {
  const front = await startFront({ upstream: UPSTREAM });
  const b = await launch({ extensions: [root], args: front.args });
  const out = { items: ITEMS, runs: RUNS, date: new Date().toISOString() };
  try {
    log(`vault with ${ITEMS} items…`);
    const email = await makeVault();
    const ext = new URL((await b.waitTarget((t) => t.type === 'service_worker' && t.url.includes('nnejaecbmnadljdpinaljbdpfcoocain'))).url).host;
    const POPUP = `chrome-extension://${ext}/popup.html`;
    const popupPage = (before) => b.newPage(null, { before: async (s) => {
      await s.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 600, deviceScaleFactor: 1, mobile: false });
      await s.send('Performance.enable');
      await s.send('Page.addScriptToEvaluateOnNewDocument', { source: POPUP_OBSERVER });
      await before?.(s);
    } });
    // log in through the popup
    const p = await popupPage();
    await p.goto(POPUP);
    for (const [sel, v] of [['form input:not([type])', VAULT], ['form input[type=email]', email], ['form input[type=password]', PASSWORD]]) {
      await p.clickSel(sel); await p.eval(`document.querySelector(${JSON.stringify(sel)}).select()`); await p.type(v);
    }
    await p.eval(`[...document.querySelectorAll('button')].find((x) => x.textContent === 'Log in').click()`);
    await p.waitFor(`document.querySelectorAll('.item').length > 3`, 120000);
    await sleep(3000);
    await p.close();

    // 1. the real toolbar popup, opened on a sign-in page that has a saved login (as a user clicks Ward's icon).
    // Timed from the openPopup call to the list in the DOM (the popup's own mark) and to its first paint.
    const site = await b.newPage(PAGE);
    const swSession = async () => b.attach((await b.waitTarget((t) => t.type === 'service_worker' && t.url.includes(ext))).targetId);
    const opens = [], seen = new Set();
    let popup;
    let retries = 0;
    for (let i = 0; i < RUNS; i++) try {
      await site.send('Page.bringToFront');
      // the worker stops when idle; a reload of the tab wakes it (Ward listens for tab updates)
      if (!(await b.targets()).some((t) => t.type === 'service_worker')) await site.goto(PAGE);
      const sw = await swSession();
      const { result } = await sw.send('Runtime.evaluate', { expression: 'Date.now() + performance.now() % 1', returnByValue: true });
      await sw.send('Runtime.evaluate', { expression: 'chrome.action.openPopup()', awaitPromise: true });
      await b.send('Target.detachFromTarget', { sessionId: sw.sessionId }); // an attached debugger keeps the worker alive
      const t = await b.waitTarget((x) => x.type === 'page' && x.url.endsWith('/popup.html') && !seen.has(x.targetId));
      seen.add(t.targetId);
      if (process.env.DEBUG) log('popup target', i, t.targetId);
      popup = await b.attach(t.targetId);
      await popup.send('Performance.enable');
      if (process.env.DEBUG) log('attached', i);
      const r = await popup.waitFor(`(() => { const m = performance.getEntriesByName('ward:list')[0], f = performance.getEntriesByName('first-contentful-paint')[0];
        return m && f && { list: m.startTime, fcp: f.startTime, origin: performance.timeOrigin, nodes: document.getElementsByTagName('*').length }; })()`, 30000);
      const m = Object.fromEntries((await popup.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
      opens.push({ click: r.origin + r.fcp - result.value, list: r.list, fcp: r.fcp, nodes: r.nodes,
        script: m.ScriptDuration * 1000, layout: (m.LayoutDuration + m.RecalcStyleDuration) * 1000, heap: m.JSHeapUsedSize / 1048576 });
      if (i < RUNS - 1) { await b.send('Target.closeTarget', { targetId: t.targetId }); await sleep(300); }
    } catch (e) { // a popup or worker session can vanish mid-round (focus, idle); redo the round
      if (++retries > 3) throw e;
      log(`  retrying popup round ${i}: ${e.message}`);
      i--;
      await sleep(500);
    }
    out.popup = Object.fromEntries(['click', 'list', 'fcp', 'script', 'layout', 'heap', 'nodes'].map((k) => [k, med(opens.map((o) => o[k]))]));
    if (process.env.DEBUG) log('opens done');
    out.popup.siteRows = await popup.eval(`document.querySelector('.group')?.textContent`);
    if (process.env.DEBUG) log('profile done');
    // 2. search in that popup: one character at a time, from the input event to the next frame
    const q = popup;
    const typing = {};
    for (const word of ['bank', 'user0042', 'zzz']) {
      const times = await q.eval(`(async (w) => { const q = document.getElementById('search'), out = [];
        const step = async (v) => { const t0 = performance.now(); q.value = v; q.dispatchEvent(new Event('input'));
          const t1 = performance.now(); document.body.offsetHeight; const t2 = performance.now(); // script, then style + layout
          await new Promise((r) => requestAnimationFrame(() => setTimeout(r))); out.push([performance.now() - t0, t1 - t0, t2 - t0]); };
        for (let i = 1; i <= w.length; i++) await step(w.slice(0, i));
        for (let i = w.length - 1; i >= 0; i--) await step(w.slice(0, i));
        return out; })(${JSON.stringify(word)})`);
      typing[word] = { toFrame: med(times.map((t) => t[0])), script: med(times.map((t) => t[1])), scriptLayout: med(times.map((t) => t[2])),
        worstScriptLayout: Math.round(Math.max(...times.map((t) => t[2])) * 10) / 10 };
    }
    out.search = typing;
    await b.send('Target.closeTarget', { targetId: q.targetId });
    await site.close();
    if (PROFILE) { // one more open (as a tab) with the profiler, after the real popup is done: a new tab closes it: where the popup's own time goes
      const pp = await popupPage(async (s) => { await s.send('Profiler.enable'); await s.send('Profiler.setSamplingInterval', { interval: 100 }); await s.send('Profiler.start'); });
      await pp.goto(POPUP, { wait: 'dom' });
      await pp.waitFor('window.__t.painted', 30000);
      const { profile } = await pp.send('Profiler.stop');
      const self = new Map(), dt = profile.timeDeltas, byId = new Map(profile.nodes.map((n) => [n.id, n]));
      profile.samples.forEach((id, k) => { const n = byId.get(id).callFrame; const key = `${n.functionName || '(anon)'} ${n.url.split('/').pop()}:${n.lineNumber + 1}`; self.set(key, (self.get(key) || 0) + (dt[k] || 0) / 1000); });
      out.profile = [...self].filter(([k]) => !/^\((idle|program|root)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${v.toFixed(1)} ms  ${k}`);
      await pp.close();
    }
    // 3. in-page menu: a trusted click into the login field until Ward's menu is in the page
    const menuOnce = async (cold) => {
      const pg = await b.newPage(null, { before: (s) => s.send('Page.addScriptToEvaluateOnNewDocument', { source: `
        addEventListener('pointerdown', () => (window.__down = performance.now()), true);
        addEventListener('input', (e) => e.target.id === 'u' && e.target.value && !window.__filled && (window.__filled = performance.now()), true);
        new MutationObserver((m, o) => { if (document.querySelector('bwlite-menu')) { window.__menu = performance.now(); o.disconnect(); } })
          .observe(document, { childList: true, subtree: true });` }) });
      await pg.goto(PAGE);
      await sleep(400);
      if (cold) { // the page is loaded and Ward's worker has gone to sleep (as after 30 s idle): the click must start it
        await pg.send('ServiceWorker.enable');
        await pg.send('ServiceWorker.stopAllWorkers');
        for (let i = 0; i < 30 && (await b.targets()).some((t) => t.type === 'service_worker'); i++) await sleep(100);
        const left = (await b.targets()).find((t) => t.type === 'service_worker');
        if (left) await b.send('Target.closeTarget', { targetId: left.targetId }).catch(() => {});
        for (let i = 0; i < 30 && (await b.targets()).some((t) => t.type === 'service_worker'); i++) await sleep(100);
        if ((await b.targets()).some((t) => t.type === 'service_worker')) throw new Error('could not stop the service worker');
      }
      await pg.clickSel('#u');
      await pg.waitFor('window.__menu', 10000);
      const ms = await pg.eval('window.__menu - window.__down');
      if (!cold) { // Fill: click the first login in the menu (after its 400 ms guard) until the field is filled
        await sleep(600);
        const r = await pg.eval(`(() => { const b = document.querySelector('bwlite-menu').getBoundingClientRect(); return { x: b.left + 20, y: b.top + 44 }; })()`);
        await pg.click(r.x, r.y);
        await pg.waitFor('window.__filled', 10000);
        fills.push(await pg.eval('window.__filled - window.__down'));
      }
      await pg.close();
      return ms;
    };
    const fills = [];
    const warm = [], cold = [];
    for (let i = 0; i < RUNS; i++) warm.push(await menuOnce(false));
    for (let i = 0; i < Math.min(RUNS, 4); i++) cold.push(await menuOnce(true));
    out.menu = { warm: med(warm), cold: med(cold), fill: med(fills) };
    // 4. unlock with the master password (lock first), to the list
    const u = await popupPage();
    await u.goto(POPUP);
    await u.waitFor(`document.querySelectorAll('.item').length > 3`);
    await u.clickSel('button[title="Lock all vaults"]');
    await u.waitFor(`!!document.querySelector('form input[type=password]')`);
    await u.clickSel('form input[type=password]'); await u.type(PASSWORD);
    const unlock = await u.eval(`(async () => { const t0 = performance.now();
      [...document.querySelectorAll('button')].find((x) => x.textContent === 'Unlock').click();
      while (document.querySelectorAll('.item').length < 4) await new Promise((r) => setTimeout(r, 5));
      return performance.now() - t0; })()`);
    out.unlockMs = Math.round(unlock);
    await u.close();
  } finally {
    await b.close();
    front.close();
  }
  mkdirSync(join(root, 'bench'), { recursive: true });
  writeFileSync(join(root, 'bench', `perf-${ITEMS}.json`), JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
}
await main();
process.exit(0);
