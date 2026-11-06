// Service worker: passkey requests, the toolbar badge, the autofill shortcut, the in-page login menu and the
// "save this login?" offer. It reads the vaults the popup has opened (session storage); writing stays in the
// extension-owned save confirmation and passkey windows.
import * as bw from './bw.js';
import { fillTab, formFrameAllowed } from './autofill.js';
import { withStateLock, lockEverything, shouldAutoLock, autoLockMinutes } from './coord.js';
import { syncOpenVault, liveHub, freshTokens, SYNC_EVERY_MIN } from './sync.js';

const local = chrome.storage.local, session = chrome.storage.session, td = new TextDecoder();
const http = (url) => /^https?:\/\//i.test(url || '');
const https = (url) => /^https:\/\//i.test(url || '');
const accountId = (id) => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);
const requestId = (id) => typeof id === 'string' && id.length > 0 && id.length < 200;

// --- vault state, cached until anything in storage changes -------------------

let state, building, stateVersion = 0, usedWrite = Promise.resolve();
// One build shared by every caller: a storage change has every tab's badge ask at once.
async function vault() {
  return state || (building ??= build().finally(() => (building = null)));
}
async function build() {
  const version = stateVersion;
  const stored = await local.get(['accounts', 'used', 'neverSave']);
  const seen = new Set();
  const accounts = Array.isArray(stored.accounts) ? stored.accounts.filter((a) => accountId(a?.id) && !seen.has(a.id) && seen.add(a.id)) : [];
  const used = stored.used && typeof stored.used === 'object' ? stored.used : {};
  const neverSave = Array.isArray(stored.neverSave) ? stored.neverSave.filter((h) => typeof h === 'string') : [];
  const s = await session.get(accounts.flatMap((a) => [`${a.id}:key`, `${a.id}:list`]));
  const validSessionKey = (key) => {
    try { return typeof key === 'string' && bw.unb64(key).length === 64; } catch { return false; }
  };
  const items = [];
  let open = 0;
  for (const a of accounts) {
    let list = s[`${a.id}:list`];
    if (list && !validSessionKey(s[`${a.id}:key`])) {
      // A list without its key is a stale half of a lock/removal. Never expose it.
      await session.remove([`${a.id}:list`, `${a.id}:key`]).catch(() => {});
      list = null;
    }
    try {
      let parsed;
      if (!list && a.persistKey) { // Never lock, browser restarted: open the encrypted list as the popup would
        list = await withStateLock(async () => {
          // A popup can lock or remove this account while decrypt is suspended.
          // Re-read the account under the same lock and publish only while its
          // current persisted key still authorizes the restore.
          const latest = (await local.get('accounts')).accounts?.find((x) => x?.id === a.id);
          if (!latest?.persistKey || latest.persistKey !== a.persistKey || stateVersion !== version) return null;
          const current = await session.get([`${a.id}:key`, `${a.id}:list`]);
          if (validSessionKey(current[`${a.id}:key`]) && current[`${a.id}:list`]) return current[`${a.id}:list`];
          const { [`${a.id}:index4`]: index } = await local.get(`${a.id}:index4`);
          if (!index) return null;
          const persistKey = bw.unb64(latest.persistKey);
          if (persistKey.length !== 64) throw new Error('bad persisted vault key');
          const text = td.decode(await bw.decrypt(index, persistKey));
          parsed = JSON.parse(text);
          if (!Array.isArray(parsed)) throw new Error('cached list is not an array');
          const currentLatest = (await local.get('accounts')).accounts?.find((x) => x?.id === a.id);
          if (currentLatest?.persistKey !== latest.persistKey || stateVersion !== version) return null;
          await session.set({ [`${a.id}:list`]: text, [`${a.id}:key`]: latest.persistKey });
          return text;
        });
      }
      if (list) {
        parsed ||= JSON.parse(list);
        if (!Array.isArray(parsed)) throw new Error('cached list is not an array');
        open++, items.push(...parsed.filter((i) => i && Array.isArray(i.uris) && i.uris.every((u) => typeof u === 'string')
          && (!i.passkeys || Array.isArray(i.passkeys))).map((i) => ({ ...i, a: a.id })));
      }
    } catch (e) {
      console.warn('Skipping corrupt cached vault', a.id, e);
      await session.remove([`${a.id}:list`, `${a.id}:key`]).catch(() => {});
    }
  }
  // Recheck the session snapshot while holding the same lock as popup lock and
  // removal. A key/list can be revoked after the first read but before this
  // state is published; in that case discard the build and retry.
  const stable = await withStateLock(async () => {
    if (version !== stateVersion) return false;
    const rawLatest = (await local.get('accounts')).accounts;
    const seenLatest = new Set();
    const latestAccounts = Array.isArray(rawLatest) ? rawLatest.filter((a) => accountId(a?.id) && !seenLatest.has(a.id) && seenLatest.add(a.id)) : [];
    if (!Array.isArray(latestAccounts) || latestAccounts.length !== accounts.length
      || accounts.some((a, i) => latestAccounts[i]?.id !== a.id || latestAccounts[i]?.persistKey !== a.persistKey)) return false;
    const current = await session.get(accounts.flatMap((a) => [`${a.id}:key`, `${a.id}:list`]));
    return accounts.every((a) => current[`${a.id}:key`] === s[`${a.id}:key`] && current[`${a.id}:list`] === s[`${a.id}:list`]);
  });
  if (!stable) return build();
  const eq = await local.get(accounts.map((a) => `${a.id}:eq`));
  const rank = (id) => accounts.findIndex((a) => a.id === id);
  if (version !== stateVersion) return build();
  const equiv = new Map(accounts.map((a) => [a.id, bw.equivalents(eq[`${a.id}:eq`])]))
  return (state = { accounts, used, neverSave, items, open, equiv, rank });
}
const forSite = (v, url) => bw.forSite(v.items, url, (i) => v.equiv.get(i.a), v.rank, v.used);
const markUsed = (i, version = null) => {
  const job = usedWrite.catch(() => {}).then(async () => {
    if (version !== null && version !== stateVersion) return false;
    const { accounts = [], used = {} } = await local.get(['accounts', 'used']);
    if (!accounts.some((a) => a?.id === i.a) || (version !== null && version !== stateVersion)) return false;
    await local.set({ used: { ...(used && typeof used === 'object' ? used : {}), [`${i.a}:${i.id}`]: Date.now() } });
    return true;
  });
  usedWrite = job.catch(() => {});
  return job;
};

// --- badge: number of logins for the tab's page --------------------------------

async function badge(tabId, url) {
  const n = http(url) ? forSite(await vault(), url).length : 0;
  await chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
}
let redraw;
chrome.storage.onChanged.addListener((changes, area) => {
  const relevant = area === 'local' || Object.keys(changes).some((k) => /:key$|:list$/.test(k));
  if (!relevant) return; // save/passkey hand-off records do not change the cached vault
  if (area === 'local' && Object.keys(changes).join() === 'used') { // a fill's timestamp only reorders: no rebuild, no redraw
    const used = changes.used.newValue;
    if (state) state.used = used && typeof used === 'object' ? used : {};
    return;
  }
  state = null;
  stateVersion++;
  clearTimeout(redraw);
  redraw = setTimeout(async () => (await chrome.tabs.query({})).forEach((t) => badge(t.id, t.url)), 300);
});
chrome.action.setBadgeBackgroundColor({ color: '#555' });

// --- auto-lock (Ward): lock on screen lock / sleep and after the chosen minutes of system idle -----------------
// chrome.idle wakes the service worker; the detection interval is re-applied on every start and setting change.
async function applyAutoLock() {
  if (!chrome.idle) return;
  const { autoLock } = await local.get('autoLock');
  chrome.idle.setDetectionInterval(Math.max(15, (autoLockMinutes(autoLock) || 240) * 60));
}
chrome.idle?.onStateChanged.addListener(async (idleState) => {
  const settings = await local.get(['neverLock', 'autoLock']);
  if (shouldAutoLock(idleState, settings)) await lockEverything(local, session);
});
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.autoLock) applyAutoLock(); });
applyAutoLock();

// --- background and live sync (Ward): open vaults stay fresh without the popup -------------------------------
const openAccounts = async () => {
  const { accounts } = await local.get('accounts');
  const list = Array.isArray(accounts) ? accounts.filter((a) => accountId(a?.id)) : [];
  const s = await session.get(list.map((a) => `${a.id}:key`));
  return list.filter((a) => s[`${a.id}:key`]);
};
const syncQuietly = (id, opts) => syncOpenVault(local, session, id, opts).catch((e) => console.warn('Ward sync', id, e?.message));
const hub = typeof WebSocket === 'function' && chrome.alarms // the test harness has neither alarms nor a server
  ? liveHub({ open: { accounts: openAccounts, tokens: (id) => freshTokens(local, id) }, onChange: (id) => syncQuietly(id, { force: true }) })
  : null;
let hubTimer;
const refreshHub = () => { clearTimeout(hubTimer); hubTimer = setTimeout(() => hub?.refresh().catch(() => {}), 1000); };
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'session' && Object.keys(changes).some((k) => /:key$/.test(k))) refreshHub(); });
chrome.alarms?.get('ward-sync').then((x) => x || chrome.alarms.create('ward-sync', { periodInMinutes: SYNC_EVERY_MIN }));
chrome.alarms?.onAlarm.addListener(async (x) => {
  if (x.name !== 'ward-sync') return;
  for (const a of await openAccounts()) await syncQuietly(a.id);
  refreshHub();
});
refreshHub();

// --- autofill shortcut (Ctrl/Cmd+Shift+L): the top login, as the popup's highlighted Fill -------------

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'autofill' || !http(tab?.url)) return;
  const v = await vault();
  const version = stateVersion;
  const [item] = forSite(v, tab.url).filter((i) => !i.reprompt); // re-prompt logins need the master password, in the popup
  if (!item) return chrome.action.openPopup().catch(() => {}); // locked or nothing saved: show why
  if (version !== stateVersion) return;
  const code = item.totp ? (await bw.totp(item.totp).catch(() => null))?.code || null : null;
  if (await fillTab(tab.id, item, v.equiv.get(item.a), code, async () => version === stateVersion) && version === stateVersion) await markUsed(item, version);
});

// --- save offers: remembered per tab when a login is submitted, offered once the page has moved on -----------

// session storage pending:<tabId> -> { at, username, url, origin, offer? }: the service worker is stopped when idle,
// often between the two steps of a two-step login
async function submitted(tabId, url, credentials) {
  if (!credentials || typeof credentials !== 'object') return;
  let { username, password } = credentials;
  if (!Number.isInteger(tabId) || !http(url) || typeof username !== 'string' || typeof password !== 'string') return;
  let page;
  try { page = new URL(url); } catch { return; }
  const now = Date.now(), origin = page.origin, key = `pending:${tabId}`;
  const { [key]: old } = await session.get(key);
  const prev = old && now - old.at <= 60e3 && old.origin === origin ? old : null;
  if (!password) return session.set({ [key]: { at: now, username, url, origin } }); // username step of a two-step login
  username ||= prev?.username || '';
  const version = stateVersion;
  const v = await vault();
  if (version !== stateVersion || !v.open || v.neverSave.includes(new URL(url).hostname)) return session.remove(key);
  const logins = forSite(v, url);
  const lower = username.toLowerCase();
  const same = username ? logins.filter((i) => i.username.toLowerCase() === lower) : logins.length === 1 ? logins : [];
  if (logins.some((i) => i.password === password && (!username || i.username.toLowerCase() === lower)) || (!username && !same.length && logins.length)) {
    return session.remove(key);
  }
  const offer = same.length ? { kind: 'update', a: same[0].a, id: same[0].id, username: same[0].username } : { kind: 'add', username };
  // domain: sign-in often lands on another subdomain (login.example.com -> app.example.com)
  await session.set({ [key]: { at: now, username, url, origin, offer: { ...offer, password, origin, domain: bw.baseDomain(page.hostname) } } });
}
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.url || info.status === 'complete') badge(tabId, tab.url);
  // loaded, or a single-page app moved to another URL
  if (!(info.status === 'complete' || (info.url && tab.status === 'complete'))) return;
  const { [`pending:${tabId}`]: p } = await session.get(`pending:${tabId}`);
  if (!p?.offer) return;
  await session.remove(`pending:${tabId}`); // offered once, or dropped
  if (Date.now() - p.at > 60e3) return;
  let current;
  try { current = new URL(tab.url); } catch { return; }
  if (!http(tab.url) || bw.baseDomain(current.hostname) !== p.offer.domain) return;
  const key = crypto.randomUUID();
  const version = stateVersion;
  await session.set({ [`save:${key}`]: { ...p.offer, tabId, expires: Date.now() + 60e3 } });
  if (version !== stateVersion) return session.remove(`save:${key}`);
  chrome.tabs.sendMessage(tabId, { bwliteBar: key }, { frameId: 0 }).catch(() => session.remove(`save:${key}`));
});
chrome.tabs.onRemoved.addListener((tabId) => session.remove([`pending:${tabId}`, `draft:${tabId}`]));

// --- card and address save offers (Ward) ------------------------------------------------------------------
// inpage.js asks to watch a frame where the user typed into a card/address field; formfill.js then sends drafts of
// the values the user typed. Drafts from all frames of a tab merge (card fields often sit in a payment iframe).
// After a submit, when the page loads or 2.5 s later (single-page checkouts), a card or address that isn't in the
// vault yet is offered through the same review window as logins. Drafts live in memory-only session storage.
const CARD_KEYS = ['cardholderName', 'number', 'expMonth', 'expYear', 'code'];
const IDENTITY_KEYS = ['title', 'firstName', 'middleName', 'lastName', 'company', 'address1', 'address2', 'address3', 'city', 'state',
  'postalCode', 'country', 'email', 'phone'];
const clean = (o, keys) => Object.fromEntries(keys.filter((k) => typeof o?.[k] === 'string' && o[k] && o[k].length <= 200).map((k) => [k, o[k]]));
const watched = new Set();
const luhn = (n) => /^\d{12,19}$/.test(n) && [...n].reverse().reduce((s, d, i) => s + (i % 2 ? [0, 2, 4, 6, 8, 1, 3, 5, 7, 9][d] : +d), 0) % 10 === 0;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function watchFrame(sender) {
  if (!sender.tab || !https(sender.url) || !https(sender.tab.url)) return null;
  const key = sender.documentId || `${sender.tab.id}:${sender.frameId}`;
  if (watched.has(key)) return null;
  if (!formFrameAllowed('card', sender.tab.url, sender.url) && !formFrameAllowed('identity', sender.tab.url, sender.url)) return null;
  if (!(await vault()).open) return null; // nothing to save into
  watched.add(key);
  const target = sender.documentId ? { tabId: sender.tab.id, documentIds: [sender.documentId] } : { tabId: sender.tab.id, frameIds: [sender.frameId] };
  await chrome.scripting.executeScript({ target, files: ['formfill.js'] }).catch(() => {});
  await chrome.scripting.executeScript({ target, func: () => globalThis.wardWatch?.() }).catch(() => {});
  return null;
}

async function draftFrom(sender, d) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId) || !d || typeof d !== 'object' || !https(sender.tab.url) || !https(sender.url)) return;
  const top = new URL(sender.tab.url), key = `draft:${tabId}`;
  const { [key]: old } = await session.get(key);
  const fresh = old && Date.now() - old.at < 15 * 60e3 && old.origin === top.origin ? old : null;
  if (!fresh && !d.card && !d.identity) return; // a submit with nothing typed anywhere
  const card = formFrameAllowed('card', sender.tab.url, sender.url) ? clean(d.card, CARD_KEYS) : {};
  const identity = formFrameAllowed('identity', sender.tab.url, sender.url) ? clean(d.identity, IDENTITY_KEYS) : {};
  const next = { at: Date.now(), origin: top.origin, domain: bw.baseDomain(top.hostname),
    card: { ...fresh?.card, ...card }, identity: { ...fresh?.identity, ...identity }, submittedAt: fresh?.submittedAt };
  if (d.submit === true) next.submittedAt = Date.now();
  await session.set({ [key]: next });
  if (d.submit === true) setTimeout(() => offerDraft(tabId), 2500);
}

async function offerDraft(tabId, tab) {
  const key = `draft:${tabId}`;
  const { [key]: d } = await session.get(key);
  if (!d?.submittedAt || Date.now() - d.submittedAt > 60e3) return;
  let current;
  try { current = new URL((tab || await chrome.tabs.get(tabId)).url); } catch { return; }
  if (current.protocol !== 'https:' || bw.baseDomain(current.hostname) !== d.domain) return;
  await session.remove(key); // offered once, or dropped
  const version = stateVersion;
  const v = await vault();
  if (version !== stateVersion || !v.open || v.neverSave.includes(new URL(d.origin).hostname)) return;
  const number = (d.card.number || '').replace(/\D/g, '');
  const card = luhn(number) && !v.items.some((i) => i.type === 3 && (i.card?.number || '').replace(/\D/g, '') === number)
    ? { ...d.card, number, brand: bw.cardBrand(number) } : null;
  const id = d.identity;
  const addressy = id.address1 && (id.postalCode || id.city);
  const known = v.items.some((i) => i.type === 4 && norm(i.identity?.address1) === norm(id.address1)
    && (!id.postalCode || norm(i.identity?.postalCode) === norm(id.postalCode)));
  const identity = addressy && !known ? id : null;
  if (!card && !identity) return;
  const save = crypto.randomUUID();
  await session.set({ [`save:${save}`]: { kind: 'form', card, identity, origin: d.origin, domain: d.domain, tabId, expires: Date.now() + 120e3 } });
  if (version !== stateVersion) return session.remove(`save:${save}`);
  const what = card && identity ? 'card and address' : card ? 'card' : 'address';
  chrome.tabs.sendMessage(tabId, { bwliteBar: save, what }, { frameId: 0 }).catch(() => session.remove(`save:${save}`));
}
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' || (info.url && tab.status === 'complete')) offerDraft(tabId, tab).catch(() => {});
});

// The page bar only asks for review. The offer itself stays in session storage
// and is opened in an extension window after Chrome authenticates the sender's
// tab and origin. This keeps the password out of a web-accessible iframe.
async function openSave(key, sender) {
  if (!requestId(key) || !sender?.tab || !Number.isInteger(sender.tab.id) || sender.frameId !== 0
    || typeof sender.url !== 'string' || !http(sender.url)) {
    return { fallback: true };
  }
  let page;
  try { page = new URL(sender.url); } catch { return { fallback: true }; }
  if (typeof sender.origin === 'string' && sender.origin !== page.origin) return { fallback: true };
  let current;
  try { current = await chrome.tabs.get(sender.tab.id); } catch { return { fallback: true }; }
  let currentOrigin;
  try { currentOrigin = new URL(current?.url || '').origin; } catch { return { fallback: true }; }
  if (current?.id !== sender.tab.id || currentOrigin !== page.origin) return { fallback: true };
  return withStateLock(async () => {
    const keyName = `save:${key}`;
    const stored = await session.get(keyName);
    const offer = stored[keyName];
    if (!offer || offer.opened || offer.tabId !== sender.tab.id || offer.domain !== bw.baseDomain(page.hostname)
      || !Number.isFinite(offer.expires) || offer.expires <= Date.now()) return { fallback: true };
    const opened = { ...offer, opened: true };
    await session.set({ [keyName]: opened });
    try {
      await chrome.windows.create({ url: `popup.html#save=${key}`, type: 'popup', width: 410, height: offer.kind === 'form' ? 360 : 240 });
      return { opened: true };
    } catch {
      await session.set({ [keyName]: offer });
      return { fallback: true };
    }
  });
}

// --- messages from inpage.js / bridge.js -----------------------------------------------

// WebAuthn says to ignore unknown transports and descriptors of an unknown type (popup.js ids() skips those).
const validDescriptor = (d) => d && typeof d === 'object' && typeof d.id === 'string' && d.id.length > 0 && d.id.length < 1000
  && (d.transports === undefined || Array.isArray(d.transports) && d.transports.every((t) => typeof t === 'string'));
const supportedPasskeyOptions = (kind, o) => {
  // Every passkey here is a user-verified platform discoverable key, so timeout, userVerification and residentKey
  // are always satisfiable and unknown extensions are ignored, as WebAuthn allows. Only a request that insists on a
  // security key or enterprise attestation goes to the browser.
  if (o.authenticatorSelection?.authenticatorAttachment === 'cross-platform' || o.attestation === 'enterprise') return false;
  return kind === 'get' || kind === 'create';
};
const validPasskeyOptions = (kind, o) => {
  if (!o || typeof o !== 'object' || typeof o.challenge !== 'string' || !o.challenge.length || o.challenge.length > 16384) return false; // Google sends ~1.7k chars
  if (!supportedPasskeyOptions(kind, o)) return false;
  if (kind === 'create') return o.rp && typeof o.rp === 'object' && typeof o.rp.name === 'string' && o.rp.name.length < 1000
    && (o.rp.id === undefined || (typeof o.rp.id === 'string' && o.rp.id.length > 0))
    && o.user && typeof o.user === 'object' && typeof o.user.id === 'string' && o.user.id.length > 0 && typeof o.user.name === 'string'
    // an empty list means ES256 and RS256; params of an unknown type are ignored
    && Array.isArray(o.pubKeyCredParams) && o.pubKeyCredParams.every((p) => p && typeof p === 'object' && Number.isInteger(p.alg))
    && (!o.pubKeyCredParams.length || o.pubKeyCredParams.some((p) => p.alg === -7 && (p.type ?? 'public-key') === 'public-key'))
    && (!o.excludeCredentials || (Array.isArray(o.excludeCredentials) && o.excludeCredentials.every(validDescriptor)));
  return kind === 'get' && (o.rpId === undefined || (typeof o.rpId === 'string' && o.rpId.length > 0))
    && (!o.allowCredentials || (Array.isArray(o.allowCredentials) && o.allowCredentials.every(validDescriptor)));
};

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  const senderOrigin = (() => {
    if (!sender?.tab || !Number.isInteger(sender.tab.id) || typeof sender.origin !== 'string' || typeof sender.url !== 'string') return false;
    try { return new URL(sender.url).origin === sender.origin; } catch { return false; }
  })();
  const job = m?.bwliteReq
    ? requestId(m.bwliteReq) && (m.kind === 'create' || m.kind === 'get') && validPasskeyOptions(m.kind, m.options)
      && senderOrigin
      ? passkey(m, sender).catch(() => ({ bwliteRes: m.bwliteReq, fallback: true }))
      : Promise.resolve({ bwliteRes: m.bwliteReq, fallback: true })
    : m?.bwliteMenu === true && sender.tab && http(sender.url) ? menu(sender)
    : typeof m?.bwliteFillKey === 'string' && m.bwliteFillKey.length < 200 && sender.tab && http(sender.url) ? fillFromMenu(m.bwliteFillKey, sender)
    : m?.bwliteSubmit && sender.tab ? submitted(sender.tab.id, sender.url, m.bwliteSubmit).then(() => null)
    : m?.wardWatch === true && sender.tab ? watchFrame(sender)
    : m?.wardDraft && sender.tab ? draftFrom(sender, m.wardDraft).then(() => null)
    : typeof m?.bwliteSaveOpen === 'string' ? openSave(m.bwliteSaveOpen, sender)
    : m?.bwliteUsed && typeof m.bwliteUsed.a === 'string' && m.bwliteUsed.a.length < 65
      && typeof m.bwliteUsed.id === 'string' && m.bwliteUsed.id.length < 200 ? markUsed(m.bwliteUsed)
    : null;
  if (!job) return;
  job.then(reply, () => reply(null));
  return true;
});

// The menu sees usernames and names only; the password goes out on a click, to the frame whose URL matches.
async function menu(sender) {
  if (!http(sender.url)) return [];
  const v = await vault();
  const multi = v.accounts.length > 1;
  return forSite(v, sender.url).filter((i) => !i.reprompt).slice(0, 8).map((i) => ({
    k: `${i.a}:${i.id}`, username: i.username, name: multi ? `${i.name} · ${v.accounts.find((a) => a.id === i.a)?.label}` : i.name,
  }));
}

async function fillFromMenu(k, sender) {
  const v = await vault();
  const version = stateVersion;
  const item = v.items.find((i) => `${i.a}:${i.id}` === k);
  if (!item || item.reprompt || version !== stateVersion || !http(sender.url) || !bw.matches(item, sender.url, v.equiv.get(item.a))) return null;
  if (!await markUsed(item, version)) return null;
  const beforeCode = await session.get(`${item.a}:key`);
  if (!beforeCode[`${item.a}:key`]) return null;
  const code = item.totp ? (await bw.totp(item.totp).catch(() => null))?.code || null : null;
  const afterCode = await session.get(`${item.a}:key`);
  if (afterCode[`${item.a}:key`] !== beforeCode[`${item.a}:key`]) return null;
  return { username: item.username, password: item.password, code };
}

// --- passkeys: check the request and open a Ward window for it; that window (popup.js passkeyView) answers the
// page directly. The origin comes from Chrome (sender.origin), never from the page.

async function passkey({ bwliteReq, kind, options: o }, { origin, tab, documentId }) {
  const fallback = { bwliteRes: bwliteReq, fallback: true };
  let page;
  try { page = new URL(origin); } catch { return fallback; }
  const host = page.hostname.toLowerCase();
  const requested = (kind === 'create' ? o.rp?.id : o.rpId) || host;
  if (typeof requested !== 'string' || !requested || /[\s\/?#@:]/.test(requested)) return fallback;
  let rpId;
  try { rpId = new URL(`https://${requested}`).hostname.toLowerCase().replace(/\.$/, ''); } catch { return fallback; }
  // rpId must be the page's host, a registrable-domain suffix or a related origin, never a public suffix.
  if (page.origin !== origin || !https(origin)
    || (bw.isPublicSuffix(rpId) && !(host === 'localhost' && rpId === 'localhost'))) return fallback;
  // Ward: check the vault first, so a page can't make Ward fetch arbitrary hosts' .well-known/webauthn for nothing
  const version = stateVersion;
  if (!(await mayAnswer(kind, rpId))) return fallback;
  if (!(host === rpId || host.endsWith(`.${rpId}`)) && !(await relatedOrigins(rpId, origin))) return fallback;
  if (version !== stateVersion) return fallback;
  const key = crypto.randomUUID();
  // One window per tab; the lock makes check-and-set atomic against a page firing many requests at once. The window
  // closes itself at `expires` (page.js uses the same clamp plus slack), so a stale record frees the tab.
  const busy = await withStateLock(async () => {
    if (Object.entries(await session.get(null)).some(([k, r]) => k.startsWith('pk:') && r?.tabId === tab.id && r.expires > Date.now())) return true;
    await session.set({ [`pk:${key}`]: { id: bwliteReq, kind, options: o, origin, rpId, tabId: tab.id, documentId,
      expires: Date.now() + Math.min(Math.max(Number(o.timeout) || 300e3, 60e3), 600e3) } });
  });
  if (busy) return { bwliteRes: bwliteReq, error: { name: 'NotAllowedError', message: 'A passkey request is already pending' } };
  if (version !== stateVersion) return session.remove(`pk:${key}`).then(() => fallback);
  try {
    await chrome.windows.create({ url: `popup.html#pk=${key}`, type: 'popup', width: 410, height: 320 });
  } catch (e) {
    await session.remove(`pk:${key}`);
    throw e;
  }
  return null;
}

// e.g. www.facebook.com signing in with rpId accounts.meta.com, allowed by https://accounts.meta.com/.well-known/webauthn
async function relatedOrigins(rpId, origin) {
  if (/^[\d.]+$|[:[\]]/.test(rpId) || bw.isLocalHost(rpId)) return false; // Ward: public domains only, never IPs or LAN names
  try {
    const r = await fetch(`https://${rpId}/.well-known/webauthn`, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
    return r.ok && bw.relatedOrigin(await r.json(), origin);
  } catch { return false; }
}

// No vaults: leave passkeys to the browser. Sign-in: skip the window when every vault is open and none has a
// passkey for the site (e.g. it wants a security key).
async function mayAnswer(kind, rpId) {
  const v = await vault();
  if (kind === 'create' || !v.accounts.length) return v.accounts.length > 0;
  return v.open < v.accounts.length || v.items.some((i) => i.passkeys?.some((p) => typeof p.rpId === 'string' && p.rpId.toLowerCase() === rpId));
}
