import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const dir = mkdtempSync(join(process.cwd(), 'node_modules', 'mailflare-app-devices-test-'));
after(() => rmSync(dir, {recursive: true, force: true}));
writeFileSync(join(dir, 'headers.mjs'), 'export async function cookies(){return {get:()=>undefined};}');
await build({stdin: {contents: `
 export {SqliteDatabase} from './server/runtime/sqlite-database';
 export {applyMigrations} from './server/runtime/migrate';
 export {createSession, createDeviceSession, getUserFromSession} from './src/lib/auth/session';
 export {GET as list} from './src/app/api/app/devices/route';
 export {DELETE as end} from './src/app/api/app/devices/[id]/route';
`, resolveDir: process.cwd()}, outfile: join(dir, 'app.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', tsconfig: 'tsconfig.json', alias: {'next/headers': join(dir, 'headers.mjs'), 'next/server': 'next/server.js', 'cloudflare:workers': './server/runtime/cloudflare-workers.ts'}, logLevel: 'silent'});
const app = await import(pathToFileURL(join(dir, 'app.mjs')).href);

async function fixture(t) {
	const DB = new app.SqliteDatabase(':memory:');
	await app.applyMigrations(DB, join(process.cwd(), 'drizzle/migrations'));
	DB.db.exec('PRAGMA foreign_keys=ON');
	const env = {DB, MAILFLARE_RUNTIME: 'node'};
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { DB.db.close(); delete globalThis.__mailflareNodeEnv; });
	DB.db.exec("INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES ('anna','anna@example.test','hash','Anna','user',1),('ben','ben@example.test','hash','Ben','user',1)");
	const tokens = {
		phone: await app.createDeviceSession(env, 'anna', 'Annas iPhone'),
		tablet: await app.createDeviceSession(env, 'anna', 'Annas iPad'),
		browser: await app.createSession(env, 'anna'),
		stranger: await app.createDeviceSession(env, 'ben', 'Bens iPhone'),
	};
	const call = (handler, token, id) => handler(
		new Request('https://mailflare.test/api/app/devices' + (id ? '/' + id : ''), {method: id ? 'DELETE' : 'GET', headers: token ? {Authorization: 'Bearer ' + token} : {}}),
		id ? {params: Promise.resolve({id})} : undefined,
	);
	return {DB, env, tokens, call};
}

test('the devices of an account are listed with their names, and the asking one is marked', async (t) => {
	const f = await fixture(t);
	const response = await f.call(app.list, f.tokens.phone);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
	const {devices} = await response.json();
	assert.deepEqual(devices.map((device) => [device.name, device.current]).sort(), [['Annas iPad', false], ['Annas iPhone', true]]);
	for (const device of devices) {
		assert.ok(device.id);
		assert.ok(!Number.isNaN(Date.parse(device.signedInAt)));
		assert.deepEqual(Object.keys(device).sort(), ['current', 'id', 'lastUsedAt', 'name', 'signedInAt'], 'no token or hash leaves the server');
	}
	const fromBrowser = await (await f.call(app.list, f.tokens.browser)).json();
	assert.equal(fromBrowser.devices.length, 2, 'the web sees the devices too');
	assert.ok(fromBrowser.devices.every((device) => device.current === false));
});

test('ending a device signs it out and leaves the others signed in', async (t) => {
	const f = await fixture(t);
	const {devices} = await (await f.call(app.list, f.tokens.phone)).json();
	const tablet = devices.find((device) => device.name === 'Annas iPad');
	assert.equal((await f.call(app.end, f.tokens.phone, tablet.id)).status, 200);
	assert.equal(await app.getUserFromSession(f.env, f.tokens.tablet), null);
	assert.equal((await app.getUserFromSession(f.env, f.tokens.phone)).id, 'anna');
	assert.equal((await app.getUserFromSession(f.env, f.tokens.browser)).id, 'anna');
	assert.equal(f.DB.db.prepare('SELECT count(*) n FROM device_sessions').get().n, 2);
	assert.equal(f.DB.db.prepare("SELECT count(*) n FROM audit_logs WHERE action='auth.device_signed_out'").get().n, 1);
});

test('nobody ends a device of another account, a web session or one that is not there', async (t) => {
	const f = await fixture(t);
	const strangers = await (await f.call(app.list, f.tokens.stranger)).json();
	assert.equal((await f.call(app.end, f.tokens.phone, strangers.devices[0].id)).status, 404);
	assert.equal((await app.getUserFromSession(f.env, f.tokens.stranger)).id, 'ben');
	const web = f.DB.db.prepare("SELECT s.id FROM sessions s LEFT JOIN device_sessions d ON d.session_id = s.id WHERE d.session_id IS NULL").get();
	assert.equal((await f.call(app.end, f.tokens.phone, web.id)).status, 404, 'the web session is not a device');
	assert.equal((await app.getUserFromSession(f.env, f.tokens.browser)).id, 'anna');
	assert.equal((await f.call(app.end, f.tokens.phone, 'missing')).status, 404);
	assert.equal((await f.call(app.list, null)).status, 401);
	assert.equal((await f.call(app.end, null, 'missing')).status, 401);
});

test('a device may end its own session', async (t) => {
	const f = await fixture(t);
	const {devices} = await (await f.call(app.list, f.tokens.phone)).json();
	assert.equal((await f.call(app.end, f.tokens.phone, devices.find((device) => device.current).id)).status, 200);
	assert.equal(await app.getUserFromSession(f.env, f.tokens.phone), null);
});
