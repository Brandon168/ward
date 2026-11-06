// Content script in every frame: fills logins, shows the login menu under login fields, notices submitted logins and
// shows the "save this login?" bar (popup.html in a frame). fillTab (autofill.js) also injects it into tabs opened
// before the extension was loaded, hence the guard.
if (!globalThis.bwliteFill) {
  // off-screen, invisible or untabbable fields are honeypots, not the username. Not opacity: sites animate it.
  const visible = (i) => {
    if (i.disabled || i.readOnly || i.tabIndex === -1) return false;
    const r = i.getBoundingClientRect();
    return r.width > 0 && r.right + scrollX > 0 && r.bottom + scrollY > 0 && getComputedStyle(i).visibility !== 'hidden'; // page, not viewport: scrolled-off fields are real
  };
  // Only the focused field's form, so a search box elsewhere on the page is never taken for the username.
  // loose: with no password field, fall back to the only text field (the username step of a two-step login).
  // ponytail: fields inside shadow DOM aren't seen.
  const loginFields = (loose) => {
    const root = document.activeElement?.closest('form') || document;
    const all = [...root.querySelectorAll('input')].filter(visible), pw = all.find((i) => i.type === 'password');
    const texts = (pw ? all.slice(0, all.indexOf(pw)) : all).filter((i) => ['text', 'email', 'tel'].includes(i.type));
    const user = pw ? texts.at(-1) : texts.find((i) => i.type === 'email' || /user|email|login/i.test(i.autocomplete + i.name + i.id)) || (loose && texts.length === 1 && texts[0]);
    return { all, user, pw };
  };

  let filling = false; // the fill focuses the fields; that must not reopen the menu under them
  globalThis.bwliteFill = (username, password, code) => {
    const { user, pw } = loginFields(true);
    let filled = false;
    const set = (el, v) => {
      filling = true;
      el.focus();
      filling = false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      filled = true;
    };
    if (user && username) set(user, username);
    if (pw && password) set(pw, password);
    if (code) navigator.clipboard.writeText(code).catch(() => {});
    return filled;
  };

  // --- menu under a login field: logins for this frame's site, from background.js. A closed shadow root keeps the
  // usernames out of the page's reach; only a real click fills.
  let menu, menuFor, menuShownAt = 0, menuVisible = null, menuWatch;
  const closeMenu = () => (menuWatch?.disconnect(), menu?.remove(), (menu = menuFor = menuWatch = null), (menuVisible = null));
  // Ward: the menu opens only right after a real pointer press on the field or a Tab/arrow key press, never on a
  // focus the page made with field.focus(), so a page can't pop it open under a decoy.
  let pressedOn = null, pressedAt = 0, keyedAt = 0;
  document.addEventListener('pointerdown', (e) => e.isTrusted && ((pressedOn = e.target), (pressedAt = performance.now())), true);
  document.addEventListener('keydown', (e) => e.isTrusted && /^(Tab|ArrowUp|ArrowDown)$/.test(e.key) && (keyedAt = performance.now()), true);
  const userFocused = (f) => ((pressedOn === f || pressedOn?.control === f) && performance.now() - pressedAt < 1500) || performance.now() - keyedAt < 800;
  // Ward: is the menu really what the user saw? Chromium's IntersectionObserver v2 reports isVisible = false when
  // anything covers it (even a pointer-events:none overlay) or a filter/opacity/transform hides it. Elsewhere,
  // fall back to computed-style checks on the menu and the root element.
  const styleHides = (cs) => cs.opacity !== '1' || cs.visibility !== 'visible' || cs.filter !== 'none' || cs.clipPath !== 'none'
    || cs.mixBlendMode !== 'normal' || (cs.mask && cs.mask !== 'none') || cs.transform !== 'none';
  const genuine = (e) => {
    if (!e.isTrusted || !menu || performance.now() - menuShownAt < 400) return false; // too soon: a swapped-in menu
    if (menuVisible === false) return false;
    if (menuVisible === null && 'isVisible' in IntersectionObserverEntry.prototype) return false; // not confirmed yet
    const root = getComputedStyle(document.documentElement), own = getComputedStyle(menu);
    return !styleHides(own) && root.opacity === '1' && root.filter === 'none' && document.elementFromPoint(e.clientX, e.clientY) === menu;
  };
  const el = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });
  function showMenu(field, logins) {
    const r = field.getBoundingClientRect();
    menuFor = field;
    menu = document.createElement('bwlite-menu');
    menu.style.cssText = `all: initial; position: fixed; z-index: 2147483647; left: ${r.left}px; top: ${r.bottom + 2}px;`;
    const root = menu.attachShadow({ mode: 'closed' });
    root.append(el('style', `
      div { min-width: ${Math.max(r.width, 220)}px; max-width: 360px; background: #000; color: #fff; border: 1px solid #555;
        font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      @media (prefers-color-scheme: light) { div { background: #fff; color: #000; border-color: #bbb; } }
      button { all: unset; display: block; box-sizing: border-box; width: 100%; padding: 6px 9px; cursor: pointer; }
      button:hover { background: #8884; }
      b, small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      small { opacity: .6; }`));
    const box = root.appendChild(document.createElement('div'));
    for (const l of logins) {
      const b = box.appendChild(document.createElement('button'));
      b.append(el('b', l.username || '(no username)'), el('small', l.name));
      b.addEventListener('click', async (e) => {
        // the page can hide this menu and draw a decoy over or under it: fill only a click on the visible menu
        if (!genuine(e)) return closeMenu();
        closeMenu();
        const c = await chrome.runtime.sendMessage({ bwliteFillKey: l.k }).catch(() => null);
        if (c) bwliteFill(c.username, c.password, c.code);
      });
    }
    root.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the field so the click lands
    document.documentElement.append(menu);
    menuShownAt = performance.now();
    try {
      menuWatch = new IntersectionObserver((entries) => { const en = entries.at(-1); menuVisible = 'isVisible' in en ? en.isVisible : null; },
        { trackVisibility: true, delay: 100 });
      menuWatch.observe(menu);
    } catch { menuWatch = null; }
  }
  async function maybeShow(f) {
    if (filling || f === menuFor) return;
    closeMenu();
    const { user, pw } = loginFields(false);
    if ((f !== user && f !== pw) || f.autocomplete === 'new-password' || !userFocused(f)) return;
    const logins = await chrome.runtime.sendMessage({ bwliteMenu: true }).catch(() => null);
    if (logins?.length && document.activeElement === f && !menu) showMenu(f, logins);
  }
  // click too: a field the page focused before this script ran (autofocus) gets no focusin when clicked
  document.addEventListener('focusin', (e) => maybeShow(e.target), true);
  document.addEventListener('click', (e) => e.isTrusted && e.target === document.activeElement && maybeShow(e.target), true);
  if (document.activeElement instanceof HTMLInputElement) maybeShow(document.activeElement);
  document.addEventListener('focusout', (e) => e.target === menuFor && closeMenu(), true);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu(), true);
  addEventListener('scroll', closeMenu, true);
  addEventListener('resize', closeMenu);

  // --- logins being submitted: background.js offers to save them after the page navigates
  // Ward: only a submit that follows real user input counts, at most one every 2 s, so a page can't script
  // submissions to probe whether a guessed password matches the saved one (no offer appears when it does).
  let capturedAt = -1e9;
  function capture() {
    if (navigator.userActivation && !navigator.userActivation.isActive) return;
    if (performance.now() - capturedAt < 2000) return;
    capturedAt = performance.now();
    const { all, user } = loginFields(true);
    const pws = all.filter((i) => i.type === 'password' && i.value);
    const username = user?.value.trim() || '';
    // no password yet: the username step of a two-step login, remembered for the password step
    if (pws.length || username) chrome.runtime.sendMessage({ bwliteSubmit: { username, password: pws.at(-1)?.value || '' } }).catch(() => {});
  }
  document.addEventListener('submit', capture, true);
  document.addEventListener('keydown', (e) => e.isTrusted && e.key === 'Enter' && e.target instanceof HTMLInputElement && capture(), true);
  document.addEventListener('click', (e) => e.isTrusted && e.target.closest?.('button, input[type=submit], [role=button]') && capture(), true);

  // --- the save bar, top frame only
  let bar;
  const removeBar = () => { bar?.remove(); bar = null; };
  const button = (root, text, onclick) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.addEventListener('click', onclick);
    root.append(b);
    return b;
  };
  const showSave = (key) => {
    removeBar();
    bar = document.createElement('bwlite-save');
    bar.style.cssText = 'all: initial; position: fixed; top: 12px; right: 12px; z-index: 2147483647;';
    const root = bar.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      div { box-sizing: border-box; width: 382px; padding: 12px; background: #000; color: #fff;
        border: 1px solid #555; font: 13px/1.4 system-ui, sans-serif; }
      p { margin: 0 0 10px; } button { margin-right: 8px; padding: 5px 10px; cursor: pointer; }
      @media (prefers-color-scheme: light) { div { background: #fff; color: #000; border-color: #bbb; } }`;
    root.append(style);
    const box = document.createElement('div');
    const message = document.createElement('p');
    message.textContent = 'Ward found a login to save.';
    box.append(message);
    const review = button(box, 'Review save', async (e) => {
      if (!e.isTrusted) return;
      review.disabled = true;
      const result = await chrome.runtime.sendMessage({ bwliteSaveOpen: key }).catch(() => null);
      if (result?.opened) removeBar();
      else review.disabled = false;
    });
    button(box, '×', (e) => e.isTrusted && removeBar()).title = 'Dismiss';
    root.append(box);
    document.documentElement.append(bar);
  };
  chrome.runtime.onMessage.addListener((m) => {
    if (typeof m?.bwliteBar !== 'string' || !/^[0-9a-f-]{20,100}$/.test(m.bwliteBar) || window !== top) return;
    showSave(m.bwliteBar);
  });
}
