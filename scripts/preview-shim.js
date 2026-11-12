// Preview only (scripts/preview.mjs): a fake extension environment with sample data, no real vault or network.
// Runs inside a sandboxed HTML preview panel (no storage, clipboard or extension APIs), so those are faked.
const key = btoa(String.fromCharCode(...new Uint8Array(64)));
// WARD_VIEW (set by preview.mjs): which window to show, as background.js would open it.
const view = window.WARD_VIEW || 'popup';
const list = [
  { id: 'gh', name: 'GitHub', username: 'brandon@example.com', password: 'pw1', uris: ['https://github.com'], totp: 'JBSWY3DPEHPK3PXP', a: 'v',
    passkeys: [{ rpId: 'github.com', credentialId: '0b6f7c1e-2f4a-4d6b-9c1e-1a2b3c4d5e6f', userName: 'brandon@example.com' }] },
  { id: 'gw', name: 'GitHub (work)', username: 'bre@company.com', password: 'pw2', uris: ['https://github.com'], totp: 'JBSWY3DPEHPK3PXQ', a: 'v' },
  { id: 'am', name: 'Amazon', username: 'ann@example.com', password: 'pw3', uris: ['https://amazon.com'], a: 'v' },
  { id: 've', name: 'Vercel', username: 'brandon@example.com', password: 'pw4', uris: ['https://vercel.com'], a: 'v' },
  { id: 'nf', name: 'Netflix', username: 'family@example.com', password: 'pw5', uris: ['https://netflix.com'], a: 'v', reprompt: true },
  { id: 'px', name: 'Proxmox', username: 'root@pam', password: 'pw6', uris: ['https://192.168.1.10:8006'], a: 'v' },
  { id: 'vi', type: 3, name: 'Visa', uris: [], card: { brand: 'Visa', number: '4111111111111111', code: '123', expMonth: '3', expYear: '2029', cardholderName: 'Ann Lee' }, a: 'v' },
  { id: 'ho', type: 4, name: 'Home', uris: [], identity: { firstName: 'Ann', lastName: 'Lee', city: 'Springfield', email: 'ann@example.com' }, a: 'v' },
  { id: 'wf', type: 2, name: 'Wi-Fi', uris: [], note: true, a: 'v' },
];
const area = (data) => ({
  get: async (k) => { const keys = k == null ? Object.keys(data) : Array.isArray(k) ? k : typeof k === 'string' ? [k] : Object.keys(k); return Object.fromEntries(keys.filter((x) => x in data).map((x) => [x, data[x]])); },
  set: async (o) => Object.assign(data, o), remove: async (k) => { for (const x of [].concat(k)) delete data[x]; }, clear: async () => { for (const x in data) delete data[x]; },
});
const later = Date.now() + 3600e3;
const handoffs = {
  'passkey': { 'pk:demo': { id: 'r1', kind: 'get', tabId: 1, origin: 'https://github.com', rpId: 'github.com', expires: later,
    options: { challenge: 'Y2hhbGxlbmdl', rpId: 'github.com' } } },
  'passkey-save': { 'pk:demo': { id: 'r1', kind: 'create', tabId: 1, origin: 'https://vercel.com', rpId: 'vercel.com', expires: later,
    options: { challenge: 'Y2hhbGxlbmdl', rp: { id: 'vercel.com', name: 'Vercel' }, user: { id: 'dXNlcg', name: 'brandon@example.com' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }] } } },
  'save': { 'save:demo': { kind: 'add', tabId: 1, origin: 'https://news.example', username: 'ann@example.com', password: 'pw7', expires: later } },
  'save-update': { 'save:demo': { kind: 'update', tabId: 1, origin: 'https://amazon.com', a: 'v', id: 'am', username: 'ann@example.com', password: 'pw8', expires: later } },
  'save-card': { 'save:demo': { kind: 'form', tabId: 1, origin: 'https://shop.example', expires: later,
    card: { brand: 'Mastercard', number: '5555555555554444', expMonth: '7', expYear: '2030', code: '321', cardholderName: 'Ann Lee' } } },
  // a login waiting for its second step (popup.js twoStepView); the key is the sample all-zero one
  'twostep': { twostep: { server: 'https://bw.example', email: 'me@example.com', label: 'Personal', kdf: { kdf: 0, kdfIterations: 600000 },
    hash: 'aGFzaA==', key, need: '2fa', provider: 7, expires: later,
    providers: [{ id: 7, data: { challenge: 'Y2g' } }, { id: 0, data: null }, { id: 1, data: { Email: 'm*@example.com' } }] } },
}[view] || {};
const localData = { accounts: [{ id: 'v', server: 'https://bw.example', email: 'me@example.com', label: 'Personal', lastSync: Date.now() }],
  used: { 'v:am': Date.now() - 1000, 'v:vi': Date.now() - 2000, 'v:ho': Date.now() - 3000 } };
// The items' stored (encrypted) ciphers, which the details view and edit form open: encrypted here with the sample
// all-zero key by the popup's own bw.js (preview.mjs calls this once the modules load).
window.wardPreviewSeed = async (bw) => {
  const k = new Uint8Array(64), e = (x) => (x ? bw.encrypt(String(x), k) : null);
  const fields = async (list) => Promise.all(list.map(async ([type, name, value, linkedId]) => ({ type, name: await e(name), value: await e(value), linkedId: linkedId ?? null })));
  const extra = {
    gh: { notes: 'Recovery codes are in the safe.', fields: [[0, 'Org', 'acme-inc'], [1, 'API token', 'ghp_preview0123456789abcdefABCDEF'], [2, 'Admin', 'true'], [3, 'Login email', null, 100]] },
    vi: { fields: [[1, 'PIN', '4321']] },
    wf: { notes: 'Network: Home-5G\nPassword: correct-horse-battery' },
  };
  localData['v:profile'] = { privateKey: await e('preview') };
  for (const i of list) {
    const x = extra[i.id] || {};
    const raw = { id: i.id, type: i.type || 1, revisionDate: '2026-11-08T00:00:00Z', name: await e(i.name), notes: await e(x.notes), reprompt: i.reprompt ? 1 : 0,
      fields: x.fields ? await fields(x.fields) : null };
    if (raw.type === 1) raw.login = { username: await e(i.username), password: await e(i.password), totp: await e(i.totp),
      uris: await Promise.all(i.uris.map(async (u) => ({ uri: await e(u), match: null }))) };
    if (i.card) raw.card = Object.fromEntries(await Promise.all(Object.entries(i.card).map(async ([f, v]) => [f, await e(v)])));
    if (i.identity) raw.identity = Object.fromEntries(await Promise.all(Object.entries(i.identity).map(async ([f, v]) => [f, await e(v)])));
    localData[`v:c:${i.id}`] = raw;
  }
  if (view !== 'item') return;
  for (let n = 0; n < 50 && !document.querySelector('.item.sel button[title^="Open"]'); n++) await new Promise((r) => setTimeout(r, 50));
  document.querySelector('.item.sel button[title^="Open"]')?.click();
};
window.chrome = {
  storage: { local: area(localData),
    session: area({ 'v:key': key, 'v:list': JSON.stringify(list), ...handoffs }), onChanged: { addListener() {} } },
  tabs: { query: async () => [{ id: 1, url: 'https://github.com/login', windowId: 1 }], get: async () => ({ id: 1, url: 'https://github.com/login', windowId: 1 }),
    sendMessage: async () => null, create: async () => ({}) },
  runtime: { sendMessage: async () => null, getManifest: () => ({ version: 'preview' }) },
  scripting: { executeScript: async () => [] }, action: { openPopup: async () => {} },
  windows: { create: async () => {}, update: async () => {}, getCurrent: async () => ({ id: 1 }), getLastFocused: async () => ({ id: 1 }) },
};
// The sandbox has no clipboard, localStorage or Web Locks (which hang there): copies go to the console, the theme
// choice lives in memory, and locks run at once (one popup, nothing to coordinate with).
Object.defineProperty(navigator, 'locks', { value: { request: async (name, opts, fn) => (fn || opts)({ name }) } });
Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => console.log('[preview] copied', t) } });
try { localStorage.length; } catch {
  const mem = {};
  const ls = new Proxy(mem, { get: (o, k) => (k === 'removeItem' ? (x) => delete o[x] : k === 'getItem' ? (x) => o[x] ?? null : o[k]) });
  Object.defineProperty(window, 'localStorage', { value: ls });
}
// Show errors on the page: the preview panel has no console.
const showError = (e) => document.body?.append(Object.assign(document.createElement('pre'), {
  style: 'color:#ff6b6b;white-space:pre-wrap;font-size:11px;margin:8px', textContent: `[preview] ${e?.stack || e}` }));
addEventListener('error', (e) => showError(e.error || e.message));
addEventListener('unhandledrejection', (e) => showError(e.reason));
