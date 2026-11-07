#!/usr/bin/env node
// End to end: two-step login with a security key, through Ward's real popup and service worker in headless Chromium,
// with a virtual authenticator standing in for the key. Not in CI (it needs Chromium); run it after changing
// twostep.js, the security key part of background.js or the two-step view:
//   docker run -d --name ward-vw -p 127.0.0.1:8099:80 -e I_REALLY_WANT_VOLATILE_STORAGE=true -e DOMAIN=https://vault.test \
//     -e LOGIN_RATELIMIT_MAX_BURST=100 -e LOGIN_RATELIMIT_SECONDS=1 vaultwarden/server:1.37.5
//   node scripts/e2e-twostep.mjs
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bw from '../bw.js';
import { launch, sleep } from './cdp.mjs';
import { startFront, register, VAULT } from './testfront.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM = process.env.SERVER || 'http://localhost:8099', PASSWORD = 'correct horse battery staple 42';
const front = await startFront({ upstream: UPSTREAM });
const b = await launch({ extensions: [root], args: front.args });
const B64U = `const bytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const b64u = (x) => btoa(String.fromCharCode(...new Uint8Array(x))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');`;
try {
  // An account with a security key, registered the way the web vault does it.
  const email = `key-${Date.now()}@example.com`;
  await register(UPSTREAM, email, PASSWORD);
  const keys = await bw.loginKeys(UPSTREAM, email, PASSWORD);
  const s = { server: UPSTREAM, tokens: (await bw.loginWith(UPSTREAM, email, keys, crypto.randomUUID())).tokens };
  const reg = await b.newPage(null);
  await reg.send('WebAuthn.enable', { enableUI: false });
  const authOptions = { protocol: 'ctap2', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true };
  const { authenticatorId } = await reg.send('WebAuthn.addVirtualAuthenticator', { options: authOptions });
  await reg.goto(`${VAULT}/alive`);
  const { userVerificationToken } = await bw.api(s, '/two-factor/get-webauthn', 'POST', { masterPasswordHash: keys.hash });
  const { options } = await bw.api(s, '/two-factor/get-webauthn-challenge', 'POST', { userVerificationToken });
  delete options.status; delete options.errorMessage;
  const deviceResponse = await reg.eval(`(async (o) => { ${B64U}
    const c = await navigator.credentials.create({ publicKey: { ...o, challenge: bytes(o.challenge), user: { ...o.user, id: bytes(o.user.id) },
      excludeCredentials: (o.excludeCredentials || []).map((x) => ({ ...x, id: bytes(x.id) })), extensions: undefined } });
    return { id: c.id, rawId: b64u(c.rawId), type: c.type,
      response: { attestationObject: b64u(c.response.attestationObject), clientDataJson: b64u(c.response.clientDataJSON) } };
  })(${JSON.stringify(options)})`);
  await bw.api(s, '/two-factor/webauthn', 'POST', { id: 1, name: 'Test key', deviceResponse, userVerificationToken });
  const [credential] = (await reg.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
  assert.ok(credential, 'the virtual key holds the registered credential');
  await reg.close();
  console.log('security key registered');

  // Ward's popup (opened as a tab: headless Chromium has no toolbar).
  const ext = new URL((await b.waitTarget((t) => t.type === 'service_worker' && t.url.includes('nnejaecbmnadljdpinaljbdpfcoocain'))).url).host;
  const p = await b.newPage(`chrome-extension://${ext}/popup.html`);
  if (process.env.DEBUG) { // the service worker's errors and logs
    const sw = await b.attach((await b.waitTarget((t) => t.type === 'service_worker' && t.url.includes(ext))).targetId);
    await sw.send('Runtime.enable');
    sw.on('Runtime.consoleAPICalled', (e) => console.log('[sw]', e.type, e.args.map((x) => x.value ?? x.description).join(' ')));
    sw.on('Runtime.exceptionThrown', (e) => console.log('[sw] exception', e.exceptionDetails.exception?.description));
  }
  // From now on every new tab (the window Ward opens on the server) gets a key holding that credential.
  const keyWindows = [];
  await b.send('Target.setDiscoverTargets', { discover: true });
  b.on(async (m) => {
    if (m.method !== 'Target.targetCreated' || m.params.targetInfo.type !== 'page') return;
    const t = await b.attach(m.params.targetInfo.targetId);
    keyWindows.push(t.targetId);
    await t.send('WebAuthn.enable', { enableUI: false });
    const { authenticatorId: id } = await t.send('WebAuthn.addVirtualAuthenticator', { options: authOptions });
    await t.send('WebAuthn.addCredential', { authenticatorId: id, credential });
  });
  const fill = async (sel, text) => {
    await p.clickSel(sel);
    await p.eval(`document.querySelector(${JSON.stringify(sel)}).select()`);
    await p.type(text);
  };
  await p.waitFor(`document.querySelectorAll('form input').length >= 3`);
  await fill('form input:not([type])', VAULT);
  await fill('form input[type=email]', email);
  await fill('form input[type=password]', PASSWORD);
  await p.eval(`[...document.querySelectorAll('button')].find((x) => x.textContent === 'Log in').click()`);
  await p.waitFor(`document.body.innerText.includes('Use security key')`, 30000);
  assert.match(await p.eval('document.body.innerText'), /Two-step login[\s\S]*vault\.test/);
  console.log('two-step login offered with the security key');
  await p.eval(`[...document.querySelectorAll('button')].find((x) => x.textContent === 'Use security key').click()`);
  // The service worker opens the key window, gets the answer, closes the window; this popup (still open here)
  // finishes the login when the answer lands in session storage.
  await p.waitFor(`!!document.getElementById('search') || document.querySelector('.err')?.textContent`, 60000).catch(async (e) => {
    console.log('twostep now:', JSON.stringify(await p.eval(`chrome.storage.session.get('twostep').then((x) => x.twostep && { ...x.twostep, hash: '…', key: '…' })`)));
    console.log('targets:', (await b.targets()).map((t) => `${t.type} ${t.url}`).join('\n  '));
    console.log('popup text:', await p.eval('document.body.innerText'));
    throw e;
  });
  const err = await p.eval(`document.querySelector('.err')?.textContent || ''`);
  assert.equal(err, '', `no error: ${err}`);
  assert.ok(await p.eval(`!!document.getElementById('search')`), 'the vault list shows');
  await sleep(500);
  const open = (await b.targets()).filter((t) => keyWindows.includes(t.targetId));
  assert.equal(open.length, 0, 'the key window was closed');
  assert.ok(keyWindows.length >= 1, 'a key window was opened');
  console.log('two-step login with a security key ok');
} finally {
  await b.close();
  front.close();
}
process.exit(0);
