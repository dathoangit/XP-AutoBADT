import type { AuthPayload } from '../auth/types';
import type { RuntimeMessage } from '../config/messages';

const POLL_MS = 2000;

function readAuth(): AuthPayload | null {
  try {
    const raw = localStorage.getItem('auth');
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as AuthPayload;
    if (!parsed?.access_token) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function sendAuth(auth: AuthPayload | null): void {
  const message: RuntimeMessage = { type: 'AUTH_UPDATED', auth };
  chrome.runtime.sendMessage(message).catch(() => {
    // Extension context may be invalidated during reload.
  });
}

let lastToken = '';

function syncAuth(): void {
  const auth = readAuth();
  const token = auth?.access_token ?? '';
  if (token === lastToken) {
    return;
  }

  lastToken = token;
  sendAuth(auth);
}

syncAuth();
setInterval(syncAuth, POLL_MS);

window.addEventListener('storage', (event) => {
  if (event.key === 'auth') {
    syncAuth();
  }
});
