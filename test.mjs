// Offline checks for bw.js; add --integration to run the optional throwaway Vaultwarden checks:
//   docker run -d --name bwlite-vw -p 127.0.0.1:8099:80 -e I_REALLY_WANT_VOLATILE_STORAGE=true vaultwarden/server
//   node test.mjs --integration
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as bw from './bw.js';
import { mutateAccounts, withStateLock, AUTO_LOCK_CHOICES, autoLockMinutes, shouldAutoLock, lockEverything } from './coord.js';
import { fillTab, formFrameAllowed } from './autofill.js';
import * as touch from './touch.js';
import { storeSync, hasInvocation, SIGNALR_PING, syncOpenVault } from './sync.js';
import * as gen from './gen.js';
import { securityKeyPrompt } from './twostep.js';

globalThis.hashwasm = createRequire(import.meta.url)('./vendor/argon2.umd.min.js');
const SERVER = process.env.SERVER || 'http://localhost:8099';
const PASSWORD = 'correct horse battery staple';

// Offline checks
assert.equal((await bw.totp('otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8', 59e3)).code, '94287082'); // RFC 6238
assert.equal((await bw.totp('GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ', 1111111109e3)).code, '081804');
await assert.rejects(bw.totp('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=7'), /digits/i);
await assert.rejects(bw.totp('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=100000'), /digits/i);
await assert.rejects(bw.totp('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=-1'), /period/i);
await assert.rejects(bw.totp('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=999999999'), /period/i);
await assert.rejects(bw.totp('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5'), /algorithm/i);
await assert.rejects(bw.totp('otpauth://totp/x?secret=&digits=6'), /secret/i);
const k = crypto.getRandomValues(new Uint8Array(64));
assert.equal(new TextDecoder().decode(await bw.decrypt(await bw.encrypt('héllo', k), k)), 'héllo');
await assert.rejects(bw.decrypt(await bw.encrypt('x', k), crypto.getRandomValues(new Uint8Array(64))), /MAC mismatch/);
const jwt = `x.${Buffer.from(JSON.stringify({ sub: 'user' })).toString('base64url')}.x`;
const oldFetch = globalThis.fetch;
let savedBody;
globalThis.fetch = async (_url, options) => (savedBody = JSON.parse(options.body), { ok: true, text: async () => JSON.stringify({ id: 'saved' }) });
const rawUnknown = { id: 'raw', revisionDate: '1', type: 1, data: { opaque: 'keep' }, login: {} };
await bw.saveCipher({ server: 'https://vault.example', tokens: { access: jwt, expires: Date.now() + 60e3 } }, k,
  { id: 'raw', raw: rawUnknown, key: k, password: 'old', uris: [] },
  { name: 'Name', username: 'u', password: 'new', totp: '', notes: '', uris: [] });
globalThis.fetch = oldFetch;
assert.deepEqual(savedBody.data, { opaque: 'keep' }, 'unknown cipher fields survive an edit');
assert.equal(savedBody.lastKnownRevisionDate, '1', 'edits keep the revision captured by the form for optimistic concurrency');
await assert.rejects(bw.saveCipher({ server: 'https://vault.example', tokens: { access: jwt, expires: Date.now() + 60e3 } }, k,
  { id: 'ro', raw: { edit: false }, key: k }, { name: 'x', username: '', password: '', totp: '', notes: '', uris: [] }), /read-only/i);
await assert.rejects(bw.saveCipher({ server: 'https://vault.example', tokens: { access: jwt, expires: Date.now() + 60e3 } }, k,
  { id: 'missing' }, { name: 'x', username: '', password: '', totp: '', notes: '', uris: [] }), /incomplete/i);
const item = (uris, m) => ({ uris, m });
assert.ok(bw.matches(item(['https://accounts.google.com/login']), 'https://mail.google.com/'));
assert.ok(bw.matches(item(['github.com']), 'https://github.com/login'));
assert.ok(!bw.matches(item(['https://a.co.uk']), 'https://b.co.uk/'));
assert.ok(!bw.matches(item(['http://192.168.1.10']), 'http://10.0.1.10/'));
assert.ok(!bw.matches(item(['androidapp://com.foo']), 'https://evil.com/'));
assert.equal(bw.baseDomain('login.github.io'), 'login.github.io');
assert.equal(bw.baseDomain('foo.pages.dev'), 'foo.pages.dev');
assert.equal(bw.baseDomain('a.co.uk'), 'a.co.uk');
assert.ok(bw.isPublicSuffix('github.io'));
assert.ok(!bw.isPublicSuffix('login.github.io'));
assert.ok(!bw.matches(item(['https://alice.github.io']), 'https://bob.github.io/'));
assert.ok(!bw.matches(item(['https://alice.pages.dev']), 'https://bob.pages.dev/'));
assert.equal(bw.baseDomain('city.kawasaki.jp'), 'city.kawasaki.jp'); // PSL exception
assert.equal(bw.baseDomain('a.b.ck'), 'a.b.ck'); // PSL wildcard
assert.equal(bw.baseDomain('BÜCHER.DE'), 'xn--bcher-kva.de'); // IDNA normalization
assert.ok(bw.matches(item(['https://BÜCHER.DE']), 'https://xn--bcher-kva.de/'));
assert.ok(bw.isPublicSuffix('公司.cn'), 'Unicode PSL rules are normalized to IDNA');
assert.equal(bw.baseDomain('alice.公司.cn'), 'alice.xn--55qx5d.cn');
assert.ok(!bw.matches(item(['https://alice.公司.cn']), 'https://bob.公司.cn/'));
const ror = { origins: ['https://facebook.com', 'https://www.facebook.com', 'not a url', 'https://github.io', 'https://a.messenger.com', 'https://instagram.com', 'https://meta.com', 'https://muse.ai', 'https://sixth.example', 'https://www.instagram.com'] };
assert.ok(bw.relatedOrigin(ror, 'https://www.facebook.com'));
assert.ok(bw.relatedOrigin(ror, 'https://www.instagram.com'), 'a label already seen still counts after the limit');
assert.ok(!bw.relatedOrigin(ror, 'https://sixth.example'), 'only 5 distinct labels count');
assert.ok(!bw.relatedOrigin(ror, 'https://m.facebook.com'));
assert.ok(!bw.relatedOrigin({}, 'https://www.facebook.com'));
assert.ok(!bw.matches({ uris: ['https://old.invalid'], d: ['example.com'] }, 'https://example.com/', null));
// per-URI match types: 1 host, 2 starts with, 3 exact, 4 regex, 5 never
assert.ok(bw.matches(item(['https://a.example.com'], [1]), 'https://a.example.com/x'));
assert.ok(!bw.matches(item(['https://a.example.com'], [1]), 'https://b.example.com/'));
assert.ok(!bw.matches(item(['https://a.example.com:8443'], [1]), 'https://a.example.com/'));
assert.ok(bw.matches(item(['https://example.com/app'], [2]), 'https://example.com/app/login'));
assert.ok(!bw.matches(item(['https://example.com/app'], [2]), 'https://example.com/other'));
assert.ok(bw.matches(item(['https://example.com/login'], [3]), 'https://example.com/login'));
assert.ok(!bw.matches(item(['https://example.com/login'], [3]), 'https://example.com/login?x'));
assert.ok(bw.matches(item(['^https://(www\\.)?example\\.com/'], [4]), 'https://www.example.com/a'));
assert.ok(!bw.matches(item(['(unclosed'], [4]), 'https://example.com/'));
assert.ok(!bw.matches(item(['https://example.com'], [5]), 'https://example.com/'));
assert.ok(bw.matches(item(['https://example.com', 'https://x.org'], [5, null]), 'https://x.org/'));
// equivalent domains
const eq = bw.equivalents([['youtube.com', 'google.com', 'google.co.uk']]);
assert.ok(bw.matches(item(['https://accounts.google.com']), 'https://www.youtube.com/', eq));
assert.ok(bw.matches(item(['https://google.co.uk']), 'https://accounts.google.com/', eq));
assert.ok(!bw.matches(item(['https://accounts.google.com']), 'https://www.youtube.com/'));
const transitive = bw.equivalents([['one.example', 'two.example'], ['two.example', 'three.example']]);
assert.ok(bw.matches(item(['https://one.example']), 'https://three.example/', transitive));
assert.ok(!bw.matches({ bad: true }, 'https://example.com/'));
// best first: last used, then vault order
const logins = [{ a: 'v2', id: '1', uris: ['x.com'] }, { a: 'v1', id: '2', uris: ['x.com'] }, { a: 'v1', id: '3', uris: ['y.com'] }];
const rank = (a) => ['v1', 'v2'].indexOf(a);
assert.deepEqual(bw.forSite(logins, 'https://x.com/', null, rank).map((i) => i.id), ['2', '1']);
assert.deepEqual(bw.forSite(logins, 'https://x.com/', null, rank, { 'v2:1': 5 }).map((i) => i.id), ['1', '2']);
const perVaultEq = new Map([
  ['v1', bw.equivalents([['one.example', 'shared.example']])],
  ['v2', bw.equivalents([['two.example', 'other.example']])],
]);
const grouped = [{ a: 'v1', id: 'one', uris: ['https://one.example'] }, { a: 'v2', id: 'two', uris: ['https://two.example'] }];
assert.deepEqual(bw.forSite(grouped, 'https://shared.example/', (i) => perVaultEq.get(i.a), rank).map((i) => i.id), ['one']);
{ // an edited URL keeps the match type of the URL in its place
  const k = crypto.getRandomValues(new Uint8Array(64)), realFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_, o) => ((body = JSON.parse(o.body)), { ok: true, text: async () => '{}' });
  const s = { server: 'https://vault.example', tokens: { access: `x.${btoa('{"sub":"u"}')}.y`, expires: Infinity } };
  const old = { id: 'c', key: k, uris: ['https://old.example'], raw: { id: 'c', login: { uris: [{ uri: '2.x', match: 3 }] } } };
  await bw.saveCipher(s, k, old, { name: 'n', uris: ['https://new.example'] }).finally(() => (globalThis.fetch = realFetch));
  assert.equal(body.login.uris[0].match, 3);
  // match types chosen in the edit form are saved as given; a bad one or a broken regex is refused
  globalThis.fetch = async (_, o) => ((body = JSON.parse(o.body)), { ok: true, text: async () => '{}' });
  await bw.saveCipher(s, k, old, { name: 'n', uris: ['https://a.example', 'https://b.example'], match: [1, null] });
  assert.deepEqual(body.login.uris.map((u) => u.match), [1, null]);
  await assert.rejects(bw.saveCipher(s, k, old, { name: 'n', uris: ['https://a.example'], match: [9] }), /match types/);
  await assert.rejects(bw.saveCipher(s, k, old, { name: 'n', uris: ['(x'], match: [4] }), /regular expression/);
  globalThis.fetch = realFetch;
}
{ // the default match detection (Settings > Matching) applies to URLs without their own
  const gym = item(['https://gym.7ven.org']);
  assert.ok(bw.matches(gym, 'https://qb.7ven.org/'), 'base domain by default');
  assert.equal(bw.setDefaultMatch(1), 1);
  assert.ok(!bw.matches(gym, 'https://qb.7ven.org/'), 'host default keeps a subdomain login on its subdomain');
  assert.ok(bw.matches(gym, 'https://gym.7ven.org/login'));
  assert.ok(bw.matches(item(['https://gym.7ven.org'], [0]), 'https://qb.7ven.org/'), 'an explicit base domain still wins');
  assert.equal(bw.setDefaultMatch(5), 0, 'never and unknown values fall back to base domain');
  assert.equal(bw.setDefaultMatch(undefined), 0);
}

// Two popup-like contexts must merge account patches while one is suspended;
// the second writer must never replace the first writer's latest list.
let accountRows = [{ id: 'a', label: 'A' }];
const accountStorage = {
  async get() { return { accounts: structuredClone(accountRows) }; },
  async set({ accounts }) { await new Promise((resolve) => setTimeout(resolve, 0)); accountRows = structuredClone(accounts); },
};
const oldLocks = globalThis.navigator?.locks;
Object.defineProperty(globalThis.navigator, 'locks', { configurable: true, value: {
  queue: Promise.resolve(),
  request(_name, _options, fn) { const job = this.queue.catch(() => {}).then(fn); this.queue = job.catch(() => {}); return job; },
} });
await Promise.all([
  mutateAccounts(accountStorage, async (rows) => { await new Promise((resolve) => setTimeout(resolve, 2)); return rows.map((a) => ({ ...a, label: 'renamed' })); }),
  mutateAccounts(accountStorage, (rows) => [...rows, { id: 'b', label: 'B' }]),
]);
assert.deepEqual(accountRows, [{ id: 'a', label: 'renamed' }, { id: 'b', label: 'B' }]);
await mutateAccounts(accountStorage, (rows) => rows.filter((a) => a.id !== 'a'));
await mutateAccounts(accountStorage, (rows) => rows.map((a) => a.id === 'a' ? { ...a, persistKey: 'stale' } : a));
assert.ok(!accountRows.some((a) => a.id === 'a'), 'a removed account cannot be resurrected by a stale patch');
if (oldLocks) Object.defineProperty(globalThis.navigator, 'locks', { configurable: true, value: oldLocks });
else delete globalThis.navigator.locks;
const oldChrome = globalThis.chrome;
let fillCalls = 0;
const fillTargets = [];
globalThis.chrome = { scripting: { executeScript: async ({ target, files, func }) => {
  fillCalls++;
  fillTargets.push(target);
  if (files) return [];
  if (target.allFrames) return [{ frameId: 0, result: 'https://example.com/login' }];
  return [{ result: true }];
} } };
let authorized = false;
assert.equal(await fillTab(1, { uris: ['https://example.com'] }, null, null, async () => authorized), false);
assert.equal(fillCalls, 0, 'fill does not inject before the authorization guard');
authorized = true;
assert.equal(await fillTab(1, { uris: ['https://example.com'] }, null, null, async () => authorized), true);
assert.deepEqual(fillTargets, [{ tabId: 1, allFrames: true }, { tabId: 1, allFrames: true }, { tabId: 1, frameIds: [0] }],
  'fill checks every frame and fills only the matching one');
if (oldChrome) globalThis.chrome = oldChrome;
else delete globalThis.chrome;
console.log('offline checks ok');

// --- Ward hardening -------------------------------------------------------------
assert.throws(() => bw.checkKdf({ kdf: 0, kdfIterations: 1 }), /Refusing PBKDF2/, 'a server cannot ask for 1 PBKDF2 iteration');
assert.throws(() => bw.checkKdf({ kdf: 0, kdfIterations: 5e7 }), /Refusing PBKDF2/, 'nor an absurd count that hangs the popup');
assert.throws(() => bw.checkKdf({ kdf: 1, kdfIterations: 1, kdfMemory: 64, kdfParallelism: 4 }), /Refusing Argon2id/);
assert.throws(() => bw.checkKdf({ kdf: 1, kdfIterations: 3, kdfMemory: 1, kdfParallelism: 4 }), /Refusing Argon2id/);
assert.throws(() => bw.checkKdf({ kdf: 1, kdfIterations: 3, kdfMemory: 64 * 1024, kdfParallelism: 4 }), /Refusing Argon2id/);
assert.throws(() => bw.checkKdf({ kdf: 7 }), /Unsupported KDF/);
bw.checkKdf({ kdf: 0, kdfIterations: 600000 });
bw.checkKdf({ kdf: 1, kdfIterations: 3, kdfMemory: 64, kdfParallelism: 4 });
await assert.rejects(bw.makeMasterKey('pw', 'a@b.c', { kdf: 0, kdfIterations: 1 }), /Refusing PBKDF2/, 'unlock checks the stored KDF too');
const a2 = { kdf: 1, kdfIterations: 3, kdfMemory: 64, kdfParallelism: 4 };
assert.ok(bw.kdfWeaker({ kdf: 0, kdfIterations: 600000 }, a2), 'Argon2id to PBKDF2 is a downgrade');
assert.ok(bw.kdfWeaker({ ...a2, kdfMemory: 16 }, a2));
assert.ok(bw.kdfWeaker({ kdf: 0, kdfIterations: 100000 }, { kdf: 0, kdfIterations: 600000 }));
assert.ok(!bw.kdfWeaker({ kdf: 0, kdfIterations: 600000 }, { kdf: 0, kdfIterations: 600000 }));
assert.ok(!bw.kdfWeaker(a2, { kdf: 0, kdfIterations: 600000 }), 'PBKDF2 to Argon2id is fine');
assert.ok(!bw.kdfWeaker(a2, undefined), 'first login: nothing pinned');
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ kdf: 0, kdfIterations: 1 }) });
  await assert.rejects(bw.login('https://vault.example', 'a@b.c', 'pw', 'dev'), /Refusing PBKDF2/, 'login refuses a weak prelogin before sending any hash');
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ kdf: 0, kdfIterations: 600000 }) });
  await assert.rejects(bw.login('https://vault.example', 'a@b.c', 'pw', 'dev', null, null, a2), /weaker key derivation/, 'a re-login cannot be downgraded');
  globalThis.fetch = realFetch;
}
const wi = (uris, m) => ({ uris, m });
assert.ok(!bw.matches(wi(['https://bank.com']), 'http://x.bank.com/'), 'an https login is never offered on an http page');
assert.ok(!bw.matches(wi(['bank.com']), 'http://bank.com/'), 'schemeless public hosts count as https');
assert.ok(bw.matches(wi(['http://legacy.example']), 'http://legacy.example/'), 'explicit http:// still matches http');
assert.ok(bw.matches(wi(['192.168.1.1']), 'http://192.168.1.1/'), 'router by IP');
assert.ok(bw.matches(wi(['nas.local:5000']), 'http://nas.local:5000/'), 'local host with port');
assert.ok(bw.matches(wi(['bank.com']), 'https://www.bank.com/'), 'https base-domain matching unchanged');
assert.ok(!bw.matches(wi(['https://bank.com'], [2]), 'https://bank.com.evil.net/'), 'starts-with compares the origin first');
assert.ok(bw.matches(wi(['https://bank.com/login'], [2]), 'https://bank.com/login?next=1'));
assert.ok(!bw.matches(wi(['https://bank.com/login'], [2]), 'https://bank.com/other'));
assert.equal(autoLockMinutes(undefined), 30);
assert.equal(autoLockMinutes(0), 0);
assert.equal(autoLockMinutes(7), 30, 'unknown choices fall back to the default');
assert.ok(shouldAutoLock('locked', {}), 'screen lock locks by default');
assert.ok(shouldAutoLock('idle', { autoLock: 5 }));
assert.ok(!shouldAutoLock('active', {}));
assert.ok(!shouldAutoLock('locked', { neverLock: true }), 'Never lock overrides auto-lock');
assert.ok(!shouldAutoLock('locked', { autoLock: 0 }), '"when the browser quits" ignores screen lock');
{
  const mem = (init) => { const d = new Map(Object.entries(init)); return { d,
    get: async (k) => Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => d.has(x)).map((x) => [x, structuredClone(d.get(x))])),
    set: async (o) => { for (const [x, v] of Object.entries(o)) d.set(x, structuredClone(v)); }, clear: async () => d.clear() }; };
  const l = mem({ accounts: [{ id: 'a', persistKey: 'k' }, { id: 'b' }] }), s = mem({ 'a:key': 'k', 'a:list': '[]', 'pending:3': { password: 'x' } });
  await lockEverything(l, s);
  assert.deepEqual(l.d.get('accounts'), [{ id: 'a' }, { id: 'b' }], 'auto-lock drops persisted keys');
  assert.equal(s.d.size, 0, 'auto-lock clears keys, lists and pending save offers');
}
console.log('ward hardening checks ok');

{ // Touch ID unlock: PRF output -> HKDF -> AES-GCM wrapped user keys; a mock authenticator returns SHA-256(salt).
  const prfOf = async (salt) => new Uint8Array(await crypto.subtle.digest('SHA-256', salt));
  const calls = [];
  const mockCreds = {
    create: async ({ publicKey: o }) => (calls.push(['create', o]), { rawId: new Uint8Array([1, 2, 3]).buffer, authenticatorAttachment: 'platform',
      getClientExtensionResults: () => ({ prf: { enabled: true } }) }),
    get: async ({ publicKey: o }) => {
      calls.push(['get', o]);
      const first = (await prfOf(o.extensions.prf.eval.first)).buffer;
      return { getClientExtensionResults: () => ({ prf: { results: { first } } }) };
    },
  };
  Object.defineProperty(globalThis.navigator, 'credentials', { value: mockCreds, configurable: true });
  const k1 = crypto.getRandomValues(new Uint8Array(64)), k2 = crypto.getRandomValues(new Uint8Array(64));
  const rec = await touch.enroll(null, [['a', k1], ['b', k2]]);
  assert.equal(calls[0][1].rp.id, undefined, 'extension pages leave rp.id to the browser (extension origin)');
  assert.equal(calls[1][1].rpId, undefined);
  assert.equal(calls[0][1].authenticatorSelection.userVerification, 'required');
  assert.equal(calls[1][1].userVerification, 'required', 'every PRF evaluation needs user verification');
  assert.ok(!JSON.stringify(rec).includes(Buffer.from(k1).toString('base64')), 'the raw key is never stored');
  const got = new Map(await touch.unlockKeys(rec, undefined, Date.now()));
  assert.deepEqual(got.get('a'), k1);
  assert.deepEqual(got.get('b'), k2);
  const swapped = { ...rec, wrapped: { a: rec.wrapped.b, b: rec.wrapped.a } };
  await assert.rejects(touch.unlockKeys(swapped, undefined, Date.now()), /no vault key/, 'a wrapped key is bound to its vault id');
  await assert.rejects(touch.unlockKeys(rec, undefined, Date.now() - 15 * 864e5), /every 14 days/);
  await assert.rejects(touch.unlockKeys(rec), /every 14 days/, 'no password ever typed: password first');
  assert.equal(rec.passwordAt, undefined, 'enrolling cannot reset the password timer');
  mockCreds.get = async () => ({ getClientExtensionResults: () => ({ prf: {} }) });
  await assert.rejects(touch.unlockKeys(rec, undefined, Date.now()), /without a PRF result/);
  mockCreds.create = async () => ({ rawId: new Uint8Array([9]).buffer, getClientExtensionResults: () => ({ prf: { enabled: false } }) });
  await assert.rejects(touch.enroll(null, [['a', k1]]), /does not support the WebAuthn PRF/);
  delete globalThis.navigator.credentials;
}
console.log('touch id checks ok');

{ // Cards and identities: field recognition (formfill.js), values, frames, brands
  const ctx = {}; ctx.globalThis = ctx;
  vm.runInNewContext(await readFile('./formfill.js', 'utf8'), ctx);
  const C = (h) => ctx.wardClassify(h, 'card'), I = (h) => ctx.wardClassify(h, 'identity');
  // Stripe Elements and other autocomplete-tagged fields
  assert.equal(C({ ac: 'cc-number', text: 'cardnumber' }), 'cc-number');
  assert.equal(C({ ac: 'cc-exp', text: 'exp-date' }), 'cc-exp');
  assert.equal(C({ ac: 'cc-csc', text: 'cvc' }), 'cc-csc');
  assert.equal(C({ ac: 'billing cc-name' }), 'cc-name');
  assert.equal(I({ ac: 'shipping address-line1' }), 'address-line1');
  assert.equal(I({ ac: 'section-ship shipping postal-code' }), 'postal-code');
  // heuristics on name/id/label
  assert.equal(C({ text: 'card-number Card number' }), 'cc-number');
  assert.equal(C({ text: 'ccExpMonth Expiration month' }), 'cc-exp-month');
  assert.equal(C({ text: 'expYear Expiry year' }), 'cc-exp-year');
  assert.equal(C({ text: 'expiry MM / YY' }), 'cc-exp');
  assert.equal(C({ text: 'cvv Security code' }), 'cc-csc');
  assert.equal(C({ text: 'nameOnCard Name on card' }), 'cc-name');
  assert.equal(C({ text: 'creditCardName' }), 'cc-name');
  assert.equal(I({ text: 'firstName First name' }), 'given-name');
  assert.equal(I({ text: 'last_name' }), 'family-name');
  assert.equal(I({ text: 'zip ZIP code' }), 'postal-code');
  assert.equal(I({ text: 'address2 Apartment, suite, etc.' }), 'address-line2');
  assert.equal(I({ text: 'address1 Street address' }), 'address-line1');
  assert.equal(I({ text: 'city' }), 'address-level2');
  assert.equal(I({ text: 'state State' }), 'address-level1');
  assert.equal(I({ text: 'country Country/Region' }), 'country');
  assert.equal(I({ type: 'email', text: 'contact' }), 'email');
  assert.equal(I({ type: 'tel', text: 'phone' }), 'tel');
  assert.equal(I({ text: 'company Company name' }), 'organization');
  assert.equal(I({ text: 'fullName Full name' }), 'name');
  // never cross-fill: login fields and the other kind
  assert.equal(I({ ac: 'username', text: 'username' }), null, 'login fields are left alone');
  assert.equal(I({ ac: 'current-password' }), null);
  assert.equal(C({ type: 'email', text: 'email' }), null, 'a card never fills the email');
  assert.equal(I({ ac: 'cc-number' }), null, 'an identity never fills a card field');
  assert.equal(C({ text: 'search' }), null);
  // values
  const card = { cardholderName: 'Ann Lee', number: '4111 1111 1111 1111', expMonth: '3', expYear: '2029', code: '123', brand: 'Visa' };
  const V = (k, el) => ctx.wardValueFor(k, card, el);
  assert.equal(V('cc-number'), '4111111111111111');
  assert.equal(V('cc-exp', { placeholder: 'MM / YY' }), '03/29');
  assert.equal(V('cc-exp', { placeholder: 'MM/YYYY' }), '03/2029');
  assert.equal(V('cc-exp', { maxLength: 4 }), '0329');
  assert.deepEqual([...V('cc-exp-month')].slice(0, 4), ['03', '3', 'march', 'mar']);
  assert.equal(V('cc-exp-year', { maxLength: 2 })[0], '29');
  assert.equal(V('cc-exp-year', {})[0], '2029');
  assert.equal(ctx.wardValueFor('name', { firstName: 'Ann', middleName: 'B', lastName: 'Lee' }), 'Ann B Lee');
  assert.equal(ctx.wardValueFor('street-address', { address1: '1 Main St', address2: 'Apt 2' }, { tagName: 'INPUT' }), '1 Main St, Apt 2');
  // frames
  const T = 'https://shop.example.com/checkout';
  assert.ok(formFrameAllowed('card', T, 'https://shop.example.com/pay'));
  assert.ok(formFrameAllowed('card', T, 'https://cdn.example.com/frame'), 'same site');
  assert.ok(formFrameAllowed('card', T, 'https://js.stripe.com/v3/elements-inner-card.html'), 'payment provider');
  assert.ok(formFrameAllowed('card', T, 'https://assets.braintreegateway.com/hosted-fields'));
  assert.ok(!formFrameAllowed('identity', T, 'https://js.stripe.com/v3/'), 'identities stay on the site');
  assert.ok(!formFrameAllowed('card', T, 'https://ads.tracker.net/frame'), 'not any third party');
  assert.ok(!formFrameAllowed('card', T, 'https://evilstripe.com/x'), 'suffix match is on a label boundary');
  assert.ok(!formFrameAllowed('card', 'http://shop.example.com/', 'http://shop.example.com/'), 'https only');
  assert.ok(!formFrameAllowed('card', T, 'http://js.stripe.com/'), 'https frames only');
  assert.equal(bw.cardBrand('4111111111111111'), 'Visa');
  assert.equal(bw.cardBrand('5555 5555 5555 4444'), 'Mastercard');
  assert.equal(bw.cardBrand('2221000000000009'), 'Mastercard');
  assert.equal(bw.cardBrand('378282246310005'), 'Amex');
  assert.equal(bw.cardBrand('6011111111111117'), 'Discover');
  assert.equal(bw.cardBrand(''), '');
  // cards and identities never match a site (no autofill badge, menu or shortcut)
  assert.ok(!bw.matches({ type: 3, uris: [] }, 'https://shop.example.com/'));
}
console.log('cards and identities: recognition, values, frames ok');

// Passkeys: a credential made by passkeyCreate signs assertions its public key verifies
const fromB64u = (s) => Buffer.from(s, 'base64url');
const challenge = bw.b64u(crypto.getRandomValues(new Uint8Array(32)));
const created = await bw.passkeyCreate({ challenge, rp: { name: 'Ex' }, user: { id: 'dXNlcg', name: 'ben' } }, 'https://login.example.com', 'example.com');
const pkReg = created.result.response;
assert.deepEqual(JSON.parse(fromB64u(pkReg.clientDataJSON)), { type: 'webauthn.create', challenge, origin: 'https://login.example.com', crossOrigin: false });
const regAuth = fromB64u(pkReg.authenticatorData);
assert.deepEqual(new Uint8Array(regAuth.subarray(0, 32)), new Uint8Array(nodeCrypto.createHash('sha256').update("example.com").digest()));
assert.equal(regAuth[32], 0x5d);
assert.deepEqual(new Uint8Array(regAuth.subarray(55, 55 + 16)), bw.credIdBytes(created.passkey.credentialId));
assert.ok(fromB64u(pkReg.attestationObject).includes(regAuth), 'attestationObject embeds authData');
async function verifyGet(passkey, publicKeyB64u) {
  const as = (await bw.passkeyGet(passkey, { challenge }, 'https://example.com')).response;
  const signed = Buffer.concat([fromB64u(as.authenticatorData), nodeCrypto.createHash('sha256').update(fromB64u(as.clientDataJSON)).digest()]);
  assert.ok(nodeCrypto.verify('sha256', signed, { key: fromB64u(publicKeyB64u), format: 'der', type: 'spki' }, fromB64u(as.signature)), 'assertion verifies');
  assert.equal(as.userHandle, 'dXNlcg');
}
for (let i = 0; i < 20; i++) await verifyGet(created.passkey, pkReg.publicKey); // DER edge cases (leading zero / high bit) vary per signature
assert.deepEqual(bw.credIdBytes('b64.AAEC'), new Uint8Array([0, 1, 2]));
console.log('passkey create + sign ok');

// The page bridge forwards an allowlist, never the page's arbitrary message object.
const bridgeListeners = {}, bridgePosts = [], bridgeRuntime = [];
const bridgeWindow = {};
const bridgeContext = {
  window: bridgeWindow, location: { origin: 'https://example.com' },
  addEventListener: (name, fn) => (bridgeListeners[name] = fn),
  postMessage: (m, origin) => bridgePosts.push({ m, origin }),
  chrome: {
    runtime: {
      sendMessage: async (m) => (bridgeRuntime.push(m), { bwliteRes: m.bwliteReq, fallback: true, secret: 'discard' }),
      onMessage: { addListener: (fn) => (bridgeListeners.runtime = fn) },
    },
  },
};
vm.runInNewContext(await readFile('./bridge.js', 'utf8'), bridgeContext);
await bridgeListeners.message({ source: bridgeWindow, data: {
  bwliteReq: 'bridge-1', kind: 'get', options: { challenge: 'c', rpId: 'example.com', evil: 'discard' }, evil: 'discard',
} });
assert.equal(JSON.stringify(bridgeRuntime), JSON.stringify([{ bwliteReq: 'bridge-1', kind: 'get', options: { challenge: 'c', rpId: 'example.com' } }]));
assert.equal(JSON.stringify(bridgePosts[0]), JSON.stringify({ m: { bwliteRes: 'bridge-1', fallback: true }, origin: 'https://example.com' }));
bridgeListeners.runtime({ bwliteRes: 'bridge-1', fallback: true, secret: 'discard' });
assert.equal(bridgePosts.at(-1).m.secret, undefined);
bridgeListeners.runtime({ bwliteRes: 'bridge-1', result: {
  id: 'id', rawId: 'raw', type: 'public-key', clientExtensionResults: { credProps: { rk: true }, secret: 'discard' },
  response: { signature: 's', secret: 'discard' },
} });
assert.equal(bridgePosts.at(-1).m.result.response.secret, undefined);
assert.equal(JSON.stringify(bridgePosts.at(-1).m.result.clientExtensionResults), JSON.stringify({ credProps: { rk: true } }));
await bridgeListeners.message({ source: bridgeWindow, data: {
  bwliteReq: 'bridge-2', kind: 'get', options: { challenge: 'c', allowCredentials: [{ id: 'ok' }, { noId: true }] },
} });
assert.deepEqual(bridgeRuntime.at(-1).options.allowCredentials, [{ id: 'ok' }, { noId: true }], 'bridge does not broaden malformed credential lists');
await bridgeListeners.message({ source: bridgeWindow, data: { bwliteReq: 'bridge-3', kind: 'get', options: null } });
assert.equal(JSON.stringify(bridgePosts.at(-1)), JSON.stringify({ m: { bwliteRes: 'bridge-3', fallback: true }, origin: 'https://example.com' }), 'malformed requests fall back immediately');
await bridgeListeners.message({ source: bridgeWindow, data: {
  bwliteReq: 'bridge-4', kind: 'create', options: { challenge: 'c', authenticatorSelection: { authenticatorAttachment: 'cross-platform' }, evil: 'discard' },
} });
assert.deepEqual(bridgeRuntime.at(-1).options.authenticatorSelection, { authenticatorAttachment: 'cross-platform' }, 'unsupported requirements reach the authoritative validator');
bridgeContext.chrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated.'); }; // extension reloaded under the page
await bridgeListeners.message({ source: bridgeWindow, data: { bwliteReq: 'bridge-5', kind: 'get', options: { challenge: 'c' } } });
assert.equal(JSON.stringify(bridgePosts.at(-1).m), JSON.stringify({ bwliteRes: 'bridge-5', fallback: true }), 'a dead extension context hands the request to the browser');
bridgeContext.chrome.runtime.sendMessage = async (m) => (bridgeRuntime.push(m), { bwliteRes: m.bwliteReq, fallback: true });
await bridgeListeners.message({ source: bridgeWindow, data: { bwliteReq: 'bridge-7', kind: 'create', conditional: true, options: { challenge: 'c' } } });
assert.equal(bridgeRuntime.at(-1).conditional, undefined, 'only sign-in can be passkey autofill');
bridgeContext.chrome.runtime.sendMessage = async (m) => (bridgeRuntime.push(m), { bwliteRes: m.bwliteReq, hold: true, secret: 'discard' });
await bridgeListeners.message({ source: bridgeWindow, data: { bwliteReq: 'bridge-6', kind: 'get', conditional: true, options: { challenge: 'c' } } });
assert.equal(bridgeRuntime.at(-1).conditional, true, 'passkey autofill is marked as such');
assert.equal(JSON.stringify(bridgePosts.at(-1).m), JSON.stringify({ bwliteRes: 'bridge-6', hold: true }));
assert.equal(bridgeContext.wardHeld, 'bridge-6', 'inpage.js can see that Ward holds it');
bridgeListeners.runtime({ bwliteRes: 'bridge-6', fallback: true, device: true, secret: 'discard' });
assert.equal(JSON.stringify(bridgePosts.at(-1).m), JSON.stringify({ bwliteRes: 'bridge-6', fallback: true, device: true }));
assert.equal(bridgeContext.wardHeld, null, 'answered: no longer held');
bridgeContext.wardHeld = 'bridge-8';
await bridgeListeners.message({ source: bridgeWindow, data: { wardCondEnd: 'bridge-8', evil: 'discard' } });
assert.equal(JSON.stringify(bridgeRuntime.at(-1)), JSON.stringify({ wardCondEnd: 'bridge-8' }), 'an abort carries only its id');
assert.equal(bridgeContext.wardHeld, null);
console.log('bridge boundary checks ok');

// Minimal Chrome storage/runtime harness for service-worker regressions; no browser or Docker is needed.
const changesListeners = [], runtimeListeners = [], tabUpdates = [], sentTabs = [], createdWindows = [];
const menuItems = [], menuClicks = [], offscreenMessages = [], alarmsCreated = [];
const makeArea = (area) => {
  const data = new Map();
  const keyList = (keys) => keys === null ? [...data.keys()] : Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys || {});
  return {
    data,
    async get(keys) { const out = {}; for (const k of keyList(keys)) if (data.has(k)) out[k] = data.get(k); return out; },
    async set(values) { const changes = {}; for (const [k, v] of Object.entries(values)) { changes[k] = { oldValue: data.get(k), newValue: v }; data.set(k, v); } for (const fn of changesListeners) await fn(changes, area); },
    async remove(keys) { const changes = {}; for (const k of keyList(keys)) if (data.has(k)) { changes[k] = { oldValue: data.get(k) }; data.delete(k); } for (const fn of changesListeners) await fn(changes, area); },
    async clear() { return this.remove([...data.keys()]); },
  };
};
const localStore = makeArea('local'), sessionStore = makeArea('session');
globalThis.chrome = {
  storage: {
    local: localStore, session: sessionStore,
    onChanged: { addListener: (fn) => changesListeners.push(fn) },
  },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: async () => {}, openPopup: async () => {} },
  commands: { onCommand: { addListener: () => {} } },
  tabs: {
    query: async () => [], get: async (id) => ({ id, url: 'https://two.example/home' }),
    sendMessage: async (...args) => sentTabs.push(args),
    onUpdated: { addListener: (fn) => tabUpdates.push(fn) }, onRemoved: { addListener: () => {} },
  },
  windows: { create: async (o) => createdWindows.push(o), update: async () => {} },
  runtime: { id: 'ward-test', onMessage: { addListener: (fn) => runtimeListeners.push(fn) }, sendMessage: async (m) => (offscreenMessages.push(m), { ok: true }) },
  scripting: { executeScript: async () => [] },
  contextMenus: { create: (o) => menuItems.push(o), removeAll: async () => { menuItems.length = 0; }, onClicked: { addListener: (fn) => menuClicks.push(fn) } },
  offscreen: { hasDocument: async () => false, createDocument: async () => {}, closeDocument: async () => {} },
  alarms: { create: (name, o) => alarmsCreated.push([name, o]) },
};
await import(`./background.js?offline=${Date.now()}`);
const sendRuntime = (message, sender = { tab: { id: 1 }, url: 'https://one.example/' }) => new Promise((resolve) => {
  for (const listener of runtimeListeners) {
    let answered = false;
    const reply = (value) => { answered = true; resolve(value); };
    const ret = listener(message, sender, reply);
    if (ret !== true && !answered) resolve(undefined);
  }
});
const accountA = { id: 'a', label: 'A' }, accountB = { id: 'b', label: 'B' };
await localStore.set({ accounts: [accountA, accountB] });
const testSessionKey = bw.b64(new Uint8Array(64));
await sessionStore.set({ 'a:key': testSessionKey, 'a:list': '{bad', 'b:key': testSessionKey, 'b:list': JSON.stringify([{ id: 'b1', name: 'B', username: 'u', password: 'p', uris: ['https://two.example'] }]) });
const warn = console.warn;
console.warn = () => {};
const menu = await sendRuntime({ bwliteMenu: true }, { tab: { id: 1 }, url: 'https://two.example/login' });
console.warn = warn;
assert.equal(menu[0].username, 'u', 'one corrupt account must not hide another account');
await localStore.set({ accounts: [accountA, accountB, { id: 'c', label: 'C' }] });
await sessionStore.set({ 'c:list': JSON.stringify([{ id: 'c1', name: 'C', username: 'leak', password: 'p', uris: ['https://two.example'] }]) });
const noStaleList = await sendRuntime({ bwliteMenu: true }, { tab: { id: 1 }, url: 'https://two.example/login' });
assert.ok(!noStaleList.some((i) => i.username === 'leak'), 'a list without its session key is never exposed');
await localStore.set({
  'a:eq': [['one.example', 'shared.example']], 'b:eq': [['two.example', 'other.example']],
});
await sessionStore.set({
  'a:key': testSessionKey,
  'a:list': JSON.stringify([{ id: 'a1', name: 'A', username: 'a', password: 'p', uris: ['https://one.example'] }]),
  'b:list': JSON.stringify([{ id: 'b1', name: 'B', username: 'b', password: 'p', uris: ['https://two.example'] }]),
});
const perAccountMenu = await sendRuntime({ bwliteMenu: true }, { tab: { id: 1 }, url: 'https://shared.example/login' });
assert.deepEqual(perAccountMenu.map((i) => i.username), ['a'], 'equivalent domains stay scoped to their account');
await sessionStore.set({ 'b:list': JSON.stringify([{ id: 'b1', name: 'B', username: 'b', password: 'p', totp: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=7', uris: ['https://two.example'] }]) });
const badTotpFill = await sendRuntime({ bwliteFillKey: 'b:b1' }, { tab: { id: 1 }, url: 'https://two.example/login' });
assert.equal(badTotpFill.password, 'p', 'bad TOTP does not suppress password fill');
assert.equal(badTotpFill.code, null, 'bad TOTP is omitted from the clipboard payload');
await Promise.all([
  sendRuntime({ bwliteUsed: { a: 'b', id: 'b1' } }, {}),
  sendRuntime({ bwliteUsed: { a: 'b', id: 'b2' } }, {}),
]);
assert.deepEqual(Object.keys((await localStore.get('used')).used).sort(), ['b:b1', 'b:b2']);
const fallback = await sendRuntime({ bwliteReq: 'rp-1', kind: 'create', options: {
  challenge: 'c', rp: { id: 'github.io', name: 'x' }, user: { id: 'u', name: 'u' }, pubKeyCredParams: [{ alg: -7 }],
} }, { origin: 'https://login.github.io', tab: { id: 1 }, url: 'https://login.github.io/' });
assert.equal(fallback.fallback, true, 'a private public suffix cannot be an RP ID');
const pagesFallback = await sendRuntime({ bwliteReq: 'rp-pages', kind: 'create', options: {
  challenge: 'c', rp: { id: 'pages.dev', name: 'x' }, user: { id: 'u', name: 'u' }, pubKeyCredParams: [{ alg: -7 }],
} }, { origin: 'https://app.pages.dev', tab: { id: 1 }, url: 'https://app.pages.dev/' });
assert.equal(pagesFallback.fallback, true, 'a private pages.dev suffix cannot be an RP ID');
const malformedAllow = await sendRuntime({ bwliteReq: 'pk-malformed', kind: 'get', options: {
  challenge: 'c', allowCredentials: [{ id: 'ok' }, { noId: true }],
} }, { origin: 'https://app.example', tab: { id: 1 }, url: 'https://app.example/' });
assert.equal(malformedAllow.fallback, true, 'malformed allowCredentials never broaden a restricted request');
await sendRuntime({ bwliteReq: 'rp-2', kind: 'create', options: {
  challenge: 'c', rp: { id: 'login.github.io', name: 'x' }, user: { id: 'u', name: 'u' }, pubKeyCredParams: [{ alg: -7 }],
} }, { origin: 'https://login.github.io', tab: { id: 1 }, url: 'https://login.github.io/' });
assert.ok(createdWindows.length, 'a registrable private suffix may be an RP ID');
const windowsBefore = createdWindows.length;
await sendRuntime({ bwliteReq: 'rp-real', kind: 'create', options: {
  challenge: 'c'.repeat(1670), timeout: 60000, rp: { name: 'x' }, user: { id: 'u', name: 'u' }, pubKeyCredParams: [{ alg: -7 }],
  authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, extensions: { appid: 'x' },
} }, { origin: 'https://login.github.io', tab: { id: 2 }, url: 'https://login.github.io/' }); // tab 1 has rp-2 pending
assert.equal(createdWindows.length, windowsBefore + 1, 'everyday options (timeout, UV, residentKey, extensions) open BW Lite');
const securityKey = await sendRuntime({ bwliteReq: 'rp-key', kind: 'create', options: {
  challenge: 'c', rp: { name: 'x' }, user: { id: 'u', name: 'u' }, pubKeyCredParams: [{ alg: -7 }],
  authenticatorSelection: { authenticatorAttachment: 'cross-platform' },
} }, { origin: 'https://login.github.io', tab: { id: 1 }, url: 'https://login.github.io/' });
assert.equal(securityKey.fallback, true, 'a request for a security key goes to the browser');
await sendRuntime({ bwliteReq: 'rp-3', kind: 'create', options: {
  challenge: 'c', rp: { name: 'x' }, user: { id: 'u', name: 'u' }, pubKeyCredParams: [{ alg: -7 }],
} }, { origin: 'https://localhost', tab: { id: 3 }, url: 'https://localhost/' });
// One pending request per tab (tab 1 still has rp-2); WebAuthn L3 tolerates unknown transports and empty pubKeyCredParams.
const create = (extra = {}) => ({ challenge: 'c', rp: { name: 'x' }, user: { id: 'u', name: 'u' }, pubKeyCredParams: [{ alg: -7 }], ...extra });
const dup = await sendRuntime({ bwliteReq: 'rp-dup', kind: 'create', options: create() },
  { origin: 'https://login.github.io', tab: { id: 1 }, url: 'https://login.github.io/' });
assert.equal(dup.error?.name, 'NotAllowedError', 'a second passkey request from the same tab opens no window');
const windowsBeforeL3 = createdWindows.length;
await sendRuntime({ bwliteReq: 'rp-cable', kind: 'get', options: { challenge: 'c', allowCredentials: [{ id: 'x', transports: ['cable'] }] } },
  { origin: 'https://login.github.io', tab: { id: 4 }, url: 'https://login.github.io/' });
await sendRuntime({ bwliteReq: 'rp-noparams', kind: 'create', options: create({ pubKeyCredParams: [] }) },
  { origin: 'https://login.github.io', tab: { id: 5 }, url: 'https://login.github.io/' });
assert.equal(createdWindows.length, windowsBeforeL3 + 2, 'unknown transports and empty pubKeyCredParams open BW Lite');
for (const k of sessionStore.data.keys()) if (k.startsWith('pk:')) sessionStore.data.delete(k);
const before = sentTabs.length;
await sendRuntime({ bwliteSubmit: { username: 'alice', password: '' } }, { tab: { id: 7 }, url: 'https://one.example/login' });
await sessionStore.set({ 'b:list': JSON.stringify([{ id: 'b1', name: 'B', username: 'bob', password: 'old', uris: ['https://two.example'] }]) });
await sendRuntime({ bwliteSubmit: { username: '', password: 'secret' } }, { tab: { id: 7 }, url: 'https://two.example/login' });
await tabUpdates[0](7, { status: 'complete' }, { id: 7, url: 'https://two.example/home', status: 'complete' });
assert.ok(sentTabs.length > before, 'the current-origin login can create a save offer');
const offerKey = sentTabs.at(-1)[1].bwliteBar;
assert.equal((await sessionStore.get(`save:${offerKey}`))[`save:${offerKey}`].username, 'bob', 'a previous origin username must not leak into the offer');
assert.equal((await sessionStore.get(`save:${offerKey}`))[`save:${offerKey}`].tabId, 7, 'save offer is tied to its tab');
assert.equal((await sendRuntime({ bwliteSaveOpen: offerKey }, { tab: { id: 8 }, frameId: 0, url: 'https://two.example/home' })).fallback, true,
  'a different tab cannot open a save offer');
assert.equal((await sendRuntime({ bwliteSaveOpen: offerKey }, { tab: { id: 7 }, frameId: 2, url: 'https://two.example/home' })).fallback, true,
  'a child frame cannot open a top-frame save offer');
assert.equal((await sendRuntime({ bwliteSaveOpen: offerKey }, { tab: { id: 7 }, frameId: 0, url: 'https://evil.example/home' })).fallback, true,
  'a different origin cannot open a save offer');
const openedSave = await sendRuntime({ bwliteSaveOpen: offerKey }, { tab: { id: 7 }, frameId: 0, url: 'https://two.example/home' });
assert.equal(openedSave.opened, true, 'a trusted page click opens the extension save window');
assert.match(createdWindows.at(-1).url, /^popup\.html#save=/);
assert.equal((await sendRuntime({ bwliteSaveOpen: offerKey }, { tab: { id: 7 }, frameId: 0, url: 'https://two.example/home' })).fallback, true,
  'a save offer is single-use');
await sendRuntime({ bwliteSubmit: { username: 'carol', password: '' } }, { tab: { id: 7 }, url: 'https://login.two.example/' });
assert.equal(sessionStore.data.get('pending:7')?.username, 'carol', 'the username step outlives the service worker');
await sendRuntime({ bwliteSubmit: { username: '', password: 'pw2' } }, { tab: { id: 7 }, url: 'https://login.two.example/password' });
const subBefore = sentTabs.length;
await tabUpdates[0](7, { status: 'complete' }, { id: 7, url: 'https://app.two.example/home', status: 'complete' });
assert.equal(sentTabs.length, subBefore + 1, 'a sign-in that lands on another subdomain is offered');
const subKey = sentTabs.at(-1)[1].bwliteBar;
assert.equal(sessionStore.data.get(`save:${subKey}`).username, 'carol', 'a two-step login keeps its username');
assert.equal(sessionStore.data.get(`save:${subKey}`).origin, 'https://login.two.example', 'the offer saves the sign-in page');
assert.equal(sessionStore.data.has('pending:7'), false, 'a pending login is offered once');
assert.equal((await sendRuntime({ bwliteSaveOpen: subKey }, { tab: { id: 7 }, frameId: 0, url: 'https://two.example/home' })).opened, true,
  'the save offer opens from another page of the same site');

{ // Ward: card/address drafts from several frames merge into one save offer after a submit
  await localStore.set({ accounts: [{ id: 'w', server: 'https://vault.example', email: 'w@x.y', label: 'W' }], neverSave: [] });
  await sessionStore.set({ 'w:key': testSessionKey, 'w:list': JSON.stringify([
    { id: 'k1', type: 3, name: 'Old', uris: [], card: { number: '5555555555554444' } },
    { id: 'k2', type: 4, name: 'Home', uris: [], identity: { address1: '9 Elm St', postalCode: '10001' } }]) });
  const top = { tab: { id: 9, url: 'https://shop.example/checkout' }, url: 'https://shop.example/checkout', frameId: 0 };
  const stripe = { tab: { id: 9, url: 'https://shop.example/checkout' }, url: 'https://js.stripe.com/v3/elements', frameId: 4 };
  const evil = { tab: { id: 9, url: 'https://shop.example/checkout' }, url: 'https://evil.example/frame', frameId: 5 };
  const offers = () => [...sessionStore.data.entries()].filter(([k, v]) => k.startsWith('save:') && v.kind === 'form').map(([, v]) => v);
  const complete = async (url) => { for (const fn of tabUpdates) await fn(9, { status: 'complete' }, { id: 9, url, status: 'complete' }); await new Promise((r) => setTimeout(r, 20)); };
  await sendRuntime({ wardDraft: { card: { number: '4111111111111111', expMonth: '3', expYear: '2029', code: '123' }, identity: {} } }, stripe);
  await sendRuntime({ wardDraft: { card: { number: '4242424242424242' }, identity: { address1: 'planted' } } }, evil);
  await sendRuntime({ wardDraft: { card: {}, identity: { firstName: 'Ann', lastName: 'Lee', address1: '1 Main St', city: 'Springfield', postalCode: '62701' } } }, top);
  const d = sessionStore.data.get('draft:9');
  assert.equal(d.card.number, '4111111111111111', 'the payment iframe supplies the card');
  assert.equal(d.identity.address1, '1 Main St', 'a third-party frame cannot plant values');
  assert.equal(offers().length, 0, 'nothing is offered before a submit');
  await complete('https://shop.example/checkout');
  assert.equal(offers().length, 0, 'a page load without a submit offers nothing');
  await sendRuntime({ wardDraft: { submit: true } }, top);
  await complete('https://shop.example/thanks');
  const [o] = offers();
  assert.ok(o, 'submit then load offers the card and address');
  assert.equal(o.card.number, '4111111111111111');
  assert.equal(o.card.brand, 'Visa');
  assert.equal(o.identity.city, 'Springfield');
  assert.equal(sentTabs.at(-1)[1].what, 'card and address');
  assert.equal(sessionStore.data.has('draft:9'), false, 'a draft is offered once');
  // already saved card / address, a bad number, a non-https page
  for (const [k] of [...sessionStore.data.entries()].filter(([k]) => k.startsWith('save:'))) sessionStore.data.delete(k);
  await sendRuntime({ wardDraft: { card: { number: '5555555555554444' }, identity: { address1: '9 Elm St', postalCode: '10001', city: 'NYC' }, submit: true } }, top);
  await complete('https://shop.example/thanks');
  assert.equal(offers().length, 0, 'a card or address already in the vault is not offered again');
  await sendRuntime({ wardDraft: { card: { number: '4111111111111112' }, identity: {}, submit: true } }, top);
  await complete('https://shop.example/thanks');
  assert.equal(offers().length, 0, 'a number failing the Luhn check is not a card');
  const plain = { tab: { id: 9, url: 'http://shop.example/checkout' }, url: 'http://shop.example/checkout', frameId: 0 };
  await sendRuntime({ wardDraft: { card: { number: '4111111111111111' }, identity: {}, submit: true } }, plain);
  assert.equal(sessionStore.data.has('draft:9'), false, 'nothing is collected on http pages');
  // Settings: card/address offers off means no watching, no drafts, no offers
  const injected = [];
  const realExec = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async (x) => (injected.push(x), []);
  await sendRuntime({ wardWatch: true }, { ...top, documentId: 'doc-on' });
  assert.equal(injected.length, 2, 'with offers on, a watched frame gets formfill.js and wardWatch');
  await localStore.set({ offerForms: false });
  await sendRuntime({ wardWatch: true }, { ...top, documentId: 'doc-off' });
  assert.equal(injected.length, 2, 'with offers off, nothing is injected into the page');
  await sendRuntime({ wardDraft: { card: { number: '4111111111111111' }, identity: {}, submit: true } }, top);
  assert.equal(sessionStore.data.has('draft:9'), false, 'and nothing is collected');
  chrome.scripting.executeScript = realExec;
  await localStore.set({ offerForms: true });
  // logins: offers off means a submitted password is not kept for an offer
  await sessionStore.set({ 'w:list': JSON.stringify([]) });
  await localStore.set({ offerLogins: false });
  await sendRuntime({ bwliteSubmit: { username: 'ann', password: 'pw' } }, { tab: { id: 12 }, url: 'https://site.example/login' });
  assert.equal(sessionStore.data.has('pending:12'), false, 'login offers off: nothing pending');
  await localStore.set({ offerLogins: true });
  await sendRuntime({ bwliteSubmit: { username: 'ann', password: 'pw' } }, { tab: { id: 12 }, url: 'https://site.example/login' });
  assert.ok(sessionStore.data.get('pending:12')?.offer, 'login offers on: offered as before');
  await sessionStore.remove(['w:key', 'w:list', 'draft:9', 'pending:12']);
  await localStore.set({ accounts: [] });
}

{ // Ward: right-click menu for the active tab's logins, copy through the offscreen document, clipboard clearing
  await localStore.set({ accounts: [{ id: 'm', server: 'https://vault.example', email: 'm@x.y', label: 'M' }] });
  await sessionStore.set({ 'm:key': testSessionKey, 'm:list': JSON.stringify([
    { id: 'l1', name: 'Menu site', username: 'mia', password: 'pw-m', uris: ['https://menu.example'], totp: 'JBSWY3DPEHPK3PXP' },
    { id: 'l2', name: 'Guarded', username: 'g', password: 'pw-g', uris: ['https://menu.example'], reprompt: true },
    { id: 'l3', name: 'Elsewhere', username: 'e', password: 'pw-e', uris: ['https://other.example'] }]) });
  const realQuery = chrome.tabs.query;
  chrome.tabs.query = async () => [{ id: 21, url: 'https://menu.example/login', active: true }];
  await localStore.set({ used: {} }); // any change rebuilds the menu
  await new Promise((r) => setTimeout(r, 320));
  const titles = menuItems.map((m) => m.title);
  assert.ok(titles.includes('Menu site — mia'), 'the menu lists this site\'s logins');
  assert.ok(!titles.some((t) => /Guarded|Elsewhere/.test(t)), 're-prompt logins and other sites are not in the menu');
  assert.ok(menuItems.every((m) => m.contexts?.includes('editable')), 'the menu appears on page fields');
  const click = (id, url = 'https://menu.example/login') => Promise.all(menuClicks.map((fn) => fn({ menuItemId: id }, { id: 21, url })));
  await click('ward|pass|m:l1');
  assert.equal(offscreenMessages.at(-1)?.text, 'pw-m', 'Copy password goes through the offscreen document');
  assert.deepEqual(alarmsCreated.at(-1), ['ward-clipboard', { delayInMinutes: 0.5 }], 'and the clipboard is cleared 30 s later');
  const n = offscreenMessages.length, a = alarmsCreated.length;
  await click('ward|user|m:l1');
  assert.equal(offscreenMessages.at(-1)?.text, 'mia');
  assert.equal(alarmsCreated.length, a, 'a username is not cleared');
  await click('ward|pass|m:l1', 'https://evil.example/');
  await click('ward|pass|m:l2');
  assert.equal(offscreenMessages.length, n + 1, 'a stale menu on another site, or a re-prompt login, copies nothing');
  await localStore.set({ clearClipboard: false });
  await click('ward|pass|m:l1');
  assert.equal(alarmsCreated.length, a, 'clearing off: no alarm');
  await localStore.set({ clearClipboard: true });
  // clear requests: from Ward's popup yes, from a web page no
  await sendRuntime({ wardClipboardClear: true }, { id: 'ward-test', url: 'chrome-extension://ward-test/popup.html' });
  assert.equal(alarmsCreated.length, a + 1, 'the popup can ask for a clear');
  await sendRuntime({ wardClipboardClear: true }, { id: 'ward-test', tab: { id: 21 }, url: 'https://menu.example/' });
  assert.equal(alarmsCreated.length, a + 1, 'a page cannot');
  chrome.tabs.query = realQuery;
  await sessionStore.remove(['m:key', 'm:list']);
  await localStore.set({ accounts: [] });
}
{ // Ward: passkey autofill (mediation: conditional). Held when an open vault has a passkey for it; the menu lists the
  // passkeys first; a pick signs and answers that document only, once; "device", abort, lock and the setting give it back.
  const made = await bw.passkeyCreate({ challenge, rp: { name: 'Pk' }, user: { id: 'dXNlcg', name: 'ben' } }, 'https://pk.example', 'pk.example');
  await localStore.set({ accounts: [{ id: 'p', server: 'https://vault.example', email: 'p@x.y', label: 'P' }], used: {} });
  const list = JSON.stringify([
    { id: 'k1', name: 'Pk site', username: 'ben', password: '', uris: ['https://pk.example'], passkeys: [made.passkey] },
    { id: 'k2', name: 'Pk site', username: 'ann', password: 'pw', uris: ['https://pk.example'] },
    { id: 'k3', name: 'Pw site', username: 'cy', password: 'pw', uris: ['https://pw.example'] }]);
  await sessionStore.set({ 'p:key': testSessionKey, 'p:list': list });
  const page = { origin: 'https://pk.example', url: 'https://pk.example/login', tab: { id: 31 }, frameId: 0, documentId: 'doc-1' };
  const ask = (id, options = { challenge }, sender = page) => sendRuntime({ bwliteReq: id, kind: 'get', conditional: true, options }, sender);
  const windows = createdWindows.length;
  assert.deepEqual(await ask('c-1'), { bwliteRes: 'c-1', hold: true }, 'held: Ward has a passkey for the site');
  assert.equal(createdWindows.length, windows, 'passkey autofill opens no window');
  const rows = await sendRuntime({ bwliteMenu: true, pk: true }, page);
  assert.deepEqual(rows.map((r) => [r.device ? 'device' : r.username, !!r.pk]), [['ben', true], ['ann', false], ['device', false]],
    'passkeys first, their logins not repeated, then "Use device or security key"');
  assert.ok(!(await sendRuntime({ bwliteMenu: true, pk: true }, { ...page, documentId: 'doc-2' })).some((r) => r.pk), 'another document gets no passkey rows');
  assert.ok(!(await sendRuntime({ bwliteMenu: true, pk: true }, { ...page, frameId: 2 })).some((r) => r.pk), 'nor does a child frame');
  assert.equal(await sendRuntime({ wardPasskey: rows[0].k }, { ...page, frameId: 2 }), null, 'a child frame cannot pick');
  assert.equal(await sendRuntime({ wardPasskey: rows[0].k }, { ...page, documentId: 'doc-2' }), null, 'nor can another document');
  assert.equal(await sendRuntime({ wardPasskey: 'p:k2:0' }, page), null, 'a login without that passkey signs nothing');
  assert.equal(await sendRuntime({ wardPasskey: rows[0].k }, page), true);
  const [tabId, res, to] = sentTabs.at(-1);
  assert.deepEqual([tabId, res.bwliteRes, to], [31, 'c-1', { documentId: 'doc-1' }], 'the answer goes to the requesting document');
  const as = res.result.response;
  assert.deepEqual(JSON.parse(fromB64u(as.clientDataJSON)), { type: 'webauthn.get', challenge, origin: 'https://pk.example', crossOrigin: false });
  const signed = Buffer.concat([fromB64u(as.authenticatorData), nodeCrypto.createHash('sha256').update(fromB64u(as.clientDataJSON)).digest()]);
  assert.ok(nodeCrypto.verify('sha256', signed, { key: fromB64u(made.result.response.publicKey), format: 'der', type: 'spki' }, fromB64u(as.signature)), 'the assertion verifies');
  assert.ok((await localStore.get('used')).used['p:k1'], 'a passkey sign-in counts as use');
  assert.equal(await sendRuntime({ wardPasskey: rows[0].k }, page), null, 'answered once');
  assert.ok(!(await sendRuntime({ bwliteMenu: true, pk: true }, page)).some((r) => r.pk), 'and no longer offered');

  await ask('c-2');
  assert.equal(await sendRuntime({ wardPasskey: 'device' }, page), true);
  assert.deepEqual(sentTabs.at(-1)[1], { bwliteRes: 'c-2', fallback: true, device: true }, '"Use device or security key" hands it to the browser');
  await ask('c-3');
  await sendRuntime({ wardCondEnd: 'c-other' }, page);
  assert.equal(sessionStore.data.get('cpk:31')?.id, 'c-3', 'another id cannot end it');
  await sendRuntime({ wardCondEnd: 'c-3' }, { ...page, documentId: 'doc-2' });
  assert.ok(sessionStore.data.has('cpk:31'), 'nor can another document');
  await sendRuntime({ wardCondEnd: 'c-3' }, page);
  assert.equal(sessionStore.data.has('cpk:31'), false, 'the page aborting ends it');
  await ask('c-4');
  await sessionStore.remove(['p:key', 'p:list']);
  const sentBefore = sentTabs.length;
  assert.ok(!(await sendRuntime({ bwliteMenu: true, pk: true }, page)).some((r) => r.pk), 'locked: no passkey rows');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sentTabs.slice(sentBefore).map((x) => x[1]), [{ bwliteRes: 'c-4', fallback: true }], 'locked: the browser takes the request');
  assert.equal((await ask('c-5')).fallback, true, 'locked: not held');
  await sessionStore.set({ 'p:key': testSessionKey, 'p:list': list });
  assert.equal((await ask('c-6', { challenge }, { ...page, frameId: 1 })).fallback, true, 'only the top frame');
  assert.equal((await ask('c-8', { challenge }, { ...page, origin: 'https://none.example', url: 'https://none.example/' })).fallback, true,
    'nothing in Ward for the site: the browser');
  // Only passwords for the site: held all the same, so the browser's list doesn't cover Ward's menu; its passkeys are
  // one click away ("Use device or security key"). Same when the site wants a credential Ward doesn't have.
  const pw = { ...page, origin: 'https://pw.example', url: 'https://pw.example/login' };
  assert.equal((await ask('c-7', { challenge }, pw)).hold, true, 'logins only: held');
  assert.deepEqual((await sendRuntime({ bwliteMenu: true, pk: true }, pw)).map((r) => r.device ? 'device' : r.username), ['cy', 'device']);
  assert.equal((await ask('c-7b', { challenge, allowCredentials: [{ id: 'b3RoZXI', type: 'public-key' }] })).hold, true);
  assert.deepEqual((await sendRuntime({ bwliteMenu: true, pk: true }, page)).map((r) => r.device ? 'device' : r.username), ['ben', 'ann', 'device'],
    'a credential Ward lacks: no passkey rows');
  await localStore.set({ passkeyMenu: false });
  assert.equal((await ask('c-9')).fallback, true, 'setting off: the browser');
  await localStore.set({ passkeyMenu: true });
  assert.equal((await ask('c-10')).hold, true);
  await sessionStore.remove(['p:key', 'p:list', 'cpk:31']);
  await localStore.set({ accounts: [] });
}
console.log('background cache, write, RP, and save-scope checks ok');

// Source-loaded popup harness. It evaluates the production popup code in a
// small VM DOM/storage environment, so these checks exercise the actual event
// handlers and start path instead of test-only helper exports.
const popupSource = await readFile('./popup.js', 'utf8');
const popupProgram = popupSource
  .replace(/^import[^\n]*\n/gm, '')
  .replace(/\nstart\(\)\.catch\([\s\S]*\);\s*$/, '\n')
  + `\nthis.__popup = { start, move, adoptAccounts, closeSave, loginView, settingsView, getAccounts: () => accounts, getPk: () => pk, getSv: () => sv, getApp: () => app };\n`;

function popupStorage(name, initial, notify) {
  const data = new Map(Object.entries(initial || {}));
  const keys = (input) => input === null ? [...data.keys()]
    : Array.isArray(input) ? input : typeof input === 'string' ? [input] : Object.keys(input || {});
  return {
    data,
    async get(input) {
      const out = {};
      for (const key of keys(input)) if (data.has(key)) out[key] = data.get(key);
      return out;
    },
    async set(values) {
      const changes = {};
      for (const [key, value] of Object.entries(values)) {
        changes[key] = { oldValue: data.get(key), newValue: value };
        data.set(key, value);
      }
      await notify(changes, name);
    },
    async remove(input) {
      const changes = {};
      for (const key of keys(input)) if (data.has(key)) {
        changes[key] = { oldValue: data.get(key) };
        data.delete(key);
      }
      if (Object.keys(changes).length) await notify(changes, name);
    },
    async clear() { await this.remove([...data.keys()]); },
  };
}

function popupElement(tag) {
  return new class {
    constructor() {
      this.tagName = String(tag).toUpperCase(); this.children = []; this.listeners = {};
      this.style = { setProperty(k, v) { this[k] = v; } }; this.dataset = {}; this.textContent = ''; this.disabled = false;
      this.className = '';
      const el = this;
      this.classList = {
        has: (c) => el.className.split(/\s+/).includes(c),
        add: (c) => { if (!el.classList.has(c)) el.className = `${el.className} ${c}`.trim(); },
        remove: (c) => { el.className = el.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
        toggle: (c, on = !el.classList.has(c)) => (on ? el.classList.add(c) : el.classList.remove(c), on),
        contains: (c) => el.classList.has(c),
      };
      this.hidden = false; this.value = ''; this.checked = false; this.removed = false;
    }
    append(...children) {
      for (const child of children) {
        if (typeof child === 'string') this.textContent += child;
        else if (child) this.children.push(child);
      }
    }
    replaceChildren(...children) { this.children = []; this.textContent = ''; this.append(...children); }
    addEventListener(type, fn) { this.listeners[type] = fn; if (type === 'click') this.onclick = fn; }
    remove() { this.removed = true; }
    focus() { this.focused = true; }
    setAttribute(name, value) { this[name] = String(value); }
    get firstChild() { return this.children[0]; }
    get childNodes() { return this.children; }
    scrollIntoView() {}
  }();
}

const popupKey = bw.b64(new Uint8Array(64));
const popupAccount = (id, label = id) => ({ id, server: 'https://vault.example', email: `${id}@example.com`, label });
const popupList = (id, extra = {}) => [{ id: `${id}-item`, name: 'Login', username: 'user', password: 'pass', uris: ['https://example.com'], a: id, ...extra }];

function makePopup(hash, initial = {}, options = {}) {
  const listeners = [];
  const notify = async (changes, area) => { for (const fn of [...listeners]) await fn(changes, area); };
  const local = popupStorage('local', initial.local, notify), session = popupStorage('session', initial.session, notify);
  const sent = [], runtimeMessages = [], parentMessages = [];
  const state = { closed: false };
  const app = popupElement('main');
  const document = {
    activeElement: null,
    body: { scrollHeight: 0, classList: { add() {} } },
    documentElement: { dataset: {}, append(...children) { this.children ||= []; this.children.push(...children); } },
    createElement: (tag) => popupElement(tag),
    createElementNS: (_ns, tag) => popupElement(tag),
    addEventListener: () => {},
    querySelectorAll: () => [],
    getElementById(id) {
      const walk = (node) => {
        if (!node) return null;
        if (node.id === id) return node;
        for (const child of node.children || []) { const found = walk(child); if (found) return found; }
        return null;
      };
      return id === 'app' ? app : walk(app);
    },
  };
  const window = {
    close: () => { state.closed = true; },
    postMessage: (message, origin) => parentMessages.push({ message, origin }),
  };
  window.top = options.framed ? {} : window;
  window.parent = window;
  const bwHarness = { ...bw, ...(options.bw || {}) };
  const chrome = {
    storage: { local, session, onChanged: { addListener: (fn) => listeners.push(fn) } },
    tabs: {
      query: async () => options.tabs || [{ id: 9, url: 'https://example.com/login' }],
      sendMessage: async (...args) => { sent.push(args); },
      get: async (id) => ({ id, windowId: 1 }),
    },
    runtime: {
      sendMessage: async (message) => {
        runtimeMessages.push(message);
        return options.onRuntime ? options.onRuntime(message) : {};
      },
    },
    windows: { update: async () => {} },
  };
  const context = {
    window, top: window.top, parent: window.parent, location: { hash }, document, chrome,
    bw: bwHarness, fillTab: options.fillTab || (async () => false), withStateLock, mutateAccounts, AUTO_LOCK_CHOICES, autoLockMinutes, touch, storeSync, fillFormTab: async () => 0, formFrameAllowed,
    navigator: { clipboard: { writeText: async () => {} } }, localStorage: {},
    crypto: globalThis.crypto || nodeCrypto.webcrypto, TextDecoder, URL, Intl, structuredClone,
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    addEventListener: () => {},
  };
  vm.runInNewContext(popupProgram, context, { filename: 'popup-harness-popup.js' });
  return { local, session, sent, runtimeMessages, parentMessages, app, context, api: context.__popup,
    get closed() { return state.closed; } };
}

const pkRequest = { id: 'request', kind: 'get', options: { challenge: 'c', rpId: 'example.com' },
  origin: 'https://example.com', rpId: 'example.com', tabId: 9, expires: Date.now() + 60e3 };
const listenerPopup = makePopup('#pk=handoff', { session: { 'pk:handoff': pkRequest } });
await listenerPopup.api.start();
await listenerPopup.session.set({ 'unrelated:key': 'still-open' });
assert.equal(listenerPopup.closed, false, 'unrelated session writes do not cancel a passkey window');
assert.ok(listenerPopup.api.getPk(), 'passkey hand-off survives an unrelated storage event');
await listenerPopup.session.remove('pk:handoff');
assert.equal(listenerPopup.closed, true, 'deleting the passkey hand-off cancels the window');
assert.equal(listenerPopup.sent.at(-1)[1].bwliteRes, 'request');

let passkeyCalls = 0;
const passkeyAccount = popupAccount('acct', 'Vault');
const passkeyItem = popupList('acct', { id: 'cipher', passkeys: [{ rpId: 'example.com', credentialId: 'b64.AAEC', userName: 'user' }] });
const passkeyPopup = makePopup('#pk=use', {
  local: { accounts: [passkeyAccount] },
  session: {
    'acct:key': popupKey, 'acct:list': JSON.stringify(passkeyItem), 'pk:use': { ...pkRequest, id: 'use-request' },
  },
}, { bw: { passkeyGet: async () => (passkeyCalls++, { id: 'credential-result' }) } });
await passkeyPopup.api.start();
const findButton = (node, text) => {
  if (node?.tagName === 'BUTTON' && node.textContent === text) return node;
  for (const child of node?.children || []) { const found = findButton(child, text); if (found) return found; }
  return null;
};
const useButton = findButton(passkeyPopup.app, 'Sign in');
assert.ok(useButton?.onclick, 'passkey view renders the real Use handler');
await useButton.onclick({ isTrusted: true });
assert.equal(passkeyCalls, 1, 'Use invokes passkey signing');
assert.equal(passkeyPopup.sent.at(-1)[1].bwliteRes, 'use-request', 'passkey Use answers the originating request');
assert.deepEqual(passkeyPopup.sent.at(-1)[1].result, { id: 'credential-result' });
const expiryPk = makePopup('#pk=expiry', { session: { 'pk:expiry': { ...pkRequest, id: 'expiry-request', expires: Date.now() + 20 } } });
await expiryPk.api.start();
await new Promise((resolve) => setTimeout(resolve, 40));
assert.equal(expiryPk.closed, true, 'a passkey window closes at its deadline');
assert.equal(expiryPk.sent.at(-1)[1].error.name, 'NotAllowedError', 'the page hears the timeout');
assert.equal(JSON.stringify(expiryPk.sent.at(-1)[2]), '{"frameId":0}','no documentId means no documentId option (Firefox < 153)');
// A create excluded by a BW Lite passkey still offers the security key; a locked second vault offers unlock.
const excludePk = makePopup('#pk=exclude', {
  local: { accounts: [passkeyAccount, popupAccount('locked')] },
  session: { 'acct:key': popupKey, 'acct:list': JSON.stringify(passkeyItem), 'pk:exclude': { ...pkRequest, kind: 'create',
    options: { challenge: 'c', rp: { name: 'x' }, user: { id: 'u', name: 'u' }, pubKeyCredParams: [],
      excludeCredentials: [{ id: bw.b64u(bw.credIdBytes('b64.AAEC')), type: 'public-key' }] } } },
});
await excludePk.api.start();
assert.ok(!excludePk.closed && findButton(excludePk.app, 'Use device or security key'), 'an excluded create is not auto-answered');
assert.equal(findButton(excludePk.app, 'Save as new login'), null, 'an excluded create offers no save');
assert.ok(findButton(excludePk.app, '1 locked'), 'a locked vault can be unlocked from the passkey window');

// Opening the popup syncs a vault last synced over 5 minutes ago in the background; a recent one is left alone.
const textOf = (node) => `${node?.textContent || ''} ${(node?.children || []).map(textOf).join(' ')}`;
const findById = (node, id) => node?.id === id ? node : (node?.children || []).reduce((f, c) => f || findById(c, id), null);
for (const [lastSync, expectSync] of [[Date.now() - 6 * 60e3, true], [Date.now() - 60e3, false]]) {
  let syncCalls = 0;
  const fresh = [{ id: 'fresh-item', name: 'Login', username: 'fresh-user', password: 'p', uris: ['https://example.com'] }];
  const popup = makePopup('', {
    local: { accounts: [{ ...popupAccount('acct', 'Vault'), lastSync }] },
    session: { 'acct:key': popupKey, 'acct:list': JSON.stringify(popupList('acct')) },
  }, { bw: { api: async (_, path) => (path === '/sync' && syncCalls++, { ciphers: [], profile: {}, domains: {} }), decryptVault: async () => fresh } });
  await popup.api.start();
  const search = findById(popup.app, 'search');
  search.value = 'fresh'; search.listeners.input(); // typing while the sync runs
  popup.context.document.activeElement = search;
  for (let i = 0; i < 20 && !textOf(popup.app).includes('fresh-user'); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(syncCalls, expectSync ? 1 : 0, expectSync ? 'a stale vault syncs when the popup opens' : 'a recent vault does not sync on open');
  assert.equal(textOf(popup.app).includes('fresh-user'), expectSync, 'the list shows what the background sync brought');
  if (expectSync) {
    const redrawn = findById(popup.app, 'search');
    assert.ok(redrawn !== search && redrawn.focused && redrawn.value === 'fresh', 'the redraw keeps the search text and focus');
  }
}

const staleAccount = popupAccount('stale');
const adoptPopup = makePopup('', { local: { accounts: [staleAccount] } });
adoptPopup.api.adoptAccounts([{ ...staleAccount, persistKey: popupKey }]);
adoptPopup.api.adoptAccounts([{ ...staleAccount }]);
assert.equal(adoptPopup.api.getAccounts()[0].persistKey, undefined, 'an omitted persisted key is removed from the existing account object');
await adoptPopup.api.start();
assert.equal(adoptPopup.api.getAccounts()[0].persistKey, undefined, 'adopting current storage removes a stale persisted key');

const moveA = popupAccount('move-a'), moveB = popupAccount('move-b'), moveC = popupAccount('move-c');
const movePopup = makePopup('', { local: { accounts: [moveA, moveB, moveC] } });
movePopup.api.adoptAccounts([moveA, moveB]);
await movePopup.api.move(0, 1);
assert.equal(JSON.stringify((await movePopup.local.get('accounts')).accounts.map((a) => a.id)), JSON.stringify(['move-b', 'move-a', 'move-c']),
  'moving a stale account snapshot preserves a concurrently added account');

const saveBase = {
  kind: 'add', username: 'user', password: 'new', origin: 'https://example.com', tabId: 9,
};
const listenerSave = makePopup('#save=listener', {
  local: { accounts: [popupAccount('save')] },
  session: { 'save:listener': { ...saveBase, expires: Date.now() + 10_000 }, 'save:key': popupKey,
    'save:list': JSON.stringify(popupList('save')) },
}, { tabs: [{ id: 99, url: 'chrome-extension://other/popup.html' }] });
await listenerSave.api.start();
await listenerSave.session.set({ 'unrelated:key': 'still-open' });
assert.ok(listenerSave.api.getSv() && !listenerSave.closed, 'unrelated session writes preserve a save window');
await listenerSave.session.remove('save:listener');
assert.equal(listenerSave.closed, true, 'deleting a save hand-off closes the save window');
assert.equal(listenerSave.parentMessages.length, 0, 'save windows never use page postMessage');

const expirySave = makePopup('#save=expiry', {
  local: { accounts: [popupAccount('expiry')] },
  session: { 'save:expiry': { ...saveBase, tabId: 9, expires: Date.now() + 15 }, 'expiry:key': popupKey,
    'expiry:list': JSON.stringify(popupList('expiry')) },
}, { tabs: [{ id: 99, url: 'chrome-extension://other/popup.html' }] });
await expirySave.api.start();
await new Promise((resolve) => setTimeout(resolve, 35));
assert.equal(expirySave.closed, true, 'an open save offer closes when its expiry timer fires');
assert.equal(expirySave.app.children.length, 0, 'expired save UI is cleared');

{ // Ward: a card + address offer saves each ticked item; the security code only when ticked
  const saves = [];
  const findText = (node, t) => (node?.textContent === t ? node : (node?.children || []).reduce((f, c) => f || findText(c, t), null));
  const checks = (node) => (node?.tagName === 'INPUT' && node.type === 'checkbox' ? [node] : []).concat(...(node?.children || []).map(checks));
  const formSave = makePopup('#save=form', {
    local: { accounts: [popupAccount('form')], 'form:profile': { privateKey: 'x', organizations: [] } },
    session: { 'save:form': { kind: 'form', origin: 'https://shop.example', domain: 'shop.example', tabId: 9, expires: Date.now() + 10_000,
      card: { number: '4111111111111111', expMonth: '3', expYear: '2029', code: '123', brand: 'Visa' },
      identity: { firstName: 'Ann', lastName: 'Lee', address1: '1 Main St', city: 'Springfield' } },
    'form:key': popupKey, 'form:list': JSON.stringify(popupList('form')) },
  }, { tabs: [{ id: 99, url: 'chrome-extension://other/popup.html' }], bw: {
    saveCipher: async (_s, _k, item, v) => (saves.push(v), { id: `new-${saves.length}`, type: v.type }),
    decryptVault: async (sync) => sync.ciphers.map((c) => ({ id: c.id, type: c.type, name: 'x', uris: [] })) } });
  await formSave.api.start();
  assert.match(textOf(formSave.app), /Visa •••• 1111 · 03\/29/);
  assert.match(textOf(formSave.app), /1 Main St/);
  const [cardBox, codeBox, idBox] = checks(formSave.app);
  assert.deepEqual([cardBox.checked, codeBox.checked, idBox.checked], [true, false, true], 'card and address ticked, security code not');
  await findText(formSave.app, 'Save').onclick();
  for (let i = 0; i < 50 && saves.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(saves.length, 2);
  assert.equal(saves[0].type, 3);
  assert.equal(saves[0].card.code, '', 'the security code is left out unless ticked');
  assert.equal(saves[0].name, 'Visa 1111');
  assert.equal(saves[1].type, 4);
  assert.equal(saves[1].name, 'Ann Lee');
}

{ // Ward: Settings switches save to local storage; the never-offer list can be edited
  const sp = makePopup('', { local: { accounts: [popupAccount('set')], neverSave: ['a.example', 'b.example'] },
    session: { 'set:key': popupKey, 'set:list': JSON.stringify(popupList('set')) } });
  await sp.api.start();
  sp.api.settingsView();
  const boxes = (node) => (node?.tagName === 'INPUT' && node.type === 'checkbox' ? [node] : []).concat(...(node?.children || []).map(boxes));
  const [logins, forms] = boxes(sp.app);
  assert.deepEqual([logins.checked, forms.checked], [true, true], 'both offers are on by default');
  forms.checked = false;
  await forms.listeners.change();
  assert.equal((await sp.local.get('offerForms')).offerForms, false);
  logins.checked = false;
  await logins.listeners.change();
  assert.equal((await sp.local.get('offerLogins')).offerLogins, false);
  assert.match(textOf(sp.app), /a\.example/);
  const removeA = (function find(n) { return n?.title === 'Offer to save on a.example again' ? n : (n?.children || []).reduce((f, c) => f || find(c), null); })(sp.app);
  await removeA.onclick();
  assert.deepEqual((await sp.local.get('neverSave')).neverSave, ['b.example']);
}

const framedSave = makePopup('#save=framed', {
  session: { 'save:framed': { ...saveBase, expires: Date.now() + 10_000 } },
}, { framed: true });
await framedSave.api.start();
assert.equal(framedSave.closed, true, 'a web frame cannot render the save confirmation');
assert.equal(framedSave.parentMessages.length, 0);

// Logging in to a vault that is already added (master password changed elsewhere) updates it in place.
const loginCalls = [];
const reloginPopup = makePopup('', { local: { accounts: [{ ...popupAccount('acct', 'Vault'), protectedKey: 'old-pk' }], deviceId: 'dev' } }, { bw: {
  loginKeys: async () => ({ kdf: { kdf: 0, kdfIterations: 1 }, hash: 'hash', key: new Uint8Array(64) }),
  loginWith: async (...args) => (loginCalls.push(args), { kdf: { kdf: 0, kdfIterations: 1 }, protectedKey: 'new-pk', userKey: new Uint8Array(64),
    tokens: { access: 't', refresh: 'r', expires: Date.now() + 3600e3 }, twoFactorToken: loginCalls.length === 1 ? 'remember-me' : undefined }),
  api: async () => ({ ciphers: [], profile: {}, domains: {} }), decryptVault: async () => [] } });
const relogin = async () => {
  reloginPopup.api.loginView();
  const form = reloginPopup.app.children[1];
  form.children[1].children[0].value = 'ACCT@example.com';
  form.children[2].children[0].value = 'new password';
  form.listeners.submit({ preventDefault() {} });
  for (let i = 0; i < 50 && !findById(reloginPopup.app, 'search'); i++) await new Promise((r) => setTimeout(r, 5));
};
await reloginPopup.api.start();
await relogin();
await relogin();
const [patched, ...added] = (await reloginPopup.local.get('accounts')).accounts;
assert.equal(added.length, 0, 'logging in to an added vault does not add it twice');
assert.deepEqual([patched.id, patched.label, patched.protectedKey, patched.twoFactorToken], ['acct', 'Vault', 'new-pk', 'remember-me']);
assert.equal(loginCalls[1][5], 'remember-me', 'the next login sends the remembered 2FA token');
assert.equal(reloginPopup.session.data.get('acct:key'), popupKey, 'the vault opens with the new key');

{ // Two-step login: the half-done login waits in session storage, a reopened popup resumes it, the code goes with
  // the chosen method, email asks the server to send the code, and success clears the pending login.
  const calls = [], sent = [];
  const twoStepBw = {
    loginKeys: async () => ({ kdf: { kdf: 0, kdfIterations: 1 }, hash: 'hash', key: new Uint8Array(64).fill(7) }),
    loginWith: async (...args) => {
      calls.push(args);
      if (!args[4]) throw Object.assign(new Error('Two-step login'), { need: '2fa', providers: [{ id: 0, data: null }, { id: 1, data: { Email: 'a***@example.com' } }] });
      if (args[4].value !== '123456') throw new Error('Invalid TOTP code');
      return { kdf: { kdf: 0, kdfIterations: 1 }, protectedKey: 'pk2', userKey: new Uint8Array(64), tokens: { access: 't', refresh: 'r', expires: Date.now() + 3600e3 } };
    },
    sendEmailCode: async (...args) => { sent.push(args); },
    api: async () => ({ ciphers: [], profile: {}, domains: {} }), decryptVault: async () => [],
  };
  const tp = makePopup('', { local: { deviceId: 'dev' } }, { bw: twoStepBw });
  await tp.api.start();
  const lf = tp.app.children[1];
  lf.children[0].children[0].value = 'https://vault.example.com';
  lf.children[1].children[0].value = 'a@example.com';
  lf.children[2].children[0].value = 'pw';
  lf.listeners.submit({ preventDefault() {} });
  for (let i = 0; i < 50 && !tp.session.data.get('twostep'); i++) await new Promise((r) => setTimeout(r, 5));
  const pending = tp.session.data.get('twostep');
  assert.equal(pending.provider, 0, 'the authenticator app comes before email');
  assert.equal(pending.hash, 'hash');
  assert.equal(pending.key, bw.b64(new Uint8Array(64).fill(7)), 'the derived key waits in session storage, not the password');
  assert.ok(!JSON.stringify(pending).includes('"pw"'), 'the master password itself is not kept');
  assert.match(textOf(tp.app), /Two-step login/);
  // the popup closes and reopens: it resumes on the second step
  const tp2 = makePopup('', { local: { deviceId: 'dev' }, session: { twostep: pending } }, { bw: twoStepBw });
  await tp2.api.start();
  assert.match(textOf(tp2.app), /authenticator app/);
  const cf = tp2.app.children[2];
  cf.children[1].children[0].value = '000000';
  cf.listeners.submit({ preventDefault() {} });
  await new Promise((r) => setTimeout(r, 10));
  assert.match(textOf(tp2.app), /Invalid TOTP code/, 'a wrong code stays on the step with the error');
  assert.ok(tp2.session.data.get('twostep'), 'and keeps the pending login');
  cf.children[1].children[0].value = '123456';
  cf.listeners.submit({ preventDefault() {} });
  for (let i = 0; i < 50 && !findById(tp2.app, 'search'); i++) await new Promise((r) => setTimeout(r, 5));
  const plain = (o) => JSON.parse(JSON.stringify(o, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v))); // objects from the popup's realm
  assert.deepEqual(plain(calls.at(-1)[4]), { kind: '2fa', provider: 0, value: '123456' });
  assert.deepEqual(plain(calls.at(-1)[2]), plain({ kdf: { kdf: 0, kdfIterations: 1 }, hash: 'hash', key: new Uint8Array(64).fill(7) }), 'the stored keys are used');
  assert.equal(tp2.session.data.get('twostep'), undefined, 'success clears the pending login');
  const added = (await tp2.local.get('accounts')).accounts;
  assert.deepEqual([added.length, added[0].email, added[0].twoFactorProvider], [1, 'a@example.com', 0], 'the vault is added and remembers the method');
  // email: switching to it sends the code once
  const tp3 = makePopup('', { local: { deviceId: 'dev' }, session: { twostep: { ...pending, provider: 1 } } }, { bw: twoStepBw });
  await tp3.api.start();
  await new Promise((r) => setTimeout(r, 10));
  assert.match(textOf(tp3.app), /a\*\*\*@example\.com/);
  assert.equal(sent.length, 1, 'the server is asked to email the code');
  assert.equal(tp3.session.data.get('twostep').emailSent, true);
  // expired: back to the login form
  const tp4 = makePopup('', { local: { deviceId: 'dev' }, session: { twostep: { ...pending, expires: Date.now() - 1 } } }, { bw: twoStepBw });
  await tp4.api.start();
  await new Promise((r) => setTimeout(r, 10));
  assert.match(textOf(tp4.app), /timed out/);
  assert.equal(tp4.session.data.get('twostep'), undefined);
  console.log('two-step login (popup) ok');
}

// Re-prompt logins ask for the master password before the password is copied; a policy-hidden password has no copy button.
const buttonsOf = (node, text) => [...(node?.tagName === 'BUTTON' && node.textContent === text ? [node] : []), ...(node?.children || []).flatMap((c) => buttonsOf(c, text))];
const rpItems = [{ ...popupList('rp')[0], id: 'r', username: 'ruser', reprompt: true }, { ...popupList('rp')[0], id: 'v', username: 'vuser', viewPassword: false }];
const rpPopup = makePopup('', { local: { accounts: [{ ...popupAccount('rp'), lastSync: Date.now() }] }, session: { 'rp:key': popupKey, 'rp:list': JSON.stringify(rpItems) } },
  { bw: { unlock: async (pw) => new Uint8Array(64).fill(pw === 'right' ? 0 : 1) } });
await rpPopup.api.start();
const copied = [];
rpPopup.context.navigator.clipboard.writeText = async (t) => { copied.push(t); };
const byTitle = (node, prefix) => [...(node?.tagName === 'BUTTON' && String(node.title || '').startsWith(prefix) ? [node] : []), ...(node?.children || []).flatMap((c) => byTitle(c, prefix))];
// a row's buttons are built when it is hovered or selected (popup.js withActions): hover every row, as a user would
const hoverRows = (node) => { if (node?.listeners?.pointerenter) node.listeners.pointerenter(); for (const c of node?.children || []) hoverRows(c); };
hoverRows(rpPopup.app);
const passButtons = byTitle(rpPopup.app, 'Copy password');
assert.equal(passButtons.length, 1, 'viewPassword: false hides the copy button');
passButtons[0].onclick({ target: passButtons[0], stopPropagation() {} });
const rpForm = rpPopup.app.children[1];
for (const pw of ['wrong', 'right']) {
  rpForm.children[0].children[0].value = pw;
  rpForm.listeners.submit({ preventDefault() {} });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(copied, pw === 'right' ? ['pass'] : [], `copies only after the right master password (${pw})`);
}
{ // Ward UI (option E): selection, Fill only where it can work, one-click copy, clipboard clear for secrets only
  const listItems = [
    { id: 'gh', name: 'GitHub', username: 'ann', password: 'pw1', uris: ['https://example.com'], totp: 'JBSWY3DPEHPK3PXP', a: 'ui' },
    { id: 'gw', name: 'GitHub work', username: 'bre', password: 'pw2', uris: ['https://example.com'], a: 'ui' },
    { id: 'am', name: 'Amazon', username: 'amy', password: 'pw3', uris: ['https://amazon.com'], a: 'ui' },
    { id: 'vc', type: 3, name: 'Visa', uris: [], card: { number: '4111111111111111', code: '123', expMonth: '3', expYear: '2029' }, a: 'ui' },
  ];
  const up = makePopup('', { local: { accounts: [{ ...popupAccount('ui'), lastSync: Date.now() }] }, session: { 'ui:key': popupKey, 'ui:list': JSON.stringify(listItems) } });
  await up.api.start();
  const copied = [];
  up.context.navigator.clipboard.writeText = async (t) => { copied.push(t); };
  const items = (node) => [...(node?.className === 'item' || String(node?.className).startsWith('item ') ? [node] : []), ...(node?.children || []).flatMap(items)];
  const rowsNow = () => items(up.app);
  const sel = () => rowsNow().filter((r) => r.classList.contains('sel')).map((r) => r.dataset.key);
  assert.deepEqual(sel(), ['ui:gh'], "this site's best match is selected when Ward opens");
  assert.equal(byTitle(up.app, 'Fill · GitHub').length, 1, 'the selected row has its buttons at once');
  assert.equal(byTitle(up.app, 'Copy username · Amazon').length, 0, 'other rows build theirs on first hover');
  const titled = (node, prefix) => (hoverRows(node), byTitle(node, prefix));
  assert.equal(titled(up.app, 'Fill · GitHub').length >= 1, true, 'site logins can be filled');
  assert.equal(titled(up.app, 'Fill · Amazon').length, 0, 'a login for another site has no Fill');
  assert.equal(titled(up.app, 'Fill · Visa').length, 1, 'a card can be filled on an https page');
  const amazon = rowsNow().find((r) => r.dataset.key === 'ui:am');
  amazon.listeners.click();
  assert.deepEqual(sel(), ['ui:am'], 'clicking a row only selects it');
  assert.equal(up.sent.length, 0, 'and fills nothing');
  const before = up.runtimeMessages.length;
  await titled(up.app, 'Copy username · Amazon')[0].onclick({ stopPropagation() {} });
  assert.deepEqual(copied, ['amy']);
  assert.equal(up.runtimeMessages.slice(before).some((m) => m.wardClipboardClear), false, 'a username is not cleared later');
  await titled(up.app, 'Copy password · Amazon')[0].onclick({ stopPropagation() {} });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(copied, ['amy', 'pw3']);
  assert.equal(up.runtimeMessages.slice(before).some((m) => m.wardClipboardClear), true, 'a password is cleared 30 s later');
  await titled(up.app, 'Copy card number · Visa')[0].onclick({ stopPropagation() {} });
  assert.equal(copied.at(-1), '4111111111111111');
  // Settings: clearing off means no clear request
  up.api.settingsView();
  const boxes = (node) => (node?.tagName === 'INPUT' && node.type === 'checkbox' ? [node] : []).concat(...(node?.children || []).map(boxes));
  const clearBox = boxes(up.app)[3]; // after the two save offers and passkey autofill
  clearBox.checked = false;
  await clearBox.listeners.change();
  assert.equal((await up.local.get('clearClipboard')).clearClipboard, false);
  assert.ok(titled(up.app, 'Removes this vault').length === 1 || textOf(up.app).includes('Log out'), 'Settings has Log out');
}
console.log('popup storage, passkey, account, save-window, and move checks ok');

// Design system (docs/design/SYSTEM.md): the in-page UI copies the popup's colour tokens and avatar palette, since a
// page's shadow root can't load popup.css. Both copies must match, in dark and light.
{
  const css = await readFile(new URL('./popup.css', import.meta.url), 'utf8');
  const inpage = await readFile(new URL('./inpage.js', import.meta.url), 'utf8');
  const popupJs = await readFile(new URL('./popup.js', import.meta.url), 'utf8');
  const vars = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
  const dark = vars(css.match(/:root \{([^}]*)\}/)[1]), light = { ...dark, ...vars(css.match(/:root\[data-theme="light"\] \{([^}]*)\}/)[1]) };
  const theme = inpage.match(/const THEME = `([\s\S]*?)`;/)[1];
  const pageDark = vars(theme.match(/\.box \{([^}]*)\}/)[1]), pageLight = { ...pageDark, ...vars(theme.match(/prefers-color-scheme: light\) \{ \.box \{([^}]*)\}/)[1]) };
  assert.ok(Object.keys(pageDark).length >= 7, 'inpage.js THEME tokens found');
  for (const k of Object.keys(pageDark)) {
    assert.equal(pageDark[k], dark[k], `inpage.js --${k} (dark) matches popup.css`);
    assert.equal(pageLight[k], light[k], `inpage.js --${k} (light) matches popup.css`);
  }
  const palette = (src) => src.match(/const PALETTE = (\[[^\]]*\])/)[1].replace(/'/g, '"');
  assert.deepEqual(JSON.parse(palette(inpage)), JSON.parse(palette(popupJs)), 'inpage.js avatar palette matches popup.js');
}
console.log('design tokens in step ok');
// page.js: the credential it hands the page takes the toJSON that @github/webauthn-json assigns (in strict mode).
{
  const listeners = [];
  const ctx = {
    btoa, atob, crypto, setTimeout, clearTimeout, DOMException,
    PublicKeyCredential: class { static async getClientCapabilities() { return { conditionalGet: true }; } },
    AuthenticatorAssertionResponse: class {}, AuthenticatorAttestationResponse: class {},
    navigator: { credentials: { create: async () => null, get: async () => null } },
    addEventListener: (_, f) => listeners.push(f), removeEventListener: () => {},
    postMessage: (m) => queueMicrotask(() => listeners.forEach((f) => f({ source: vm.runInContext('window', ctx), data: { bwliteRes: m.bwliteReq, result: {
      id: 'aWQ', rawId: 'aWQ', type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA', userHandle: null } } } }))),
  };
  ctx.window = ctx;
  vm.runInNewContext(await readFile('./page.js', 'utf8'), ctx);
  const cred = await ctx.navigator.credentials.get({ publicKey: { challenge: new Uint8Array([1]) } });
  assert.doesNotThrow(() => { 'use strict'; cred.toJSON = () => 'mine'; }, 'credential.toJSON is assignable');
  assert.equal(cred.toJSON(), 'mine');
  assert.equal(await ctx.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(), true, 'sites see a platform authenticator');
  assert.equal(JSON.stringify(await ctx.PublicKeyCredential.getClientCapabilities()), '{"conditionalGet":true,"userVerifyingPlatformAuthenticator":true}',
    'client capabilities keep the native fields and add the platform authenticator');
  console.log('page credential checks ok');
}
{ // page.js passkey autofill: Ward holds it and answers, or the browser gets it (no passkey, "device", no answer);
  // the page's AbortSignal ends it; cancelling the browser's prompt after "device" goes back to Ward.
  const listeners = new Set(), posted = [], native = [], timers = [];
  let ward = () => {}, nativeAnswer = async () => 'native';
  const ctx = {
    btoa, atob, crypto, clearTimeout, DOMException, AbortController,
    setTimeout: (f, ms) => (ms === 5e3 ? timers.push(f) : setTimeout(f, ms)),
    PublicKeyCredential: class {}, AuthenticatorAssertionResponse: class {}, AuthenticatorAttestationResponse: class {},
    navigator: { credentials: { create: async () => null, get: (o) => (native.push(o), nativeAnswer(o)) } },
    addEventListener: (_, f) => listeners.add(f), removeEventListener: (_, f) => listeners.delete(f),
    postMessage: (m) => (posted.push(m), queueMicrotask(() => ward(m))),
  };
  ctx.window = ctx;
  vm.runInNewContext(await readFile('./page.js', 'utf8'), ctx);
  const win = vm.runInContext('window', ctx);
  const say = (data) => [...listeners].forEach((f) => f({ source: win, data }));
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const get = (extra) => ctx.navigator.credentials.get({ mediation: 'conditional', publicKey: { challenge: new Uint8Array([1]) }, ...extra });
  const result = { id: 'aWQ', rawId: 'aWQ', type: 'public-key', clientExtensionResults: {},
    response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA', userHandle: null } };

  ward = (m) => m.bwliteReq && say({ bwliteRes: m.bwliteReq, fallback: true });
  assert.equal(await get(), 'native', 'no passkey in Ward: the browser takes it');
  assert.equal(native.at(-1).mediation, 'conditional');
  assert.equal(posted.at(-1).conditional, true, 'asked as passkey autofill');

  ward = (m) => m.bwliteReq && say({ bwliteRes: m.bwliteReq, hold: true });
  let p = get(), done = false;
  p.then(() => (done = true));
  await tick();
  assert.equal(done, false, 'held: pending until a pick');
  const n = native.length;
  say({ bwliteRes: posted.at(-1).bwliteReq, result });
  assert.equal((await p).id, 'aWQ', 'a pick in Ward\'s menu answers it');
  assert.equal(native.length, n, 'without the browser');

  p = get();
  await tick();
  nativeAnswer = async () => { throw new DOMException('cancelled', 'NotAllowedError'); };
  const first = posted.at(-1).bwliteReq;
  say({ bwliteRes: first, fallback: true, device: true });
  await tick();
  assert.equal(native.at(-1).mediation, 'optional', '"Use device or security key" opens the browser\'s prompt');
  assert.ok(posted.at(-1).bwliteReq && posted.at(-1).bwliteReq !== first, 'cancelling it goes back to Ward');
  nativeAnswer = async () => 'native';
  say({ bwliteRes: posted.at(-1).bwliteReq, result });
  assert.equal((await p).id, 'aWQ');

  const ac = new AbortController();
  p = get({ signal: ac.signal });
  await tick();
  const held = posted.at(-1).bwliteReq;
  ac.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError', 'the page can abort it');
  assert.equal(posted.at(-1).wardCondEnd, held, 'and Ward drops it');
  say({ bwliteRes: held, result }); // a late pick changes nothing
  await assert.rejects(get({ signal: AbortSignal.abort() }), (e) => e.name === 'AbortError', 'an aborted signal fails at once');

  ward = () => {};
  p = get();
  await tick();
  const silent = posted.at(-1).bwliteReq;
  timers.at(-1)();
  assert.equal(await p, 'native', 'no answer from Ward: the browser takes it');
  assert.equal(posted.at(-1).wardCondEnd, silent, 'and Ward drops it');
  console.log('page passkey autofill checks ok');
}
const inpageSource = await readFile('./inpage.js', 'utf8');
{ // a click on a page with no password field and no single username-like field (Google's OAuth consent page) used to
  // throw in capture(): loginFields gave user = false and `false?.value.trim()` failed
  const on = {}, sent = [];
  class El { closest() { return null; } }
  const input = (name) => Object.assign(new HTMLInput(), { name, id: '', autocomplete: '', type: 'text', value: 'x' });
  class HTMLInput extends El { getBoundingClientRect() { return { width: 100, right: 100, bottom: 10 }; } }
  const button = Object.assign(new El(), { closest: (s) => (s.includes('button') ? button : null) });
  for (const inputs of [[], [input('q'), input('code')]]) {
    const ctx = {
      HTMLInputElement: HTMLInput, HTMLSelectElement: class {}, HTMLTextAreaElement: class {}, Node: El, performance, scrollX: 0, scrollY: 0,
      getComputedStyle: () => ({ visibility: 'visible' }), location: { protocol: 'https:' }, navigator: {}, addEventListener() {},
      document: { activeElement: null, querySelectorAll: () => inputs, addEventListener: (t, f) => (on[t] ||= []).push(f) },
      chrome: { runtime: { sendMessage: async (m) => (sent.push(m), null), onMessage: { addListener() {} } } },
    };
    ctx.globalThis = ctx;
    for (const k in on) delete on[k];
    vm.runInNewContext(inpageSource, ctx);
    for (const f of on.click) assert.doesNotThrow(() => f({ isTrusted: true, target: button }), 'a click on a page without login fields');
  }
  assert.ok(!sent.some((m) => m.bwliteSubmit), 'no login to offer when there is no username or password');
}
assert.equal(inpageSource.includes('popup.html#save='), false, 'the page bar cannot frame the extension popup');
assert.equal(inpageSource.includes('attachShadow({ mode: \'closed\' })'), true, 'the save token stays in a closed extension bar');
assert.match(inpageSource, /const verdict = genuine\(e\);\s*if \(verdict === 'wait'\) return;\s*if \(verdict !== 'ok'\) return closeMenu\(\);/, 'a menu click fills only when it is genuine');
assert.match(inpageSource, /menuGuard\.observe\(menu, \{ attributes: true \}\)/, 'the page cannot move or restyle the menu');
assert.match(inpageSource, /typed\.get\(i\) === i\.value/, 'only typed passwords are offered for saving');
assert.match(inpageSource, /const genuine = \(e\) => \{\s*if \(!e\.isTrusted[^\n]*\n[\s\S]*?elementFromPoint/, 'genuine: trusted click on the menu itself');
assert.match(inpageSource, /trackVisibility: true/, 'genuine: IntersectionObserver v2 occlusion check');
assert.match(inpageSource, /!userFocused\(f\)\) return;/, 'the menu opens only after real user focus');
assert.match(inpageSource, /userActivation && !navigator\.userActivation\.isActive\) return;/, 'save capture needs user activation');

{ // Generator: sets, lengths, uniform picks, passphrases from the EFF list, usernames
  const eff = (await readFile(new URL('./vendor/eff_large_wordlist.txt', import.meta.url), 'utf8')).trim().split('\n').map((l) => l.split('\t')[1]);
  assert.deepEqual(gen.words(), eff, 'eff_large_wordlist.js is generated from the .txt (vendor/wordlist.sh)');
  assert.equal(new Set(gen.words()).size, 7776);
  for (let i = 0; i < 200; i++) {
    const p = gen.password({ length: 12 });
    assert.equal(p.length, 12);
    for (const re of [/[A-Z]/, /[a-z]/, /[0-9]/, /[!@#$%^&*_-]/]) assert.match(p, re, 'one of each set');
    assert.doesNotMatch(p, /[IlO01o]/, 'ambiguous characters avoided by default');
  }
  assert.match(gen.password({ length: 8, upper: false, lower: false, symbols: false }), /^[2-9]{8}$/);
  assert.match(gen.password({ upper: false, lower: false, digits: false, symbols: false }), /^[a-km-np-z]{20}$/, 'nothing chosen: lowercase');
  assert.equal(gen.password({ length: 3 }).length, 8, 'length is clamped');
  assert.equal(gen.password({ length: 9999 }).length, 128);
  assert.match(gen.password({ avoidAmbiguous: false, length: 128, upper: false, digits: false, symbols: false }), /^[a-z]{128}$/);
  const words = gen.passphrase({ words: 6, separator: ' ', capitalize: true, number: true }).split(' ');
  assert.equal(words.length, 6);
  assert.equal(words.filter((w) => /\d$/.test(w)).length, 1, 'one word carries the number');
  for (const w of words) assert.ok(gen.words().includes(w.replace(/\d$/, '').toLowerCase()) && /^[A-Z]/.test(w));
  assert.equal(gen.bits({ type: 'passphrase', words: 5 }), 64);
  assert.equal(gen.bits({ length: 20 }), 120, '20 characters from 66 (look-alikes removed)');
  assert.match(gen.username({ type: 'username', userType: 'plus', email: 'ann+old@example.com' }), /^ann\+[a-z-]+\d{4}@example\.com$/);
  assert.match(gen.username({ userType: 'catchall', domain: '@mail.example.org' }), /^[a-z-]+\d{4}@mail\.example\.org$/);
  assert.throws(() => gen.username({ userType: 'catchall', domain: 'nope' }), /catch-all domain/);
  assert.throws(() => gen.username({ userType: 'plus', email: '' }), /email/);
  assert.match(gen.generate({ type: 'username', capitalize: true }), /^[A-Z][a-z-]+$/);
  assert.deepEqual(gen.normalize({ type: 'evil', length: 'x', separator: 'abcdef' }).type, 'password');
  // uniform: 60,000 picks over 6 values stay within 3% of 10,000 each (a modulo bias over 2^32 is far smaller;
  // this guards against a broken rejection loop)
  const counts = new Array(6).fill(0);
  for (let i = 0; i < 60000; i++) counts[gen.randomInt(6)]++;
  for (const c of counts) assert.ok(Math.abs(c - 10000) < 300, `randomInt uniform: ${counts}`);
  assert.throws(() => gen.randomInt(0));
  console.log('generator ok');
}

{ // Two-step login, bw.js side: methods in Ward's order, Duo-only refused, the email code requested
  const realFetch = globalThis.fetch, seen = [];
  const reply = (status, json) => ({ ok: status < 300, status, json: async () => json });
  const keys = { kdf: { kdf: 0, kdfIterations: 600000 }, hash: 'aGFzaA==', key: new Uint8Array(64) };
  try {
    globalThis.fetch = async (url, init) => (seen.push([url, init]), reply(400, { error: 'invalid_grant', TwoFactorProviders2: { 0: null, 1: { Email: 'a***@x.y' }, 2: { AuthUrl: 'u' }, 7: { challenge: 'Y2g' } } }));
    const e = await bw.loginWith('https://vault.example.com', 'a@x.y', keys, 'dev', null, 'stale').catch((x) => x);
    assert.equal(e.need, '2fa');
    assert.deepEqual(e.providers.map((x) => x.id), [7, 0, 1], 'security key first, Duo left out');
    assert.equal(e.providers[2].data.Email, 'a***@x.y');
    const body = new URLSearchParams(seen[0][1].body);
    assert.deepEqual([body.get('password'), body.get('twoFactorProvider'), body.get('twoFactorToken')], ['aGFzaA==', '5', 'stale'], 'hash from loginKeys, remember token tried first');
    seen.length = 0;
    await bw.loginWith('https://vault.example.com', 'a@x.y', keys, 'dev', { kind: '2fa', provider: 7, value: '{"id":"k"}' }).catch(() => {});
    const b2 = new URLSearchParams(seen[0][1].body);
    assert.deepEqual([b2.get('twoFactorProvider'), b2.get('twoFactorToken'), b2.get('twoFactorRemember')], ['7', '{"id":"k"}', '1']);
    globalThis.fetch = async () => reply(400, { TwoFactorProviders2: { 2: { AuthUrl: 'u' } } });
    await assert.rejects(bw.loginWith('https://vault.example.com', 'a@x.y', keys, 'dev'), /Duo/);
    globalThis.fetch = async (url, init) => (seen.push([url, init]), reply(200, {}));
    seen.length = 0;
    await bw.sendEmailCode('https://vault.example.com', 'a@x.y', keys, 'dev');
    assert.equal(seen[0][0], 'https://vault.example.com/api/two-factor/send-email-login');
    assert.deepEqual(JSON.parse(seen[0][1].body), { email: 'a@x.y', masterPasswordHash: 'aGFzaA==', deviceIdentifier: 'dev' });
  } finally { globalThis.fetch = realFetch; }

  // The security key prompt, run like executeScript runs it: alone, with a fake page and authenticator.
  const el = () => ({ style: {}, textContent: '', append() {}, replaceChildren(...k) { this.kids = k; } });
  const bytes = (...b) => new Uint8Array(b).buffer;
  let asked;
  const sandbox = vm.createContext({ btoa, atob, Uint8Array, String, JSON, Object, Error,
    document: { createElement: el, documentElement: el(), body: el(), title: '' },
    navigator: { credentials: { get: async (o) => ((asked = o), { id: 'a-b_c', rawId: bytes(1, 2, 251), type: 'public-key',
      getClientExtensionResults: () => ({ appid: false }),
      response: { authenticatorData: bytes(9), clientDataJSON: bytes(123, 125), signature: bytes(48, 0), userHandle: null } }) } } });
  const prompt = vm.runInContext(`(${securityKeyPrompt.toString()})`, sandbox); // proves it needs nothing from its module
  const res = await prompt({ challenge: 'AQID', rpId: 'vault.example.com', allowCredentials: [{ type: 'public-key', id: '-_8' }], userVerification: 'discouraged' }, 'vault.example.com');
  assert.deepEqual(Array.from(asked.publicKey.challenge), [1, 2, 3]);
  assert.deepEqual(Array.from(asked.publicKey.allowCredentials[0].id), [251, 255], 'base64url ids decoded');
  assert.equal(asked.publicKey.rpId, 'vault.example.com');
  assert.deepEqual(JSON.parse(res.ok), { id: 'a-b_c', rawId: 'AQL7', type: 'public-key', extensions: { appid: false },
    response: { authenticatorData: 'CQ', clientDataJson: 'e30', signature: 'MAA', userHandle: null } }, 'the shape Vaultwarden reads');
  sandbox.navigator.credentials.get = async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); };
  assert.match((await prompt({ challenge: 'AQID' }, 'h')).error, /cancelled or timed out/);
  assert.match((await prompt({}, 'h')).error, /no security key challenge/);
  console.log('two-step login (bw.js, security key prompt) ok');
}

{ // vendor/public_suffix_list.js is generated from the .dat by vendor/psl.sh: same rules, in lookup form
  const psl = await import('./vendor/public_suffix_list.js');
  const dat = await readFile(new URL('./vendor/public_suffix_list.dat', import.meta.url), 'utf8');
  const ascii = (b) => { try { return new URL(`https://${b}`).hostname.toLowerCase().replace(/\.$/, ''); } catch { return b.toLowerCase(); } };
  const want = { PSL_EXACT: new Set(), PSL_WILDCARD: new Set(), PSL_EXCEPTION: new Set() };
  for (const line of dat.split('\n')) {
    const r = line.trim().split(/\s/)[0];
    if (!r || r.startsWith('//')) continue;
    if (r[0] === '!') want.PSL_EXCEPTION.add(ascii(r.slice(1))); else if (r.startsWith('*.')) want.PSL_WILDCARD.add(ascii(r.slice(2))); else want.PSL_EXACT.add(ascii(r));
  }
  for (const [k, set] of Object.entries(want)) assert.deepEqual(new Set(psl[k].trim().split('\n')), set, `${k} matches public_suffix_list.dat (run vendor/psl.sh)`);
  assert.match(psl.PSL_DATE, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(bw.baseDomain('a.b.bücher.example.xn--p1ai'), 'example.xn--p1ai', 'internationalised suffixes still apply');
  console.log('public suffix list in step ok');
}

{ // Base domains computed ahead: used when their suffix-list version matches, ignored when stale or misaligned
  const it = (d, dv) => ({ uris: ['https://shop.example.com/x'], d, dv });
  const V = bw.DOMAINS_VERSION;
  assert.ok(bw.matches(it(['example.com'], V), 'https://example.com/'), 'stored domain used');
  assert.ok(!bw.matches(it(['other.com'], V), 'https://example.com/'), 'and trusted as stored (it was computed by decryptVault)');
  assert.ok(bw.matches(it(['other.com'], V + 1), 'https://example.com/'), 'a different suffix list version: recomputed');
  assert.ok(bw.matches(it(['other.com']), 'https://example.com/'), 'no version (an older cache): recomputed');
  assert.ok(!bw.matches(it(['github.io']), 'https://evil.github.io/') && !bw.matches({ uris: ['https://login.github.io'], d: ['github.io'] }, 'https://evil.github.io/'),
    'a pre-suffix-list domain in an old cache cannot match another github.io site');
  assert.ok(bw.matches(it(['other.com', 'x'], V), 'https://example.com/'), 'not one per URI: recomputed');
  const raw = [['youtube.com', 'google.com', 'google.co.uk'], ['one.example', 'two.example']];
  const ready = { v: V, groups: raw.map((g) => g.map((x) => bw.domainOf(x))) };
  for (const [page, uri] of [['https://www.youtube.com/', 'https://accounts.google.com'], ['https://two.example/', 'https://one.example'], ['https://x.org/', 'https://google.com']])
    assert.equal(bw.matches(item([uri]), page, bw.equivalents(ready)), bw.matches(item([uri]), page, bw.equivalents(raw)), `equivalents forms agree on ${page}`);
  assert.ok(bw.matches(item(['https://google.co.uk']), 'https://youtube.com/', bw.equivalents({ v: V + 1, groups: ready.groups })), 'stale groups recomputed');
  console.log('precomputed domains ok');
}

{ // The plain-host fast path in domainOf gives exactly what URL gives (the old way), on tricky and random input
  const slowHost = (u) => { try { return new URL(/^[a-z][\w+.-]*:\/\//i.test(u) ? u : `https://${u}`).hostname; } catch { return null; } };
  const slowNorm = (h) => { let v = String(h || '').trim(); try { if (v && !v.includes('/') && !v.startsWith('[')) v = new URL(`https://${v}`).hostname; } catch {} return v.toLowerCase().replace(/\.$/, ''); };
  const expected = (u) => { const h = slowHost(u); return h === null ? null : bw.baseDomain(slowNorm(h)); };
  const tricky = ['https://Example.COM/x', 'example.com', 'http://1.2.3.4/', 'http://0x7f.1/', 'https://1.2.3/', 'https://a.b.123/', 'https://xn--bcher-kva.de/',
    'https://xn--zz.com/', 'https://exa\tmple.com/', ' https://example.com', 'https://example.com./', 'https://user@example.com/', 'https://example.com:99999/',
    'https://example.com:443/', 'ftp://example.com/', 'https:example.com', '//example.com', 'https://-a-.example.com', 'https://a..b.com', 'https://%65xample.com',
    'https://exam ple.com', 'https://EXAMPLE.co.uk', 'localhost', 'localhost:8080/x', 'https://bücher.de', 'javascript:alert(1)', 'https://a.github.io',
    'https://' + 'a'.repeat(64) + '.com', 'https://' + 'a.'.repeat(130) + 'com', 'HTTP://WWW.Example.Com?x', 'https://example.com#frag', 'https://example.com\\x', ''];
  for (const u of tricky) assert.equal(bw.domainOf(u), expected(u), `domainOf(${JSON.stringify(u)})`);
  const pre = ['', 'http://', 'https://', 'HTTPS://', 'ftp://', '//', 'https:'], abc = 'aZ09.-:/@?#\\%_ \tx';
  let seed = 7;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) >>> 0) % n);
  for (let k = 0; k < 30000; k++) {
    let u = pre[rand(pre.length)];
    const n = 1 + rand(14);
    for (let j = 0; j < n; j++) u += rand(3) ? 'abcdexyz0123456789.-'[rand(20)] : abc[rand(abc.length)];
    if (rand(4) === 0) u += '.com';
    assert.equal(bw.domainOf(u), expected(u), `domainOf(${JSON.stringify(u)})`);
  }
  console.log('domain fast path matches URL ok');
}

if (!process.argv.includes('--integration')) process.exit(0);

// Registration is not part of the extension; done here with the same primitives.
async function register(email, kdf) {
  const mk = await bw.makeMasterKey(PASSWORD, email, kdf);
  const userKey = crypto.getRandomValues(new Uint8Array(64));
  const rsa = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-1' }, true, ['encrypt', 'decrypt']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('spki', rsa.publicKey));
  const json = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
  const token = await (await fetch(`${SERVER}/identity/accounts/register/send-verification-email`, { ...json, body: JSON.stringify({ email, name: 'test' }) })).text();
  const r = await fetch(`${SERVER}/identity/accounts/register/finish`, {
    ...json,
    body: JSON.stringify({
      email, emailVerificationToken: token, masterPasswordHash: await bw.passwordHash(mk, PASSWORD), masterPasswordHint: null, ...kdf,
      userSymmetricKey: await bw.encrypt(userKey, await bw.stretch(mk)),
      userAsymmetricKeys: { publicKey: bw.b64(pub), encryptedPrivateKey: await bw.encrypt(new Uint8Array(await crypto.subtle.exportKey('pkcs8', rsa.privateKey)), userKey) },
    }),
  });
  assert.ok(r.ok, `register: ${r.status} ${await r.text()}`);
  return { userKey, publicKey: rsa.publicKey };
}

const run = Date.now();
const email = `pbkdf-${run}@example.com`;
const reg = await register(email, { kdf: 0, kdfIterations: 600000 });
const deviceId = crypto.randomUUID();

await assert.rejects(bw.login(SERVER, email, 'wrong', deviceId), /Username or password is incorrect|invalid/i);
const r = await bw.login(SERVER, email, PASSWORD, deviceId);
assert.deepEqual(r.userKey, reg.userKey);
assert.deepEqual(await bw.unlock(PASSWORD, email, r.kdf, r.protectedKey), reg.userKey);
await assert.rejects(bw.unlock('nope', email, r.kdf, r.protectedKey), /Wrong master password/);
const s = { server: SERVER, tokens: r.tokens };
const me = (await bw.api(s, '/sync')).profile.id;
console.log('pbkdf2 login + unlock ok');

// Create, then edit a personal login
await bw.saveCipher(s, r.userKey, null, { name: 'Example', username: 'ben', password: 'pw1', totp: 'JBSWY3DPEHPK3PXP', notes: 'n', uris: ['https://example.com'] });
let vault = await bw.decryptVault(await bw.api(s, '/sync'), r.userKey);
assert.equal(vault.length, 1);
assert.deepEqual([vault[0].name, vault[0].username, vault[0].password, vault[0].uris], ['Example', 'ben', 'pw1', ['https://example.com']]);
// add a custom field the extension doesn't show, to make sure edits keep it
const raw = vault[0].raw;
await bw.api(s, `/ciphers/${raw.id}`, 'PUT', { ...raw, encryptedFor: me, attachments: undefined, fields: [{ type: 0, name: await bw.encrypt('pin', r.userKey), value: await bw.encrypt('1234', r.userKey) }] });
vault = await bw.decryptVault(await bw.api(s, '/sync'), r.userKey);
await bw.saveCipher(s, r.userKey, vault[0], { ...vault[0], password: 'pw2', uris: ['https://example.com', 'https://login.example.org'] });
const sync = await bw.api(s, '/sync');
vault = await bw.decryptVault(sync, r.userKey);
assert.equal(vault[0].password, 'pw2');
assert.deepEqual(vault[0].uris, ['https://example.com', 'https://login.example.org']);
const c = sync.ciphers[0];
assert.equal(c.fields.length, 1, 'custom field kept');
assert.equal(new TextDecoder().decode(await bw.decrypt(c.passwordHistory[0].password, r.userKey)), 'pw1');
assert.equal(new TextDecoder().decode(await bw.decrypt(c.login.uris[1].uriChecksum, r.userKey)),
  bw.b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('https://login.example.org'))));
console.log('create + edit ok (custom field kept, password history, uri checksum)');

// Passkey saved into the login survives the round trip through the server and still signs
await bw.saveCipher(s, r.userKey, vault[0], { ...vault[0], passkey: created.passkey });
const synced = (await bw.decryptVault(await bw.api(s, '/sync'), r.userKey))[0];
assert.equal(synced.passkeys.length, 1);
assert.equal(synced.passkeys[0].keyValue, created.passkey.keyValue);
assert.equal(synced.password, 'pw2');
await verifyGet(synced.passkeys[0], pkReg.publicKey);
console.log('passkey stored in vault ok');

// Incremental decrypt: unchanged items come back as the same object, changed ones are decrypted fresh
const prev = new Map(vault.map((i) => [i.id, i]));
assert.equal((await bw.decryptVault(sync, r.userKey, prev))[0], vault[0]);
const stale = new Map([[vault[0].id, { ...vault[0], rev: 'old', password: 'stale' }]]);
assert.equal((await bw.decryptVault(sync, r.userKey, stale))[0].password, 'pw2');
// Base domains are stored with the suffix-list version that made them; unversioned or older ones (BW Lite's cache
// computed them without the Public Suffix List) are never trusted for matching (offline checks above).
assert.deepEqual([vault[0].d, vault[0].dv], [vault[0].uris.map((u) => bw.domainOf(u)), bw.DOMAINS_VERSION], 'derived domains carry their version');
assert.equal(vault[0].m, undefined, 'no match types set');
console.log('incremental decrypt ok');

// Item with its own cipher key
const ck = crypto.getRandomValues(new Uint8Array(64));
await bw.api(s, '/ciphers', 'POST', { type: 1, encryptedFor: me, key: await bw.encrypt(ck, r.userKey), name: await bw.encrypt('Keyed', ck), login: { username: await bw.encrypt('u', ck) } });
vault = await bw.decryptVault(await bw.api(s, '/sync'), r.userKey);
let keyed = vault.find((i) => i.name === 'Keyed');
await bw.saveCipher(s, r.userKey, keyed, { ...keyed, password: 'kp' });
keyed = (await bw.decryptVault(await bw.api(s, '/sync'), r.userKey)).find((i) => i.name === 'Keyed');
assert.equal(keyed.password, 'kp');
console.log('per-item cipher key ok');

// Match detection chosen in the form round-trips through the server; saving without it keeps it
await bw.saveCipher(s, r.userKey, keyed, { ...keyed, uris: ['https://gym.example.org', 'https://x.example.net'], match: [1, null] });
keyed = (await bw.decryptVault(await bw.api(s, '/sync'), r.userKey)).find((i) => i.name === 'Keyed');
assert.deepEqual(keyed.m, [1, null]);
assert.ok(!bw.matches(keyed, 'https://qb.example.org/') && bw.matches(keyed, 'https://y.example.net/'));
await bw.saveCipher(s, r.userKey, keyed, { ...keyed, password: 'kp2' });
keyed = (await bw.decryptVault(await bw.api(s, '/sync'), r.userKey)).find((i) => i.name === 'Keyed');
assert.deepEqual(keyed.m, [1, null]);
console.log('match detection round-trip ok');

// Organization item
const orgKey = crypto.getRandomValues(new Uint8Array(64));
const wrapped = '4.' + bw.b64(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, reg.publicKey, orgKey));
const org = await bw.api(s, '/organizations', 'POST', { name: 'Org', billingEmail: email, key: wrapped, collectionName: await bw.encrypt('Default', orgKey), planType: 0 });
const cols = await bw.api(s, `/organizations/${org.id}/collections`);
await bw.api(s, '/ciphers/create', 'POST', {
  cipher: { type: 1, encryptedFor: me, organizationId: org.id, name: await bw.encrypt('Shared', orgKey), login: { password: await bw.encrypt('orgpw', orgKey) } },
  collectionIds: [cols.data[0].id],
});
vault = await bw.decryptVault(await bw.api(s, '/sync'), r.userKey);
let shared = vault.find((i) => i.name === 'Shared');
assert.equal(shared.password, 'orgpw');
await bw.saveCipher(s, r.userKey, shared, { ...shared, password: 'orgpw2' });
shared = (await bw.decryptVault(await bw.api(s, '/sync'), r.userKey)).find((i) => i.name === 'Shared');
assert.equal(shared.password, 'orgpw2');
console.log('organization item read + edit ok');

// Delete moves to the trash
await bw.deleteCipher(s, shared.id);
const trashed = (await bw.api(s, '/sync')).ciphers.find((c) => c.id === shared.id);
assert.ok(trashed?.deletedDate, 'in the trash');
assert.ok(!(await bw.decryptVault(await bw.api(s, '/sync'), r.userKey)).some((i) => i.id === shared.id));
console.log('delete to trash ok');

// Token refresh
s.tokens.expires = 0;
let refreshed;
s.onTokens = (t) => (refreshed = t);
await bw.api(s, '/sync');
assert.ok(refreshed?.access && refreshed.expires > Date.now());
console.log('token refresh ok');

// Ward: live updates. The notification hub announces a change made by another client, and the service worker's
// background sync (sync.js) brings the open vault up to date in storage.
{
  assert.ok(hasInvocation(new Uint8Array([0x05, 0x95, 0x01, 0x80, 0xc0, 0xa0])), 'an invocation frame is a change');
  assert.ok(!hasInvocation(SIGNALR_PING), 'a ping is not');
  assert.ok(!hasInvocation(new Uint8Array([0x7b, 0x7d, 0x1e])), 'nor the handshake answer');
  assert.ok(!hasInvocation(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x08, 0x91, 0x01])), 'an over-long length ends parsing (no hang)');
  assert.ok(!hasInvocation(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff])), 'a 6-byte varint is refused');
  assert.ok(hasInvocation(new Uint8Array([0x02, 0x91, 0x06, 0x05, 0x95, 0x01, 0x80, 0xc0, 0xa0])), 'a ping then a change in one frame');
  const tok = await bw.refresh(SERVER, s.tokens.refresh);
  const ws = new WebSocket(`${bw.urls(SERVER).notifications}/hub?access_token=${encodeURIComponent(tok.access)}`);
  ws.binaryType = 'arraybuffer';
  const frames = [];
  let wake;
  ws.onmessage = (e) => { frames.push(e.data); wake?.(); };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('notifications websocket failed')); });
  ws.send('{"protocol":"messagepack","version":1}\x1e');
  const waitFor = async (pred, ms) => {
    const end = Date.now() + ms;
    while (!frames.some(pred) && Date.now() < end) await new Promise((r) => { wake = r; setTimeout(r, 200); });
    return frames.some(pred);
  };
  assert.ok(await waitFor((f) => typeof f !== 'string' && new Uint8Array(f)[0] === 0x7b, 5000), 'hub answers the messagepack handshake');
  ws.send(SIGNALR_PING);
  assert.ok(await waitFor((f) => typeof f !== 'string' && new Uint8Array(f)[1] === 0x91, 5000), 'Vaultwarden echoes the keep-alive ping');
  // background sync of an "open" vault, with in-memory storage
  const store = () => { const d = new Map(); return { d,
    get: async (k) => Object.fromEntries((k == null ? [...d.keys()] : Array.isArray(k) ? k : [k]).filter((x) => d.has(x)).map((x) => [x, structuredClone(d.get(x))])),
    set: async (o) => { for (const [x, v] of Object.entries(o)) d.set(x, structuredClone(v)); },
    remove: async (k) => { for (const x of Array.isArray(k) ? k : [k]) d.delete(x); } }; };
  const L = store(), S = store();
  await L.set({ accounts: [{ id: 'live', server: SERVER, email, tokens: tok, lastSync: 0 }] });
  await S.set({ 'live:key': bw.b64(r.userKey) });
  assert.equal(await syncOpenVault(L, S, 'live'), true, 'a stale open vault syncs');
  const before = JSON.parse(S.d.get('live:list'));
  assert.equal(await syncOpenVault(L, S, 'live'), false, 'a fresh one waits for the next period');
  // another client changes a login
  const other = { server: SERVER, tokens: await bw.refresh(SERVER, s.tokens.refresh) };
  const cur = await bw.decryptVault(await bw.api(other, '/sync'), r.userKey);
  frames.length = 0;
  await bw.saveCipher(other, r.userKey, cur[0], { ...cur[0], password: 'from-phone' });
  assert.ok(await waitFor((f) => typeof f !== 'string' && hasInvocation(f), 8000), 'the hub announces the change');
  assert.equal(await syncOpenVault(L, S, 'live', { force: true }), true);
  const after = JSON.parse(S.d.get('live:list'));
  assert.equal(after.find((i) => i.id === cur[0].id).password, 'from-phone', 'the open vault has the new password');
  assert.equal(after.length, before.length);
  assert.equal(new TextDecoder().decode(await bw.decrypt(L.d.get('live:index4'), r.userKey)), S.d.get('live:list'), 'encrypted cache matches');
  await S.set({ 'live:key': bw.b64(crypto.getRandomValues(new Uint8Array(64))) });
  ws.close();
}
console.log('live notifications + background sync ok');

{ // Ward: secure notes, cards and identities round-trip through Vaultwarden
  const note = await bw.saveCipher(s, r.userKey, null, { type: 2, name: 'Wi-Fi', notes: 'ssid: home\npass: hunter2' });
  const card = await bw.saveCipher(s, r.userKey, null, { type: 3, name: 'Visa', notes: '',
    card: { cardholderName: 'Ann Lee', number: '4111111111111111', expMonth: '3', expYear: '2029', code: '123' } });
  const ident = await bw.saveCipher(s, r.userKey, null, { type: 4, name: 'Me', notes: '',
    identity: { firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com', address1: '1 Main St', city: 'Springfield', postalCode: '12345', country: 'US' } });
  let all = await bw.decryptVault(await bw.api(s, '/sync'), r.userKey);
  const byId = (id) => all.find((i) => i.id === id);
  assert.equal(byId(note.id).type, 2);
  assert.equal(byId(note.id).notes, 'ssid: home\npass: hunter2');
  assert.deepEqual(byId(card.id).card, { cardholderName: 'Ann Lee', brand: 'Visa', number: '4111111111111111', expMonth: '3', expYear: '2029', code: '123' }, 'brand detected on save');
  assert.equal(byId(ident.id).identity.email, 'ann@example.com');
  assert.equal(byId(ident.id).identity.ssn, undefined, 'empty fields are left out');
  assert.deepEqual(byId(card.id).uris, [], 'non-logins never match a site');
  // edit keeps fields Ward doesn't show (a custom field added by another client)
  const rawCard = byId(card.id).raw;
  await bw.api(s, `/ciphers/${card.id}`, 'PUT', { ...rawCard, encryptedFor: me, attachments: undefined,
    fields: [{ type: 0, name: await bw.encrypt('PIN', r.userKey), value: await bw.encrypt('9999', r.userKey) }] });
  all = await bw.decryptVault(await bw.api(s, '/sync'), r.userKey);
  await bw.saveCipher(s, r.userKey, byId(card.id), { type: 3, name: 'Visa', notes: 'new', card: { ...byId(card.id).card, expYear: '2031' } });
  const synced2 = await bw.api(s, '/sync');
  all = await bw.decryptVault(synced2, r.userKey);
  assert.equal(byId(card.id).card.expYear, '2031');
  assert.equal(byId(card.id).notes, 'new');
  assert.equal(synced2.ciphers.find((c) => c.id === card.id).fields.length, 1, 'custom field kept on a card edit');
  assert.equal(all.filter((i) => (i.type || 1) === 1).length >= 1, true, 'logins are still there');
  for (const x of [note, card, ident]) await bw.deleteCipher(s, x.id);
}
console.log('secure notes, cards, identities round trip ok');

// Argon2id account
const email2 = `argon-${run}@example.com`;
const reg2 = await register(email2, { kdf: 1, kdfIterations: 3, kdfMemory: 64, kdfParallelism: 4 });
assert.deepEqual((await bw.login(SERVER, email2, PASSWORD, deviceId)).userKey, reg2.userKey);
console.log('argon2id login ok');

// Email two-step login, against a Vaultwarden that sends mail to Mailpit (MAILPIT=http://localhost:8025; see
// docs/TESTING.md). Skipped without it.
if (process.env.MAILPIT) {
  const mailpit = process.env.MAILPIT.replace(/\/+$/, '');
  const email3 = `email2fa-${run}@example.com`;
  await register(email3, { kdf: 0, kdfIterations: 600000 });
  const dev = crypto.randomUUID();
  const keys = await bw.loginKeys(SERVER, email3, PASSWORD);
  const first = await bw.loginWith(SERVER, email3, keys, dev);
  const s3 = { server: SERVER, tokens: first.tokens };
  // the code in the newest email to this address (Mailpit's search API)
  const codeFor = async (to, since) => {
    for (let i = 0; i < 50; i++) {
      const list = await (await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)).json();
      const m = (list.messages || []).find((x) => Date.parse(x.Created) >= since);
      if (m) {
        const text = (await (await fetch(`${mailpit}/api/v1/message/${m.ID}`)).json()).Text;
        return text.match(/\b(\d{6})\b/)[1];
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no email to ${to}`);
  };
  // turn on email two-step for the account (as the web vault does)
  const { userVerificationToken } = await bw.api(s3, '/two-factor/get-email', 'POST', { masterPasswordHash: keys.hash });
  let since = Date.now() - 1000;
  await bw.api(s3, '/two-factor/send-email', 'POST', { email: email3, userVerificationToken });
  await bw.api(s3, '/two-factor/email', 'PUT', { email: email3, token: await codeFor(email3, since), userVerificationToken });
  // now login asks for it; Ward offers email, asks the server to send the code, and logs in with it
  const need = await bw.loginWith(SERVER, email3, keys, dev).catch((e) => e);
  assert.equal(need.need, '2fa');
  assert.deepEqual(need.providers.map((x) => x.id), [1]);
  assert.match(need.providers[0].data.Email, /\*/, 'the address comes back obscured');
  await new Promise((r) => setTimeout(r, 1100)); // Mailpit timestamps have 1 s resolution
  since = Date.now() - 500;
  await bw.sendEmailCode(SERVER, email3, keys, dev);
  const code = await codeFor(email3, since);
  await assert.rejects(bw.loginWith(SERVER, email3, keys, dev, { kind: '2fa', provider: 1, value: '000000' }), /invalid|token/i);
  const ok = await bw.loginWith(SERVER, email3, keys, dev, { kind: '2fa', provider: 1, value: code });
  assert.ok(ok.userKey.length === 64 && ok.twoFactorToken, 'logged in, with a remember token for next time');
  const again = await bw.loginWith(SERVER, email3, keys, dev, null, ok.twoFactorToken);
  assert.ok(again.tokens.access, 'the remember token skips the code next time');
  console.log('email two-step login ok');
}
