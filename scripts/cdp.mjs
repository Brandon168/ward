// Minimal Chrome DevTools Protocol client for scripts/bench.mjs and scripts/screenshots.mjs. No dependencies: it
// launches a local Chromium with a throwaway profile and talks to it over Node's built-in WebSocket.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep };

// Every Chromium this process starts dies with it, also when it is stopped (Ctrl-C, or timeout's SIGTERM): otherwise
// a killed script leaves a browser running in the background, which skews every later measurement.
const browsers = new Set();
const killAll = () => { for (const p of browsers) if (p.exitCode === null) try { p.kill('SIGKILL'); } catch {} };
process.once('exit', killAll);
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) process.once(sig, () => { killAll(); process.exit(code); });

export async function launch({ chromium = process.env.CHROMIUM || '/usr/bin/chromium', extensions = [], args = [], width = 1280, height = 800 } = {}) {
  const CHROME_MAJOR = (execFileSync(chromium, ['--version'], { encoding: 'utf8' }).match(/(\d+)\./) || [, '150'])[1];
  const base = existsSync(join(homedir(), '.cache')) ? join(homedir(), '.cache') : tmpdir();
  const profile = mkdtempSync(join(base, 'ward-cdp-'));
  const flags = [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--password-store=basic',
    '--disable-features=DisableLoadExtensionCommandLineSwitch', `--window-size=${width},${height}`,
    // Headless Chromium says "HeadlessChrome", which Bitwarden takes for Safari; use the normal Chrome string.
    `--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
    ...(extensions.length ? [`--load-extension=${extensions.join(',')}`, `--disable-extensions-except=${extensions.join(',')}`] : []),
    ...args, 'about:blank',
  ];
  const proc = spawn(chromium, flags, { stdio: ['ignore', 'ignore', 'pipe'] });
  browsers.add(proc);
  proc.once('exit', () => browsers.delete(proc));
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; !existsSync(portFile) || readFileSync(portFile, 'utf8').split('\n').length < 2; i++) {
    if (i > 200 || proc.exitCode !== null) throw new Error(`Chromium did not start: ${stderr}`);
    await sleep(50);
  }
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  const browser = await Browser.connect(`ws://127.0.0.1:${port}${path}`);
  browser.proc = proc;
  browser.close = async () => {
    try { await browser.send('Browser.close'); } catch {}
    for (let i = 0; proc.exitCode === null && i < 100; i++) await sleep(50);
    if (proc.exitCode === null) proc.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true });
  };
  return browser;
}

class Browser {
  static async connect(url) {
    const b = new Browser();
    b.ws = new WebSocket(url);
    b.id = 0; b.pending = new Map(); b.listeners = new Set();
    b.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && b.pending.has(m.id)) {
        const { resolve, reject } = b.pending.get(m.id); b.pending.delete(m.id);
        m.error ? reject(new Error(`${m.error.message} ${m.error.data || ''}`.trim())) : resolve(m.result);
      } else for (const l of b.listeners) l(m);
    };
    await new Promise((resolve, reject) => { b.ws.onopen = resolve; b.ws.onerror = () => reject(new Error('CDP connect failed')); });
    return b;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, 30000);
      this.pending.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(Object.assign(e, { message: `${method}: ${e.message}` }))) });
    });
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  async targets() { return (await this.send('Target.getTargets')).targetInfos; }
  async waitTarget(pred, ms = 15000) {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
      const t = (await this.targets()).find(pred);
      if (t) return t;
    }
    throw new Error('target not found');
  }
  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return new Session(this, sessionId, targetId);
  }
  // A new tab, attached, optionally prepared (scripts to run before the page's own) before it navigates.
  async newPage(url, { before } = {}) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const s = await this.attach(targetId);
    await s.send('Page.enable');
    await s.send('Runtime.enable');
    if (before) await before(s);
    await s.send('Page.bringToFront');
    if (url) await s.goto(url);
    return s;
  }
}

class Session {
  constructor(browser, sessionId, targetId) { Object.assign(this, { browser, sessionId, targetId }); }
  send(method, params) { return this.browser.send(method, params, this.sessionId); }
  on(event, fn) { return this.browser.on((m) => m.sessionId === this.sessionId && m.method === event && fn(m.params)); }
  async goto(url, { wait = 'load', timeout = 30000 } = {}) {
    const done = new Promise((resolve) => {
      const off = this.on(wait === 'load' ? 'Page.loadEventFired' : 'Page.domContentEventFired', () => { off(); resolve(); });
      setTimeout(() => { off(); resolve(); }, timeout);
    });
    await this.send('Page.navigate', { url });
    await done;
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async waitFor(expr, ms = 20000) {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
      const v = await this.eval(expr).catch(() => null);
      if (v) return v;
    }
    throw new Error(`timed out waiting for ${expr}`);
  }
  async screenshot(clip) {
    await this.send('Page.bringToFront'); // a background tab produces no frames, so the capture would wait forever
    return Buffer.from((await this.send('Page.captureScreenshot', { format: 'png', ...(clip && { clip: { ...clip, scale: 1 } }) })).data, 'base64');
  }
  // Trusted input: real mouse events and typed keys, as a user would produce them.
  async click(x, y) {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
      await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
  async clickSel(sel) {
    const r = await this.waitFor(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
      e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return b.width ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null; })()`);
    await this.click(r.x, r.y);
  }
  async type(text) { await this.send('Input.insertText', { text }); }
  async key(key, code = key, keyCode) {
    for (const type of ['keyDown', 'keyUp']) await this.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode });
  }
  close() { return this.browser.send('Target.closeTarget', { targetId: this.targetId }); }
}
