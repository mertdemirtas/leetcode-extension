'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BrowserSignIn, credentialsFromCookie } = require('../src/auth.cjs');

const cookie = 'other=ignored; csrftoken=csrf-token; LEETCODE_SESSION=session+token/with%escapes';
const options = { scheme: 'vscode', authority: 'mertdemirtas.singularity-leetcode' };
function callback(url, value = cookie) {
  const authorization = new URL(url);
  const target = new URL(`${authorization.pathname.split('/')[2]}://${authorization.searchParams.get('path')}`);
  return { scheme: target.protocol.slice(0, -1), authority: target.host, path: target.pathname, query: new URLSearchParams({ cookie: value }).toString() };
}

test('authorization cookies are parsed without decoding or exposing their values', () => {
  assert.deepEqual(credentialsFromCookie(cookie), { session: 'session+token/with%escapes', csrf: 'csrf-token' });
  for (const value of ['', 'LEETCODE_SESSION=secret', cookie + '; csrftoken=duplicate', cookie + '\r\nheader=value', 'x'.repeat(65537)]) {
    assert.throws(() => credentialsFromCookie(value), error => !error.message.includes('session+token') && !error.message.includes('secret'));
  }
});

test('browser authorization uses the IDE scheme, a random state path, and a single-use callback', async t => {
  const auth = new BrowserSignIn({ ...options, scheme: 'cursor' }); t.after(() => auth.dispose());
  const url = await auth.begin();
  assert.equal(new URL(url).pathname, '/authorize-login/cursor/');
  assert.match(new URL(url).searchParams.get('path'), /^mertdemirtas\.singularity-leetcode\/auth\/[a-f0-9]{64}$/);
  const uri = callback(url);
  for (const changed of [{ scheme: 'vscode' }, { authority: 'other.extension' }, { path: '/auth/wrong-state' }]) {
    assert.equal(auth.handleUri({ ...uri, ...changed }), false); assert.equal(auth.pending, true);
  }
  assert.equal(auth.handleUri(uri), true);
  assert.deepEqual(await auth.result, credentialsFromCookie(cookie));
  assert.equal(auth.handleUri(uri), false);
});

test('cancelled, expired, and malformed sign-ins cannot replace a session', async t => {
  const cancelled = new BrowserSignIn(options); t.after(() => cancelled.dispose());
  const old = callback(await cancelled.begin()); cancelled.cancel();
  assert.equal(await cancelled.result, null); assert.equal(cancelled.handleUri(old), false);
  const expired = new BrowserSignIn({ ...options, timeout: 5 }); t.after(() => expired.dispose());
  await expired.begin();
  // Keep the test alive while the extension's unreferenced expiry timer runs.
  const waiting = new Promise(resolve => setTimeout(resolve, 15));
  await assert.rejects(expired.result, /expired/); await waiting;
  const malformed = new BrowserSignIn(options); t.after(() => malformed.dispose());
  const uri = callback(await malformed.begin()); uri.query += '&cookie=duplicate';
  malformed.handleUri(uri); await assert.rejects(malformed.result, /did not return sign-in data/);
  const fresh = new BrowserSignIn(options); t.after(() => fresh.dispose()); await fresh.begin();
  assert.equal(fresh.handleUri(old), false); assert.equal(fresh.pending, true);
});

test('Singularity receives authorization through a loopback-only HTTP callback', async t => {
  const auth = new BrowserSignIn({ ...options, loopback: true }); t.after(() => auth.dispose());
  const url = await auth.begin();
  const uri = callback(url);
  assert.equal(new URL(url).pathname, '/authorize-login/http/');
  assert.match(uri.authority, /^127\.0\.0\.1:\d+$/);
  const base = `http://${uri.authority}`;
  assert.equal((await fetch(`${base}/wrong`)).status, 404);
  assert.equal((await fetch(`${base}${uri.path}`, { method: 'POST' })).status, 400);
  assert.equal(auth.pending, true);
  const response = await fetch(`${base}${uri.path}?${uri.query}`, { redirect: 'manual' });
  assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/complete');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.deepEqual(await auth.result, credentialsFromCookie(cookie));
  const page = await (await fetch(`${base}/complete`)).text();
  assert.ok(page.includes('Return to your IDE')); assert.ok(!page.includes('session+token'));
  assert.equal((await fetch(`${base}${uri.path}?${uri.query}`)).status, 404);
});
