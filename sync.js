// Background sync and live updates (Ward). The service worker keeps open vaults fresh without the popup:
//   - every 5 minutes (chrome.alarms) it syncs vaults whose last sync is older than that
//   - while a vault is unlocked it holds Vaultwarden's notification WebSocket and syncs ~1.5 s after a change
//     made anywhere else (phone, web vault, another browser)
// Decryption reuses unchanged items, exactly like the popup's sync. Nothing here runs while every vault is locked.
import * as bw from './bw.js';
import { withStateLock } from './coord.js';

export const SYNC_EVERY_MIN = 5;
export const strip = ({ raw, key, notes, fields, ...listFields }) => (notes ? { ...listFields, note: true } : listFields);

// The account's on-disk sync data (raw encrypted ciphers, profile keys, equivalent domains). Shared with popup.js.
export async function storeSync(local, accountId, sync) {
  const p = `${accountId}:`;
  const ids = sync.ciphers.map((c) => c.id), keep = new Set(ids);
  const stored = await local.get(`${p}ids`);
  const old = Array.isArray(stored[`${p}ids`]) ? stored[`${p}ids`] : [];
  // raw ciphers stored one key per item so editing reads just the one it needs
  await local.remove(old.filter((id) => !keep.has(id)).map((id) => `${p}c:${id}`));
  const d = sync.domains || {};
  const raw = [...(d.equivalentDomains || []), ...(d.globalEquivalentDomains || []).filter((g) => !g.excluded).map((g) => g.domains)];
  // stored as base domains, worked out once here instead of on every popup open (bw.equivalents)
  const eq = { v: bw.DOMAINS_VERSION, groups: raw.filter(Array.isArray).map((g) => g.map((x) => bw.domainOf(x)).filter(Boolean)) };
  // only what decrypting needs; the rest of the profile (hint, names, security stamp) stays off disk
  const profile = { privateKey: sync.profile.privateKey, organizations: (sync.profile.organizations || []).map(({ id, key }) => ({ id, key })) };
  await local.set({ [`${p}profile`]: profile, [`${p}ids`]: ids, [`${p}eq`]: eq, ...Object.fromEntries(sync.ciphers.map((c) => [`${p}c:${c.id}`, c])) });
}

// One refresh at a time per account, from the latest stored tokens, so two contexts never spend the same
// refresh token. Returns tokens valid for at least a minute.
export async function freshTokens(local, accountId) {
  const run = async () => {
    const a = ((await local.get('accounts')).accounts || []).find((x) => x?.id === accountId);
    if (!a?.tokens) throw new Error('vault removed');
    if (Date.now() < a.tokens.expires - 5 * 60e3) return a.tokens; // wide margin, so bw.api never refreshes on its own
    const tokens = await bw.refresh(a.server, a.tokens.refresh);
    await withStateLock(async () => {
      const list = (await local.get('accounts')).accounts || [];
      await local.set({ accounts: list.map((x) => (x?.id === accountId ? { ...x, tokens } : x)) });
    });
    return tokens;
  };
  return globalThis.navigator?.locks?.request ? navigator.locks.request(`ward:tokens:${accountId}`, run) : run();
}

// Syncs one open vault from the service worker. force: ignore the 5-minute throttle (a live notification).
export async function syncOpenVault(local, session, accountId, { force = false } = {}) {
  const a = ((await local.get('accounts')).accounts || []).find((x) => x?.id === accountId);
  const before = await session.get([`${accountId}:key`, `${accountId}:list`, `${accountId}:checked`]);
  const k = before[`${accountId}:key`];
  if (!a || !k) return false;
  const last = Math.max(a.lastSync || 0, before[`${accountId}:checked`] || 0);
  if (!force && Date.now() - last < (SYNC_EVERY_MIN - 1) * 60e3) return false;
  const tokens = await freshTokens(local, accountId);
  const sync = await bw.api({ server: a.server, tokens }, '/sync'); // outside the state lock, like the popup
  return withStateLock(async () => {
    const cur = await session.get([`${accountId}:key`, `${accountId}:list`]);
    if (cur[`${accountId}:key`] !== k) return false; // locked or re-keyed while downloading
    // Someone else (the popup's sync or an edit) stored a list while this download ran: theirs may be newer.
    if (cur[`${accountId}:list`] !== before[`${accountId}:list`]) return false;
    const key = bw.unb64(k);
    let prev = [];
    try { prev = JSON.parse(cur[`${accountId}:list`] || '[]'); } catch {}
    const items = (await bw.decryptVault(sync, key, new Map((Array.isArray(prev) ? prev : []).map((i) => [i.id, i]))))
      .map((i) => ({ ...strip(i), a: accountId }));
    const list = JSON.stringify(items);
    // Nothing changed: note the check in session storage only, so the worker's vault cache and every tab's badge
    // aren't rebuilt for nothing.
    if (list === cur[`${accountId}:list`]) { await session.set({ [`${accountId}:checked`]: Date.now() }); return false; }
    await storeSync(local, accountId, sync);
    await session.set({ [`${accountId}:list`]: list });
    await local.set({ [`${accountId}:index4`]: await bw.encrypt(list, key) });
    const latest = (await local.get('accounts')).accounts || [];
    await local.set({ accounts: latest.map((x) => (x?.id === accountId ? { ...x, lastSync: Date.now() } : x)) });
    return true;
  });
}

// --- live updates: Vaultwarden's SignalR hub (MessagePack protocol) --------------------------------------------
// Frames are varint-length-prefixed MessagePack arrays; element 0 is the message type: 1 invocation (a change),
// 6 ping, 7 close. Only invocations matter, so no full MessagePack decoder is needed.
export function hasInvocation(buf) {
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length;) {
    let len = 0, byte, n = 0;
    do {
      if (i >= b.length || n === 5) return false; // truncated or over-long varint
      byte = b[i++];
      len += (byte & 0x7f) * 2 ** (7 * n++); // arithmetic, not bit shifts: no sign wrap at 2^31
    } while (byte & 0x80);
    if (len < 1 || len > b.length - i) return false; // every frame must fit in what was received
    if (len >= 2 && (b[i] & 0xf0) === 0x90 && b[i + 1] === 1) return true;
    i += len;
  }
  return false;
}
export const SIGNALR_PING = new Uint8Array([0x02, 0x91, 0x06]);
export const SIGNALR_HANDSHAKE = '{"protocol":"messagepack","version":1}\x1e';

// Keeps one notification socket per open vault. onChange(accountId) is called (debounced) after a change.
// The 20 s SignalR ping is echoed by Vaultwarden, which also keeps the MV3 service worker alive while unlocked.
export function liveHub({ open, onChange, log = () => {} }) {
  const conns = new Map(), failures = new Map();
  let retry, chain = Promise.resolve();
  // Failed connects back off 1, 2, 4 ... 30 min; an expired session stops until the vault is unlocked again.
  const later = (id, e) => {
    conns.delete(id);
    if (/Session expired/.test(e?.message || '')) return failures.set(id, Infinity);
    const n = (failures.get(id) || 0) + 1;
    failures.set(id, n);
    clearTimeout(retry);
    retry = setTimeout(refresh, Math.min(30, 2 ** (n - 1)) * 60e3);
  };
  function connect(a) {
    let ws, ping, debounce, closed = false;
    const c = { close: () => { closed = true; clearInterval(ping); clearTimeout(debounce); try { ws?.close(); } catch {} } };
    (async () => {
      const tokens = await open.tokens(a.id);
      if (closed) return; // locked while the token was being fetched
      ws = new WebSocket(`${bw.urls(a.server).notifications}/hub?access_token=${encodeURIComponent(tokens.access)}`);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        ws.send(SIGNALR_HANDSHAKE);
        failures.delete(a.id);
        ping = setInterval(() => ws.readyState === 1 && ws.send(SIGNALR_PING), 20e3);
        log(`live: connected ${a.id}`);
      };
      ws.onmessage = (e) => {
        if (typeof e.data === 'string' || !hasInvocation(e.data)) return;
        clearTimeout(debounce);
        debounce = setTimeout(() => onChange(a.id), 1500);
      };
      ws.onclose = () => {
        clearInterval(ping);
        if (!closed) later(a.id);
      };
    })().catch((e) => { log(`live: ${a.id} ${e?.message}`); if (!closed) later(a.id, e); });
    return c;
  }
  // Serialized, so an older snapshot of which vaults are open never wins over a newer one.
  function refresh() {
    chain = chain.catch(() => {}).then(async () => {
      const want = new Map((await open.accounts()).map((a) => [a.id, a]));
      for (const [id, c] of conns) if (!want.has(id)) { c.close(); conns.delete(id); }
      for (const id of failures.keys()) if (!want.has(id)) failures.delete(id); // locked: a later unlock starts fresh
      for (const [id, a] of want) if (!conns.has(id) && failures.get(id) !== Infinity) conns.set(id, connect(a));
    });
    return chain;
  }
  return { refresh, size: () => conns.size };
}
