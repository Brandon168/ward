// Preview only (scripts/preview.mjs): a fake extension environment with sample data, no real vault or network.
// Runs inside Paseo's HTML preview (a sandboxed frame: no storage, clipboard or extension APIs), so those are faked.
const key = btoa(String.fromCharCode(...new Uint8Array(64)));
const list = [
  { id: 'gh', name: 'GitHub', username: 'brandon@example.com', password: 'pw1', uris: ['https://github.com'], totp: 'JBSWY3DPEHPK3PXP', a: 'v' },
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
window.chrome = {
  storage: { local: area({ accounts: [{ id: 'v', server: 'https://bw.example', email: 'me@example.com', label: 'Personal', lastSync: Date.now() }],
    used: { 'v:am': Date.now() - 1000, 'v:vi': Date.now() - 2000, 'v:ho': Date.now() - 3000 } }),
    session: area({ 'v:key': key, 'v:list': JSON.stringify(list) }), onChanged: { addListener() {} } },
  tabs: { query: async () => [{ id: 1, url: 'https://github.com/login', windowId: 1 }], get: async () => ({ id: 1, url: 'https://github.com/login', windowId: 1 }),
    sendMessage: async () => null },
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
