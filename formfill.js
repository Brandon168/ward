// Fills checkout and address forms with a card or an identity (Ward). Injected on demand, only into the frames
// autofill.js chose, when you press Fill on a card or identity in the popup; it is not loaded on every page.
// Fields are recognised by their autocomplete token first (the standard), then by name/id/placeholder/label text.
(() => {
  if (globalThis.wardFillForm) return;

  const AC = new Set(['cc-name', 'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc', 'cc-type', 'honorific-prefix',
    'given-name', 'additional-name', 'family-name', 'name', 'organization', 'street-address', 'address-line1', 'address-line2',
    'address-line3', 'address-level2', 'address-level1', 'postal-code', 'country', 'country-name', 'email', 'tel', 'tel-national']);
  // Order matters: the first rule that matches wins (expiry month/year before plain expiry, middle name before name).
  const CARD_RULES = [
    ['cc-csc', /\b(cvc2?|cvv2?|cvn|csc|cid)\b|security.?code|card.?code|verification.?(code|number|value)|card.?verification/],
    ['cc-exp', /\bmm\s*[\/-]?\s*yy|month\s*\/\s*year/], // one field for both, e.g. placeholder "MM / YY"
    ['cc-exp-month', /(exp|expir|valid|card).{0,12}(month|\bmm\b)|\b(cc|card)[-_ ]?month\b|^mm$|^month$/],
    ['cc-exp-year', /(exp|expir|valid|card).{0,12}(year|\byy(yy)?\b)|\b(cc|card)[-_ ]?year\b|^yy(yy)?$|^year$/],
    ['cc-exp', /expir|\bexp\b|exp[-_ ]?date|valid.?(thru|until)|mm\s*\/\s*yy/],
    ['cc-name', /name.?on.?card|card.?holder|holder.?name|cc[-_ ]?name|nameoncard|card[-_ ]?name/],
    ['cc-number', /card.?(number|no\b|num)|cc[-_ ]?(number|num|no)\b|cardnumber|ccnumber|credit.?card|debit.?card|\bpan\b|acct.?num/],
    ['cc-type', /card.?(type|brand)|cc[-_ ]?type/],
  ];
  const IDENTITY_RULES = [
    ['email', /e-?mail/],
    ['tel', /phone|mobile|\btel\b|telephone|cell/],
    ['honorific-prefix', /\b(title|salutation|honorific|prefix)\b/],
    ['additional-name', /middle.?(name|initial)|\bmname\b/],
    ['given-name', /first.?name|\bfname\b|given.?name|forename/],
    ['family-name', /last.?name|\blname\b|surname|family.?name/],
    ['organization', /company|organi[sz]ation|business.?name|employer/],
    ['address-line2', /address.?(line)?.?2|\baddr2\b|apartment|\bapt\b|suite|\bunit\b|building|flat\b/],
    ['address-line3', /address.?(line)?.?3|\baddr3\b/],
    ['address-line1', /address.?(line)?.?1|\baddr1\b|street|^address$|billing.?address$|shipping.?address$|\baddress\b/],
    ['postal-code', /zip|postal|post.?code|postcode/],
    ['address-level2', /\bcity\b|town|locality|suburb/],
    ['country', /country|nation/],
    ['address-level1', /\bstate\b|province|region|county|prefecture/],
    ['name', /full.?name|your.?name|^name$|\bname\b/],
  ];

  // hints: { ac, type, text } -> a field kind, or null. Exported for tests.
  function classify({ ac = '', type = '', text = '' }, want) {
    const token = ac.toLowerCase().split(/\s+/).filter((t) => !/^(section-|shipping$|billing$|home$|work$|mobile$)/.test(t)).at(-1);
    if (token && AC.has(token)) return ok(token, want);
    if (/^(off|on|new-password|current-password|username|one-time-code)$/.test(token || '')) return null;
    const t = text.toLowerCase();
    if (type === 'email') return ok('email', want);
    if (type === 'tel' && !/card|cc|cvc|cvv|zip|postal/.test(t)) return ok('tel', want);
    for (const [kind, re] of want === 'card' ? CARD_RULES : IDENTITY_RULES) if (re.test(t)) return kind;
    return null;
  }
  const ok = (kind, want) => ((want === 'card') === kind.startsWith('cc-') ? kind : null);
  globalThis.wardClassify = classify;
  globalThis.wardValueFor = (kind, d, el = {}) => valueFor(kind, d, { getAttribute: () => '', ...el });

  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  // What to put in a field of this kind; an array is a list of acceptable spellings (for <select>).
  function valueFor(kind, d, el) {
    const ph = `${el.placeholder || ''} ${el.getAttribute?.('aria-label') || ''}`.toLowerCase();
    const max = el.maxLength > 0 ? el.maxLength : 99;
    const m = parseInt(d.expMonth, 10), y = String(d.expYear || '');
    const y4 = y.length === 2 ? `20${y}` : y, y2 = y4.slice(-2);
    const mm = m ? String(m).padStart(2, '0') : '';
    switch (kind) {
      case 'cc-name': return d.cardholderName;
      case 'cc-number': return (d.number || '').replace(/\s+/g, '');
      case 'cc-csc': return d.code;
      case 'cc-type': return [d.brand, d.brand === 'Amex' ? 'American Express' : d.brand];
      case 'cc-exp-month': return mm && [mm, String(m), MONTHS[m - 1], MONTHS[m - 1]?.slice(0, 3), `${mm} - ${MONTHS[m - 1]}`];
      case 'cc-exp-year': return y4 && (max === 2 || (/\byy\b/.test(ph) && !/yyyy/.test(ph)) ? [y2, y4] : [y4, y2]);
      case 'cc-exp': return mm && y4 && (/yyyy/.test(ph) || max === 7 ? `${mm}/${y4}` : max === 4 ? `${mm}${y2}` : `${mm}/${y2}`);
      case 'honorific-prefix': return d.title;
      case 'given-name': return d.firstName;
      case 'additional-name': return d.middleName;
      case 'family-name': return d.lastName;
      case 'name': return [d.firstName, d.middleName, d.lastName].filter(Boolean).join(' ');
      case 'organization': return d.company;
      case 'address-line1': return d.address1;
      case 'address-line2': return d.address2;
      case 'address-line3': return d.address3;
      case 'street-address': return [d.address1, d.address2, d.address3].filter(Boolean).join(el.tagName === 'TEXTAREA' ? '\n' : ', ');
      case 'address-level2': return d.city;
      case 'address-level1': return d.state;
      case 'postal-code': return d.postalCode;
      case 'country': case 'country-name': return d.country;
      case 'email': return d.email;
      case 'tel': case 'tel-national': return d.phone;
      default: return null;
    }
  }

  const labelText = (el) => [...(el.labels || [])].map((l) => l.textContent).join(' ')
    || el.closest?.('label')?.textContent || document.getElementById(el.getAttribute('aria-labelledby') || '')?.textContent || '';
  const hints = (el) => ({
    ac: el.getAttribute('autocomplete') || '', type: (el.type || '').toLowerCase(),
    text: [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.getAttribute('data-testid'), labelText(el)]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
  });
  const usable = (el) => {
    if (el.disabled || el.readOnly || el.type === 'hidden') return false;
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const SKIP = /^(submit|button|reset|checkbox|radio|file|image|range|color|search)$/;

  function setValue(el, v) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    el.focus();
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }
  function setSelect(el, wanted) {
    const want = (Array.isArray(wanted) ? wanted : [wanted]).filter(Boolean).map((w) => String(w).toLowerCase().trim());
    const opts = [...el.options];
    const norm = (s) => String(s || '').toLowerCase().trim();
    const hit = opts.find((o) => want.includes(norm(o.value)) || want.includes(norm(o.textContent)))
      || opts.find((o) => want.some((w) => w.length > 2 && norm(o.textContent).startsWith(w)));
    if (!hit) return false;
    el.value = hit.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  // want: 'card' | 'identity'; d: the card or identity fields. Returns how many fields were filled.
  globalThis.wardFillForm = (want, d) => {
    if (!d || (want !== 'card' && want !== 'identity')) return 0;
    const root = document.activeElement?.closest?.('form') || document;
    let n = 0;
    for (const el of root.querySelectorAll('input, select, textarea')) {
      if (!usable(el) || SKIP.test(el.type || '')) continue;
      const kind = classify(hints(el), want);
      if (!kind || (el.type === 'password' && kind !== 'cc-csc')) continue; // never touch a login password
      const v = valueFor(kind, d, el);
      if (v == null || v === '' || (Array.isArray(v) && !v.some(Boolean))) continue;
      if (el.tagName === 'SELECT' ? setSelect(el, v) : (setValue(el, Array.isArray(v) ? v.find(Boolean) : v), true)) n++;
    }
    return n;
  };
})();
