'use strict';

const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { ORIGIN, validateCredentials } = require('./client.cjs');

function credentialsFromCookie(cookie) {
  if (typeof cookie !== 'string' || !cookie || cookie.length > 65536 || /[\r\n\0]/.test(cookie)) throw new Error('LeetCode returned invalid sign-in data. Connect again.');
  const values = {};
  for (const item of cookie.split(';')) {
    const split = item.indexOf('=');
    if (split < 0) continue;
    const key = item.slice(0, split).trim();
    if (!['LEETCODE_SESSION', 'csrftoken'].includes(key)) continue;
    if (Object.hasOwn(values, key)) throw new Error('LeetCode returned duplicate sign-in cookies. Connect again.');
    values[key] = item.slice(split + 1).trim();
  }
  try { return validateCredentials({ session: values.LEETCODE_SESSION, csrf: values.csrftoken }); }
  catch { throw new Error('LeetCode did not return a signed-in session and CSRF token. Sign in and authorize again, or use Connect with browser session.'); }
}

// LeetCode's authorization page returns a cookie parameter to scheme://path.
// The random callback path ties that response to this window and this attempt.
class BrowserSignIn {
  constructor({ scheme, authority, loopback = false, timeout = 300000 }) {
    if (!/^[a-z][a-z0-9+.-]*$/.test(scheme) || !/^[a-z0-9-]+\.[a-z0-9.-]+$/i.test(authority)) throw new Error('This IDE does not provide a valid sign-in callback. Use Connect with browser session.');
    Object.assign(this, { scheme, authority, loopback, timeout });
    this.path = `/auth/${randomBytes(32).toString('hex')}`;
    this.pending = true;
    this.result = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    // begin() can fail before the caller starts awaiting result.
    this.result.catch(() => {});
  }

  async begin() {
    if (this.loopback) {
      this.server = http.createServer({ maxHeaderSize: 100000, requestTimeout: 10000, headersTimeout: 10000 }, (request, response) => this.receive(request, response));
      this.server.maxConnections = 8;
      this.server.on('clientError', (_error, socket) => socket.destroy());
      try {
        await new Promise((resolve, reject) => {
          this.server.once('error', reject);
          this.server.listen(0, '127.0.0.1', resolve);
        });
      } catch {
        this.finish(null, new Error('Could not open the local sign-in callback. Use Connect with browser session.'));
        this.closeServer();
        throw new Error('Could not open the local sign-in callback. Use Connect with browser session.');
      }
      if (!this.pending) { this.closeServer(); return null; }
      this.scheme = 'http';
      this.authority = `127.0.0.1:${this.server.address().port}`;
    }
    if (!this.pending) return null;
    this.timer = setTimeout(() => this.finish(null, new Error('Browser sign-in expired. Select Connect and authorize again.')), this.timeout);
    this.timer.unref?.();
    const url = new URL(`${ORIGIN}/authorize-login/${this.scheme}/`);
    url.searchParams.set('path', this.authority + this.path);
    return url.href;
  }

  handleUri(uri) {
    if (!this.pending || uri.scheme !== this.scheme || uri.authority !== this.authority || uri.path !== this.path) return false;
    try {
      if (typeof uri.query !== 'string' || uri.query.length > 100000) throw new Error('LeetCode returned invalid sign-in data. Connect again.');
      const cookies = new URLSearchParams(uri.query).getAll('cookie');
      if (cookies.length !== 1) throw new Error('LeetCode did not return sign-in data. Connect and authorize again.');
      this.finish(credentialsFromCookie(cookies[0]));
    } catch (error) { this.finish(null, error); }
    return true;
  }

  receive(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    if (request.method !== 'GET' || request.headers.host !== this.authority || !request.url.startsWith('/')) {
      response.writeHead(400); response.end('Invalid callback.'); return;
    }
    let url;
    try { url = new URL(request.url, `http://${this.authority}`); }
    catch { response.writeHead(400); response.end('Invalid callback.'); return; }
    if (url.pathname === '/complete' && !this.pending) {
      response.end('Authorization received. Return to your IDE to finish connecting. You can close this tab.'); return;
    }
    if (!this.handleUri({ scheme: 'http', authority: url.host, path: url.pathname, query: url.search.slice(1) })) {
      response.writeHead(404); response.end('No active sign-in matches this callback. Start Connect again in your IDE.'); return;
    }
    // Remove the credential-bearing callback from the browser's current URL.
    response.writeHead(303, { Location: '/complete' }); response.end();
  }

  finish(credentials, error) {
    if (!this.pending) return;
    this.pending = false;
    clearTimeout(this.timer);
    if (error) this.reject(error); else this.resolve(credentials);
    if (this.server) {
      this.closeTimer = setTimeout(() => this.closeServer(), credentials ? 10000 : 0);
      this.closeTimer.unref?.();
    }
  }

  cancel() { this.finish(null); }
  closeServer() { clearTimeout(this.closeTimer); this.server?.close(); this.server?.closeAllConnections(); }
  dispose() { this.cancel(); this.closeServer(); }
}

module.exports = { BrowserSignIn, credentialsFromCookie };
