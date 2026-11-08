import * as bw from './bw.js';
import { fillTab, fillFormTab, formFrameAllowed } from './autofill.js';
import * as touch from './touch.js';
import * as gen from './gen.js';
import { storeSync } from './sync.js';
import { withStateLock, mutateAccounts, AUTO_LOCK_CHOICES, autoLockMinutes } from './coord.js';

const app = document.getElementById('app');
const local = chrome.storage.local, session = chrome.storage.session; // session = memory only, gone when the browser quits
const td = new TextDecoder();
// Created on first sort: the first Intl object loads locale data, which a popup or worker start shouldn't wait for.
let collatorObj;
const collator = { compare: (a, b) => (collatorObj ||= new Intl.Collator()).compare(a, b) };

// accounts: ordered list (the order is the autofill priority) of
//   { id, server, email, label, kdf, protectedKey, tokens, lastSync, persistKey? }
// Per account in local storage: `${id}:index4` (encrypted list; entries carry passkeys, match types, note flag), `${id}:ids`,
// `${id}:profile`, `${id}:eq` (equivalent domain groups), `${id}:c:${cipherId}` (raw).
// Per account in session storage: `${id}:key` and `${id}:list` (decrypted list, so an open is a read + JSON.parse).
let st, accounts = [], keys = Object.create(null), lists = Object.create(null), vault = [], equiv = new Map(), tab, host, pageUrl, query = '', wide = false;
// Ward: which item type the vault view shows. Types as in Bitwarden: 1 login, 2 secure note, 3 card, 4 identity.
let kind = 0, kindPicked = false; // 0 = all types
const typeOf = (i) => i?.type || 1;
const KINDS = [[1, 'Logins', 'login'], [3, 'Cards', 'card'], [4, 'Identities', 'identity'], [2, 'Notes', 'note']];
const kindName = (t) => KINDS.find(([k]) => k === t)?.[2] || 'item';
// Reprompt-protected items ask for the master password before anything sensitive is shown or used.
const guarded = (i, fn) => (i.reprompt ? repromptView(i, fn) : fn());
// Opened by background.js for a page: #pk=<key> a passkey request or #save=<key>
// an extension-owned save confirmation window. pk / sv are hand-offs from session storage.
const [mode, modeKey] = location.hash.slice(1).split('=');
let pk, sv;
if (mode) document.body.classList.add('window'); // a window of its own, not the toolbar popup
let saveCancelled = false;
let saveTimer;

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) el[k] = v;
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false && k !== '' && k !== 0)); // `n && node` children
  return el;
}
// Replaces the whole view; skips the false/null left by `condition && element` (the DOM would print them).
const render = (...kids) => app.replaceChildren(...kids.filter((k) => k != null && k !== false && k !== ''));
const field = (label, el) => h('label', {}, label, el);
const title = (text) => h('h1', {}, text);
const newId = () => crypto.randomUUID().slice(0, 8);
const strip = ({ raw, key, notes, fields, ...listFields }) => (notes ? { ...listFields, note: true } : listFields);
const validList = (items) => Array.isArray(items) && items.every((i) => i && typeof i.id === 'string' && Array.isArray(i.uris)
  && i.uris.every((u) => typeof u === 'string') && (!i.passkeys || Array.isArray(i.passkeys)));
const keyBytes = (encoded) => {
  try {
    const key = typeof encoded === 'string' ? bw.unb64(encoded) : null;
    return key?.length === 64 ? key : null;
  } catch { return null; }
};
const validAccount = (a) => {
  if (!a || !/^[\w-]{1,64}$/.test(a.id) || typeof a.server !== 'string' || typeof a.email !== 'string') return false;
  try { return /^https?:$/i.test(new URL(a.server).protocol); } catch { return false; }
};
const normalizedAccounts = (list) => {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).filter((a) => validAccount(a) && !seen.has(a.id) && seen.add(a.id));
};
// Keep object identity for buttons/forms while adopting a current storage snapshot.
const adoptAccounts = (next) => {
  const old = new Map(accounts.map((a) => [a.id, a]));
  accounts = normalizedAccounts(next).map((raw) => {
    const a = old.get(raw.id);
    if (!a) return raw;
    // A storage snapshot is authoritative. Remove fields omitted by it so a
    // stale persisted key cannot survive a lock or removal in another window.
    for (const key of Object.keys(a)) if (!Object.prototype.hasOwnProperty.call(raw, key)) delete a[key];
    return Object.assign(a, raw);
  });
  if (st) st.accounts = accounts;
  return accounts;
};
const acct = (id) => accounts.find((a) => a.id === id);
const unlocked = () => accounts.filter((a) => keys[a.id]);
const locked = () => accounts.filter((a) => !keys[a.id]);
const rank = (id) => accounts.findIndex((a) => a.id === id);

// Account changes are patches against the latest storage value. No popup writes
// its old complete array back after another popup has changed it.
const updateAccounts = (mutate) => mutateAccounts(local, async (current) => normalizedAccounts(await mutate(normalizedAccounts(current))))
  .then((next) => adoptAccounts(next));
const patchAccountsUnlocked = async (id, patch) => {
  const current = normalizedAccounts((await local.get('accounts')).accounts);
  const next = current.map((a) => a.id === id ? { ...a, ...patch } : a);
  await local.set({ accounts: next });
  adoptAccounts(next);
  return acct(id);
};
const update = (a, patch) => updateAccounts((list) => list.map((x) => x.id === a.id ? { ...x, ...patch } : x));
const sess = (a, locked = false) => ({
  server: a.server,
  tokens: a.tokens,
  onTokens: (tokens) => locked ? patchAccountsUnlocked(a.id, { tokens }) : update(a, { tokens }),
});
const accountTask = (a, fn) => withStateLock(async () => {
  const latest = normalizedAccounts((await local.get('accounts')).accounts);
  if (!latest.some((x) => x.id === a.id)) return;
  adoptAccounts(latest);
  const current = acct(a.id);
  const cached = await session.get(`${a.id}:key`);
  if (!keys[a.id] || bw.b64(keys[a.id]) !== cached[`${a.id}:key`]) return;
  return fn(current);
});
// One color per vault, by its place in the vault order.
const COLORS = ['#4f9dff', '#f0a03c', '#3fbf7f', '#c678dd', '#e5605a'];
const vaultTag = (id) => h('span', { className: 'vault', title: 'Vault' }, h('i', { style: `background: ${COLORS[rank(id) % COLORS.length]}` }), h('span', {}, acct(id)?.label));
// used: { 'account:cipher': time of last fill or passkey sign-in }, kept on this computer only, like Bitwarden's last used.
const markUsed = (i) => {
  if (mode === 'pk' && !pk) return Promise.resolve();
  st.used = { ...(st.used && typeof st.used === 'object' ? st.used : {}), [`${i.a}:${i.id}`]: Date.now() };
  return chrome.runtime.sendMessage({ bwliteUsed: { a: i.a, id: i.id } }).catch(() => {});
};
const byName = (a, b) => collator.compare(a.name, b.name) || collator.compare(a.username, b.username);


// Disables the button while fn runs and shows any error under the form.
async function run(btn, err, fn) {
  btn.disabled = true;
  err.textContent = '';
  try {
    await fn();
  } catch (e) {
    err.textContent = e?.message || String(e);
  } finally {
    btn.disabled = false;
  }
}

async function start() {
  let s;
  [st, s, [tab]] = await Promise.all([
    local.get(['accounts', 'used', 'deviceId', 'neverLock', 'autoLock', 'touchUnlock', 'passwordAt', 'offerLogins', 'offerForms', 'passkeyMenu', 'defaultMatch', 'neverSave', 'clearClipboard', 'generator', 'server', 'email', 'kdf', 'protectedKey', 'tokens', 'persistKey']),
    session.get(null), chrome.tabs.query({ active: true, currentWindow: true })]);
  bw.setDefaultMatch(st.defaultMatch);
  if (mode === 'pk') {
    if (!(pk = s[`pk:${modeKey}`])) return window.close();
    if (!['create', 'get'].includes(pk.kind) || typeof pk.id !== 'string' || !Number.isInteger(pk.tabId)
      || typeof pk.origin !== 'string' || !pk.options || typeof pk.options !== 'object') {
      session.remove(`pk:${modeKey}`);
      return window.close();
    }
    tab = { id: pk.tabId, url: pk.origin };
    addEventListener('pagehide', () => answer(CANCEL)); // closing the window cancels
    pkTimer = setTimeout(() => answer(TIMEOUT), pk.expires - Date.now()); // a missing expires times out at once
  }
  if (mode === 'save') {
    if (!(sv = s[`save:${modeKey}`])) return closeSave();
    saveCancelled = false;
    let offer;
    try { offer = new URL(sv.origin); } catch { return closeSave(); }
    const formOffer = sv.kind === 'form' && offer.protocol === 'https:' && (sv.card || sv.identity)
      && (!sv.card || typeof sv.card === 'object') && (!sv.identity || typeof sv.identity === 'object');
    if ((!['add', 'update'].includes(sv.kind) && !formOffer) || !/^https?:$/i.test(offer.protocol) || offer.origin !== sv.origin
      || !Number.isFinite(sv.expires) || sv.expires <= Date.now() || (!formOffer && typeof sv.password !== 'string')
      || (sv.kind === 'update' && (!/^[\w-]{1,64}$/.test(sv.a) || typeof sv.id !== 'string'))) return closeSave();
    // The background authenticated the originating tab and origin before it
    // opened this extension window. Do not rely on whichever tab happens to
    // be active now, and never allow a web page to frame this view.
    if (!Number.isInteger(sv.tabId) || window !== top) return closeSave();
    tab = { id: sv.tabId, url: sv.origin };
  } else if (window !== top) return; // a web page framing the full popup gets nothing
  pageUrl = /^https?:\/\//i.test(tab?.url) ? tab.url : null;
  host = pageUrl && new URL(pageUrl).hostname;
  if (!st.accounts && st.protectedKey) s = await migrate();
  const rawAccounts = st.accounts;
  accounts = normalizedAccounts(rawAccounts);
  // Persisted keys are restored under the same state lock as lock/removal.
  // Re-read each account before publishing a key so a suspended decrypt cannot
  // resurrect an account that another popup just removed.
  await withStateLock(async () => {
    const latest = normalizedAccounts((await local.get('accounts')).accounts);
    adoptAccounts(latest);
    const currentSession = await session.get(accounts.map((a) => `${a.id}:key`)); // keys only; the lists came with s
    for (const a of accounts) {
      const sessionKey = keyBytes(currentSession[`${a.id}:key`]);
      const persisted = keyBytes(a.persistKey);
      const key = sessionKey || persisted;
      if (!key) continue;
      keys[a.id] = key;
      if (!sessionKey) await session.set({ [`${a.id}:key`]: bw.b64(key) });
    }
    if (!Array.isArray(rawAccounts) || accounts.length !== rawAccounts.length) {
      const clean = normalizedAccounts(accounts);
      await local.set({ accounts: clean });
      adoptAccounts(clean);
    }
  });
  if (mode === 'touch') return touchView(modeKey);
  if (!mode && s.twostep) return twoStepView(s.twostep); // a login waiting for its second step
  // The save offer is a tiny extension-owned window. It must never fall
  // through to the full login/unlock/vault views when its account closed.
  if (mode === 'save' && (!accounts.length || !unlocked().length)) return closeSave();
  if (!accounts.length) return loginView();
  if (!unlocked().length) return unlockView();
  const problems = await loadVaults(s);
  await loadEquiv();
  vaultView();
  globalThis.performance?.mark('ward:list'); // scripts/perf.mjs reads it: the list is in the DOM
  if (problems) status(problems);
  if (!mode) refreshStale();
}

// 0.1/0.2 stored one account in flat keys. Move it into the accounts list; its cached vault is re-synced.
async function migrate() {
  return withStateLock(async () => {
    const latest = await local.get(['accounts', 'server', 'email', 'kdf', 'protectedKey', 'tokens', 'persistKey', 'deviceId', 'neverLock']);
    if (Array.isArray(latest.accounts)) return session.get(null);
    const a = { id: newId(), server: latest.server, email: latest.email, label: latest.email, kdf: latest.kdf,
      protectedKey: latest.protectedKey, tokens: latest.tokens };
    if (latest.neverLock && latest.persistKey) a.persistKey = latest.persistKey;
    st = { deviceId: latest.deviceId, neverLock: latest.neverLock, accounts: [a] };
    await local.clear();
    await local.set(st);
    await session.clear();
    return {};
  });
}

// "Never lock" (like Bitwarden's Never timeout) also keeps the key in local storage so it survives a browser restart.
async function setKey(a, key) {
  await withStateLock(async () => {
    const latest = normalizedAccounts((await local.get('accounts')).accounts);
    if (!latest.some((x) => x.id === a.id)) return;
    adoptAccounts(latest);
    const current = acct(a.id);
    const k = bw.b64(key);
    const { neverLock } = await local.get('neverLock');
    const next = latest.map((x) => {
      if (x.id !== a.id) return x;
      const copy = { ...x };
      if (neverLock) copy.persistKey = k;
      else delete copy.persistKey;
      return copy;
    });
    keys[a.id] = key;
    await local.set({ accounts: next });
    adoptAccounts(next);
    await session.set({ [`${current.id}:key`]: k });
  });
}

async function setList(a, items, persist = true) {
  if (acct(a.id) !== a || !keys[a.id]) return;
  if (!validList(items)) throw new Error('Vault cache is invalid');
  lists[a.id] = items;
  const list = JSON.stringify(items);
  await Promise.all([
    session.set({ [`${a.id}:list`]: list }),
    persist && local.set({ [`${a.id}:index4`]: await bw.encrypt(list, keys[a.id]) }),
  ]);
}

function merge() {
  const parts = unlocked().map((a) => Array.isArray(lists[a.id]) ? lists[a.id] : []);
  vault = parts.length === 1 ? parts[0] : parts.flat().sort(byName);
}

// Loads every unlocked account that isn't loaded yet; one failing account doesn't block the others.
async function loadVaults(s = {}) {
  const todo = unlocked().filter((a) => !lists[a.id]);
  const res = await Promise.allSettled(todo.map((a) => accountTask(a, () => loadAccount(a, s)).then((r) => r === 'sync' && syncAccount(a))));
  merge();
  return failures(todo, res);
}

async function loadAccount(a, s) {
  if (acct(a.id) !== a || !keys[a.id]) return;
  const cachedKey = s[`${a.id}:key`];
  if (s[`${a.id}:list`] && keyBytes(cachedKey) && bw.b64(keys[a.id]) === cachedKey) {
    try {
      const cached = JSON.parse(s[`${a.id}:list`]);
      if (validList(cached)) return (lists[a.id] = cached);
    } catch {}
    await session.remove(`${a.id}:list`);
  } else if (s[`${a.id}:list`]) {
    await session.remove([`${a.id}:list`, `${a.id}:key`]);
  }
  const { [`${a.id}:index4`]: index } = await local.get(`${a.id}:index4`);
  if (!index) {
    await local.remove([`${a.id}:index`, `${a.id}:index2`, `${a.id}:index3`]);
    return 'sync'; // loadVaults syncs it after the lock is released
  }
  try {
    const cached = JSON.parse(td.decode(await bw.decrypt(index, keys[a.id])));
    if (!validList(cached)) throw new Error('cached list is invalid');
    await setList(a, cached, false);
  } catch {
    await local.remove([`${a.id}:index`, `${a.id}:index2`, `${a.id}:index3`, `${a.id}:index4`]);
    return 'sync'; // loadVaults syncs it after the lock is released
  }
}

const loadEquiv = async () => {
  const stored = await local.get(accounts.map((a) => `${a.id}:eq`));
  equiv = new Map(accounts.map((a) => [a.id, bw.equivalents(stored[`${a.id}:eq`])]));
  return equiv;
};

const failures = (todo, res) =>
  res.map((r, i) => r.status === 'rejected' && `${todo[i].label}: ${r.reason?.message || String(r.reason)}`).filter(Boolean).join('\n');

// Sync button / Ctrl+S, refreshStale() on open, and an account with no local data yet. Unchanged items aren't decrypted again.
// The download runs outside the state lock so background.js (autofill, badge) isn't blocked while it waits on the network.
const syncAccount = async (a) => {
  if (acct(a.id) !== a || !keys[a.id]) return;
  const sync = await bw.api(sess(a), '/sync');
  return accountTask(a, () => syncAccountNow(a, sync));
};
async function syncAccountNow(a, sync) {
  const p = `${a.id}:`;
  if (acct(a.id) !== a || !keys[a.id]) return;
  const prev = new Map((Array.isArray(lists[a.id]) ? lists[a.id] : []).map((i) => [i.id, i]));
  const items = (await bw.decryptVault(sync, keys[a.id], prev)).map((i) => ({ ...strip(i), a: a.id }));
  if (acct(a.id) !== a || !keys[a.id]) return;
  await storeSync(local, p.slice(0, -1), sync); // shared with background sync (sync.js)
  await setList(a, items);
  await patchAccountsUnlocked(a.id, { lastSync: Date.now() });
  await loadEquiv();
}

// Opening or unlocking the popup syncs vaults last synced over 5 minutes ago, in the background, so a change made in another
// client (a new TOTP secret, a changed password) shows up without pressing sync.
async function refreshStale() {
  const stale = unlocked().filter((a) => Date.now() - (a.lastSync || 0) > 5 * 60e3);
  if (!stale.length) return;
  const res = await Promise.allSettled(stale.map(syncAccount));
  merge();
  const q = document.getElementById('search');
  if (!q) return; // an edit form or another view is open; it picks up the new data when it returns to the list
  const focused = document.activeElement === q, at = q.selectionStart;
  vaultView();
  const fresh = document.getElementById('search');
  if (focused) (fresh.focus(), fresh.setSelectionRange?.(at, at));
  const problems = failures(stale, res);
  if (problems) status(problems);
}

async function syncAll() {
  const todo = unlocked();
  const res = await Promise.allSettled(todo.map(syncAccount));
  merge();
  vaultView();
  const problems = failures(todo, res);
  if (problems) throw new Error(problems);
}

function loginView(message = '') {
  if (mode === 'save') return closeSave();
  const server = h('input', { value: accounts.at(-1)?.server || 'https://vault.bitwarden.com', required: true });
  const email = h('input', { type: 'email', required: true });
  const pw = h('input', { type: 'password', required: true });
  const label = h('input', { placeholder: 'Defaults to the email' });
  const btn = h('button', { className: 'primary' }, 'Log in');
  const err = h('p', { className: 'err' }, message);
  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      run(btn, err, async () => {
        const srv = server.value.trim().replace(/\/+$/, ''), mail = email.value.trim();
        // Ward: tokens, the password hash and the KDF choice must not cross the network in clear text.
        let su;
        try { su = new URL(srv); } catch { throw new Error('Enter the server address, e.g. https://vault.example.com'); }
        if (su.protocol !== 'https:' && !(su.protocol === 'http:' && /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i.test(su.hostname)))
          throw new Error('Use an https:// server address (plain http is only allowed for localhost).');
        // the same vault again (after a master password or KDF change elsewhere) is logged in again in place
        const old = findAccount(srv, mail);
        if (!st.deviceId) await local.set({ deviceId: (st.deviceId = crypto.randomUUID()) }); // one id per install avoids new-device emails
        const keys = await bw.loginKeys(srv, mail, pw.value, old?.kdf);
        await attempt({ server: srv, email: mail, label: label.value.trim() || mail, keys }, null, old?.twoFactorToken);
      });
    },
  },
    field('Server', server), field('Email', email), field('Master password', pw), field('Label', label),
    h('div', { className: 'inline' }, btn, accounts.length && h('button', { type: 'button', onclick: accountsView }, 'Cancel')), err);
  render(title(accounts.length ? 'Add vault' : 'Ward'), form);
  email.focus();
}

let waitingKey = false; // the security key window is open for this popup's login
const findAccount = (server, email) => accounts.find((a) => a.server === server && a.email.toLowerCase() === email.toLowerCase());

// One login attempt with keys from bw.loginKeys. A two-step or new-device request is kept in session storage
// (`twostep`: memory only, trusted contexts only, cleared by locking) and shown, so the popup can close while you
// read an email or touch a key. Success adds the vault (or refreshes it in place) and opens it.
async function attempt(p, code, remember) {
  const old = findAccount(p.server, p.email);
  let r;
  try {
    r = await bw.loginWith(p.server, p.email, p.keys, st.deviceId, code, remember);
  } catch (e) {
    if (!e.need) throw e;
    const providers = e.providers || p.providers || [];
    const pick = [p.provider, old?.twoFactorProvider].find((id) => providers.some((x) => x.id === id));
    const next = { server: p.server, email: p.email, label: p.label, kdf: p.keys.kdf, hash: p.keys.hash, key: bw.b64(p.keys.key),
      need: e.need, providers, provider: e.need === '2fa' ? pick ?? providers[0].id : null, expires: Date.now() + 10 * 60e3 };
    await session.set({ twostep: next });
    return twoStepView(next);
  }
  await session.remove('twostep');
  const fields = { kdf: r.kdf, protectedKey: r.protectedKey, tokens: r.tokens, ...(r.twoFactorToken && { twoFactorToken: r.twoFactorToken }),
    ...(code?.kind === '2fa' && { twoFactorProvider: code.provider }) };
  const a = old || { id: newId(), server: p.server, email: p.email, label: p.label, ...fields };
  await (old ? update(old, fields) : updateAccounts((list) => [...list, a]));
  await setKey(a, r.userKey);
  await local.set({ passwordAt: (st.passwordAt = Date.now()) });
  await syncAccount(a);
  merge();
  vaultView();
}

const validTwoStep = (p) => p && typeof p.server === 'string' && typeof p.email === 'string' && typeof p.hash === 'string'
  && keyBytes(p.key) && Array.isArray(p.providers) && (p.need === 'device' || p.providers.some((x) => x?.id === p.provider))
  && p.expires > Date.now();

// Ward: the second step of a login (security key, YubiKey, authenticator app, email) or a new-device code.
function twoStepView(p) {
  if (!validTwoStep(p)) return session.remove('twostep').then(() => loginView('That login timed out. Log in again.'));
  const keys = { kdf: p.kdf, hash: p.hash, key: keyBytes(p.key) };
  const where = new URL(p.server).host;
  const data = p.providers.find((x) => x.id === p.provider)?.data;
  const save = (patch) => session.set({ twostep: (p = { ...p, ...patch }) });
  const code = h('input', { autocomplete: 'one-time-code', inputmode: p.provider === 3 ? 'text' : 'numeric', required: true });
  const btn = h('button', { className: 'primary' }, 'Continue');
  const err = h('p', { className: 'err' }, p.keyError || '');
  const cancel = h('button', { type: 'button', onclick: () => session.remove('twostep').then(() => loginView()) }, 'Cancel');
  const finish = (value) => run(btn, err, () => attempt({ ...p, keys },
    p.need === 'device' ? { kind: 'device', value } : { kind: '2fa', provider: p.provider, value }));
  const others = p.need === '2fa' ? p.providers.filter((x) => x.id !== p.provider) : [];
  const switcher = others.length > 0 && h('p', { className: 'muted switch' }, 'Or use',
    ...others.map((x) => h('button', { type: 'button', className: 'link', onclick: () => save({ provider: x.id, keyError: null, emailSent: false }).then(() => twoStepView(p)) },
      bw.TWO_STEP[x.id])));
  const head = [title('Two-step login'), h('p', { className: 'muted' }, `${p.email} · ${where}`)];
  const sendCode = () => bw.sendEmailCode(p.server, p.email, keys, st.deviceId)
    .catch((e) => { throw e instanceof TypeError ? new Error('Could not reach the server to send the code.') : e; });
  if (p.provider === 7 && p.need === '2fa') {
    const go = h('button', { className: 'primary', onclick: () => {
      go.disabled = true;
      err.textContent = '';
      waitingKey = true;
      save({ keyError: null }).then(() => chrome.runtime.sendMessage({ wardTwoStepKey: true })).catch(() => {});
    } }, 'Use security key');
    render(...head, h('p', {}, `A small window from ${where} opens for your security key or passkey; Ward finishes the login after it.`),
      h('div', { className: 'inline' }, go, cancel), err, switcher);
    if (p.assertion) { // back from the key window: finish with its answer (once)
      const token = p.assertion;
      go.disabled = true;
      save({ assertion: null }).then(() => run(go, err, () => attempt({ ...p, keys }, { kind: '2fa', provider: 7, value: token })));
    }
    return;
  }
  const say = p.need === 'device' ? 'Ward is new to this vault. Enter the code the server just emailed you to approve it.'
    : p.provider === 1 ? `Enter the code sent to ${data?.Email || 'your email'}.`
      : p.provider === 3 ? 'Insert your YubiKey and touch it.' : 'Enter the 6-digit code from your authenticator app.';
  const resend = p.provider === 1 && p.need === '2fa' && h('button', { type: 'button', className: 'link end', onclick: () =>
    run(resend, err, () => sendCode().then(() => (err.textContent = 'Sent again.'))) }, 'Send the code again');
  render(...head, h('form', { onsubmit: (e) => (e.preventDefault(), finish(code.value.trim())) }, h('p', {}, say), field('Code', code),
    h('div', { className: 'inline' }, btn, cancel, resend), err), switcher);
  code.focus();
  if (p.provider === 1 && p.need === '2fa' && !p.emailSent) { // the server only emails the code when asked
    save({ emailSent: true }).then(sendCode).catch((e) => (err.textContent = e.message));
  }
}

// One password box for every locked vault: each vault it opens unlocks, the rest stay locked.
function unlockView() {
  if (mode === 'save') return closeSave();
  const todo = locked();
  const pw = h('input', { type: 'password', required: true });
  const btn = h('button', { className: 'primary' }, 'Unlock');
  const err = h('p', { className: 'err' });
  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      run(btn, err, async () => {
        const opened = await Promise.all(todo.map((a) =>
          bw.unlock(pw.value, a.email, a.kdf, a.protectedKey).then((k) => setKey(a, k)).then(() => true, (e) => e)));
        if (!opened.includes(true)) throw new Error([...new Set(opened.map((e) => e?.message || String(e)))].join('\n'));
        await local.set({ passwordAt: (st.passwordAt = Date.now()) }); // Touch ID's every-14-days password check
        const problems = await loadVaults();
        vaultView();
        if (problems) status(problems);
        refreshStale();
      });
    },
  },
    field(`Master password${todo.length > 1 ? ' (tried on every locked vault)' : ''}`, pw),
    h('p', { className: 'muted' }, `Locked: ${todo.map((a) => a.label).join(', ')}`),
    h('div', { className: 'inline' }, btn, unlocked().length && h('button', { type: 'button', onclick: vaultView }, 'Skip')), err);
  const touchIds = Object.keys(st.touchUnlock?.wrapped || {});
  const touchBtn = todo.some((a) => touchIds.includes(a.id))
    && h('button', { className: 'primary touch', title: 'Opens a small window for the Touch ID prompt', onclick: () => openTouch('unlock') }, 'Unlock with Touch ID');
  render(title('Ward'), touchBtn || '', form, h('button', { className: 'link', onclick: accountsView }, 'Vaults'));
  pw.focus();
}

function accountsView() {
  if (mode === 'save') return closeSave();
  const rows = accounts.map((a, i) => {
    const label = h('input', { value: a.label, title: 'Label shown on this vault\'s items', onchange: () => update(a, { label: label.value.trim() || a.email }) });
    const remove = h('button', {
      title: 'Log out and remove this vault from Ward',
      onclick: () => (remove.textContent === 'Sure?' ? removeAccount(a) : (remove.textContent = 'Sure?')),
    }, 'Remove');
    return h('div', { className: 'row' },
      h('div', { className: 'info' }, label, h('small', {}, accounts.length > 1 && vaultTag(a.id), `${a.email} · ${new URL(a.server).host}${keys[a.id] ? '' : ' · locked'}`)),
      h('div', { className: 'actions' },
        h('button', { title: 'Higher autofill priority', disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
        h('button', { title: 'Lower autofill priority', disabled: i === accounts.length - 1, onclick: () => move(i, 1) }, '↓'),
        remove));
  });
  render(title('Vaults'),
    h('p', { className: 'muted' }, 'Order is the autofill priority: the first vault with a login for the site fills, unless you last used another one there.'),
    h('div', { className: 'list' }, rows),
    h('div', { className: 'inline' },
      h('button', { className: 'primary', onclick: loginView }, 'Add vault'),
      h('button', { onclick: () => (unlocked().length ? vaultView() : unlockView()) }, 'Done')));
}

async function move(i, d) {
  const id = accounts[i]?.id;
  if (!id) return;
  await updateAccounts((list) => {
    const from = list.findIndex((a) => a.id === id), target = from + d;
    if (from < 0 || target < 0 || target >= list.length) return list;
    const next = [...list];
    [next[from], next[target]] = [next[target], next[from]];
    return next;
  });
  accountsView();
}

async function removeAccount(a) {
  const p = `${a.id}:`;
  await withStateLock(async () => {
    // Publish the removal before deleting session data so another popup cannot
    // reopen this account from its persisted key during the cleanup window.
    const latest = normalizedAccounts((await local.get('accounts')).accounts);
    if (!latest.some((x) => x.id === a.id)) return;
    const next = latest.filter((x) => x.id !== a.id);
    await local.set({ accounts: next });
    adoptAccounts(next);
    delete keys[a.id];
    delete lists[a.id];
    const stored = await local.get(`${p}ids`);
    const ids = Array.isArray(stored[`${p}ids`]) ? stored[`${p}ids`] : [];
    try {
      await local.remove([`${p}index`, `${p}index2`, `${p}index3`, `${p}index4`, `${p}eq`, `${p}ids`, `${p}profile`, ...ids.map((id) => `${p}c:${id}`)]);
    } finally {
      await session.remove([`${p}key`, `${p}list`]);
    }
    const { touchUnlock } = await local.get('touchUnlock');
    if (touchUnlock?.wrapped?.[a.id]) {
      const wrapped = { ...touchUnlock.wrapped };
      delete wrapped[a.id];
      if (Object.keys(wrapped).length) await local.set({ touchUnlock: (st.touchUnlock = { ...touchUnlock, wrapped }) });
      else await local.remove('touchUnlock'), (st.touchUnlock = undefined);
    }
    const { used = {} } = await local.get('used');
    await local.set({ used: Object.fromEntries(Object.entries(used || {}).filter(([k]) => !k.startsWith(`${a.id}:`))) });
  });
  merge();
  if (accounts.length) accountsView();
  else loginView();
}

async function lockAll() {
  await withStateLock(async () => {
    const stored = await local.get('accounts');
    const latest = normalizedAccounts(stored.accounts);
    // A single global lock avoids deadlocks between two windows locking the
    // same accounts in different orders.
    adoptAccounts(latest);
    keys = Object.create(null);
    lists = Object.create(null);
    vault = [];
    const next = latest.map((a) => { const copy = { ...a }; delete copy.persistKey; return copy; });
    await local.set({ accounts: next }); // first, so background cannot reopen a persisted key in between
    adoptAccounts(next);
    await session.clear();
  });
  unlockView();
}

async function fullItem(a, raw) {
  if (!a || !keys[a.id] || !raw || typeof raw !== 'object') throw new Error('Login is no longer available; sync and try again');
  const { [`${a.id}:profile`]: profile } = await local.get(`${a.id}:profile`);
  if (!profile || typeof profile !== 'object' || typeof profile.privateKey !== 'string') throw new Error('Vault data is missing; sync and try again');
  const [item] = await bw.decryptVault({ profile, ciphers: [raw] }, keys[a.id], null, true);
  if (!item) throw new Error('Could not decrypt this login; sync and try again');
  return { ...item, a: a.id };
}

async function latestList(a) {
  const s = await session.get([`${a.id}:key`, `${a.id}:list`]);
  if (s[`${a.id}:key`] === bw.b64(keys[a.id]) && typeof s[`${a.id}:list`] === 'string') {
    try {
      const cached = JSON.parse(s[`${a.id}:list`]);
      if (validList(cached)) return cached;
    } catch {}
  }
  return Array.isArray(lists[a.id]) ? lists[a.id] : [];
}

// The list only holds what it shows; the details and editing need the raw cipher and its key.
async function loadItem(i) {
  const k = `${i.a}:c:${i.id}`;
  return fullItem(acct(i.a), (await local.get(k))[k]);
}
// opts: { fill } from the vault list when the item can be filled on this page.
const openItem = async (i, opts, confirmed) => (i.reprompt && !confirmed
  ? repromptView(i, () => openItem(i, opts, true).catch((e) => status(e.message))) : itemView(await loadItem(i), opts));

// Bitwarden's master password re-prompt: the password must open this vault's key again, then the list comes back and next runs.
function repromptView(i, next) {
  const a = acct(i.a);
  const pw = h('input', { type: 'password', required: true });
  const btn = h('button', { className: 'primary' }, 'Continue');
  const err = h('p', { className: 'err' });
  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      run(btn, err, async () => {
        const k = a && keys[a.id] && await bw.unlock(pw.value, a.email, a.kdf, a.protectedKey);
        if (!k || !keys[a.id] || bw.b64(k) !== bw.b64(keys[a.id])) throw new Error('Wrong master password');
        vaultView();
        await next();
      });
    },
  }, field(`Master password for ${i.name || 'this login'}`, pw), h('div', { className: 'inline' }, btn, h('button', { type: 'button', onclick: vaultView }, 'Cancel')), err);
  render(title('Ward'), form);
  pw.focus();
}

// Applies a saved cipher from the server's reply locally, no full sync needed.
async function storeCipher(a, raw) {
  if (acct(a.id) !== a || !keys[a.id] || !raw?.id) return;
  const p = `${a.id}:`;
  const stored = await local.get(`${p}ids`);
  const ids = Array.isArray(stored[`${p}ids`]) ? stored[`${p}ids`] : [];
  await local.set({ [`${p}c:${raw.id}`]: raw, [`${p}ids`]: ids.includes(raw.id) ? ids : [...ids, raw.id] });
  const base = await latestList(a);
  await setList(a, [...base.filter((i) => i.id !== raw.id), strip(await fullItem(a, raw))].sort(byName));
  merge();
}

async function deleteItem(item) {
  const a = acct(item.a);
  if (!a || !keys[a.id]) return;
  await bw.deleteCipher(sess(a), item.id); // outside the lock, like syncAccount
  await accountTask(a, async () => {
    if (acct(a.id) !== a || !keys[a.id]) return;
    const p = `${a.id}:`;
    const stored = await local.get(`${p}ids`);
    const ids = Array.isArray(stored[`${p}ids`]) ? stored[`${p}ids`] : [];
    await local.remove(`${p}c:${item.id}`);
    await local.set({ [`${p}ids`]: ids.filter((id) => id !== item.id) });
    await setList(a, (await latestList(a)).filter((i) => i.id !== item.id));
    merge();
    vaultView();
  });
}

async function saveItem(a, item, value, authorize = async () => true) {
  let saved = false;
  if (acct(a.id) !== a || !keys[a.id]) return saved;
  if (item && (!item.raw || item.raw.edit === false)) throw new Error(item?.raw?.edit === false ? 'This login is read-only' : 'Login is no longer available; sync and try again');
  // Keep the revision captured when the edit form opened. Reloading a newer
  // raw cipher here would turn a concurrent edit into an overwrite instead
  // of letting the server's lastKnownRevisionDate reject it.
  if (!await authorize()) return saved;
  let raw;
  try {
    raw = await bw.saveCipher(sess(a), keys[a.id], item, value); // outside the lock, like syncAccount
  } catch (e) {
    if (/\(409\)/.test(e?.message || '')) throw new Error('Login changed elsewhere; sync and try again');
    throw e;
  }
  await accountTask(a, async () => {
    if (!await authorize()) return;
    const sessionKey = await session.get(`${a.id}:key`);
    if (acct(a.id) === a && keys[a.id] && sessionKey[`${a.id}:key`] === bw.b64(keys[a.id])) {
      await storeCipher(a, raw);
      saved = true;
    }
  });
  return saved;
}

function status(msg) {
  const el = document.getElementById('status');
  if (el) el.textContent = msg;
}

// Copies and confirms on the button itself (✓ for a moment). secret: Ward clears the clipboard 30 s later
// (Settings > Clear copied secrets), through the service worker, since this popup closes long before that.
async function copy(btn, text, secret = true) {
  await navigator.clipboard.writeText(text);
  if (secret && st.clearClipboard !== false) chrome.runtime.sendMessage({ wardClipboardClear: true }).catch(() => {});
  if (!btn) return;
  const kids = [...btn.childNodes];
  btn.classList.add('done');
  btn.replaceChildren(icon('check'));
  setTimeout(() => (btn.classList.remove('done'), btn.replaceChildren(...kids)), 1100);
}

async function fill(item, confirmed) {
  const key = keys[item.a];
  if (!key) return status('Vault locked; unlock it before filling');
  if (item.reprompt && !confirmed) return repromptView(item, () => fill(item, true));
  if (typeOf(item) === 3 || typeOf(item) === 4) return fillForm(item, key);
  let code = null;
  if (item.totp) code = (await bw.totp(item.totp).catch(() => null))?.code;
  const guard = async () => {
    const current = await session.get(`${item.a}:key`);
    return keys[item.a] === key && current[`${item.a}:key`] === bw.b64(key);
  };
  const ok = await fillTab(tab.id, item, equiv.get(item.a), code, guard).catch((e) => status(e.message));
  if (!ok) return ok === false && status('No login form for this login on the page');
  if (!await guard()) return status('Vault locked before filling finished');
  await markUsed(item); // before the clipboard, which can throw and leave the fill unrecorded
  if (code) await copy(null, code); // the one-time code, ready to paste on the next step
  window.close();
}

// Ward: a card or identity into the page's checkout/address form (see autofill.js fillFormTab and formfill.js).
async function fillForm(item, key) {
  const guard = async () => {
    const current = await session.get(`${item.a}:key`);
    return keys[item.a] === key && current[`${item.a}:key`] === bw.b64(key);
  };
  let n;
  try { n = await fillFormTab(tab.id, item, guard); } catch (e) { return status(e.message); }
  if (!n) return status(`No ${typeOf(item) === 3 ? 'card' : 'address or contact'} fields found on this page`);
  if (!await guard()) return status('Vault locked before filling finished');
  await markUsed(item);
  window.close();
}

// --- icons (24-unit outline paths, drawn with SVG DOM, no markup strings) ------------------------------------
const ICONS = {
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14M20 20l-4-4',
  user: 'M12 4a4 4 0 1 0 0 8a4 4 0 0 0 0-8M4 20a8 8 0 0 1 16 0',
  key: 'M8 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8M12 12h9M18 12v3M21 12v2',
  card: 'M3 6h18v12H3zM3 10h18M7 15h3',
  hash: 'M9 4 7 20M17 4l-2 16M4 9h16M3 15h16',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  open: 'M9 6l6 6-6 6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12M12 9a3 3 0 1 0 0 6a3 3 0 0 0 0-6',
  launch: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  check: 'M5 12l5 5 9-10',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6 6 18',
  sync: 'M20 11a8 8 0 0 0-14-5l-2 2M4 4v4h4M4 13a8 8 0 0 0 14 5l2-2M20 20v-4h-4',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  gear: 'M12 9a3 3 0 1 0 0 6a3 3 0 0 0 0-6M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1',
  person: 'M12 5a3 3 0 1 0 0 6a3 3 0 0 0 0-6M6 19a6 6 0 0 1 12 0',
  note: 'M6 3h9l4 4v14H6zM9 12h7M9 16h5',
  dice: 'M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2M8.5 8.5h0M15.5 8.5h0M12 12h0M8.5 15.5h0M15.5 15.5h0',
};
function icon(name, size = 16) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
    'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}
const PALETTE = ['#2f6fec', '#e2553f', '#16a34a', '#9333ea', '#ea8a0c', '#0891b2', '#db2777', '#4b5563'];
const hue = (s) => PALETTE[[...String(s || '?')].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];
function avatar(i) {
  const t = typeOf(i);
  if (t === 1) return h('span', { className: 'av', style: `background:${hue(i.name)}` }, (i.name || '?').trim()[0]?.toUpperCase() || '?');
  return h('span', { className: 'av', style: `background:${t === 3 ? '#374151' : t === 4 ? '#0891b2' : '#6b7280'}` }, icon(t === 3 ? 'card' : t === 4 ? 'person' : 'note', 16));
}

// Windows background.js opens for a page (passkey, save offers) share one layout, built from the popup's own parts:
// the brand bar (so it is clearly Ward, not the page), a title that names the site, choices as list rows, then one
// action row (primary first, the way out last). The window fills its width and fits its height to the content.
const siteAvatar = (name) => h('span', { className: 'av', style: `background:${hue(name)}` }, (name || '?').trim()[0]?.toUpperCase() || '?');
const promptHead = (heading) => [h('div', { className: 'bar' }, h('span', { className: 'brand' }, 'Ward')), title(heading)];
const promptActions = (...kids) => h('div', { className: 'inline wrap' }, ...kids);
const choice = (i, name, sub, ...btns) => h('div', { className: 'item choice' }, i ? avatar(i) : siteAvatar(name),
  h('div', { className: 'info' }, h('b', { title: name }, name), sub && h('small', {}, sub)), h('div', { className: 'actions' }, ...btns));

// The one-time code button: a pie that empties as the code's time runs out (red for the last 5 s); a click copies the
// current code. The digits stay off screen (screen shares, shoulders); Fill and the copy put them on the clipboard.
function codeButton(i) {
  const ring = h('span', { className: 'ring' });
  const b = h('button', { className: 'totp', title: `Copy one-time code · ${i.name}` }, ring);
  b.addEventListener('click', (e) => (e.stopPropagation(), guarded(i, async () => copy(b, (await bw.totp(i.totp)).code))));
  b._tick = () => bw.totp(i.totp).then((t) => {
    ring.style.setProperty('--p', String(Math.round((t.remaining / (t.period || 30)) * 100)));
    ring.classList.toggle('low', t.remaining <= 5);
  }, () => (ring.classList.add('bad'), (b.title = `The one-time code secret for ${i.name} is not valid`)));
  b._tick();
  return b;
}
setInterval(() => document.querySelectorAll('.totp').forEach((b) => !b.classList.contains('done') && b._tick?.()), 1000);

// Layout (option E): search, type chips, then quiet rows. The selected row (this site's best match when the popup
// opens; any row you click) keeps its one-click actions visible; other rows show them on hover. Actions sit in fixed
// slots (user, password, code) so they never shift, then Fill for what can be filled here. Clicking a row only
// selects it; Fill, Enter or a double-click fills. Feedback appears on the button itself.
let selectedKey = null;
const searchText = new WeakMap(); // item -> its search text, built on first search
function vaultView() {
  if (mode === 'save' && !sv) return closeSave();
  if (pk) return passkeyView();
  if (sv) return saveView();
  const multi = accounts.length > 1;
  const formPage = /^https:\/\//i.test(pageUrl || ''); // cards and identities fill only on https pages
  const keyOf = (i) => `${i.a}:${i.id}`;
  let rows = [], here = [];
  const q = h('input', {
    id: 'search', type: 'search', placeholder: 'Search Ward', value: query, autocomplete: 'off',
    oninput: () => ((query = q.value), (selectedKey = null), draw()),
    onkeydown: (e) => {
      const at = rows.findIndex((r) => r.key === selectedKey);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (e.key === 'ArrowDown' && at === rows.length - 1) drawMore();
        const next = rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (next) select(next.key, true);
      } else if (e.key === 'Enter' && rows[at]) primary(rows[at].item);
    },
  });
  const kinds = h('nav', { className: 'kinds' });
  const list = h('div', { className: 'list' });
  const fillable = (i) => (typeOf(i) === 1 ? here.includes(i) : (typeOf(i) === 3 || typeOf(i) === 4) && formPage);
  const open = (i) => openItem(i, fillable(i) ? { fill: () => fill(i, true) } : {}).catch((e) => status(e.message));
  const primary = (i) => (fillable(i) ? fill(i) : open(i));
  const act = (name, title, fn, className = '') => {
    const b = h('button', { title, className }, icon(name));
    b.addEventListener('click', (e) => (e.stopPropagation(), fn(b)));
    return b;
  };
  const slot = () => h('span', { className: 'slot' });
  const sub = (i) => {
    const t = typeOf(i), c = i.card || {}, d = i.identity || {};
    return t === 1 ? i.username || '(no username)'
      : t === 3 ? [`${c.brand || 'Card'} •••• ${(c.number || '').replace(/\D/g, '').slice(-4) || '????'}`, c.expMonth || c.expYear ? `${String(c.expMonth || '?').padStart(2, '0')}/${String(c.expYear || '??').slice(-2)}` : ''].filter(Boolean).join(' · ')
      : t === 4 ? [[d.firstName, d.lastName].filter(Boolean).join(' '), d.city || d.email].filter(Boolean).join(' · ')
      : 'Secure note';
  };
  const actions = (i) => {
    const t = typeOf(i), c = i.card || {}, d = i.identity || {}, out = [];
    const secret = (name, title, value) => act(name, `${title} · ${i.name}`, (b) => guarded(i, () => copy(b, value())));
    if (t === 1) {
      out.push(i.username ? act('user', `Copy username · ${i.name}`, (b) => copy(b, i.username, false)) : slot());
      out.push(i.password && i.viewPassword !== false ? secret('key', 'Copy password', () => i.password) : slot());
      if (i.totp) out.push(codeButton(i));
    } else if (t === 3) {
      out.push(c.number ? secret('card', 'Copy card number', () => c.number.replace(/\s+/g, '')) : slot());
      out.push(c.code ? secret('hash', 'Copy security code', () => c.code) : slot());
    } else if (t === 4) {
      if (d.email) out.push(act('mail', `Copy email · ${i.name}`, (b) => copy(b, d.email, false)));
    } else if (i.note) {
      out.push(act('copy', `Copy note · ${i.name}`, (b) => guarded(i, () => loadItem(i).then((f) => copy(b, f.notes || '')).catch((e) => status(e.message)))));
    }
    out.push(act('open', `Open · ${i.name}`, () => open(i)));
    if (fillable(i)) {
      const f = h('button', { className: 'fill', title: `Fill · ${i.name}` }, 'Fill');
      f.addEventListener('click', (e) => (e.stopPropagation(), fill(i)));
      out.push(f);
    }
    return h('div', { className: 'acts' }, ...out);
  };
  const itemRow = (i) => {
    const el = h('div', { className: 'item', ondblclick: () => primary(i) },
      avatar(i),
      h('div', { className: 'info' },
        h('b', {}, i.name || '(no name)', multi && h('span', { className: 'vaultdot', title: acct(i.a)?.label, style: `background:${COLORS[rank(i.a) % COLORS.length]}` })),
        h('small', {}, sub(i), i.reprompt ? ' · 🔒' : '')));
    el.addEventListener('click', () => select(keyOf(i)));
    el.addEventListener('pointerenter', () => withActions(el, i));
    el.dataset.key = keyOf(i);
    return el;
  };
  // A row's buttons are hidden unless it is hovered or selected, so they are built then (the first hover, or
  // selection) rather than for every row drawn: a keystroke in the search builds a few elements, not hundreds.
  const withActions = (el, i) => el.acts || el.append((el.acts = actions(i)));
  const select = (key, scroll) => {
    selectedKey = key;
    for (const r of rows) {
      r.el.classList.toggle('sel', r.key === key);
      if (r.key === key) withActions(r.el, r.item);
    }
    if (scroll) rows.find((r) => r.key === key)?.el.scrollIntoView({ block: 'nearest' });
  };
  // Worked out once per view, not per keystroke: this site's logins, recent items, and each item's search text.
  here = pageUrl ? bw.forSite(vault, pageUrl, (i) => equiv.get(i.a), rank, st.used) : [];
  const hereSet = new Set(here);
  const byKey = new Map(vault.map((i) => [keyOf(i), i]));
  const recentAll = Object.entries(st.used || {}).sort((a, b) => b[1] - a[1]).map(([k]) => byKey.get(k)).filter(Boolean);
  const textOf = (i) => {
    let t = searchText.get(i);
    if (t === undefined) searchText.set(i, (t = [i.name, i.username, ...(i.uris || []), i.card?.brand, i.card?.cardholderName, (i.card?.number || '').slice(-4),
      i.identity?.firstName, i.identity?.lastName, i.identity?.email, i.identity?.city, i.identity?.company].filter(Boolean).join(' ').toLowerCase()));
    return t;
  };
  // Rows are drawn in chunks: the first CHUNK at once (the popup shows about ten), the rest when the list scrolls
  // near its end or the arrow keys walk past the last drawn row. Typing never builds hundreds of rows.
  const CHUNK = 30;
  let queue = [], qi = 0, sentinel = null; // rows still to draw, and how far drawMore got
  const more = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && drawMore(), { root: list, rootMargin: '200px' })
    : { observe() {}, disconnect() {} };
  const drawMore = () => {
    if (qi >= queue.length) return false;
    const out = [];
    for (let n = 0; qi < queue.length && n < CHUNK;) {
      const next = queue[qi++];
      if (next.head) { out.push(next.head); continue; }
      const el = itemRow(next.item);
      rows.push({ key: keyOf(next.item), item: next.item, el });
      out.push(el);
      n++;
    }
    sentinel?.remove();
    sentinel = null;
    if (qi < queue.length) {
      sentinel = h('div', { className: 'more' });
      out.push(sentinel);
    }
    list.append(...out);
    if (sentinel) more.observe(sentinel);
    return true;
  };
  const draw = () => {
    kinds.replaceChildren(...[[0, 'All'], ...KINDS.map(([t, label]) => [t, label])].map(([t, label]) =>
      h('button', { className: t === kind ? 'on' : '', onclick: () => ((kind = t), (kindPicked = true), (selectedKey = null), draw(), q.focus()) }, label)));
    const s = q.value.trim().toLowerCase();
    const ofKind = kind ? vault.filter((i) => typeOf(i) === kind) : vault;
    const groups = [];
    if (s) {
      const hits = ofKind.filter((i) => textOf(i).includes(s));
      groups.push([`${hits.length} match${hits.length === 1 ? '' : 'es'}`, [...hits.filter((i) => hereSet.has(i)), ...hits.filter((i) => !hereSet.has(i))]]);
    } else {
      const site = (!kind || kind === 1) ? here : [];
      if (site.length) groups.push([`For ${host}`, site]);
      if (!kind) {
        const recent = recentAll.filter((i) => !hereSet.has(i)).slice(0, 5), shown = new Set([...site, ...recent]);
        if (recent.length) groups.push(['Recent', recent]);
        groups.push([`All items · ${vault.length}`, ofKind.filter((i) => !shown.has(i))]);
      } else groups.push([KINDS.find(([t]) => t === kind)[1], ofKind.filter((i) => !hereSet.has(i))]);
    }
    rows = [];
    queue = [];
    qi = 0;
    more.disconnect();
    sentinel = null;
    for (const [label, items] of groups) {
      if (!items.length) continue;
      const head = h('div', { className: 'group' }, h('span', {}, label));
      if ((kind === 3 || kind === 4) && formPage && label === KINDS.find(([t]) => t === kind)?.[1])
        head.append(h('button', { className: 'link', title: `New ${kindName(kind)} from the form on this page`, onclick: () => fromPage(kind).catch((e) => status(e.message)) }, 'from page'));
      queue.push({ head });
      for (const item of items) queue.push({ item });
    }
    list.replaceChildren();
    drawMore();
    if (!rows.length) list.append(h('p', { className: 'empty' }, s ? 'Nothing matches.' : 'Nothing here yet.'));
    const keep = rows.find((r) => r.key === selectedKey);
    select(keep ? selectedKey : (here.length && (!kind || kind === 1) ? keyOf(here[0]) : s && rows[0] ? rows[0].key : null));
  };
  const last = Math.min(...unlocked().map((a) => a.lastSync || 0));
  const ago = last ? Math.round((Date.now() - last) / 60e3) : null;
  const barBtn = (name, title, onclick, id) => h('button', { title, onclick, id }, icon(name, 17));
  const syncBtn = barBtn('sync', `Sync now (Ctrl+S)${ago == null ? '' : ` · last synced ${ago < 1 ? 'just now' : ago < 120 ? `${ago} min ago` : `${Math.round(ago / 60)} h ago`}`}`,
    () => run(syncBtn, document.getElementById('status'), syncAll), 'sync');
  const stillLocked = locked().length;
  render(
    h('div', { className: 'bar' }, h('span', { className: 'brand' }, 'Ward'),
      barBtn('plus', 'New item', () => editView(null)), barBtn('dice', 'Generator', () => generatorView()), syncBtn, barBtn('lock', 'Lock all vaults', lockAll), barBtn('gear', 'Settings', settingsView)),
    h('header', {}, icon('search'), q), kinds, list, h('p', { id: 'status', className: 'err' }),
    (stillLocked > 0 || multi) && h('footer', {},
      h('span', {}, stillLocked > 0 && h('button', { className: 'link', onclick: unlockView }, `${stillLocked} locked`)),
      h('button', { className: 'link', onclick: accountsView }, `Vaults (${accounts.length})`)));
  // A checkout-looking page with no logins opens on Cards.
  if (!kindPicked && formPage && /checkout|payment|billing|\/pay\b|\/cart|\/order/i.test(new URL(pageUrl).pathname)
    && !bw.forSite(vault, pageUrl, (i) => equiv.get(i.a), rank, st.used).length && vault.some((i) => typeOf(i) === 3)) kind = 3;
  kindPicked = true;
  draw();
  q.focus();
}

// Ward: Settings. Saving offers (logins; cards and addresses), sites never offered, locking, Touch ID.
function settingsView() {
  if (mode === 'save') return closeSave();
  const toggle = (key, label, title) => {
    const box = h('input', { type: 'checkbox', checked: st[key] !== false, onchange: () => local.set({ [key]: (st[key] = box.checked) }) });
    return h('label', { className: 'check', title }, box, label);
  };
  const neverList = h('div', { className: 'list' });
  const drawNever = () => {
    const hosts = Array.isArray(st.neverSave) ? st.neverSave : [];
    neverList.replaceChildren(...(hosts.length ? hosts.map((host) => h('div', { className: 'row' }, h('div', { className: 'info' }, h('span', {}, host)),
      h('div', { className: 'actions' }, h('button', { className: 'quiet', title: `Offer to save on ${host} again`, onclick: async () => {
        st.neverSave = hosts.filter((x) => x !== host);
        await local.set({ neverSave: st.neverSave });
        drawNever();
      } }, 'remove')))) : [h('p', { className: 'muted' }, 'None.')]));
  };
  drawNever();
  const neverLock = h('input', {
    type: 'checkbox', checked: !!st.neverLock,
    onchange: async () => {
      await withStateLock(async () => {
        const latest = normalizedAccounts((await local.get('accounts')).accounts);
        const next = latest.map((a) => {
          const copy = { ...a }, key = keys[a.id];
          if (neverLock.checked && key) copy.persistKey = bw.b64(key);
          else delete copy.persistKey;
          return copy;
        });
        await local.set({ neverLock: (st.neverLock = neverLock.checked), accounts: next });
        adoptAccounts(next);
      });
    },
  });
  const lockLabel = (m) => (m === 0 ? 'Lock when the browser quits' : `Lock after ${m < 60 ? `${m} min` : `${m / 60} h`} idle or screen lock`);
  const autoLock = h('select', {
    title: 'Auto-lock: locks every vault after this much time without keyboard or mouse input, and when the computer locks or sleeps. Never lock overrides it.',
    disabled: !!st.neverLock,
    onchange: () => local.set({ autoLock: (st.autoLock = Number(autoLock.value)) }),
  }, AUTO_LOCK_CHOICES.map((m) => h('option', { value: String(m), selected: m === autoLockMinutes(st.autoLock) }, lockLabel(m))));
  neverLock.addEventListener('change', () => (autoLock.disabled = neverLock.checked));
  // Matching: the match detection for URLs without their own (as Bitwarden's "Default URI match detection").
  const matchLabel = { 0: 'Base domain: any subdomain of the site', 1: 'Host: the exact subdomain and port', 2: 'Starts with the saved URL', 3: 'Exact URL' };
  const defaultMatch = h('select', {
    title: 'Default match detection, for URLs that have none of their own',
    onchange: () => local.set({ defaultMatch: (st.defaultMatch = bw.setDefaultMatch(Number(defaultMatch.value))) }),
  }, bw.DEFAULT_MATCHES.map((m) => h('option', { value: String(m), selected: m === bw.getDefaultMatch() }, matchLabel[m])));
  // Appearance: follow the system unless chosen here (theme.js applies it before first paint).
  const root = document.documentElement;
  let themeNow = 'system';
  try { themeNow = localStorage.theme || 'system'; } catch {}
  const theme = h('select', {
    onchange: () => {
      const v = theme.value;
      try { v === 'system' ? localStorage.removeItem('theme') : (localStorage.theme = v); } catch {}
      const light = v === 'light' || (v === 'system' && matchMedia('(prefers-color-scheme: light)').matches);
      if (light) root.dataset.theme = 'light'; else delete root.dataset.theme;
    },
  }, [['system', 'Match the system'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => h('option', { value: v, selected: v === themeNow }, l)));
  // Account: log out of each vault (removes it and its local data from Ward).
  const accountRows = accounts.map((a) => {
    const out = h('button', {
      className: 'danger', title: 'Removes this vault, its tokens and its cached data from Ward',
      onclick: () => (out.textContent === 'Sure?' ? removeAccount(a).then(() => accounts.length && settingsView()) : (out.textContent = 'Sure?')),
    }, 'Log out');
    return h('div', { className: 'row' }, h('div', { className: 'info' }, h('b', {}, a.label), h('small', {}, `${a.email} · ${new URL(a.server).host}`)), out);
  });
  render(title('Settings'),
    h('h2', {}, 'Account'), ...accountRows,
    h('p', { className: 'muted' }, 'Logging out removes the vault and its saved tokens from this browser. To end every session on the server too, use "Deauthorize sessions" in the web vault.'),
    h('h2', {}, 'Saving'),
    toggle('offerLogins', 'Offer to save new and changed logins', 'After you sign in with a password Ward does not have yet'),
    toggle('offerForms', 'Offer to save cards and addresses', 'After you submit a checkout or address form with a card or address you typed. Off: Ward does not watch card or address fields at all.'),
    h('p', { className: 'muted' }, 'Never offered on these sites:'), neverList,
    h('h2', {}, 'Passkeys'),
    toggle('passkeyMenu', 'Passkey sign-in in Ward\'s menu under sign-in fields', 'When a site offers passkey sign-in on its username field, Ward\'s menu there lists your passkeys for it first, and the browser\'s own list stays out of the way ("Use device or security key" opens it). Off: the browser shows its list, on top of Ward\'s menu.'),
    h('h2', {}, 'Copying'),
    toggle('clearClipboard', 'Clear copied passwords and codes after 30 s', 'Usernames and emails are left alone. The clipboard is emptied even if you copied something else since.'),
    h('h2', {}, 'Locking'),
    h('label', { className: 'check', title: 'Keeps the vault keys on this computer so the vaults stay open after a browser restart. Anyone with access to this browser profile can then open them.' }, neverLock, 'Never lock'),
    autoLock,
    h('button', { title: 'Touch ID unlock (experimental)', onclick: touchSettingsView }, 'Touch ID…'),
    h('h2', {}, 'Matching'), defaultMatch,
    h('p', { className: 'muted' }, 'For URLs without their own match detection. Set one login\'s URLs in its edit form.'),
    h('h2', {}, 'Appearance'), theme,
    h('div', { className: 'inline' }, h('button', { className: 'primary', onclick: vaultView }, 'Done')));
}

// The edit form's URLs: one row per URL with its match detection (null: the default from Settings > Matching).
function uriEditor(list) {
  const rows = h('div', { className: 'urls' });
  const add = (u = '', m = null) => {
    const input = h('input', { value: u, placeholder: 'example.com', ariaLabel: 'URL' });
    const match = h('select', { title: 'Match detection: when this URL counts as the page you are on', ariaLabel: 'Match detection' },
      [null, ...bw.MATCH_TYPES.keys()].map((v) => h('option', { value: v ?? '', selected: v === m },
        v === null ? `Default (${bw.MATCH_TYPES[bw.getDefaultMatch()]})` : bw.MATCH_TYPES[v])));
    const row = h('div', { className: 'inline' }, input, match,
      h('button', { type: 'button', className: 'quiet', title: 'Remove this URL', onclick: () => row.remove() }, icon('x')));
    row.read = () => [input.value.trim(), match.value === '' ? null : Number(match.value)];
    rows.append(row);
    return input;
  };
  for (const [u, m] of list) add(u, m);
  if (!list.length) add();
  const el = h('div', { className: 'field' }, h('span', {}, 'URLs'), rows,
    h('button', { type: 'button', className: 'link', onclick: () => add().focus() }, 'Add URL'));
  const read = () => {
    const got = [...rows.children].map((r) => r.read()).filter(([u]) => u);
    return { uris: got.map(([u]) => u), match: got.map(([, m]) => m) };
  };
  return { el, read };
}

// The edit form's Gen: a password or passphrase with the generator's saved options.
const genPassword = () => {
  const o = gen.normalize(st.generator);
  return gen.generate({ ...o, type: o.type === 'passphrase' ? 'passphrase' : 'password' });
};

// Ward: the generator (password, passphrase, username). Options persist in local storage (`generator`).
// use(value): opened from a form, a Use button hands the value back there; back: where Cancel/Done goes.
function generatorView({ type, use, back = vaultView } = {}) {
  if (mode === 'save') return closeSave();
  let o = gen.normalize({ ...st.generator, ...(type && { type }) });
  if (!o.email) o.email = unlocked()[0]?.email || accounts[0]?.email || '';
  let value = '';
  const out = h('div', { className: 'genout', title: 'Generated value' });
  const hint = h('p', { className: 'muted' });
  const err = h('p', { className: 'err' });
  const roll = () => {
    err.textContent = '';
    try { value = gen.generate(o); } catch (e) { value = ''; err.textContent = e.message; }
    out.textContent = value || ' ';
    const b = gen.bits(o);
    hint.textContent = b ? `About ${b} bits of randomness` : 'For sign-ups; not a secret';
  };
  const set = (patch, redraw) => {
    o = gen.normalize({ ...o, ...patch });
    local.set({ generator: (st.generator = { ...o }) });
    redraw ? draw() : roll();
  };
  const num = (key, label) => {
    const el = h('input', { type: 'number', min: gen.LIMITS[key][0], max: gen.LIMITS[key][1], value: o[key],
      onchange: () => (set({ [key]: el.value }), (el.value = o[key])) });
    return field(label, el);
  };
  const text = (key, label, placeholder) => {
    const el = h('input', { value: o[key], placeholder, oninput: () => set({ [key]: el.value }) });
    return field(label, el);
  };
  const check = (key, label) => {
    const box = h('input', { type: 'checkbox', checked: o[key], onchange: () => set({ [key]: box.checked }, true) });
    return h('label', { className: 'check' }, box, label);
  };
  const userType = () => h('select', { onchange: (e) => set({ userType: e.target.value }, true) },
    [['word', 'Random word'], ['plus', 'Email with a +tag'], ['catchall', 'Catch-all email']]
      .map(([v, l]) => h('option', { value: v, selected: o.userType === v }, l)));
  const options = () => (o.type === 'password'
    ? [num('length', 'Length'), h('div', { className: 'checks' }, check('upper', 'A–Z'), check('lower', 'a–z'), check('digits', '0–9'),
      check('symbols', '!@#$%^&*-_'), check('avoidAmbiguous', 'Avoid look-alikes (I l O 0 1 o)'))]
    : o.type === 'passphrase'
      ? [num('words', 'Words'), text('separator', 'Separator'), h('div', { className: 'checks' }, check('capitalize', 'Capitalize'), check('number', 'Add a number'))]
      : [field('Kind', userType()),
        o.userType === 'plus' ? text('email', 'Your email', 'you@example.com')
          : o.userType === 'catchall' ? text('domain', 'Your catch-all domain', 'example.com')
            : h('div', { className: 'checks' }, check('capitalize', 'Capitalize'), check('userNumber', 'Add 4 digits'))]);
  const draw = () => {
    const tabs = h('nav', { className: 'kinds' }, [['password', 'Password'], ['passphrase', 'Passphrase'], ['username', 'Username']]
      .map(([t, l]) => h('button', { type: 'button', className: o.type === t ? 'on' : '', onclick: () => set({ type: t }, true) }, l)));
    const copyBtn = h('button', { type: 'button', className: use ? '' : 'primary', onclick: () => value && copy(copyBtn, value, o.type !== 'username') }, 'Copy');
    out.classList.toggle('words', o.type !== 'password'); // passphrases wrap at the separators, passwords anywhere
    render(title('Generator'), tabs, out, hint, h('form', { onsubmit: (e) => e.preventDefault() }, ...options(),
      h('div', { className: 'inline' },
        use && h('button', { type: 'button', className: 'primary', onclick: () => value && use(value) }, 'Use'),
        copyBtn, h('button', { type: 'button', title: 'Generate another', onclick: roll }, 'New'),
        h('button', { type: 'button', onclick: back }, use ? 'Cancel' : 'Done')), err));
    roll();
  };
  draw();
}

// Bitwarden's linked custom fields point at one of the item's own fields (LinkedIdType).
const LINKED = { 100: 'Username', 101: 'Password', 300: 'Cardholder name', 301: 'Expiry month', 302: 'Expiry year', 303: 'Security code',
  304: 'Brand', 305: 'Number', 400: 'Title', 401: 'Middle name', 402: 'Address', 403: 'Address line 2', 404: 'Address line 3', 405: 'City',
  406: 'State / province', 407: 'Postal code', 408: 'Country', 409: 'Company', 410: 'Email', 411: 'Phone', 412: 'Social security number',
  413: 'Username', 414: 'Passport number', 415: 'Licence number', 416: 'First name', 417: 'Last name', 418: 'Full name' };
const linkedTo = (id) => `Linked to ${LINKED[id] || 'another field'}`;
// Choices for a new link, by item type: the login's username and password, or the card's or identity's fields.
const linkChoices = (t) => Object.keys(LINKED).map(Number).filter((id) => Math.floor(id / 100) === t && id !== 418);

// The edit forms' custom fields (text, hidden, checkbox, linked): per field a name, its kind and a remove icon on one
// row, the value under it. orgHidden: hidden values an organization keeps out of view stay as stored. t: item type.
function fieldsEditor(list, orgHidden, t) {
  const rows = h('div', { className: 'urls' });
  const KIND = [[0, 'Text'], [1, 'Hidden'], [2, 'Checkbox'], ...(linkChoices(t).length ? [[3, 'Linked']] : [])];
  const add = (f = { type: 0, name: '', value: '' }, n = null) => {
    const kept = n != null && f.type === 1 && orgHidden;
    const name = h('input', { value: f.name || '', placeholder: 'Field name', ariaLabel: 'Field name', autocomplete: 'off' });
    const kindSel = h('select', { ariaLabel: 'Field kind', title: 'Kind of field', disabled: kept },
      KIND.map(([v, l]) => h('option', { value: v, selected: v === (f.type ?? 0) }, l)));
    const valueRow = h('div', { className: 'inline' });
    let read = () => ({});
    const draw = (type, value) => {
      if (type === 3) {
        const target = h('select', { ariaLabel: 'Linked to', title: 'The field this one fills with' },
          linkChoices(t).map((id) => h('option', { value: id, selected: id === f.linkedId }, LINKED[id])));
        if (f.linkedId != null && !linkChoices(t).includes(f.linkedId)) target.append(h('option', { value: f.linkedId, selected: true }, linkedTo(f.linkedId)));
        valueRow.replaceChildren(h('span', { className: 'muted' }, 'Linked to'), target);
        read = () => ({ linkedId: Number(target.value) });
      } else if (type === 2) {
        const box = h('input', { type: 'checkbox', checked: value === 'true' || value === true });
        valueRow.replaceChildren(h('label', { className: 'check' }, box, 'On'));
        read = () => ({ value: String(box.checked) });
      } else {
        const input = h('input', { type: type === 1 ? 'password' : 'text', value: kept ? '' : value || '', ariaLabel: 'Field value', autocomplete: 'off',
          placeholder: kept ? 'Hidden by your organization' : 'Value', disabled: kept });
        valueRow.replaceChildren(input, type === 1 && !kept && h('button', { type: 'button', onclick: () => (input.type = input.type === 'password' ? 'text' : 'password') }, 'Show'));
        read = () => (kept ? { keep: n } : { value: input.value });
      }
    };
    draw(f.type ?? 0, f.value);
    kindSel.onchange = () => {
      const now = read(), next = Number(kindSel.value);
      draw(next, next === 2 ? (now.value === 'true' || (now.value && now.value !== 'false') ? 'true' : 'false') : now.value === 'false' && f.type === 2 ? '' : now.value);
    };
    const entry = h('div', { className: 'cfield' },
      h('div', { className: 'inline' }, name, kindSel, h('button', { type: 'button', className: 'quiet', title: 'Remove this field', onclick: () => entry.remove() }, icon('x'))),
      valueRow);
    entry.read = () => ({ type: Number(kindSel.value), name: name.value, ...read() });
    rows.append(entry);
    return name;
  };
  (list || []).forEach((f, n) => add(f, n));
  const el = h('div', { className: 'field' }, h('span', {}, 'Custom fields'), rows,
    h('button', { type: 'button', className: 'link', onclick: () => add().focus() }, 'Add field'));
  // a new entry left empty is dropped
  const read = () => [...rows.children].map((r) => r.read()).filter((f) => f.type === 3 || f.keep != null || f.name.trim() || (f.type !== 2 && f.value));
  return { el, read };
}

// Ward: an item's details. Every value is on screen without the edit form: secrets stay masked until the eye (or a
// click on the dots) shows them, each value has its copy button, and Edit opens the form. opts.fill: Fill this page.
function itemView(item, opts = {}) {
  if (mode === 'save') return closeSave();
  const t = typeOf(item), c = item.card || {}, d = item.identity || {}, orgHidden = item.viewPassword === false;
  const rows = [];
  const MASK = '••••••••••';
  const btn = (name, label, fn) => {
    const b = h('button', { type: 'button', title: label, ariaLabel: label }, icon(name));
    b.addEventListener('click', () => fn(b));
    return b;
  };
  // one detail row: caption, the value in full (wrapped), then its actions
  const row = (label, value, { secret, copyValue, mono, link } = {}) => {
    if (value == null || value === '') return;
    const val = h('div', { className: `val${mono || secret ? ' mono' : ''}` }, secret ? MASK : value);
    const acts = [];
    if (secret) {
      let shown = false;
      const show = (b) => {
        shown = !shown;
        val.textContent = shown ? value : MASK;
        b.title = b.ariaLabel = shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`;
      };
      const eye = btn('eye', `Show ${label.toLowerCase()}`, show);
      val.addEventListener('click', () => !shown && show(eye));
      val.classList.add('masked');
      acts.push(eye);
    }
    if (link) acts.push(btn('launch', `Open ${value} in a new tab`, () => chrome.tabs.create({ url: link }).then(() => window.close(), (e) => status(e.message))));
    acts.push(btn('copy', `Copy ${label.toLowerCase()}`, (b) => copy(b, copyValue ?? value, !!secret).catch((e) => status(e.message))));
    rows.push(h('div', { className: 'kv' }, h('div', { className: 'info' }, h('small', {}, label), val), h('div', { className: 'actions' }, ...acts)));
  };
  const note = (label, text) => text && rows.push(h('div', { className: 'kv' }, h('div', { className: 'info' }, h('small', {}, label), h('div', { className: 'val' }, text))));
  if (t === 1) {
    row('Username', item.username);
    if (orgHidden && item.password) note('Password', 'Hidden by your organization');
    else row('Password', item.password, { secret: true });
    if (item.totp) {
      // the digits stay masked like a password; the ring button copies the current code, as in the list
      const code = codeButton({ ...item, reprompt: false });
      let shown = false;
      const val = h('div', { className: 'val mono masked' }, '••• •••');
      const tick = code._tick;
      const paint = () => (shown ? bw.totp(item.totp).then((x) => (val.textContent = x.code.replace(/^(\d{3})(\d{3})$/, '$1 $2')), () => {}) : (val.textContent = '••• •••'));
      code._tick = () => (tick(), shown && paint());
      const eye = btn('eye', 'Show one-time code', (b) => ((shown = !shown), paint(), (b.title = b.ariaLabel = `${shown ? 'Hide' : 'Show'} one-time code`)));
      val.addEventListener('click', () => !shown && eye.click());
      rows.push(h('div', { className: 'kv' }, h('div', { className: 'info' }, h('small', {}, 'One-time code'), val), h('div', { className: 'actions' }, eye, code)));
    }
    item.uris.forEach((u, n) => {
      const href = /^https?:\/\//i.test(u) ? u : /^[\w.-]+\.[a-z]{2,}(:\d+)?(\/|$)/i.test(u) ? `https://${u}` : null;
      const m = item.m?.[n];
      row(m != null ? `Website · ${bw.MATCH_TYPES[m].toLowerCase()}` : 'Website', u, { link: href });
    });
    for (const p of item.passkeys || []) note('Passkey', [p.userName || p.userDisplayName, p.rpId].filter(Boolean).join(' · ') || 'Saved');
  } else if (t === 3) {
    row('Cardholder name', c.cardholderName);
    row('Number', c.number && c.number.replace(/(\d{4})(?=\d)/g, '$1 '), { secret: true, copyValue: c.number });
    row('Brand', c.brand);
    row('Expiry', c.expMonth || c.expYear ? `${String(c.expMonth || '--').padStart(2, '0')} / ${c.expYear || '----'}` : '');
    row('Security code', c.code, { secret: true });
  } else if (t === 4) {
    row('Name', [d.title, d.firstName, d.middleName, d.lastName].filter(Boolean).join(' '));
    row('Company', d.company);
    row('Email', d.email);
    row('Phone', d.phone);
    row('Address', [d.address1, d.address2, d.address3, [d.city, d.state, d.postalCode].filter(Boolean).join(' '), d.country].filter(Boolean).join('\n'));
    row('Username', d.username);
    row('Social security number', d.ssn, { secret: true });
    row('Passport number', d.passportNumber, { secret: true });
    row('Licence number', d.licenseNumber);
  }
  for (const f of item.fields || []) {
    const label = f.name || '(no name)';
    if (f.type === 3) note(label, linkedTo(f.linkedId));
    else if (f.type === 2) note(label, f.value === 'true' ? 'On' : 'Off');
    else if (f.type === 1 && orgHidden) note(label, 'Hidden by your organization');
    else row(label, f.value, { secret: f.type === 1 });
  }
  if (item.notes) row(t === 2 ? 'Note' : 'Notes', item.notes);
  const readOnly = item.raw?.edit === false;
  const self = (fresh) => (fresh ? loadItem(item).then((f) => itemView(f, opts), () => vaultView()) : itemView(item, opts));
  const fillBtn = opts.fill && h('button', { className: 'primary', onclick: opts.fill }, 'Fill');
  const editBtn = !readOnly && h('button', { className: opts.fill ? '' : 'primary', onclick: () => editView(item, self) }, 'Edit');
  render(title(item.name || '(no name)'),
    (accounts.length > 1 || readOnly) && h('p', { className: 'muted' }, accounts.length > 1 && vaultTag(item.a), readOnly && (accounts.length > 1 ? ' · read-only' : 'Read-only')),
    rows.length ? h('div', { className: 'details' }, ...rows) : h('p', { className: 'empty' }, 'Nothing saved in this item yet.'),
    h('div', { className: 'inline' }, fillBtn, editBtn, h('button', { onclick: vaultView }, 'Back')),
    h('p', { id: 'status', className: 'err' }));
  (fillBtn || editBtn || app.querySelector('button'))?.focus();
}

// back: where Cancel goes, and (with true) where a save goes; the item's details when the form was opened from there.
function editView(item, back = vaultView) {
  if (mode === 'save') return closeSave();
  const t = item ? typeOf(item) : kind || 1;
  if (t !== 1) return otherEditView(item, t, null, back);
  const name = h('input', { value: item ? item.name : host || '', required: true });
  const user = h('input', { value: item?.username || '' });
  const hidden = item?.viewPassword === false; // hidden by an organization policy: left empty, the saved one is kept
  const pass = h('input', { type: 'password', value: hidden ? '' : item?.password || '', placeholder: hidden ? 'Hidden by your organization' : null });
  const totp = h('input', { value: item?.totp || '', placeholder: 'Secret or otpauth:// URI' });
  const uris = uriEditor(item ? item.uris.map((u, n) => [u, item.m?.[n] ?? null]) : host ? [[new URL(tab.url).origin, null]] : []);
  const notes = h('textarea', { rows: 3, value: item?.notes || '' });
  const custom = fieldsEditor(item?.fields, hidden, 1);
  const target = !item && unlocked().length > 1 && h('select', {}, unlocked().map((a) => h('option', { value: a.id }, a.label)));
  const readOnly = item?.raw.edit === false;
  const btn = h('button', { className: 'primary', disabled: readOnly }, readOnly ? 'Read-only' : 'Save');
  const err = h('p', { className: 'err' });
  // second click confirms; the item goes to the server's trash
  const del = h('button', {
    type: 'button', className: 'danger', title: 'Move to the trash (restore it from the Bitwarden web vault)',
    onclick: () => (del.textContent === 'Sure?' ? run(del, err, () => deleteItem(item)) : (del.textContent = 'Sure?')),
  }, 'Delete');
  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      if (readOnly) return;
      run(btn, err, async () => {
        if (totp.value.trim()) await bw.totp(totp.value.trim()); // reject a bad secret before saving it
        const a = acct(item?.a || (target ? target.value : unlocked()[0].id));
        if (!await saveItem(a, item, {
          name: name.value.trim(), username: user.value, password: hidden && !pass.value ? item.password : pass.value, totp: totp.value.trim(), notes: notes.value,
          ...uris.read(), fields: custom.read(),
        })) throw new Error('Vault locked or removed before the save finished');
        back(true);
      });
    },
  },
    target && field('Vault', target),
    field('Name', name),
    field('Username', h('div', { className: 'inline' }, user,
      h('button', { type: 'button', className: 'quiet', title: 'Generate a username', onclick: () => generatorView({
        type: 'username', back: show, use: (v) => ((user.value = v), show()) }) }, icon('dice')))),
    field('Password', h('div', { className: 'inline' }, pass,
      h('button', { type: 'button', onclick: () => (pass.type = pass.type === 'password' ? 'text' : 'password') }, 'Show'),
      h('button', { type: 'button', title: 'Generate with your generator settings', onclick: () => ((pass.value = genPassword()), (pass.type = 'text')) }, 'Gen'),
      h('button', { type: 'button', className: 'quiet', title: 'Generator options', onclick: () => generatorView({
        type: gen.normalize(st.generator).type === 'passphrase' ? 'passphrase' : 'password', back: show,
        use: (v) => ((pass.value = v), (pass.type = 'text'), show()) }) }, icon('dice')))),
    field('TOTP', totp), uris.el, custom.el, field('Notes', notes),
    h('div', { className: 'inline' }, btn, h('button', { type: 'button', onclick: () => back() }, 'Cancel'), item && !readOnly && del), err);
  // show() also returns here from the generator with the form as it was
  const heading = title(item ? 'Edit login' : 'Add login'), tag = item && accounts.length > 1 && h('p', { className: 'muted' }, vaultTag(item.a));
  function show() { render(heading, tag, form); }
  show();
  name.focus();
}

// Ward: add/edit a secure note (2), card (3) or identity (4). item: the full decrypted item (openEdit) or null.
function otherEditView(item, t, prefill, back = vaultView) {
  const c = item?.card || prefill?.card || {}, d = item?.identity || prefill?.identity || {};
  const input = (value, props = {}) => h('input', { value: value || '', ...props });
  const secret = (value, props = {}) => {
    const el = input(value, { type: 'password', autocomplete: 'off', ...props });
    return [el, h('div', { className: 'inline' }, el, h('button', { type: 'button', onclick: () => (el.type = el.type === 'password' ? 'text' : 'password') }, 'Show'))];
  };
  const name = input(item?.name, { required: t === 2 });
  const notes = h('textarea', { rows: t === 2 ? 10 : 3, value: item?.notes || '' });
  const pair = (...kids) => h('div', { className: 'pair' }, ...kids);
  let fields = [], read;
  if (t === 3) {
    const holder = input(c.cardholderName, { autocomplete: 'off' });
    const [num, numBox] = secret(c.number, { inputMode: 'numeric', placeholder: '1234 5678 9012 3456' });
    const brand = h('select', {}, ['', 'Visa', 'Mastercard', 'Amex', 'Discover', 'Diners Club', 'JCB', 'Maestro', 'UnionPay', 'RuPay', 'Other']
      .map((b) => h('option', { value: b, selected: (c.brand || '') === b }, b || 'Detect from number')));
    const month = h('select', {}, ['', ...Array.from({ length: 12 }, (_, n) => String(n + 1))]
      .map((m) => h('option', { value: m, selected: String(parseInt(c.expMonth, 10) || '') === m }, m ? m.padStart(2, '0') : '--')));
    const year = input(c.expYear, { inputMode: 'numeric', placeholder: 'YYYY', maxLength: 4 });
    const [code, codeBox] = secret(c.code, { inputMode: 'numeric', maxLength: 4 });
    fields = [field('Cardholder name', holder), field('Number', numBox), field('Brand', brand),
      pair(field('Expiry month', month), field('Expiry year', year)), field('Security code', codeBox)];
    read = () => {
      const number = num.value.replace(/[\s-]/g, '');
      if (number && !/^\d{12,19}$/.test(number)) throw new Error('The card number should be 12 to 19 digits');
      const y = year.value.trim();
      if (y && !/^\d{2}(\d{2})?$/.test(y)) throw new Error('Expiry year: 4 digits, e.g. 2029');
      return { card: { cardholderName: holder.value.trim(), number, brand: brand.value || bw.cardBrand(number), expMonth: month.value,
        expYear: y.length === 2 ? `20${y}` : y, code: code.value.trim() } };
    };
  } else if (t === 4) {
    const f = Object.fromEntries(bw.IDENTITY_FIELDS.map((k) => [k, input(d[k], { autocomplete: 'off' })]));
    f.email.type = 'email';
    f.phone.type = 'tel';
    const [ssn, ssnBox] = secret(d.ssn);
    f.ssn = ssn;
    fields = [pair(field('Title', f.title), field('First name', f.firstName)), pair(field('Middle name', f.middleName), field('Last name', f.lastName)),
      field('Company', f.company), pair(field('Email', f.email), field('Phone', f.phone)),
      field('Address', f.address1), field('Address line 2', f.address2), field('Address line 3', f.address3),
      pair(field('City', f.city), field('State / province', f.state)), pair(field('Postal code', f.postalCode), field('Country', f.country)),
      field('Username', f.username), field('Social security number', ssnBox),
      pair(field('Passport number', f.passportNumber), field('Licence number', f.licenseNumber))];
    read = () => ({ identity: Object.fromEntries(bw.IDENTITY_FIELDS.map((k) => [k, f[k].value.trim()])) });
  } else read = () => ({});
  const custom = fieldsEditor(item?.fields, item?.viewPassword === false, t);
  const target = !item && unlocked().length > 1 && h('select', {}, unlocked().map((a) => h('option', { value: a.id }, a.label)));
  const readOnly = item?.raw?.edit === false;
  const btn = h('button', { className: 'primary', disabled: readOnly }, readOnly ? 'Read-only' : 'Save');
  const err = h('p', { className: 'err' });
  const del = h('button', {
    type: 'button', className: 'danger', title: 'Move to the trash (restore it from the Bitwarden web vault)',
    onclick: () => (del.textContent === 'Sure?' ? run(del, err, () => deleteItem(item)) : (del.textContent = 'Sure?')),
  }, 'Delete');
  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      if (readOnly) return;
      run(btn, err, async () => {
        const extra = read();
        const fallback = t === 3 ? [extra.card.brand || 'Card', extra.card.number.slice(-4)].filter(Boolean).join(' ')
          : t === 4 ? [extra.identity.firstName, extra.identity.lastName].filter(Boolean).join(' ') : '';
        const nm = name.value.trim() || fallback;
        if (!nm) throw new Error('Give it a name');
        const a = acct(item?.a || (target ? target.value : unlocked()[0].id));
        if (!await saveItem(a, item, { type: t, name: nm, notes: notes.value, ...extra, fields: custom.read() })) throw new Error('Vault locked or removed before the save finished');
        kind = t;
        back(true);
      });
    },
  },
    target && field('Vault', target), field('Name', name), ...fields, custom.el, field(t === 2 ? 'Note' : 'Notes', notes),
    h('div', { className: 'inline' }, btn, h('button', { type: 'button', onclick: () => back() }, 'Cancel'), item && !readOnly && del), err);
  const noun = { 2: 'secure note', 3: 'card', 4: 'identity' }[t];
  render(title(`${item ? 'Edit' : 'Add'} ${noun}`), item && accounts.length > 1 && h('p', { className: 'muted' }, vaultTag(item.a)), form);
  (t === 2 && item ? notes : name).focus();
}

const CANCEL = { error: { name: 'NotAllowedError', message: 'Cancelled' } };
const TIMEOUT = { error: { name: 'NotAllowedError', message: 'Timed out' } };
let pkTimer;

function closeSave() {
  const active = !!sv;
  saveCancelled = true;
  sv = null;
  if (saveTimer) clearTimeout(saveTimer), saveTimer = null;
  render();
  if (active) {
    session.remove(`save:${modeKey}`);
    window.close();
  } else if (mode === 'save') window.close();
}

// --- Touch ID unlock (Ward, experimental) -------------------------------------------------------------------
// WebAuthn runs in its own small window: the toolbar popup closes as soon as the system prompt takes focus.
async function openTouch(kind) {
  await chrome.windows.create({ url: `popup.html#touch=${kind}`, type: 'popup', width: 420, height: 330, focused: true });
  window.close();
}

// Does this key open the vault? The profile's private key and the cached list are both MAC-checked EncStrings.
async function keyFits(a, key) {
  const { [`${a.id}:profile`]: profile, [`${a.id}:index4`]: index } = await local.get([`${a.id}:profile`, `${a.id}:index4`]);
  const probe = typeof profile?.privateKey === 'string' ? profile.privateKey : index;
  if (!probe) return true;
  try { await bw.decrypt(probe, key); return true; } catch { return false; }
}

function touchSettingsView() {
  const rec = st.touchUnlock;
  const covered = Object.keys(rec?.wrapped || {}).map((id) => acct(id)?.label).filter(Boolean);
  const err = h('p', { className: 'err' });
  const remove = h('button', {
    onclick: async () => {
      if (remove.textContent !== 'Sure?') return (remove.textContent = 'Sure?');
      await local.remove('touchUnlock');
      st.touchUnlock = undefined;
      touchSettingsView();
    },
  }, 'Turn off');
  render(title('Touch ID'),
    h('p', { className: 'muted' }, rec
      ? `On since ${new Date(rec.createdAt).toLocaleDateString()} for ${covered.join(', ') || 'no vaults'}. Your master password is still needed every ${touch.PASSWORD_EVERY_DAYS} days.`
      : 'Unlock with Touch ID instead of typing your master password. Experimental: it needs the browser to support the WebAuthn PRF extension for extensions. Setting it up covers the vaults that are open now.'),
    h('div', { className: 'inline' },
      h('button', { className: 'primary', disabled: !unlocked().length, onclick: () => openTouch('enroll') }, rec ? 'Set up again' : 'Set up Touch ID'),
      rec && remove,
      h('button', { onclick: settingsView }, 'Back')),
    err);
}

async function touchView(kind) {
  const lines = [];
  const log = h('pre', { className: 'touchlog' });
  const say = (t) => { lines.push(t); log.textContent = lines.join('\n'); };
  const err = h('p', { className: 'err' });
  let caps = null;
  const report = () => JSON.stringify({ ward: chrome.runtime.getManifest().version, kind, caps, steps: lines, error: err.textContent }, null, 2);
  const copy = h('button', { hidden: true, onclick: () => navigator.clipboard.writeText(report()).then(() => (copy.textContent = 'Copied')) }, 'Copy report');
  const retry = h('button', { className: 'primary', hidden: true, onclick: () => go() }, 'Try again');
  const usePassword = h('button', { hidden: true, onclick: () => (location.hash = '', location.reload()) }, 'Use password');
  render(title(kind === 'enroll' ? 'Set up Touch ID' : 'Unlock with Touch ID'), log, err,
    h('div', { className: 'inline' }, retry, usePassword, copy, h('button', { onclick: () => window.close() }, 'Close')));
  const go = async () => {
    retry.hidden = copy.hidden = usePassword.hidden = true;
    err.textContent = '';
    try {
      caps = await touch.capabilities();
      say(`platform authenticator: ${caps.platformAuthenticator}; PRF capability: ${caps.clientCapabilities?.['extension:prf'] ?? 'not reported'}`);
      if (kind === 'enroll') {
        const rec = await touch.enroll(null, unlocked().map((a) => [a.id, keys[a.id]]), say);
        await local.set({ touchUnlock: (st.touchUnlock = rec) });
        say('Touch ID unlock is on.');
        copy.hidden = false;
        setTimeout(() => window.close(), 2500);
        return;
      }
      if (!st.touchUnlock) throw new Error('Touch ID is not set up');
      let opened = 0;
      for (const [id, key] of await touch.unlockKeys(st.touchUnlock, say, (await local.get('passwordAt')).passwordAt)) {
        const a = acct(id);
        if (!a || keys[id]) continue;
        if (!(await keyFits(a, key))) { say(`the key for ${a.label} no longer fits (master key rotated?)`); continue; }
        await setKey(a, key);
        opened++;
      }
      if (!opened && !unlocked().length) throw new Error('No vault opened. Set up Touch ID again after unlocking with your password.');
      say(`unlocked ${opened} vault(s)`);
      try {
        const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
        await chrome.action.openPopup({ windowId: w.id });
      } catch {}
      window.close();
    } catch (e) {
      err.textContent = e?.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : e?.message || String(e);
      say(`failed: ${err.textContent}`);
      retry.hidden = copy.hidden = false;
      usePassword.hidden = kind !== 'unlock';
    }
  };
  go();
}

// A lock/removal in another popup revokes this window's in-memory keys and any hand-off UI.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  const has = (key) => Object.prototype.hasOwnProperty.call(changes, key);
  // the security key window answered while this popup stayed open: finish (or show why not) right here
  const ts = has('twostep') && changes.twostep.newValue;
  if (waitingKey && ts && (ts.assertion || ts.keyError)) return (waitingKey = false, twoStepView(ts));
  if (mode === 'save' && has(`save:${modeKey}`) && changes[`save:${modeKey}`].newValue === undefined) return closeSave();
  if (mode === 'pk' && has(`pk:${modeKey}`) && changes[`pk:${modeKey}`].newValue === undefined) return answer(CANCEL);
  const removed = [...new Set(Object.entries(changes).filter(([k, v]) => /:key$/.test(k) && v.newValue === undefined)
    .map(([k]) => k.slice(0, k.lastIndexOf(':'))))];
  if (!removed.length) return;
  for (const id of removed) { delete keys[id]; delete lists[id]; }
  merge();
  if (pk) answer(CANCEL);
  else if (mode === 'save') closeSave();
  else if (mode === 'touch') return;
  else if (st && accounts.length) unlocked().length ? vaultView() : unlockView();
});

// Sends the page its answer, once, and closes the window.
async function answer(res) {
  if (!pk) return;
  const { id, tabId, documentId } = pk;
  pk = null;
  clearTimeout(pkTimer);
  // Cancel and timeout go out before any await: on pagehide (window closed) the document is gone after the first one.
  if (!res.error) {
    const handoff = await session.get(`pk:${modeKey}`).catch(() => ({}));
    if (handoff[`pk:${modeKey}`]?.id !== id) return window.close();
    // the page's own passkey UI needs its window focused
    if (res.fallback) {
      const t = await chrome.tabs.get(tabId).catch(() => null);
      if (t) await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
    }
  }
  // Firefox before 153 rejects a documentId option, even an undefined one; bridge.js runs only in the top frame.
  chrome.tabs.sendMessage(tabId, { bwliteRes: id, ...res }, documentId ? { documentId } : { frameId: 0 }).catch(() => {});
  session.remove(`pk:${modeKey}`);
  window.close();
}

// Chrome sizes the window before the page renders; shrink or grow it to what the passkey view shows.
async function fitWindow() {
  try {
    const w = await chrome.windows.getCurrent();
    await chrome.windows.update(w.id, { height: Math.min(outerHeight - innerHeight + document.body.offsetHeight, 620) });
  } catch {}
}

// ponytail: user verification is the unlocked vault plus this click; there is no extra master password prompt.
function passkeyView() {
  const { kind, rpId, origin, options: o } = pk;
  const err = h('p', { className: 'err' });
  const multi = unlocked().length > 1;
  const action = (text, primary, fn) => {
    const b = h('button', { type: 'button', className: primary ? 'primary' : '', onclick: () => run(b, err, fn) }, text);
    return b;
  };
  const authorized = async (a) => {
    const id = typeof a === 'string' ? a : a?.id || a?.a;
    const current = await session.get(`${id}:key`);
    return !!id && !!keys[id] && current[`${id}:key`] === bw.b64(keys[id]);
  };
  const ids = (list) => new Set((Array.isArray(list) ? list : [])
    .filter((c) => c && typeof c.id === 'string' && (c.type ?? 'public-key') === 'public-key').map((c) => c.id));
  const mine = vault.flatMap((i) => (i.passkeys || []).filter((p) => typeof p.rpId === 'string' && p.rpId.toLowerCase() === rpId).map((p) => {
    try { return { i, p, id: bw.b64u(bw.credIdBytes(p.credentialId)) }; } catch { return null; }
  }).filter(Boolean));
  const cancel = h('button', { type: 'button', onclick: () => answer(CANCEL) }, 'Cancel');
  const device = h('button', { type: 'button', className: 'link end', title: 'Hand this request to the browser: a phone, security key or the computer\'s own passkeys',
    onclick: () => answer({ fallback: true }) }, 'Use device or security key');
  const show = (heading, text, rows, primary) =>
    (render(...promptHead(heading), h('p', { className: 'muted' }, text, ' ',
      locked().length && h('button', { className: 'link', onclick: unlockView }, `${locked().length} locked`)),
    rows.length && h('div', { className: 'list' }, rows), promptActions(primary, cancel, device), err), fitWindow());

  if (kind === 'get') {
    const allow = ids(o.allowCredentials);
    // a non-empty allow list stays a restriction even when all its entries are of an unknown type
    const rows = mine.filter((m) => !o.allowCredentials?.length || allow.has(m.id)).map(({ i, p }) =>
      choice(i, p.userName || i.username || '(no username)', `${i.name}${multi ? ` · ${acct(i.a)?.label}` : ''}`,
        action('Sign in', true, async () => {
          const result = await bw.passkeyGet(p, o, origin);
          if (!await authorized(i.a)) return answer(CANCEL);
          await markUsed(i);
          answer({ result });
        })));
    return show(`Sign in to ${rpId}`, rows.length ? 'With a passkey from Ward:' : `Ward has no passkey for ${rpId}.`, rows);
  }

  const exclude = ids(o.excludeCredentials);
  // no auto-answer: the user may still want to add a security key next to it
  if (mine.some((m) => exclude.has(m.id))) return show(`Save a passkey for ${rpId}`, 'This site\'s passkey is already in Ward.', []);
  const save = async (a, item) => {
    if (!a || !await authorized(a)) return answer(CANCEL);
    const { passkey, result } = await bw.passkeyCreate(o, origin, rpId);
    if (!await authorized(a)) return answer(CANCEL);
    const v = item ? { ...item, passkey }
      : { name: o.rp.name || rpId, username: o.user.name || '', password: '', totp: '', notes: '', uris: [origin], passkey };
    if (!pk) return; // timed out or cancelled meanwhile: never store a passkey the site won't receive
    if (!await saveItem(a, item, v)) return answer(CANCEL);
    if (!await authorized(a)) return answer(CANCEL);
    answer({ result });
  };
  // existing logins for the site that have no passkey yet
      const rows = vault.filter((i) => bw.matches(i, pageUrl, equiv.get(i.a)) && !i.passkeys).map((i) =>
    choice(i, i.username || '(no username)', `${i.name}${multi ? ` · ${acct(i.a)?.label}` : ''}`,
      action('Save here', false, async () => save(acct(i.a), await loadItem(i)))));
  const target = multi && h('select', { title: 'Vault' }, unlocked().map((a) => h('option', { value: a.id }, a.label)));
  const create = action('Save as new login', true, () => save(target ? acct(target.value) : unlocked()[0]));
  show(`Save a passkey for ${rpId}`, `For ${o.user.name || 'this account'}${rows.length ? ', in a new login or one you have:' : '.'}`, rows, [create, target]);
}

// The "save this login?" bar. sv: { kind: 'add' | 'update', username, password, origin, a?, id? } from background.js.
function saveView() {
  if (mode !== 'save' || !sv) return closeSave();
  if (sv.kind === 'form') return formSaveView();
  const { kind, username, password, origin } = sv;
  const expires = sv.expires;
  const err = h('p', { className: 'err' });
  const close = closeSave;
  const valid = () => sv && sv.expires === expires && Number.isFinite(expires) && expires > Date.now();
  saveTimer = setTimeout(() => sv?.expires === expires && close(), Math.max(0, expires - Date.now()));
  const target = kind === 'add' && unlocked().length > 1 && h('select', { title: 'Vault' }, unlocked().map((a) => h('option', { value: a.id }, a.label)));
  const save = h('button', {
    className: 'primary',
    onclick: () => run(save, err, async () => {
      if (saveCancelled || !valid()) return close();
      const a = acct(sv.a || (target ? target.value : unlocked()[0].id));
      if (!a || !keys[a.id]) return close();
      const item = kind === 'update' ? await loadItem(sv) : null;
      if (!valid()) return close();
      const saved = await saveItem(a, item, item ? { ...item, password }
        : { name: new URL(origin).hostname, username, password, totp: '', notes: '', uris: [origin] }, valid);
      if (!saved) return close();
      close();
    }),
  }, kind === 'add' ? 'Save' : 'Update');
  const host = new URL(origin).hostname;
  const existing = kind === 'update' && vault.find((i) => i.a === sv.a && i.id === sv.id);
  const never = kind === 'add' && h('button', {
    className: 'link end',
    title: `Never offer to save logins for ${host}`,
    onclick: async () => {
      if (!valid()) return close();
      const { neverSave = [] } = await local.get('neverSave');
      const hostname = new URL(origin).hostname;
      await local.set({ neverSave: [...new Set((Array.isArray(neverSave) ? neverSave : []).concat(hostname))] });
      close();
    },
  }, 'Never for this site');
  render(
    ...promptHead(kind === 'add' ? `Save this login for ${host}?` : `Update the password for ${host}?`),
    h('div', { className: 'list' }, existing ? choice(existing, existing.name || host, username || existing.username || '(no username)')
      : choice(null, host, username || '(no username)')),
    promptActions(save, target, h('button', { onclick: close }, 'Not now'), never), err);
  fitWindow();
}

// Ward: a card and/or address the user typed into a checkout or address form. Each is a checkbox; the security code
// is only saved when ticked. Nothing reaches the vault without Save here.
function formSaveView() {
  const { card, identity, origin } = sv;
  const expires = sv.expires;
  const err = h('p', { className: 'err' });
  const valid = () => sv && sv.expires === expires && expires > Date.now();
  saveTimer = setTimeout(() => sv?.expires === expires && closeSave(), Math.max(0, expires - Date.now()));
  const check = (checked, text, title) => { const el = h('input', { type: 'checkbox', checked }); return [el, h('label', { className: 'check', title }, el, text)]; };
  const last4 = (card?.number || '').slice(-4);
  const exp = card && (card.expMonth || card.expYear) ? ` · ${String(card.expMonth || '?').padStart(2, '0')}/${String(card.expYear || '??').slice(-2)}` : '';
  const [cardBox, cardRow] = card ? check(true, `Card: ${card.brand || 'Card'} •••• ${last4}${exp}${card.cardholderName ? ` · ${card.cardholderName}` : ''}`) : [];
  const [codeBox, codeRow] = card?.code ? check(false, 'Also save the security code', 'Most people leave it out; sites ask for it each time') : [];
  const who = identity && [identity.firstName, identity.lastName].filter(Boolean).join(' ');
  const [idBox, idRow] = identity ? check(true, `Address: ${[who, identity.address1, identity.city || identity.postalCode].filter(Boolean).join(', ')}`) : [];
  const target = unlocked().length > 1 && h('select', { title: 'Vault' }, unlocked().map((a) => h('option', { value: a.id }, a.label)));
  const save = h('button', {
    className: 'primary',
    onclick: () => run(save, err, async () => {
      if (saveCancelled || !valid()) return closeSave();
      const a = acct(target ? target.value : unlocked()[0].id);
      if (!a || !keys[a.id]) return closeSave();
      if (card && cardBox.checked) {
        const c = { ...card, code: codeBox?.checked ? card.code : '' };
        if (!await saveItem(a, null, { type: 3, name: `${c.brand || 'Card'} ${last4}`, notes: '', card: c }, valid)) return closeSave();
      }
      if (identity && idBox.checked) {
        if (!await saveItem(a, null, { type: 4, name: who || identity.address1, notes: '', identity }, valid)) return closeSave();
      }
      closeSave();
    }),
  }, 'Save');
  const never = h('button', {
    className: 'link end',
    title: `Never offer to save anything for ${new URL(origin).hostname}`,
    onclick: async () => {
      if (!valid()) return closeSave();
      const { neverSave = [] } = await local.get('neverSave');
      await local.set({ neverSave: [...new Set((Array.isArray(neverSave) ? neverSave : []).concat(new URL(origin).hostname))] });
      closeSave();
    },
  }, 'Never for this site');
  render(
    ...promptHead(`Save from ${new URL(origin).hostname}?`),
    h('div', { className: 'checks' }, cardRow, codeRow, idRow),
    promptActions(save, target, h('button', { onclick: closeSave }, 'Not now'), never), err);
  fitWindow();
}

// Ward: "from page" on the Cards/Identities tab: read the card or address form on this page (values as they are,
// you review them before saving) into a new item.
async function fromPage(t) {
  const want = t === 3 ? 'card' : 'identity';
  const frames = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: () => location.href });
  const top = frames.find((r) => r.frameId === 0)?.result;
  const out = {};
  for (const f of frames.filter((r) => formFrameAllowed(want, top, r.result))) {
    const target = f.documentId ? { tabId: tab.id, documentIds: [f.documentId] } : { tabId: tab.id, frameIds: [f.frameId] };
    try {
      await chrome.scripting.executeScript({ target, files: ['formfill.js'] });
      const [r] = await chrome.scripting.executeScript({ target, args: [want], func: (w) => globalThis.wardReadForm?.(w) || {} });
      for (const [k, v] of Object.entries(r?.result || {})) if (typeof v === 'string' && v && !out[k]) out[k] = v.slice(0, 200);
    } catch {}
  }
  if (!Object.keys(out).length) return status(`No ${want === 'card' ? 'card' : 'address'} details found in this page's form`);
  otherEditView(null, t, want === 'card' ? { card: { ...out, brand: bw.cardBrand(out.number) } } : { identity: out });
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    document.getElementById('sync')?.click();
  }
});

start().catch((e) => mode === 'save' ? closeSave() : render(h('p', { className: 'err' }, e?.message || String(e))));
