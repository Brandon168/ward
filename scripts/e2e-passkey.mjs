#!/usr/bin/env node
// End to end: passkey autofill (0.7.0) through Ward's real popup, service worker and in-page menu in headless Chromium.
// The vault holds a passkey for login.test; https://login.test/passkey (scripts/testfront.mjs) asks for passkey
// autofill on its username field. Checks: Ward's menu lists the passkey first, a click signs in without a window and
// the site's key verifies the signature; the page aborting for its own button falls through to Ward's passkey window;
// "Use device or security key" hands the request to the browser (a virtual authenticator here); a login popover that
// closes on presses outside it (like southwest.com) still fills from the menu (/popover); locked, the menu has one
// "Ward is locked" row that opens Ward. Not in CI (needs
// Chromium); run it after changing page.js, bridge.js, the menu in inpage.js or the passkey part of background.js:
//   docker run -d --name ward-vw -p 127.0.0.1:8099:80 -e I_REALLY_WANT_VOLATILE_STORAGE=true -e DOMAIN=https://vault.test \
//     -e LOGIN_RATELIMIT_MAX_BURST=100 -e LOGIN_RATELIMIT_SECONDS=1 vaultwarden/server:1.37.5
//   node scripts/e2e-passkey.mjs
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bw from '../bw.js';
import { launch, sleep } from './cdp.mjs';
import { startFront, register, VAULT } from './testfront.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM = process.env.SERVER || 'http://localhost:8099', PASSWORD = 'correct horse battery staple 42';
const SITE = 'https://login.test/passkey';
const front = await startFront({ upstream: UPSTREAM });
const b = await launch({ extensions: [root], args: front.args });
const b64 = (s) => Buffer.from(s, 'base64');

// Ward's menu sits in a closed shadow root; DevTools can still see it (pierce), and clicks go in as real input.
async function menuButtons(pg) {
  const { root: doc } = await pg.send('DOM.getDocument', { depth: -1, pierce: true });
  const found = [];
  const text = (n) => (n.nodeType === 3 ? n.nodeValue : (n.children || []).map(text).join(' '));
  const walk = (n, inMenu) => {
    inMenu ||= n.nodeName === 'BWLITE-MENU';
    if (inMenu && n.nodeName === 'BUTTON') found.push(n);
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c, inMenu);
  };
  walk(doc, false);
  return Promise.all(found.map(async (n) => {
    const q = (await pg.send('DOM.getBoxModel', { nodeId: n.nodeId })).model.border;
    return { text: text(n).replace(/\s+/g, ' ').trim(), x: (q[0] + q[2]) / 2, y: (q[1] + q[5]) / 2 };
  }));
}
async function openMenu(pg) {
  await pg.eval(`document.activeElement?.blur(), document.querySelector('bwlite-menu')?.remove(), 0`);
  await pg.clickSel('#u');
  await pg.waitFor(`!!document.querySelector('bwlite-menu')`, 10000);
  await sleep(600); // the menu ignores clicks for 400 ms after it appears
  return menuButtons(pg);
}
const pkWindows = async () => (await b.targets()).filter((t) => t.url.includes('popup.html#pk='));

try {
  // A vault with a passkey for login.test (made with Ward's own code, as the passkey window would) and a password login.
  const email = `pk-${Date.now()}@example.com`;
  await register(UPSTREAM, email, PASSWORD);
  const l = await bw.login(UPSTREAM, email, PASSWORD, crypto.randomUUID());
  const s = { server: UPSTREAM, tokens: l.tokens };
  const made = await bw.passkeyCreate({ challenge: 'AA', rp: { name: 'Login test' }, user: { id: bw.b64u(new TextEncoder().encode('user-ben')), name: 'ben' } },
    'https://login.test', 'login.test');
  const item = { totp: '', notes: '', uris: ['https://login.test/'] };
  await bw.saveCipher(s, l.userKey, null, { ...item, name: 'Login test', username: 'ben', password: '', passkey: made.passkey });
  await bw.saveCipher(s, l.userKey, null, { ...item, name: 'Login test (password)', username: 'ann', password: 'pw-ann' });

  // Ward's popup (as a tab: headless Chromium has no toolbar): log in.
  const ext = new URL((await b.waitTarget((t) => t.type === 'service_worker' && t.url.includes('nnejaecbmnadljdpinaljbdpfcoocain'))).url).host;
  const p = await b.newPage(`chrome-extension://${ext}/popup.html`);
  const fill = async (sel, value) => { await p.clickSel(sel); await p.eval(`document.querySelector(${JSON.stringify(sel)}).select()`); await p.type(value); };
  await p.waitFor(`document.querySelectorAll('form input').length >= 3`);
  await fill('form input:not([type])', VAULT);
  await fill('form input[type=email]', email);
  await fill('form input[type=password]', PASSWORD);
  await p.eval(`[...document.querySelectorAll('button')].find((x) => x.textContent === 'Log in').click()`);
  await p.waitFor(`!!document.getElementById('search')`, 30000);
  console.log('logged in');

  // 1. Passkey autofill: Ward's menu, passkey first; a click signs in with no window.
  const pg = await b.newPage(SITE);
  await pg.send('DOM.enable');
  await sleep(500);
  let rows = await openMenu(pg);
  assert.deepEqual(rows.map((r) => r.text), ['L Login test Passkey · ben', 'L Login test (password) ann', 'Use device or security key'],
    `menu rows: ${JSON.stringify(rows.map((r) => r.text))}`);
  await pg.click(rows[0].x, rows[0].y);
  const [got] = await pg.waitFor(`log.length && log`, 10000);
  assert.equal(got.how, 'autofill', JSON.stringify(got));
  assert.equal(got.user, 'user-ben', 'the passkey for ben answered');
  assert.deepEqual([got.client.type, got.client.origin], ['webauthn.get', 'https://login.test']);
  const signed = Buffer.concat([b64(got.signed.auth), nodeCrypto.createHash('sha256').update(b64(got.signed.data)).digest()]);
  assert.ok(nodeCrypto.verify('sha256', signed, { key: Buffer.from(made.result.response.publicKey, 'base64url'), format: 'der', type: 'spki' }, b64(got.signed.sig)),
    'the site verifies the signature with the passkey\'s public key');
  assert.equal((await pkWindows()).length, 0, 'no Ward window for passkey autofill');
  console.log('passkey autofill signs in from the menu');

  // 2. The site aborts autofill for its own button: the request ends, the menu goes back to passwords only, and the
  // button's (modal) request opens Ward's passkey window as before.
  await pg.eval('log.length = 0, restart(), 0');
  await sleep(300);
  await pg.clickSel('#modal');
  await pg.waitFor(`log.some((x) => x.how === 'autofill' && x.error === 'AbortError')`, 5000);
  const win = await b.attach((await b.waitTarget((t) => t.url.includes('popup.html#pk='), 10000)).targetId);
  await win.send('Runtime.enable');
  await win.waitFor(`document.body.innerText.includes('Sign in to login.test')`);
  console.log('abort ends autofill; the modal request opens Ward\'s window');
  await win.eval(`[...document.querySelectorAll('button')].find((x) => x.textContent === 'Cancel').click()`).catch(() => {});
  await pg.waitFor(`log.some((x) => x.how === 'modal' && x.error === 'NotAllowedError')`, 10000);
  rows = await openMenu(pg);
  assert.deepEqual(rows.map((r) => r.text), ['L Login test ben', 'L Login test (password) ann'], 'no passkey rows once the site aborted');
  console.log('Cancel in the window ends it; the menu is back to logins');

  // 3. "Use device or security key": the browser's own prompt (a virtual authenticator holding another passkey).
  await pg.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await pg.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const { privateKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  await pg.send('WebAuthn.addCredential', { authenticatorId, credential: {
    credentialId: Buffer.from('device-key').toString('base64'), isResidentCredential: true, rpId: 'login.test', signCount: 0,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'), userHandle: Buffer.from('user-dev').toString('base64') } });
  await pg.eval('log.length = 0, restart(), 0');
  await sleep(300);
  rows = await openMenu(pg);
  assert.equal(rows.at(-1).text, 'Use device or security key');
  await pg.click(rows.at(-1).x, rows.at(-1).y);
  const [dev] = await pg.waitFor(`log.length && log`, 10000);
  assert.equal(dev.user, 'user-dev', `the browser's authenticator answered: ${JSON.stringify(dev)}`);
  assert.equal((await pkWindows()).length, 0, 'and no Ward window');
  console.log('"Use device or security key" hands it to the browser');

  // 4. A login popover that closes on a press outside it (southwest.com): picking a row still fills, the popover stays.
  const pop = await b.newPage('https://login.test/popover');
  await pop.send('DOM.enable');
  await sleep(500);
  rows = await openMenu(pop);
  const ann = rows.find((r) => r.text.endsWith('ann'));
  await pop.click(ann.x, ann.y);
  await pop.waitFor(`document.getElementById('u')?.value === 'ann'`, 5000);
  assert.deepEqual(await pop.eval(`[document.getElementById('p').value, document.activeElement.id]`), ['pw-ann', 'p'],
    'the popover kept its fields and Ward filled them');
  console.log('a popover that closes on outside presses still fills from the menu');

  // 5. Locked: the menu shows one "Ward is locked" row; picking it opens Ward (the toolbar popup, or a window).
  await p.eval(`document.querySelector('button[title="Lock all vaults"]').click()`);
  await sleep(500);
  await pop.goto('https://login.test/popover');
  await sleep(500);
  rows = await openMenu(pop);
  assert.deepEqual(rows.map((r) => r.text), ['Ward is locked Unlock to fill your logins'], `locked menu: ${JSON.stringify(rows.map((r) => r.text))}`);
  const before = new Set((await b.targets()).map((t) => t.targetId));
  await pop.click(rows[0].x, rows[0].y);
  await b.waitTarget((t) => !before.has(t.targetId) && /popup\.html$/.test(t.url), 10000);
  console.log('locked: the menu says so and its row opens Ward');
  console.log('passkey autofill e2e ok');
} finally {
  await b.close();
  front.close();
}
process.exit(0);
