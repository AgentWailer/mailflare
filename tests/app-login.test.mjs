import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const dir = mkdtempSync(join(process.cwd(), 'node_modules', 'mailflare-app-login-test-'));
after(() => rmSync(dir, {recursive: true, force: true}));
writeFileSync(join(dir, 'headers.mjs'), 'export async function cookies(){return {get:()=>undefined};}');
await build({stdin: {contents: `
 export {SqliteDatabase} from './server/runtime/sqlite-database';
 export {applyMigrations} from './server/runtime/migrate';
 export {createSession, getUserFromSession, deleteUserSessions} from './src/lib/auth/session';
 export {hashPassword} from './src/lib/auth/password';
 export {generateTotpSecret, totp} from './src/lib/auth/totp';
 export {POST as login} from './src/app/api/app/login/route';
 export {POST as mfa} from './src/app/api/app/login/mfa/route';
 export {GET as me} from './src/app/api/auth/me/route';
`, resolveDir: process.cwd()}, outfile: join(dir, 'app.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', tsconfig: 'tsconfig.json', alias: {'next/headers': join(dir, 'headers.mjs'), 'next/server': 'next/server.js', 'cloudflare:workers': './server/runtime/cloudflare-workers.ts'}, logLevel: 'silent'});
const app = await import(pathToFileURL(join(dir, 'app.mjs')).href);

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

async function fixture(t, extraEnv = {}) {
	const DB = new app.SqliteDatabase(':memory:');
	await app.applyMigrations(DB, join(process.cwd(), 'drizzle/migrations'));
	const env = {DB, MAILFLARE_RUNTIME: 'node', ...extraEnv};
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { DB.db.close(); delete globalThis.__mailflareNodeEnv; });
	DB.db.prepare("INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES ('owner','owner@example.test',?,'Owner','user',1)").run(app.hashPassword('correct horse'));
	const post = (handler, body, headers = {}) => handler(new Request('https://mailflare.test/api/app/login', {method: 'POST', headers: {'Content-Type': 'application/json', ...headers}, body: JSON.stringify(body)}));
	// A device session is an ordinary session row plus its device entry.
	const session = () => DB.db.prepare('SELECT s.id, s.expires_at, d.device_name, d.last_used_at FROM sessions s LEFT JOIN device_sessions d ON d.session_id = s.id ORDER BY s.rowid DESC').get();
	return {DB, env, post, session};
}

const credentials = {email: 'owner@example.test', password: 'correct horse', deviceName: '  iPhone von Test  '};

test('a password sign-in returns a device session that works as a bearer token', async (t) => {
	const f = await fixture(t);
	const response = await f.post(app.login, credentials);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('Set-Cookie'), null);
	assert.equal(response.headers.get('Cache-Control'), 'no-store');
	const data = await response.json();
	assert.equal(data.ok, true);
	assert.deepEqual(data.user, {id: 'owner', email: 'owner@example.test', name: 'Owner', role: 'user'});
	const row = f.session();
	assert.equal(row.device_name, 'iPhone von Test');
	assert.match(data.token, /^dev_/);
	assert.ok(Math.abs(row.expires_at - (now() + 90 * DAY)) < 60);
	const me = await app.me(new Request('https://mailflare.test/api/auth/me', {headers: {Authorization: 'Bearer ' + data.token}}));
	assert.equal(me.status, 200);
});

test('a second factor is asked for when it is switched on', async (t) => {
	const f = await fixture(t);
	const secret = app.generateTotpSecret();
	f.DB.db.prepare("UPDATE users SET totp_secret=?, totp_enabled=1 WHERE id='owner'").run(secret);
	const first = await (await f.post(app.login, credentials)).json();
	assert.equal(first.mfaRequired, true);
	assert.equal(first.token, undefined);
	assert.equal(f.DB.db.prepare('SELECT count(*) n FROM sessions').get().n, 0);
	const wrong = await f.post(app.mfa, {challengeToken: first.challengeToken, code: '000000', deviceName: 'iPhone'});
	assert.equal(wrong.status, 401);
	const second = await f.post(app.mfa, {challengeToken: first.challengeToken, code: await app.totp(secret), deviceName: 'iPhone'});
	assert.equal(second.status, 200);
	assert.equal(second.headers.get('Set-Cookie'), null);
	const data = await second.json();
	assert.ok(data.token);
	assert.equal(data.user.id, 'owner');
	assert.equal(f.session().device_name, 'iPhone');
});

test('wrong passwords, disabled accounts and missing device names are refused', async (t) => {
	const f = await fixture(t);
	assert.equal((await f.post(app.login, {...credentials, password: 'nope'})).status, 401);
	assert.equal((await f.post(app.login, {...credentials, deviceName: '   '})).status, 400);
	assert.equal((await f.post(app.login, {...credentials, deviceName: 'x'.repeat(81)})).status, 400);
	f.DB.db.exec("UPDATE users SET disabled=1 WHERE id='owner'");
	assert.equal((await f.post(app.login, credentials)).status, 403);
	assert.equal(f.DB.db.prepare('SELECT count(*) n FROM sessions').get().n, 0);
});

test('the sign-in limiter of the web applies', async (t) => {
	let calls = 0;
	const f = await fixture(t, {LOGIN_RATE_LIMIT: {limit: async () => ({success: ++calls <= 5})}});
	for (let i = 0; i < 5; i++) assert.equal((await f.post(app.login, {...credentials, password: 'nope'})).status, 401);
	const limited = await f.post(app.login, credentials);
	assert.equal(limited.status, 429);
	assert.equal(limited.headers.get('Retry-After'), '60');
});

test('a device session renews itself in use and a web session does not', async (t) => {
	const f = await fixture(t);
	const {token} = await (await f.post(app.login, credentials)).json();
	f.DB.db.prepare('UPDATE sessions SET expires_at=?').run(now() + 85 * DAY);
	await app.getUserFromSession(f.env, token);
	assert.ok(Math.abs(f.session().expires_at - (now() + 85 * DAY)) < 60, 'not renewed with 85 days left');
	assert.equal(f.session().last_used_at, null);
	f.DB.db.prepare('UPDATE sessions SET expires_at=?').run(now() + 80 * DAY);
	assert.equal((await app.getUserFromSession(f.env, token)).id, 'owner');
	assert.ok(Math.abs(f.session().expires_at - (now() + 90 * DAY)) < 60, 'renewed with 80 days left');
	assert.ok(Math.abs(f.session().last_used_at - now()) < 60);

	f.DB.db.exec('DELETE FROM sessions');
	const web = await app.createSession(f.env, 'owner');
	assert.equal(f.session().device_name, null);
	f.DB.db.prepare('UPDATE sessions SET expires_at=?').run(now() + 5 * DAY);
	await app.getUserFromSession(f.env, web);
	assert.ok(Math.abs(f.session().expires_at - (now() + 5 * DAY)) < 60);
});

test('an expired device session is not revived', async (t) => {
	const f = await fixture(t);
	const {token} = await (await f.post(app.login, credentials)).json();
	f.DB.db.prepare('UPDATE sessions SET expires_at=?').run(now() - 10);
	assert.equal(await app.getUserFromSession(f.env, token), null);
});

test('a password change ends device sessions and removes their device entries', async (t) => {
	const f = await fixture(t);
	const {token} = await (await f.post(app.login, credentials)).json();
	f.DB.db.exec('PRAGMA foreign_keys=ON');
	await app.deleteUserSessions(f.env, 'owner');
	assert.equal(await app.getUserFromSession(f.env, token), null);
	assert.equal(f.DB.db.prepare('SELECT count(*) n FROM device_sessions').get().n, 0);
});

test('web sign-in keeps working on a database that has not been migrated yet', async (t) => {
	const f = await fixture(t);
	f.DB.db.exec('DROP TABLE device_sessions');
	const web = await app.createSession(f.env, 'owner');
	assert.equal((await app.getUserFromSession(f.env, web)).id, 'owner');
});

test('an installation that uses Turnstile only signs an app in through Cloudflare Access', async (t) => {
	const pair = await crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, true, ['sign', 'verify']);
	const publicKey = {...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'app-login-test', alg: 'RS256', use: 'sig'};
	const access = {MCP_ACCESS_ISSUER: 'https://app-login.cloudflareaccess.com', MCP_ACCESS_AUDIENCE: 'b'.repeat(64)};
	const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
	const assertion = async (key, claims = {}) => {
		const unsigned = encode({alg: 'RS256', kid: publicKey.kid}) + '.' + encode({iss: access.MCP_ACCESS_ISSUER, aud: [access.MCP_ACCESS_AUDIENCE], sub: '', type: 'app', common_name: 'device-token.access', iat: now() - 10, exp: now() + 600, ...claims});
		return unsigned + '.' + Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned))).toString('base64url');
	};
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (input) => {
		assert.equal(String(input), access.MCP_ACCESS_ISSUER + '/cdn-cgi/access/certs');
		return new Response(JSON.stringify({keys: [publicKey]}), {headers: {'Content-Type': 'application/json'}});
	};
	t.after(() => { globalThis.fetch = realFetch; });
	const f = await fixture(t, {TURNSTILE_SECRET_KEY: 'secret', ...access});

	const bare = await f.post(app.login, credentials);
	assert.equal(bare.status, 403);
	assert.deepEqual(await bare.json(), {error: 'App sign-in requires Cloudflare Access'});

	const other = await crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, true, ['sign', 'verify']);
	assert.equal((await f.post(app.login, credentials, {'Cf-Access-Jwt-Assertion': await assertion(other.privateKey)})).status, 403, 'forged signature');
	assert.equal((await f.post(app.login, credentials, {'Cf-Access-Jwt-Assertion': await assertion(pair.privateKey, {exp: now() - 5, iat: now() - 600})})).status, 403, 'expired');
	assert.equal((await f.post(app.login, credentials, {'Cf-Access-Jwt-Assertion': await assertion(pair.privateKey, {aud: ['c'.repeat(64)]})})).status, 403, 'other application');

	const through = await f.post(app.login, credentials, {'Cf-Access-Jwt-Assertion': await assertion(pair.privateKey)});
	assert.equal(through.status, 200);
	assert.ok((await through.json()).token);

	// With its own Access application, the app is not let through by an assertion for another one.
	f.env.APP_ACCESS_AUDIENCE = 'd'.repeat(64);
	assert.equal((await f.post(app.login, credentials, {'Cf-Access-Jwt-Assertion': await assertion(pair.privateKey)})).status, 403, 'assertion for the MCP application');
	assert.equal((await f.post(app.login, credentials, {'Cf-Access-Jwt-Assertion': await assertion(pair.privateKey, {aud: ['d'.repeat(64)]})})).status, 200);
	f.env.APP_ACCESS_AUDIENCE = 'not-an-audience';
	assert.equal((await f.post(app.login, credentials, {'Cf-Access-Jwt-Assertion': await assertion(pair.privateKey)})).status, 403, 'a broken setting fails closed');
});
