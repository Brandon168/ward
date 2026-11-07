// Ward: two-step login with a security key (or a passkey registered as one). The key is registered for the vault
// server's own address, so the prompt can't run on an extension page: background.js opens a small window on the
// server (its /alive page) and runs this function there, in Ward's isolated world, with the server's challenge.
// It must stay self-contained (chrome.scripting.executeScript serialises it): no imports, no outer variables.
// Returns { ok: JSON for twoFactorToken } or { error } (cancelled, timed out, no matching key).
export async function securityKeyPrompt(options, host) {
  const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const bytes = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  // The window shows one line in the system font and colours while the browser's own prompt is up.
  const box = document.createElement('div');
  Object.assign(box.style, { font: '15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif', padding: '28px 24px', maxWidth: '420px' });
  const head = document.createElement('b');
  head.textContent = 'Ward: two-step login';
  const line = document.createElement('p');
  line.textContent = `Use your security key or passkey to finish logging in to ${host}.`;
  box.append(head, line);
  document.documentElement.style.colorScheme = 'light dark';
  document.title = 'Ward: two-step login';
  (document.body || document.documentElement).replaceChildren(box);
  try {
    if (!options || typeof options.challenge !== 'string') throw new Error('The server sent no security key challenge.');
    const cred = await navigator.credentials.get({ publicKey: {
      ...options, challenge: bytes(options.challenge),
      allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: bytes(c.id) })),
    } });
    const r = cred.response;
    line.textContent = 'Done. Ward is finishing the login.';
    // Vaultwarden expects clientDataJson (sic) and base64url throughout.
    return { ok: JSON.stringify({
      id: cred.id, rawId: b64u(cred.rawId), type: cred.type, extensions: cred.getClientExtensionResults?.() || {},
      response: { authenticatorData: b64u(r.authenticatorData), clientDataJson: b64u(r.clientDataJSON), signature: b64u(r.signature),
        userHandle: r.userHandle ? b64u(r.userHandle) : null },
    }) };
  } catch (e) {
    const error = e?.name === 'NotAllowedError' ? 'The security key prompt was cancelled or timed out.' : e?.message || String(e);
    line.textContent = error;
    return { error };
  }
}
