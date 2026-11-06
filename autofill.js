// Filling a tab, shared by the popup and background.js (shortcut). The work in the page is inpage.js's bwliteFill.
import { matches, baseDomain } from './bw.js';

// Fills every frame of the tab whose own URL matches the login, so a login form in an iframe is reached but a frame
// from another site never gets the password. code: TOTP to put on the clipboard from the page.
export async function fillTab(tabId, item, equiv, code = null, guard = async () => true) {
  const all = { tabId, allFrames: true };
  if (!await guard()) return false;
  await chrome.scripting.executeScript({ target: all, files: ['inpage.js'] });
  if (!await guard()) return false;
  const frames = (await chrome.scripting.executeScript({ target: all, func: () => location.href }))
    .filter((r) => /^https?:/.test(r.result) && matches(item, r.result, equiv));
  const res = await Promise.all(frames.map(async ({ frameId, result: href, documentId: frameDocumentId }) => {
    // Lock/revocation and navigation can happen during TOTP generation or
    // while another frame is being injected. Check immediately before each
    // credential handoff as well as inside the page.
    if (!await guard()) return [];
    return chrome.scripting.executeScript({
      target: frameDocumentId ? { tabId, documentIds: [frameDocumentId] } : { tabId, frameIds: [frameId] },
      args: [href, item.username, item.password, code],
      func: (expected, u, p, c) => location.href === expected && bwliteFill(u, p, c), // the frame may have navigated meanwhile
    }).catch(() => []); // a frame that went away must not hide the fill that worked in another
  }));
  return res.some(([r]) => r?.result);
}

// --- cards and identities (Ward) ---------------------------------------------------------------------------
// Card fields often sit in a payment provider's iframe. A card may fill frames of the page's own site and of these
// providers only; an identity only the page's own site. The top page must be https.
export const PAYMENT_HOSTS = /(^|\.)(stripe\.com|stripecdn\.com|braintreegateway\.com|braintree-api\.com|adyen\.com|adyenpayments\.com|checkout\.com|paypal\.com|squareup\.com|squarecdn\.com|shopifycs\.com|recurly\.com|chargebee\.com|authorize\.net|worldpay\.com|globalpay\.com|cybersource\.com|spreedly\.com|bluesnap\.com|paddle\.com|mollie\.com|vgs\.io|verygoodvault\.com|basistheory\.com|clover\.com|helcim\.com)$/i;

export function formFrameAllowed(kind, topUrl, frameUrl) {
  let top, f;
  try { top = new URL(topUrl); f = new URL(frameUrl); } catch { return false; }
  if (top.protocol !== 'https:' || f.protocol !== 'https:') return false;
  if (baseDomain(f.hostname) === baseDomain(top.hostname)) return true;
  return kind === 'card' && PAYMENT_HOSTS.test(f.hostname);
}

// item: a decrypted card (type 3) or identity (type 4). Returns the number of fields filled across frames.
export async function fillFormTab(tabId, item, guard = async () => true) {
  const kind = item.type === 3 ? 'card' : item.type === 4 ? 'identity' : null;
  const data = kind === 'card' ? item.card : item.identity;
  if (!kind || !data) return 0;
  if (!await guard()) return 0;
  const frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => location.href });
  const top = frames.find((r) => r.frameId === 0)?.result;
  if (!top || !/^https:/.test(top)) throw new Error('Cards and identities fill only on https pages');
  const chosen = frames.filter((r) => formFrameAllowed(kind, top, r.result));
  const res = await Promise.all(chosen.map(async ({ frameId, result: href, documentId }) => {
    const target = documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [frameId] };
    if (!await guard()) return 0;
    try {
      await chrome.scripting.executeScript({ target, files: ['formfill.js'] });
      if (!await guard()) return 0;
      const [r] = await chrome.scripting.executeScript({
        target, args: [href, kind, data],
        func: (expected, k, d) => (location.href === expected ? wardFillForm(k, d) : 0), // the frame may have navigated meanwhile
      });
      return r?.result || 0;
    } catch { return 0; } // a frame that went away must not hide the fill that worked in another
  }));
  return res.reduce((a, b) => a + b, 0);
}
