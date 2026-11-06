// Clipboard writes for the service worker, which has no DOM (Manifest V3). background.js opens this hidden
// document only to copy from the right-click menu or to clear the clipboard, then closes it again.
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m?.wardOffscreen !== 'clipboard' || sender.id !== chrome.runtime.id || typeof m.text !== 'string') return;
  // Chrome's offscreen clipboard pattern (select a textarea, execCommand('copy')), plus a copy handler that sets the
  // exact text, so '' really empties the clipboard instead of copying nothing.
  const ta = document.createElement('textarea');
  ta.value = m.text || ' ';
  document.body.append(ta);
  ta.select();
  const put = (e) => { e.clipboardData.setData('text/plain', m.text); e.preventDefault(); };
  document.addEventListener('copy', put, { once: true });
  let ok = false;
  try { ok = document.execCommand('copy'); } finally {
    document.removeEventListener('copy', put);
    ta.remove();
  }
  reply({ ok });
});
