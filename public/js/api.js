// REST + WebSocket client.

let token = '';
try {
  const m = location.hash.match(/token=([A-Za-z0-9]+)/);
  if (m) {
    localStorage.setItem('hubToken', m[1]);
    history.replaceState(null, '', location.pathname + '#/');
  }
  token = localStorage.getItem('hubToken') || '';
} catch {}

export function setToken(t) {
  token = t;
  try {
    localStorage.setItem('hubToken', t);
  } catch {}
}

export async function api(method, path, body, { timeoutMs = 0 } = {}) {
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { 'x-hub-token': token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller?.signal,
    });
  } catch (err) {
    if (controller?.signal.aborted) {
      const timeout = new Error('連線逾時');
      timeout.code = 'ETIMEDOUT';
      throw timeout;
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const get = (p, options) => api('GET', p, undefined, options);
export const post = (p, b = {}) => api('POST', p, b);
export const put = (p, b) => api('PUT', p, b);
export const patch = (p, b) => api('PATCH', p, b);
export const del = (p) => api('DELETE', p);

// Persistent socket with backoff. onStatus(true|false) reports connectivity;
// callers resync state after a reconnect (and say again what they watch:
// the server starts each connection knowing nothing). Returns { send },
// which drops what is sent while disconnected.
export function connect(onMessage, onStatus) {
  let delay = 500;
  let ws;
  let timer;
  const socket = {
    send(msg) {
      if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
    },
  };
  const schedule = (wait = delay) => {
    if (timer || ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
    timer = setTimeout(() => {
      timer = null;
      open();
    }, wait);
  };
  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`);
    ws.onopen = () => {
      delay = 500;
      onStatus(true);
    };
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch (err) {
        console.error(err);
      }
    };
    ws.onclose = () => {
      onStatus(false);
      schedule(delay);
      delay = Math.min(delay * 2, 8000);
    };
  };
  // Phones commonly suspend timers and sockets while the screen is locked or
  // while switching between Wi-Fi and mobile data. Retry immediately once the
  // browser tells us that a usable network/page is back.
  window.addEventListener('online', () => {
    delay = 500;
    schedule(0);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') schedule(0);
  });
  open();
  return socket;
}
