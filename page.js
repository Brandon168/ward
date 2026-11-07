// Runs in the page itself (MAIN world) so it can wrap navigator.credentials. Passkey requests go to Ward via
// bridge.js; the answer is a credential, an error, or "fallback" to hand the call to the browser's own passkey UI.
(() => {
  const c = navigator.credentials;
  if (!c || !window.PublicKeyCredential) return;
  const native = { create: c.create.bind(c), get: c.get.bind(c) };
  const bytes = (b) => (ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b));
  const b64u = (b) => btoa(String.fromCharCode(...bytes(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const buf = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0)).buffer;
  const toJSON = (v) => (v instanceof ArrayBuffer || ArrayBuffer.isView(v) ? b64u(v)
    : Array.isArray(v) ? v.map(toJSON)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJSON(x)])) : v);
  // writable: @github/webauthn-json assigns its own credential.toJSON, which throws on a read-only property
  const props = (o) => Object.fromEntries(Object.entries(o).map(([k, value]) => [k, { value, enumerable: true, writable: true, configurable: true }]));

  // Objects with the real prototypes, so `instanceof PublicKeyCredential` holds; own values shadow the native getters.
  function credential(j) {
    const r = j.response;
    const response = r.attestationObject
      ? Object.create(AuthenticatorAttestationResponse.prototype, props({
        clientDataJSON: buf(r.clientDataJSON), attestationObject: buf(r.attestationObject), getTransports: () => r.transports,
        getAuthenticatorData: () => buf(r.authenticatorData), getPublicKey: () => buf(r.publicKey), getPublicKeyAlgorithm: () => r.publicKeyAlgorithm,
      }))
      : Object.create(AuthenticatorAssertionResponse.prototype, props({
        clientDataJSON: buf(r.clientDataJSON), authenticatorData: buf(r.authenticatorData), signature: buf(r.signature),
        userHandle: r.userHandle ? buf(r.userHandle) : null,
      }));
    return Object.create(PublicKeyCredential.prototype, props({
      id: j.id, rawId: buf(j.rawId), type: j.type, authenticatorAttachment: j.authenticatorAttachment, response,
      getClientExtensionResults: () => j.clientExtensionResults, toJSON: () => j,
    }));
  }

  // ponytail: an AbortSignal on the request is ignored; the Ward window stays open until answered or closed.
  const ask = (kind, publicKey) => new Promise((resolve) => {
    const id = crypto.randomUUID();
    const done = (r) => (removeEventListener('message', on), clearTimeout(t), resolve(r));
    const on = (e) => e.source === window && e.data?.bwliteRes === id && done(e.data);
    // background.js gives the window the same clamped deadline; the 5 s slack lets the window's answer arrive first
    const t = setTimeout(() => done({ error: { name: 'NotAllowedError', message: 'Timed out' } }),
      Math.min(Math.max(Number(publicKey.timeout) || 300e3, 60e3), 600e3) + 5e3);
    addEventListener('message', on);
    postMessage({ bwliteReq: id, kind, options: toJSON(publicKey) }, '*');
  });

  // Passkey autofill (mediation: conditional): Ward holds it if it has a passkey for the site (its field menu offers it),
  // else the browser gets it. "device": the browser's prompt; cancelling that returns to Ward. The signal aborts.
  const conditional = (o) => new Promise((resolve, reject) => {
    const signal = o.signal;
    let id, t;
    const end = () => (removeEventListener('message', on), clearTimeout(t), signal?.removeEventListener('abort', abort));
    const abort = () => (end(), postMessage({ wardCondEnd: id }, '*'), reject(signal.reason));
    const on = (e) => {
      const r = e.source === window && e.data?.bwliteRes === id && e.data;
      if (!r) return;
      if (r.hold) return clearTimeout(t);
      end();
      if (r.result) return resolve(credential(r.result));
      if (r.device) return native.get({ ...o, mediation: 'optional' }).then(resolve, (x) => (signal?.aborted ? reject(x) : start()));
      native.get(o).then(resolve, reject);
    };
    const start = () => {
      if (signal?.aborted) return reject(signal.reason);
      id = crypto.randomUUID();
      addEventListener('message', on);
      signal?.addEventListener('abort', abort, { once: true });
      t = setTimeout(() => (postMessage({ wardCondEnd: id }, '*'), on({ source: window, data: { bwliteRes: id, fallback: true } })), 5e3);
      postMessage({ bwliteReq: id, kind: 'get', conditional: true, options: toJSON(o.publicKey) }, '*');
    };
    start();
  });
  const wrap = (kind) => async function (o) {
    if (!o?.publicKey) return native[kind](o);
    if (o.mediation === 'conditional') return kind === 'get' ? conditional(o) : native[kind](o);
    const r = await ask(kind, o.publicKey);
    if (r.fallback) return native[kind](o);
    if (r.error) throw new DOMException(r.error.message, r.error.name);
    return credential(r.result);
  };
  c.create = wrap('create');
  c.get = wrap('get');
  // Ward is a user-verifying platform authenticator, so sites offer passkey creation even without Hello / Touch ID.
  PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => true;
  const caps = PublicKeyCredential.getClientCapabilities?.bind(PublicKeyCredential);
  if (caps) PublicKeyCredential.getClientCapabilities = async () => ({ ...await caps(), userVerifyingPlatformAuthenticator: true });
})();
