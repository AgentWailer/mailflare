import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const dir = mkdtempSync(join(process.cwd(), 'node_modules', 'mailflare-app-push-test-'));
after(() => rmSync(dir, {recursive: true, force: true}));
writeFileSync(join(dir, 'headers.mjs'), 'export async function cookies(){return {get:()=>undefined};}');
await build({stdin: {contents: `
 export {SqliteDatabase} from './server/runtime/sqlite-database';
 export {applyMigrations} from './server/runtime/migrate';
 export {createSession, createDeviceSession} from './src/lib/auth/session';
 export {sendPushNotifications} from './src/lib/push/server';
 export {resetApnsTokenCache} from './src/lib/push/apns';
 export {POST as register, DELETE as unregister} from './src/app/api/app/push/route';
`, resolveDir: process.cwd()}, outfile: join(dir, 'app.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', tsconfig: 'tsconfig.json', alias: {'next/headers': join(dir, 'headers.mjs'), 'next/server': 'next/server.js', 'cloudflare:workers': './server/runtime/cloudflare-workers.ts'}, logLevel: 'silent'});
const app = await import(pathToFileURL(join(dir, 'app.mjs')).href);

const phoneToken = 'a1'.repeat(32);
const tabletToken = 'b2'.repeat(32);

async function fixture(t, {configured = true} = {}) {
	const DB = new app.SqliteDatabase(':memory:');
	await app.applyMigrations(DB, join(process.cwd(), 'drizzle/migrations'));
	const pair = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
	const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
	const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
	const env = {DB, MAILFLARE_RUNTIME: 'node', ...(configured ? {APNS_KEY: pem, APNS_KEY_ID: 'KEY1234567', APNS_TEAM_ID: 'TEAM123456', APNS_BUNDLE_ID: 'de.example.mail'} : {})};
	globalThis.__mailflareNodeEnv = env;
	app.resetApnsTokenCache();
	DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES ('anna','anna@example.test','hash','Anna','user',1),('ben','ben@example.test','hash','Ben','user',1);
	INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES ('domain','anna','example.test','manual','active',1);
	INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES ('box','anna','domain','anna','personal',1),('ben-box','ben','domain','ben','personal',1);
	INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,snippet,thread_id,status,category,read,created_at) VALUES
	('m1','anna','box','inbound','Kita <kita@example.test>','anna@example.test','Elternabend','Am Dienstag um 19 Uhr.','t1','received','primary',0,1),
	('m2','anna','box','inbound','x@example.test','anna@example.test','Zweite','Noch ungelesen.',NULL,'received','primary',0,1),
	('spam','anna','box','inbound','x@example.test','anna@example.test','Gewinn','Jetzt.',NULL,'spam','primary',0,1);`);
	const tokens = {
		phone: await app.createDeviceSession(env, 'anna', 'Annas iPhone'),
		tablet: await app.createDeviceSession(env, 'anna', 'Annas iPad'),
		browser: await app.createSession(env, 'anna'),
		ben: await app.createDeviceSession(env, 'ben', 'Bens iPhone'),
	};
	const calls = [];
	let answer = () => new Response(null, {status: 200});
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (input, init = {}) => {
		const call = {url: String(input), headers: Object.fromEntries(new Headers(init.headers)), body: init.body ? JSON.parse(init.body) : null};
		calls.push(call);
		return answer(call);
	};
	t.after(() => { globalThis.fetch = realFetch; DB.db.close(); delete globalThis.__mailflareNodeEnv; });
	const call = (handler, session, body) => handler(new Request('https://mailflare.test/api/app/push', {
		method: body ? 'POST' : 'DELETE', headers: {'Content-Type': 'application/json', ...(session ? {'X-Mailflare-Session': session} : {})}, body: body ? JSON.stringify(body) : undefined,
	}));
	const devices = () => DB.db.prepare('SELECT user_id, token, environment FROM app_devices ORDER BY token').all().map((row) => ({...row}));
	const notify = (messageId = 'm1', users = ['anna'], extra = {}) => app.sendPushNotifications(env, users, {type: 'new_message', from: 'kita@example.test', fromName: 'Kita', mailboxId: 'box', messageId, subject: 'Elternabend', ...extra});
	return {DB, env, tokens, calls, call, devices, notify, pair, setAnswer: (next) => { answer = next; }};
}

test('an app registers its token for its own session, and only an app can', async (t) => {
	const f = await fixture(t);
	assert.equal((await f.call(app.register, null, {token: phoneToken, environment: 'production'})).status, 401);
	assert.equal((await f.call(app.register, f.tokens.browser, {token: phoneToken, environment: 'production'})).status, 403, 'a browser session has no device');
	for (const body of [{token: 'xyz', environment: 'production'}, {token: phoneToken, environment: 'elsewhere'}, {environment: 'production'}, {token: 'a'.repeat(513), environment: 'sandbox'}]) {
		assert.equal((await f.call(app.register, f.tokens.phone, body)).status, 400);
	}
	assert.equal((await f.call(app.register, f.tokens.phone, {token: phoneToken.toUpperCase(), environment: 'production'})).status, 200);
	assert.deepEqual(f.devices(), [{user_id: 'anna', token: phoneToken, environment: 'production'}]);
	// The same session registering again replaces its token.
	assert.equal((await f.call(app.register, f.tokens.phone, {token: tabletToken, environment: 'sandbox'})).status, 200);
	assert.deepEqual(f.devices(), [{user_id: 'anna', token: tabletToken, environment: 'sandbox'}]);
	assert.equal((await f.call(app.unregister, f.tokens.phone)).status, 200);
	assert.deepEqual(f.devices(), []);
});

test('a phone that signed in again is notified once, and two accounts on one phone both are', async (t) => {
	const f = await fixture(t);
	await f.call(app.register, f.tokens.phone, {token: phoneToken, environment: 'production'});
	// The same phone under a newer session of the same account, as after reinstalling the app.
	await f.call(app.register, f.tokens.tablet, {token: phoneToken, environment: 'production'});
	await f.call(app.register, f.tokens.ben, {token: phoneToken, environment: 'production'});
	assert.deepEqual(f.devices().map((row) => row.user_id), ['anna', 'ben']);
});

test('new mail is sent to Apple with sender, subject, preview, conversation, unread count and a signed token', async (t) => {
	const f = await fixture(t);
	await f.call(app.register, f.tokens.phone, {token: phoneToken, environment: 'production'});
	await f.call(app.register, f.tokens.tablet, {token: tabletToken, environment: 'sandbox'});
	await f.notify();
	assert.deepEqual(f.calls.map((call) => call.url).sort(), [
		'https://api.push.apple.com/3/device/' + phoneToken,
		'https://api.sandbox.push.apple.com/3/device/' + tabletToken,
	]);
	const call = f.calls.find((entry) => entry.url.includes(phoneToken));
	assert.equal(call.headers['apns-topic'], 'de.example.mail');
	assert.equal(call.headers['apns-push-type'], 'alert');
	assert.equal(call.headers['apns-priority'], '10');
	assert.equal(call.headers['apns-collapse-id'], 'm1');
	assert.ok(Number(call.headers['apns-expiration']) > Date.now() / 1000);
	assert.deepEqual(call.body, {
		aps: {alert: {title: 'Kita', subtitle: 'Elternabend', body: 'Am Dienstag um 19 Uhr.'}, badge: 2, sound: 'default', 'thread-id': 't1', category: 'MAIL', 'content-available': 1},
		messageId: 'm1', mailboxId: 'box', userId: 'anna',
	});
	const [scheme, jwt] = call.headers.authorization.split(' ');
	assert.equal(scheme, 'bearer');
	const [header, claims, signature] = jwt.split('.');
	assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), {alg: 'ES256', kid: 'KEY1234567'});
	const decoded = JSON.parse(Buffer.from(claims, 'base64url'));
	assert.equal(decoded.iss, 'TEAM123456');
	assert.ok(Math.abs(decoded.iat - Date.now() / 1000) < 60);
	assert.ok(await crypto.subtle.verify({name: 'ECDSA', hash: 'SHA-256'}, f.pair.publicKey, Buffer.from(signature, 'base64url'), new TextEncoder().encode(header + '.' + claims)));
	// Apple refuses a provider token renewed more than once in 20 minutes: it is reused.
	await f.notify('m2');
	assert.equal(f.calls.at(-1).headers.authorization, call.headers.authorization);
});

test('nothing is sent for spam, silent mail, a mailbox the user cannot read, an ended session or a disabled user', async (t) => {
	const f = await fixture(t);
	await f.call(app.register, f.tokens.phone, {token: phoneToken, environment: 'production'});
	await f.call(app.register, f.tokens.ben, {token: tabletToken, environment: 'production'});
	await f.notify('spam');
	await f.notify('m1', ['anna'], {silent: true});
	await f.notify('missing');
	assert.equal(f.calls.length, 0);
	await f.notify('m1', ['anna', 'ben']);
	assert.deepEqual(f.calls.map((call) => call.body.userId), ['anna'], 'Ben cannot read the mailbox');
	f.calls.length = 0;
	f.DB.db.exec("UPDATE sessions SET expires_at = 1 WHERE user_id = 'anna'");
	await f.notify();
	f.DB.db.exec("UPDATE sessions SET expires_at = 9999999999; UPDATE users SET disabled = 1 WHERE id = 'anna'");
	await f.notify();
	assert.equal(f.calls.length, 0);
});

test('a token Apple no longer knows is forgotten, another failure keeps it', async (t) => {
	const f = await fixture(t);
	await f.call(app.register, f.tokens.phone, {token: phoneToken, environment: 'production'});
	await f.call(app.register, f.tokens.tablet, {token: tabletToken, environment: 'production'});
	f.setAnswer((call) => call.url.includes(phoneToken)
		? new Response(JSON.stringify({reason: 'Unregistered'}), {status: 410})
		: new Response(JSON.stringify({reason: 'TooManyRequests'}), {status: 429}));
	await f.notify();
	assert.deepEqual(f.devices().map((row) => row.token), [tabletToken]);
	f.setAnswer(() => new Response(JSON.stringify({reason: 'BadDeviceToken'}), {status: 400}));
	await f.notify();
	assert.deepEqual(f.devices(), []);
});

test('without an Apple key nothing is sent and nothing is read, also on a database without the table', async (t) => {
	const f = await fixture(t, {configured: false});
	await f.call(app.register, f.tokens.phone, {token: phoneToken, environment: 'production'});
	f.DB.db.exec('DROP TABLE app_devices');
	await f.notify();
	assert.equal(f.calls.length, 0);
});

test('a database that lacks the table does not break the delivery of web push', async (t) => {
	const f = await fixture(t);
	f.DB.db.exec('DROP TABLE app_devices');
	await f.notify();
	assert.equal(f.calls.length, 0);
});
