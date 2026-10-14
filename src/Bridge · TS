// ============================================================
// Bridge page served at  GET /?bridge=<capability>
//
// It runs inside the app's hardened WebView and does only this:
//   app  <-- TelegramWebProxy.postMessage / onmessage -->  page
//   page <-- HTTPS session creation + one WebSocket   -->  this Worker
//
// !! UNVERIFIED against a real client. It follows PROTOCOL.md ("Injected WebView
// !! boundary"), but the exact message representation (string vs object for the
// !! control messages, ArrayBuffer for frames) must be checked against the
// !! reference bridge page. See the notes next to each TODO.
// ============================================================

const jsString = (s: string): string => JSON.stringify(s);

export const bridgeHtml = (opts: { host: string; bootstrap: string; nonce: string }): string => {
  const script = `
(function () {
  'use strict';
  var HOST = ${jsString(opts.host)};
  var BOOT = ${jsString(opts.bootstrap)};

  // fragment: #android=<webview-nonce>   (the key name is frozen in v1)
  var m = /(?:^#|&)android=([A-Za-z0-9_-]+)/.exec(location.hash || '');
  var wvNonce = m ? m[1] : null;
  try { history.replaceState(null, '', location.pathname); } catch (e) {}

  var app = window.TelegramWebProxy;
  if (!app || !wvNonce) { return; }

  var ws = null, token = null, started = false, dead = false, queue = [];

  function toApp(v) { try { app.postMessage(v); } catch (e) {} }
  // TODO(verify): control values may need to be objects instead of JSON strings.
  function control(o) { toApp(JSON.stringify(o)); }

  function fail() {
    if (dead) { return; }
    dead = true;
    // TODO(verify): the real "replace this carrier" control message.
    control({ t: 'close' });
    try { if (ws) { ws.close(); } } catch (e) {}
  }

  function asBytes(d) {
    if (d instanceof ArrayBuffer) { return new Uint8Array(d); }
    if (d && d.buffer instanceof ArrayBuffer && typeof d.byteLength === 'number') {
      return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    }
    return null;
  }

  function sendUp(bytes) {
    if (ws && ws.readyState === 1) { ws.send(bytes); } else { queue.push(bytes); }
  }

  // relay -> app: split a batch into single frames (type:u8 | id:u24 | len:u32 | payload)
  function deliverBatch(buf) {
    var u = new Uint8Array(buf), o = 0;
    while (o + 8 <= u.length) {
      var len = ((u[o + 4] << 24) | (u[o + 5] << 16) | (u[o + 6] << 8) | u[o + 7]) >>> 0;
      var end = o + 8 + len;
      if (end > u.length) { fail(); return; }
      toApp(buf.slice(o, end));
      o = end;
    }
  }

  function openSocket() {
    ws = new WebSocket('wss://' + HOST + '/api/v1/ws', ['tproxy-v1.' + token]);
    ws.binaryType = 'arraybuffer';
    ws.onopen = function () {
      for (var i = 0; i < queue.length; i++) { ws.send(queue[i]); }
      queue = [];
    };
    ws.onmessage = function (ev) {
      if (ev.data instanceof ArrayBuffer) { deliverBatch(ev.data); } else { fail(); }
    };
    ws.onclose = fail;
    ws.onerror = fail;
  }

  function createSession(helloFrame) {
    fetch('/api/v1/session', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + BOOT, 'Content-Type': 'application/octet-stream' },
      body: helloFrame,
      mode: 'same-origin', credentials: 'omit', cache: 'no-store',
      redirect: 'error', referrerPolicy: 'no-referrer'
    }).then(function (res) {
      if (!res.ok) { throw new Error('session ' + res.status); }
      token = res.headers.get('X-Session-Token');
      return res.arrayBuffer();
    }).then(function (welcome) {
      toApp(welcome);   // WELCOME frame
      openSocket();
    }).catch(fail);
  }

  function onAppMessage(ev) {
    var d = (ev && ev.data !== undefined) ? ev.data : ev;
    var bytes = asBytes(d);
    if (!bytes) { return; }            // JSON control values from the app are ignored
    if (!started) {                    // first frame from the app is HELLO
      started = true;
      createSession(bytes);
    } else {
      sendUp(bytes);
    }
  }

  app.onmessage = onAppMessage;
  control({ t: 'tproxy-android-init', v: 1, nonce: wvNonce });
})();
`;
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title></title></head><body>' +
    `<script nonce="${opts.nonce}">${script}</script></body></html>`
  );
};
