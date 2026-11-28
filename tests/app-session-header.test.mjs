import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

// Cloudflare Access with Managed OAuth claims `Authorization: Bearer` for its own tokens and
// refuses anything else there before the request reaches Mailflare. An installed app therefore
// carries its session in a header of its own.
const dir = mkdtempSync(join(process.cwd(), 'node_modules', 'mailflare-session-header-test-'));
after(() => rmSync(dir, {recursive: true, force: true}));
writeFileSync(join(dir, 'headers.mjs'), 'export async function cookies(){return {get:()=>undefined,set(){},delete(){}};}');
await build({stdin: {contents: `
 export {SqliteDatabase} from './server/runtime/sqlite-database';
 export {applyMigrations} from './server/runtime/migrate';
 export {createDeviceSession, createSession, getUserFromSession} from './src/lib/auth/session';
 export {GET as me} from './src/app/api/auth/me/route';
 export {POST as logout} from './src/app/api/auth/logout/route';
 export {GET as devices} from './src/app/api/app/devices/route';
 export {DELETE as endDevice} from './src/app/api/app/devices/[id]/route';
 export {GET as sync} from './src/app/api/app/sync/route';
 export {getSessionTokenFromRequest} from './src/lib/realtime/utils';
 export {hasValidSessionMutationOrigin} from './src/lib/auth/origin';
`, resolveDir: process.cwd()}, outfile: join(dir, 'app.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', tsconfig: 'tsconfig.json', alias: {'next/headers': join(dir, 'headers.mjs'), 'next/server': 'next/server.js', 'cloudflare:workers': './server/runtime/cloudflare-workers.ts'}, logLevel: 'silent'});
const app = await import(pathToFileURL(join(dir, 'app.mjs')).href);

async function fixture(t) {
	const DB = new app.SqliteDatabase(':memory:');
	await app.applyMigrations(DB, join(process.cwd(), 'drizzle/migrations'));
	DB.db.exec('PRAGMA foreign_keys=ON');
	const env = {DB, MAILFLARE_RUNTIME: 'node'};
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { DB.db.close(); delete globalThis.__mailflareNodeEnv; });
	DB.db.exec("INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES ('anna','anna@example.test','hash','Anna','user',1)");
	const phone = await app.createDeviceSession(env, 'anna', 'Annas iPhone');
	const tablet = await app.createDeviceSession(env, 'anna', 'Annas iPad');
	const request = (path, headers, method = 'GET') => new Request('https://mailflare.test' + path, {method, headers});
	return {DB, env, phone, tablet, request};
}

test('a session in the app header signs requests in, also when Access has put its own token into Authorization', async (t) => {
	const f = await fixture(t);
	assert.equal((await app.me(f.request('/api/auth/me', {'X-Mailflare-Session': f.phone}))).status, 200);
	assert.equal((await app.sync(f.request('/api/app/sync', {'X-Mailflare-Session': f.phone}))).status, 200);
	assert.equal((await app.me(f.request('/api/auth/me', {'X-Mailflare-Session': f.phone, Authorization: 'Bearer some-oauth-access-token'}))).status, 200, 'the app header wins');
	assert.equal((await app.me(f.request('/api/auth/me', {'X-Mailflare-Session': 'dev_wrong'}))).status, 401);
	assert.equal((await app.me(f.request('/api/auth/me', {'X-Mailflare-Session': '   '}))).status, 401);
	assert.equal((await app.me(f.request('/api/auth/me', {Authorization: 'Bearer ' + f.phone}))).status, 200, 'a bearer session keeps working where nothing claims the header');
});

test('changing requests with the app header need no browser origin and act on that session', async (t) => {
	const f = await fixture(t);
	assert.equal(app.hasValidSessionMutationOrigin(f.request('/api/x', {'X-Mailflare-Session': f.phone}, 'POST')), true);
	assert.equal(app.hasValidSessionMutationOrigin(f.request('/api/x', {}, 'POST')), false);
	const {devices} = await (await app.devices(f.request('/api/app/devices', {'X-Mailflare-Session': f.phone}))).json();
	assert.deepEqual(devices.filter((device) => device.current).map((device) => device.name), ['Annas iPhone']);
	const tablet = devices.find((device) => device.name === 'Annas iPad');
	const ended = await app.endDevice(f.request('/api/app/devices/' + tablet.id, {'X-Mailflare-Session': f.phone}, 'DELETE'), {params: Promise.resolve({id: tablet.id})});
	assert.equal(ended.status, 200);
	assert.equal(await app.getUserFromSession(f.env, f.tablet), null);

	assert.equal((await app.logout(f.request('/api/auth/logout', {'X-Mailflare-Session': f.phone, 'Content-Type': 'application/json'}, 'POST'))).status, 200);
	assert.equal(await app.getUserFromSession(f.env, f.phone), null, 'signing out ends the session the header named');
});

test('the realtime connection is opened with the app header', async (t) => {
	const f = await fixture(t);
	assert.equal(app.getSessionTokenFromRequest(f.request('/api/realtime', {Upgrade: 'websocket', 'X-Mailflare-Session': f.phone})), f.phone);
	assert.equal(app.getSessionTokenFromRequest(f.request('/api/realtime', {Upgrade: 'websocket', 'X-Mailflare-Session': f.phone, Authorization: 'Bearer other', Cookie: 'ep_session=cookie'})), f.phone);
});
