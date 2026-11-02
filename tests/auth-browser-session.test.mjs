import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('', { url: 'https://mailflare.test/inbox' });
for (const key of ['window', 'localStorage', 'sessionStorage', 'CustomEvent', 'Event']) {
 Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
const dir = mkdtempSync(join(process.cwd(), 'node_modules', 'mailflare-cookie-session-'));
after(() => { dom.window.close(); rmSync(dir, { recursive: true, force: true }); });
await build({ stdin: { contents: `export * from './src/lib/auth/client'; export * from './src/lib/auth/session-client'; export * from './src/lib/auth/logout';`, resolveDir: process.cwd() }, outfile: join(dir, 'app.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', tsconfig: 'tsconfig.json', logLevel: 'silent' });
const app = await import(pathToFileURL(join(dir, 'app.mjs')).href);
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); app.clearClientSessionToken(); app.clearSessionSnapshot(); });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('new login never persists its credential and browser requests rely only on same-origin cookies', async t => {
 await app.persistAuthSession(Response.json({ ok: true, token: 'synthetic-server-secret' }));
 const scope = app.getClientSessionToken();
 assert.match(scope, /^scope:/);
 assert.equal(localStorage.getItem('mailflare-session-token'), null);
 assert(!JSON.stringify(localStorage).includes('synthetic-server-secret'));
 t.mock.method(globalThis, 'fetch', async (_url, init) => {
  assert.equal(init.credentials, 'same-origin');
  assert.equal(init.headers.get('Authorization'), null);
  assert.equal(init.headers.get('Content-Type'), 'application/json');
  return Response.json({ ok: true });
 });
 await app.authFetch(new Request('https://mailflare.test/api/messages', { headers: { Authorization: 'Bearer synthetic-legacy', 'Content-Type': 'application/json' } }), { credentials: 'omit' });
 assert.equal(app.getAuthHeaders({ Authorization: 'Bearer synthetic-legacy' }).get('Authorization'), null, 'XHR uploads use cookie-only headers too');
});

test('legacy browser credentials migrate once and a later old-version login gets a new cache scope', () => {
 localStorage.setItem('mailflare-session-token', 'synthetic-legacy');
 const first = app.getClientSessionToken();
 assert.match(first, /^scope:/);
 assert.equal(localStorage.getItem('mailflare-session-token'), null);
 assert.equal(app.getClientSessionToken(), first);
 localStorage.setItem('mailflare-session-token', 'synthetic-other-account');
 assert.notEqual(app.getClientSessionToken(), first);
 assert.equal(localStorage.getItem('mailflare-session-token'), null);
});

test('returning cookie sessions initialize one nonsecret scope without a duplicate auth validation', async t => {
 let requests = 0, ready = 0, resets = 0;
 const onReady = () => ready++, onReset = () => resets++;
 window.addEventListener(app.AUTH_SESSION_SCOPE_READY_EVENT, onReady);
 window.addEventListener(app.AUTH_SESSION_CHANGED_EVENT, onReset);
 t.after(() => { window.removeEventListener(app.AUTH_SESSION_SCOPE_READY_EVENT, onReady); window.removeEventListener(app.AUTH_SESSION_CHANGED_EVENT, onReset); });
 t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json({ user: { id: 'owner' } }); });
 await Promise.all([app.fetchSessionSnapshot(true), app.fetchSessionSnapshot()]);
 await app.fetchSessionSnapshot();
 assert.equal(requests, 1); assert.equal(ready, 1); assert.equal(resets, 0);
 assert.match(app.getClientSessionToken(), /^scope:/);
});

test('an expired cookie does not invent a session scope or retry with a legacy Bearer token', async t => {
 let requests = 0;
 t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response(null, { status: 401 }); });
 assert.equal((await app.fetchSessionSnapshot()).status, 401);
 assert.equal(app.getClientSessionToken(), null);
 assert.equal((await app.fetchSessionSnapshot()).status, 401);
 assert.equal(requests, 2, 'failed validation is never cached');
});

test('cross-tab account changes invalidate caches and local draft recovery', async t => {
 app.setClientSessionToken('synthetic-old');
 const oldScope = app.getClientSessionToken();
 t.mock.method(globalThis, 'fetch', async () => Response.json({ user: { id: 'old' } }));
 await app.fetchSessionSnapshot();
 sessionStorage.setItem('mailflare-compose-recovery:draft', 'private old draft');
 localStorage.setItem('mailflare-session-scope', 'scope:other-tab');
 window.dispatchEvent(new dom.window.StorageEvent('storage', { key: 'mailflare-session-scope', oldValue: oldScope, newValue: 'scope:other-tab' }));
 assert.equal(sessionStorage.getItem('mailflare-compose-recovery:draft'), null);
 t.mock.method(globalThis, 'fetch', async () => Response.json({ user: { id: 'new' } }));
 assert.equal((await app.fetchSessionSnapshot()).data.user.id, 'new');
 localStorage.removeItem('mailflare-session-scope');
 window.dispatchEvent(new dom.window.StorageEvent('storage', { key: 'mailflare-session-scope', oldValue: 'scope:other-tab', newValue: null }));
 assert.equal(app.getClientSessionToken(), null);
});

test('cookies remain usable when localStorage is disabled', async t => {
 t.mock.method(dom.window.Storage.prototype, 'getItem', () => { throw new DOMException('Blocked', 'SecurityError'); });
 t.mock.method(dom.window.Storage.prototype, 'setItem', () => { throw new DOMException('Blocked', 'SecurityError'); });
 t.mock.method(dom.window.Storage.prototype, 'removeItem', () => { throw new DOMException('Blocked', 'SecurityError'); });
 app.setClientSessionToken('synthetic-secret');
 assert.match(app.getClientSessionToken(), /^scope:/);
 t.mock.method(globalThis, 'fetch', async (_url, init) => { assert.equal(init.headers.get('Authorization'), null); return Response.json({ ok: true }); });
 assert.equal((await app.authFetch('/api/messages')).status, 200);
 app.clearClientSessionToken(); assert.equal(app.getClientSessionToken(), null);
});

test('failed logout preserves the current session until the server confirms revocation', async t => {
 app.setClientSessionToken('synthetic-active');
 const scope = app.getClientSessionToken();
 for (const result of [new Error('offline'), new Response(null, { status: 503 }), Response.json({ error: 'not confirmed' })]) {
  t.mock.method(globalThis, 'fetch', async () => { if (result instanceof Error) throw result; return result; });
  await assert.rejects(app.logoutClientSession());
  assert.equal(app.getClientSessionToken(), scope);
 }
 t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true }));
 assert.equal(await app.logoutClientSession(), false);
 assert.equal(app.getClientSessionToken(), null);
});

test('double logout is one request and promoted account credentials are discarded', async t => {
 app.setClientSessionToken('synthetic-first'); const oldScope = app.getClientSessionToken();
 const pending = deferred(); let requests = 0;
 t.mock.method(globalThis, 'fetch', () => { requests++; return pending.promise; });
 const first = app.logoutClientSession(), second = app.logoutClientSession();
 pending.resolve(Response.json({ ok: true, token: 'synthetic-second' }));
 assert.deepEqual(await Promise.all([first, second]), [true, true]);
 assert.equal(requests, 1);
 assert.notEqual(app.getClientSessionToken(), oldScope);
 assert(!JSON.stringify(localStorage).includes('synthetic-second'));
});

test('an old logout response cannot clear a newly switched account', async t => {
 app.setClientSessionToken('synthetic-old'); const pending = deferred();
 t.mock.method(globalThis, 'fetch', () => pending.promise);
 const logout = app.logoutClientSession();
 app.setClientSessionToken('synthetic-new'); const scope = app.getClientSessionToken();
 pending.resolve(Response.json({ ok: true }));
 await assert.rejects(logout);
 assert.equal(app.getClientSessionToken(), scope);
});
