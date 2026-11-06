// One shared transaction boundary for every popup/background context.
// Web Locks are shared by extension contexts (Chrome 111 is the minimum
// supported version). The queue is only a fallback for one-context test runs.
const LOCK = 'bwlite:state';
let fallback = Promise.resolve();

export function withStateLock(fn) {
  if (globalThis.navigator?.locks?.request) {
    return navigator.locks.request(LOCK, { mode: 'exclusive' }, fn);
  }
  const job = fallback.catch(() => {}).then(fn);
  fallback = job.catch(() => {});
  return job;
}

// Storage has no compare-and-swap operation. Keeping the read, mutation and
// write in the same Web Lock makes patches from two popup windows commute
// instead of letting a stale full account snapshot overwrite the other one.
export function mutateAccounts(local, mutate) {
  return withStateLock(async () => {
    const stored = await local.get('accounts');
    const current = Array.isArray(stored.accounts) ? structuredClone(stored.accounts) : [];
    const next = await mutate(current);
    if (!Array.isArray(next)) throw new Error('Account update must return an array');
    await local.set({ accounts: next });
    return next;
  });
}

// --- auto-lock (Ward) -------------------------------------------------------
// autoLock setting in local storage: minutes of system idle before locking (0 = only when the browser quits).
// Every setting except 0 also locks when the computer's screen locks or it sleeps. "Never lock" overrides it.
export const AUTO_LOCK_CHOICES = [5, 15, 30, 60, 240, 0];
export const AUTO_LOCK_DEFAULT = 30;
export const autoLockMinutes = (v) => (AUTO_LOCK_CHOICES.includes(v) ? v : AUTO_LOCK_DEFAULT);

// Decides whether an idle-state change locks: 'locked' (screen lock / sleep) and 'idle' (the detection interval,
// set to the chosen minutes, passed with no input) lock unless Never lock is on or the choice is 0.
export const shouldAutoLock = (state, { neverLock, autoLock } = {}) =>
  !neverLock && autoLockMinutes(autoLock) > 0 && (state === 'locked' || state === 'idle');

// Locks every vault: drops persisted keys first (so nothing can reopen one in between), then all session data,
// which also discards pending save offers and passkey hand-offs. Same order as the popup's lockAll.
export function lockEverything(local, session) {
  return withStateLock(async () => {
    const { accounts } = await local.get('accounts');
    if (Array.isArray(accounts) && accounts.some((a) => a && a.persistKey))
      await local.set({ accounts: accounts.map((a) => { if (!a || typeof a !== 'object') return a; const c = { ...a }; delete c.persistKey; return c; }) });
    await session.clear();
  });
}
