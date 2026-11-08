// Shared by scripts/bench.mjs and scripts/e2e-twostep.mjs (not shipped, not run in CI):
// - startFront(): a local TLS front. https://vault.test proxies to a throwaway Vaultwarden (HTTP and WebSocket),
//   https://login.test serves a plain sign-in page (and /passkey, one with passkey autofill; /popover, one that closes on a press outside). Chromium reaches them through the returned flags; every other
//   host is blocked. Vaultwarden needs DOMAIN=https://vault.test for security keys (WebAuthn checks the origin).
// - register(): a new Vaultwarden account with Ward's own crypto (registration is not part of the extension).
import { createServer as https } from 'node:https';
import { request } from 'node:http';
import { connect } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as bw from '../bw.js';

export const VAULT = 'https://vault.test', PAGE = 'https://login.test/';

const SIGNIN = `<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title>
<style>body{font:15px system-ui;display:grid;place-items:center;height:90vh;margin:0;background:#f4f5f7}form{background:#fff;padding:28px;border-radius:12px;width:300px;box-shadow:0 2px 12px #0001}
label{display:block;margin:12px 0 4px;font-size:13px;color:#555}input{width:100%;box-sizing:border-box;padding:9px;border:1px solid #ccd;border-radius:6px;font:inherit}
button{margin-top:18px;width:100%;padding:10px;border:0;border-radius:6px;background:#2563eb;color:#fff;font:inherit}</style></head>
<body><form action="/done" method="post"><h2 style="margin:0 0 8px">Sign in</h2><label for="u">Email</label>
<input id="u" name="username" type="email" autocomplete="username"><label for="p">Password</label>
<input id="p" name="password" type="password" autocomplete="current-password"><button>Sign in</button></form></body></html>`;

// https://login.test/passkey: a sign-in page with passkey autofill (mediation: conditional) on its username field, a
// "Passwordless sign in" button that aborts it for a modal request, as real sites do. window.log records the outcomes;
// window.restart() asks again.
const PASSKEY = `<!doctype html><html><head><meta charset="utf-8"><title>Passkey sign in</title></head>
<body style="font:15px system-ui;padding:60px"><form onsubmit="return false" style="width:300px"><label for="u">Username</label>
<input id="u" name="username" autocomplete="username webauthn" style="display:block;width:100%;padding:8px">
<label for="p">Password</label><input id="p" type="password" autocomplete="current-password" style="display:block;width:100%;padding:8px">
<button>Sign in</button></form><button id="modal" type="button" style="margin-top:12px">Passwordless sign in</button>
<script>
  window.log = [];
  const challenge = () => crypto.getRandomValues(new Uint8Array(32));
  const b64 = (x) => btoa(String.fromCharCode(...new Uint8Array(x)));
  const seen = (how) => (c) => log.push({ how, id: c.id, user: c.response.userHandle && new TextDecoder().decode(c.response.userHandle),
    client: JSON.parse(new TextDecoder().decode(c.response.clientDataJSON)),
    signed: { auth: b64(c.response.authenticatorData), data: b64(c.response.clientDataJSON), sig: b64(c.response.signature) } });
  let ac;
  window.restart = () => {
    ac = new AbortController();
    navigator.credentials.get({ mediation: 'conditional', signal: ac.signal, publicKey: { challenge: challenge(), rpId: 'login.test' } })
      .then(seen('autofill'), (e) => log.push({ how: 'autofill', error: e.name }));
  };
  restart();
  document.getElementById('modal').onclick = () => {
    ac.abort();
    navigator.credentials.get({ publicKey: { challenge: challenge(), rpId: 'login.test' } }).then(seen('modal'), (e) => log.push({ how: 'modal', error: e.name }));
  };
</script></body></html>`;

// https://login.test/popover: a login popover that closes on a press outside it, the way southwest.com does: a window
// capture listener (added before any extension's document_idle scripts) removes the form on mouseup and focuses the
// toggle. Ward's menu sits outside the popover, so the page must never see presses on it.
const POPOVER = `<!doctype html><html><head><meta charset="utf-8"><title>Popover sign in</title><script>
addEventListener('mouseup', (e) => { const pop = document.getElementById('pop'); if (pop && !pop.contains(e.target)) { pop.remove(); document.getElementById('toggle').focus(); } }, true);
</script></head><body style="font:15px system-ui;padding:60px"><button id="toggle">Log in</button>
<form id="pop" onsubmit="return false" style="width:300px;margin-top:8px"><input id="u" name="username" style="display:block;width:100%;padding:8px">
<input id="p" name="password" type="password" style="display:block;width:100%;padding:8px;margin-top:8px"></form></body></html>`;

export async function startFront({ upstream = 'http://localhost:8099', port = 8443 } = {}) {
  const work = mkdtempSync(join(homedir(), '.cache', 'ward-front-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=vault.test',
    '-addext', 'subjectAltName=DNS:vault.test,DNS:login.test', '-keyout', join(work, 'key.pem'), '-out', join(work, 'cert.pem')], { stdio: 'ignore' });
  const up = new URL(upstream);
  const server = https({ key: readFileSync(join(work, 'key.pem')), cert: readFileSync(join(work, 'cert.pem')) }, (req, res) => {
    if ((req.headers.host || '').startsWith('login.test')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(req.url === '/passkey' ? PASSKEY : req.url === '/popover' ? POPOVER : SIGNIN);
    }
    const p = request({ host: up.hostname, port: up.port, path: req.url, method: req.method, headers: { ...req.headers, host: up.host } }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    p.on('error', () => res.destroy());
    req.pipe(p);
  });
  server.on('upgrade', (req, sock, head) => { // WebSocket (Vaultwarden's notification hub): pass the bytes through
    const u = connect(+up.port, up.hostname, () => {
      u.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries({ ...req.headers, host: up.host }).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      u.write(head);
      u.pipe(sock).pipe(u);
    });
    u.on('error', () => sock.destroy()); sock.on('error', () => u.destroy());
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    args: ['--ignore-certificate-errors',
      `--host-resolver-rules=MAP vault.test:443 127.0.0.1:${port}, MAP login.test:443 127.0.0.1:${port}, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1`],
    close: () => { server.close(); rmSync(work, { recursive: true, force: true }); },
  };
}

export async function register(server, email, password, kdf = { kdf: 0, kdfIterations: 600000 }) {
  const mk = await bw.makeMasterKey(password, email, kdf);
  const userKey = crypto.getRandomValues(new Uint8Array(64));
  const rsa = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-1' }, true, ['encrypt', 'decrypt']);
  const json = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
  const token = await (await fetch(`${server}/identity/accounts/register/send-verification-email`, { ...json, body: JSON.stringify({ email, name: 'test' }) })).text();
  const r = await fetch(`${server}/identity/accounts/register/finish`, { ...json, body: JSON.stringify({
    email, emailVerificationToken: token, masterPasswordHash: await bw.passwordHash(mk, password), masterPasswordHint: null, ...kdf,
    userSymmetricKey: await bw.encrypt(userKey, await bw.stretch(mk)),
    userAsymmetricKeys: { publicKey: bw.b64(new Uint8Array(await crypto.subtle.exportKey('spki', rsa.publicKey))),
      encryptedPrivateKey: await bw.encrypt(new Uint8Array(await crypto.subtle.exportKey('pkcs8', rsa.privateKey)), userKey) },
  }) });
  if (!r.ok) throw new Error(`register: ${r.status} ${await r.text()}`);
  return userKey;
}
