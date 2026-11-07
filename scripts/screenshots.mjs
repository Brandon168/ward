#!/usr/bin/env node
// Builds the README screenshots in docs/screenshots/ from the generated previews (the real popup and in-page code with
// the sample data in scripts/preview-shim.js; no real vault). Needs a local Chromium (CHROMIUM=..., default
// /usr/bin/chromium).   Usage: node scripts/screenshots.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'docs', 'screenshots');
execFileSync(process.execPath, [join(root, 'scripts', 'preview.mjs')], { stdio: 'ignore' });
mkdirSync(out, { recursive: true });
const url = (f) => pathToFileURL(join(root, 'preview', f)).href;
// The previews frame the window with a margin and shadow; the screenshots show the window alone.
const BARE = `body { margin: 0 !important; box-shadow: none !important; border-radius: 0 !important; }`;

const b = await launch({ width: 1000, height: 900 });
async function page(file, { dark = false, width = 420, height = 700 } = {}) {
  const p = await b.newPage(null, { before: async (s) => {
    await s.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
    await s.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  } });
  await p.goto(url(file));
  await sleep(800);
  return p;
}
async function bodyShot(p, name) {
  await p.eval(`document.head.append(Object.assign(document.createElement('style'), { textContent: ${JSON.stringify(BARE)} }))`);
  await sleep(200);
  const r = await p.eval(`(() => { const b = document.body.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: Math.min(b.height, innerHeight) }; })()`);
  writeFileSync(join(out, name), await p.screenshot(r));
  console.log(`docs/screenshots/${name}`);
}

try {
  for (const dark of [false, true]) {
    const p = await page('ward-popup.html', { dark });
    await p.waitFor(`document.querySelectorAll('.item').length > 3`);
    await bodyShot(p, `popup-${dark ? 'dark' : 'light'}.png`);
    if (!dark) {
      await p.clickSel('button[title="Settings"]');
      await sleep(400);
      await bodyShot(p, 'settings.png');
    }
    await p.close();
  }
  for (const [file, name] of [['ward-save.html', 'save-login.png'], ['ward-passkey.html', 'passkey.png']]) {
    const p = await page(file);
    await bodyShot(p, name);
    await p.close();
  }
  // In-page: click the username field (a real, trusted click), wait for the menu, capture the form and the menu.
  const p = await page('ward-inpage.html', { width: 640, height: 520 });
  await p.clickSel('input[name=username]');
  await sleep(900);
  writeFileSync(join(out, 'inpage-menu.png'), await p.screenshot({ x: 118, y: 0, width: 505, height: 372 })); // save bar, field, menu
  console.log('docs/screenshots/inpage-menu.png');
  await p.close();
} finally {
  await b.close();
}
