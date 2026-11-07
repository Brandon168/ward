// Ward: password, passphrase and username generator. Pure functions over crypto.getRandomValues; the popup keeps the
// options (chrome.storage.local `generator`) and shows the result. Every pick is uniform (rejection sampling, no
// modulo bias), and a password holds at least one character of each set the user turned on.
import { EFF_LARGE_WORDLIST } from './vendor/eff_large_wordlist.js';

export const WORDS = EFF_LARGE_WORDLIST.trim().split('\n');
const SETS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  symbols: '!@#$%^&*-_',
};
const AMBIGUOUS = /[IlO01o]/g; // look alike in many fonts
export const DEFAULTS = {
  type: 'password', // password | passphrase | username
  length: 20, upper: true, lower: true, digits: true, symbols: true, avoidAmbiguous: true,
  words: 5, separator: '-', capitalize: false, number: false,
  userType: 'word', // word | plus | catchall
  userNumber: false, email: '', domain: '',
};
export const LIMITS = { length: [8, 128], words: [3, 20] };

// A uniform integer in [0, n).
export function randomInt(n) {
  if (!Number.isInteger(n) || n < 1 || n > 2 ** 32) throw new Error('bad range');
  const limit = 2 ** 32 - (2 ** 32 % n); // values at or above this would favour the low numbers
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}
const pick = (list) => list[randomInt(list.length)];
const clamp = (v, [lo, hi], dflt) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : dflt);
const cap = (w) => w[0].toUpperCase() + w.slice(1);

// Options as stored may be stale or hand-edited: fill gaps and clamp numbers.
export function normalize(o = {}) {
  const n = { ...DEFAULTS, ...(o && typeof o === 'object' ? o : {}) };
  n.length = clamp(n.length, LIMITS.length, DEFAULTS.length);
  n.words = clamp(n.words, LIMITS.words, DEFAULTS.words);
  for (const k of ['upper', 'lower', 'digits', 'symbols', 'avoidAmbiguous', 'capitalize', 'number', 'userNumber']) n[k] = !!n[k];
  if (!['upper', 'lower', 'digits', 'symbols'].some((k) => n[k])) n.lower = true; // at least one set
  if (!['password', 'passphrase', 'username'].includes(n.type)) n.type = DEFAULTS.type;
  if (!['word', 'plus', 'catchall'].includes(n.userType)) n.userType = DEFAULTS.userType;
  n.separator = typeof n.separator === 'string' ? n.separator.slice(0, 3) : DEFAULTS.separator;
  n.email = typeof n.email === 'string' ? n.email.trim() : '';
  n.domain = typeof n.domain === 'string' ? n.domain.trim().replace(/^@/, '') : '';
  return n;
}

function sets(o) {
  return Object.entries(SETS).filter(([k]) => o[k]).map(([, s]) => (o.avoidAmbiguous ? s.replace(AMBIGUOUS, '') : s));
}

export function password(opts) {
  const o = normalize(opts);
  const chosen = sets(o), all = chosen.join('');
  // one from each chosen set first, the rest from all of them, then shuffle so the guaranteed ones aren't up front
  const out = chosen.map(pick);
  while (out.length < o.length) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}

export function passphrase(opts) {
  const o = normalize(opts);
  const words = Array.from({ length: o.words }, () => pick(WORDS)).map((w) => (o.capitalize ? cap(w) : w));
  if (o.number) {
    const i = randomInt(words.length);
    words[i] += randomInt(10);
  }
  return words.join(o.separator);
}

// word: a random word (and 4 digits); plus: you+word@example.com; catchall: word@your-domain. email/domain empty: the
// caller (the popup) passes the vault's account email as the default.
export function username(opts) {
  const o = normalize(opts);
  const digits = () => String(randomInt(10000)).padStart(4, '0');
  const word = pick(WORDS) + (o.userNumber || o.userType !== 'word' ? digits() : '');
  if (o.userType === 'plus') {
    const at = o.email.lastIndexOf('@');
    if (at < 1) throw new Error('Enter the email address to add +tags to');
    return `${o.email.slice(0, at).split('+')[0]}+${word}${o.email.slice(at)}`;
  }
  if (o.userType === 'catchall') {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(o.domain)) throw new Error('Enter your catch-all domain, e.g. example.com');
    return `${word}@${o.domain}`;
  }
  return o.capitalize ? cap(word) : word;
}

export function generate(opts) {
  const o = normalize(opts);
  return o.type === 'passphrase' ? passphrase(o) : o.type === 'username' ? username(o) : password(o);
}

// About how many bits of randomness a password or passphrase with these options carries (shown as a hint).
export function bits(opts) {
  const o = normalize(opts);
  if (o.type === 'passphrase') return Math.floor(o.words * Math.log2(WORDS.length) + (o.number ? Math.log2(10 * o.words) : 0));
  if (o.type === 'username') return 0;
  return Math.floor(o.length * Math.log2(sets(o).join('').length));
}
