// Touch ID unlock (experimental): the vault keys are wrapped with a key that only the platform authenticator can
// re-derive, through the WebAuthn PRF extension, after user verification (Touch ID, or the device password).
//
//   enroll:  create a credential for this extension with PRF (no rp.id: Chromium scopes WebAuthn on extension pages
//            to the chrome-extension://<id> origin, which needs the pinned extension ID), evaluate PRF on a
//            random salt, HKDF the output into an AES-256-GCM key and encrypt each open vault's user key with it.
//   unlock:  one WebAuthn get() with the same salt gives the same PRF output, which decrypts the user keys.
//
// Stored (chrome.storage.local `touchUnlock`): credential ID, salt, rpId and the wrapped keys. Never the PRF output
// or the wrapping key. Without the authenticator and a successful verification the wrapped keys are useless, which
// is what makes this safer than "Never lock" (that stores the raw key). Note: if the browser stores the credential
// in a synced passkey provider (iCloud Keychain, Google Password Manager), its PRF secret syncs with it, so the
// guarantee is "your passkey provider plus user verification", not "this device only".
const te = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const PASSWORD_EVERY_DAYS = 14; // like 1Password: the master password is still needed now and then

// Wrapping key from a PRF output. info binds it to this credential.
export async function wrappingKey(prfOutput, credId) {
  const ikm = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: te.encode('ward-touch-unlock'), info: te.encode(`v1:${credId}`) },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function wrap(key, accountId, userKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(accountId) }, key, userKey);
  return { iv: b64(iv), ct: b64(ct) };
}
export async function unwrap(key, accountId, w) {
  const out = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(w.iv), additionalData: te.encode(accountId) }, key, unb64(w.ct)));
  if (out.length !== 64) throw new Error('unexpected key length');
  return out;
}

const prfFirst = (cred) => {
  const r = cred?.getClientExtensionResults?.().prf;
  return r?.results?.first ? new Uint8Array(r.results.first) : null;
};

async function assertion(rpId, credId, salt) {
  const cred = await navigator.credentials.get({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)), ...(rpId && { rpId }), timeout: 60e3, userVerification: 'required',
    allowCredentials: [{ type: 'public-key', id: unb64(credId) }],
    extensions: { prf: { eval: { first: unb64(salt) } } },
  } });
  const out = prfFirst(cred);
  if (!out) throw new Error('The authenticator answered without a PRF result, so it cannot unlock Ward.');
  return out;
}

// rpId: null on extension pages (the browser uses the extension origin). keys: [[accountId, userKey bytes]] for the
// vaults that are open now. log(step) reports progress for diagnostics.
export async function enroll(rpId, keys, log = () => {}) {
  if (!keys.length) throw new Error('Unlock a vault first');
  const salt = b64(crypto.getRandomValues(new Uint8Array(32)));
  log('creating a credential (Touch ID prompt 1)');
  const cred = await navigator.credentials.create({ publicKey: {
    rp: { ...(rpId && { id: rpId }), name: 'Ward' },
    user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'Ward unlock', displayName: 'Ward unlock' },
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'discouraged', userVerification: 'required' },
    hints: ['client-device'], timeout: 60e3, attestation: 'none',
    extensions: { prf: { eval: { first: unb64(salt) } } },
  } });
  const ext = cred.getClientExtensionResults?.() || {};
  log(`credential created; prf.enabled = ${ext.prf?.enabled}; PRF result at create: ${!!ext.prf?.results?.first}`);
  if (ext.prf?.enabled === false) throw new Error('This browser/authenticator does not support the WebAuthn PRF extension.');
  const credId = b64(cred.rawId);
  let out = prfFirst(cred);
  if (!out) {
    log('evaluating PRF (Touch ID prompt 2)');
    out = await assertion(rpId, credId, salt);
  }
  const key = await wrappingKey(out, credId);
  const wrapped = {};
  for (const [id, userKey] of keys) wrapped[id] = await wrap(key, id, userKey);
  log(`wrapped ${keys.length} vault key(s)`);
  return { v: 1, rpId, credId, salt, wrapped, createdAt: Date.now(), attachment: cred.authenticatorAttachment || null };
}

// Returns [[accountId, userKey]] for the wrapped vaults (one verification for all of them).
// passwordAt: when the master password was last typed (login or password unlock), kept outside the record so
// re-enrolling can't reset it.
export async function unlockKeys(record, log = () => {}, passwordAt = 0) {
  if (Date.now() - (passwordAt || 0) > PASSWORD_EVERY_DAYS * 864e5)
    throw Object.assign(new Error(`Enter your master password: it is needed every ${PASSWORD_EVERY_DAYS} days.`), { needPassword: true });
  log('verifying (Touch ID prompt)');
  const key = await wrappingKey(await assertion(record.rpId, record.credId, record.salt), record.credId);
  const out = [];
  for (const [id, w] of Object.entries(record.wrapped || {})) {
    try { out.push([id, await unwrap(key, id, w)]); } catch { log(`could not unwrap the key for vault ${id}`); }
  }
  if (!out.length) throw new Error('Touch ID worked, but no vault key could be opened. Set up Touch ID again.');
  return out;
}

// What this browser says it supports, for the diagnostics report.
export async function capabilities() {
  const PKC = globalThis.PublicKeyCredential;
  const out = { webauthn: !!PKC, userAgent: navigator.userAgent, origin: location.origin };
  if (!PKC) return out;
  try { out.platformAuthenticator = await PKC.isUserVerifyingPlatformAuthenticatorAvailable(); } catch (e) { out.platformAuthenticator = `error: ${e.name}`; }
  try { if (PKC.getClientCapabilities) out.clientCapabilities = await PKC.getClientCapabilities(); } catch (e) { out.clientCapabilities = `error: ${e.name}`; }
  return out;
}
