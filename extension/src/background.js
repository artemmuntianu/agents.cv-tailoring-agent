/**
 * MV3 service worker - the extension's only network client.
 *
 * The popup closes as soon as it loses focus, so the fetch must not live there: the
 * popup scrapes, sends the payload here, and this worker performs the authenticated
 * POST and keeps the session token in `chrome.storage.local`.
 */
const DEFAULT_GATEWAY = 'http://localhost:4321';

async function settings() {
  const stored = await chrome.storage.local.get(['gateway', 'token', 'user']);
  return {
    gateway: String(stored.gateway || DEFAULT_GATEWAY).replace(/\/+$/, ''),
    token: stored.token || '',
    user: stored.user || '',
  };
}

async function signIn(message) {
  const gateway = String(message.gateway || DEFAULT_GATEWAY).replace(/\/+$/, '');
  const response = await fetch(`${gateway}/api/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: message.email, password: message.password }),
  });
  const body = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (!response.ok || !body.ok) return { ok: false, error: body.error || `HTTP ${response.status}` };

  await chrome.storage.local.set({ gateway: gateway, token: body.token, user: body.user });
  return { ok: true, gateway: gateway, user: body.user };
}

async function publish(payload) {
  const { gateway, token } = await settings();
  if (!token) return { ok: false, error: 'not signed in' };

  const response = await fetch(`${gateway}/api/vacancies/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const body = await response
    .json()
    .catch(() => ({ ok: false, error: `HTTP ${response.status}` }));

  // A stale token is a normal case (8h TTL): forget it so the popup asks again.
  if (response.status === 401) await chrome.storage.local.remove(['token', 'user']);
  return body;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message && message.type === 'status') {
        sendResponse({ ok: true, ...(await settings()) });
      } else if (message && message.type === 'signIn') {
        sendResponse(await signIn(message));
      } else if (message && message.type === 'signOut') {
        await chrome.storage.local.remove(['token', 'user']);
        sendResponse({ ok: true });
      } else if (message && message.type === 'publish') {
        sendResponse(await publish(message.payload));
      } else {
        sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error && error.message ? error.message : String(error) });
    }
  })();
  return true; // async response
});
