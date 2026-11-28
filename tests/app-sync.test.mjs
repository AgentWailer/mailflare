import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const dir = mkdtempSync(join(process.cwd(), 'node_modules', 'mailflare-app-sync-test-'));
after(() => rmSync(dir, {recursive: true, force: true}));
writeFileSync(join(dir, 'headers.mjs'), 'export async function cookies(){return {get:()=>undefined};}');
await build({stdin: {contents: `
 export {SqliteDatabase} from './server/runtime/sqlite-database';
 export {applyMigrations} from './server/runtime/migrate';
 export {createSession} from './src/lib/auth/session';
 export {GET as sync} from './src/app/api/app/sync/route';
 export {pruneMailChanges} from './src/lib/app-sync/prune';
`, resolveDir: process.cwd()}, outfile: join(dir, 'app.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', tsconfig: 'tsconfig.json', alias: {'next/headers': join(dir, 'headers.mjs'), 'next/server': 'next/server.js', 'cloudflare:workers': './server/runtime/cloudflare-workers.ts'}, logLevel: 'silent'});
const app = await import(pathToFileURL(join(dir, 'app.mjs')).href);

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

async function fixture(t) {
	const DB = new app.SqliteDatabase(':memory:');
	await app.applyMigrations(DB, join(process.cwd(), 'drizzle/migrations'));
	// Match Cloudflare D1's binding limit rather than SQLite's larger local default.
	const prepare = DB.prepare.bind(DB);
	DB.prepare = (sql) => {
		const statement = prepare(sql), bind = statement.bind.bind(statement);
		statement.bind = (...values) => { assert(values.length <= 100, 'D1 statement exceeds 100 bound parameters'); return bind(...values); };
		return statement;
	};
	DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES ('owner','owner@example.test','hash','Owner','user',1),('other','other@example.test','hash','Other','user',1),('reader','reader@example.test','hash','Reader','user',1);
	INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES ('domain','owner','example.test','zone','active',1);
	INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES ('box','owner','domain','owner','personal',1),('private','other','domain','private','personal',1),('shared','owner','domain','shared','shared',1);
	INSERT INTO mailbox_access(id,user_id,mailbox_id,permission,created_at) VALUES ('access','reader','shared','read_only',1);
	INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES ('label','owner','box','Work',1);`);
	const insert = DB.db.prepare(`INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,snippet,text_body,html_body,raw_r2_key,status,category,read,created_at) VALUES (?,?,?,'inbound','Sender <sender@example.test>','owner@example.test',?,'Short','Long body','<p>Long body</p>','raw/key',?,'primary',0,?)`);
	const add = (id, {mailbox = 'box', status = 'received', age = 0, subject = 'Note'} = {}) => insert.run(id, mailbox === 'private' ? 'other' : 'owner', mailbox, subject, status, now() - age);
	const env = {DB, MAILFLARE_RUNTIME: 'node'};
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { DB.db.close(); delete globalThis.__mailflareNodeEnv; });
	const tokens = {};
	for (const id of ['owner', 'other', 'reader']) tokens[id] = await app.createSession(env, id);
	const call = async (params = {}, user = 'owner') => {
		const url = new URL('https://mailflare.test/api/app/sync');
		for (const [key, value] of Object.entries(params)) if (value != null) url.searchParams.set(key, String(value));
		const response = await app.sync(new Request(url, {headers: user ? {Authorization: 'Bearer ' + tokens[user]} : {}}));
		return {status: response.status, data: await response.json()};
	};
	/** Follow `more` until the server has nothing further, as a device does. */
	const drain = async (cursor, params = {}, user = 'owner') => {
		const pages = [];
		let page;
		do {
			page = (await call({...params, cursor}, user)).data;
			pages.push(page);
			cursor = page.cursor;
			assert.ok(pages.length < 50, 'sync does not terminate');
		} while (page.more && !page.reset);
		return {pages, cursor, messages: pages.flatMap((entry) => entry.messages), removed: pages.flatMap((entry) => entry.removed)};
	};
	return {DB, env, add, call, drain};
}

test('a first sync pages through the window newest first, without duplicates', async (t) => {
	const f = await fixture(t);
	for (let i = 0; i < 250; i++) f.add('m' + String(i).padStart(3, '0'), {age: i * 60});
	f.add('too-old', {age: 31 * DAY});
	f.add('draft', {status: 'draft', age: 5});
	f.add('trashed', {status: 'trash', age: 6});
	const first = (await f.call({limit: 100})).data;
	assert.equal(first.messages.length, 100);
	assert.equal(first.more, true);
	assert.equal(first.reset, false);
	assert.deepEqual(first.mailboxIds.sort(), ['box', 'shared']);
	assert.equal(first.messages[0].id, 'm000');
	const rest = await f.drain(first.cursor, {limit: 100});
	const ids = [...first.messages, ...rest.messages].map((message) => message.id);
	assert.equal(new Set(ids).size, ids.length, 'no message twice');
	assert.equal(ids.length, 252);
	assert.ok(!ids.includes('too-old'));
	assert.ok(ids.includes('draft') && ids.includes('trashed'));
	const created = [...first.messages, ...rest.messages].map((message) => new Date(message.createdAt).getTime());
	assert.deepEqual(created, [...created].sort((a, b) => b - a));
	assert.equal(rest.pages.at(-1).more, false);
});

test('a row carries what a list draws and never bodies or storage keys', async (t) => {
	const f = await fixture(t);
	f.add('m1');
	f.DB.db.exec("INSERT INTO message_labels(message_id,folder_id) VALUES ('m1','label'); INSERT INTO message_attachments(id,message_id,filename,content_type,size,r2_key,disposition,created_at) VALUES ('a1','m1','file.pdf','application/pdf',10,'key','attachment',1); INSERT INTO contacts(id,user_id,email,display_name,source,created_at) VALUES ('c1','owner','sender@example.test','Known Sender','manual',1)");
	const [row] = (await f.drain()).messages;
	assert.equal(row.subject, 'Note');
	assert.equal(row.snippet, 'Short');
	assert.equal(row.mailboxId, 'box');
	assert.equal(row.read, false);
	assert.equal(row.attachmentCount, 1);
	assert.deepEqual(row.labels.map((label) => label.id), ['label']);
	assert.equal(row.fromContactName, 'Known Sender');
	for (const hidden of ['textBody', 'htmlBody', 'rawR2Key', 'headerMetadata']) assert.ok(!(hidden in row), hidden);
});

test('changes made during and after the first sync arrive as changed and removed', async (t) => {
	const f = await fixture(t);
	for (let i = 0; i < 30; i++) f.add('m' + i, {age: i * 60});
	const first = (await f.call({limit: 10})).data;
	f.add('arrived-meanwhile');
	const initial = await f.drain(first.cursor, {limit: 10});
	assert.ok(initial.messages.some((message) => message.id === 'arrived-meanwhile'));

	f.DB.db.exec("UPDATE messages SET read=1 WHERE id='m1'; UPDATE messages SET status='archived' WHERE id='m2'; DELETE FROM messages WHERE id='m3'; UPDATE messages SET mailbox_id='private', user_id='other' WHERE id='m4'");
	f.add('old-but-touched', {age: 60 * DAY});
	f.DB.db.exec("UPDATE messages SET starred=1 WHERE id='old-but-touched'");
	const next = await f.drain(initial.cursor);
	const byId = Object.fromEntries(next.messages.map((message) => [message.id, message]));
	assert.equal(byId.m1.read, true);
	assert.equal(byId.m2.status, 'archived');
	assert.equal(byId['old-but-touched'].starred, true, 'changes outside the window still arrive');
	assert.deepEqual(next.removed.sort(), ['m3', 'm4']);
	assert.equal(new Set(next.messages.map((message) => message.id)).size, next.messages.length);

	const quiet = await f.drain(next.cursor);
	assert.deepEqual(quiet.messages, []);
	assert.deepEqual(quiet.removed, []);
	assert.equal(quiet.pages.length, 1);
});

test('a burst of changes larger than one page arrives completely', async (t) => {
	const f = await fixture(t);
	for (let i = 0; i < 450; i++) f.add('m' + i, {age: i});
	const initial = await f.drain(undefined, {limit: 100});
	f.DB.db.exec('UPDATE messages SET read=1');
	const next = await f.drain(initial.cursor, {limit: 100});
	assert.ok(next.pages.length > 1);
	assert.ok(next.pages.every((page) => page.messages.length <= 100));
	assert.equal(new Set(next.messages.map((message) => message.id)).size, 450);
	assert.ok(next.messages.every((message) => message.read === true));
});

test('mail in a mailbox the user cannot read never appears', async (t) => {
	const f = await fixture(t);
	f.add('mine');
	f.add('theirs', {mailbox: 'private'});
	f.add('team', {mailbox: 'shared'});
	const initial = await f.drain();
	assert.deepEqual(initial.messages.map((message) => message.id).sort(), ['mine', 'team']);
	f.DB.db.exec("UPDATE messages SET read=1 WHERE id='theirs'; DELETE FROM messages WHERE id='theirs'");
	const next = await f.drain(initial.cursor);
	assert.deepEqual(next.messages, []);
	assert.deepEqual(next.removed, [], 'a stranger\'s deletion is not announced');

	const reader = await f.drain(undefined, {}, 'reader');
	assert.deepEqual(reader.pages[0].mailboxIds, ['shared']);
	assert.deepEqual(reader.messages.map((message) => message.id), ['team']);
});

test('a revoked shared mailbox drops out of the readable mailboxes', async (t) => {
	const f = await fixture(t);
	f.add('team', {mailbox: 'shared'});
	const initial = await f.drain(undefined, {}, 'reader');
	f.DB.db.exec("DELETE FROM mailbox_access WHERE id='access'; UPDATE messages SET read=1 WHERE id='team'");
	const next = await f.drain(initial.cursor, {}, 'reader');
	assert.deepEqual(next.pages[0].mailboxIds, []);
	assert.deepEqual(next.messages, []);
});

test('a cursor the log no longer covers asks for a fresh start', async (t) => {
	const f = await fixture(t);
	f.add('m1');
	const initial = await f.drain();
	f.add('m2');
	f.add('m3');
	f.DB.db.exec('UPDATE mail_changes SET changed_at = changed_at - 50 * 86400');
	assert.equal(await app.pruneMailChanges(f.env, new Date()), 3);
	f.add('m4');
	const stale = (await f.call({cursor: initial.cursor})).data;
	assert.equal(stale.reset, true);
	assert.deepEqual(stale.messages, []);
	assert.deepEqual(stale.removed, []);
	assert.equal(stale.more, false);

	const fresh = await f.drain();
	f.DB.db.exec('DELETE FROM mail_changes');
	const stillGood = (await f.call({cursor: fresh.cursor})).data;
	assert.equal(stillGood.reset, false, 'an up-to-date cursor survives pruning');
});

test('a cursor from before a restore, a different window or plain garbage asks for a fresh start', async (t) => {
	const f = await fixture(t);
	for (let i = 0; i < 5; i++) f.add('m' + i);
	const initial = await f.drain();
	assert.equal((await f.call({cursor: initial.cursor, days: 14})).data.reset, true);
	assert.equal((await f.call({cursor: 'not-a-cursor'})).data.reset, true);
	assert.equal((await f.call({cursor: Buffer.from('{"v":2}').toString('base64url')})).data.reset, true);
	f.DB.db.exec("DELETE FROM mail_changes; DELETE FROM sqlite_sequence WHERE name='mail_changes'");
	assert.equal((await f.call({cursor: initial.cursor})).data.reset, true, 'the log restarted below the cursor');
});

test('pruning keeps 45 days', async (t) => {
	const f = await fixture(t);
	f.add('m1');
	f.add('m2');
	f.DB.db.exec("UPDATE mail_changes SET changed_at = changed_at - 44 * 86400 WHERE message_id='m1'; UPDATE mail_changes SET changed_at = changed_at - 46 * 86400 WHERE message_id='m2'");
	assert.equal(await app.pruneMailChanges(f.env, new Date()), 1);
	assert.deepEqual(f.DB.db.prepare('SELECT message_id FROM mail_changes').all().map((row) => row.message_id), ['m1']);
});

test('pruning does nothing on a database that has not been migrated yet', async (t) => {
	const f = await fixture(t);
	f.DB.db.exec('DROP TABLE mail_changes');
	assert.equal(await app.pruneMailChanges(f.env, new Date()), 0);
});

test('a request without a session is refused and odd parameters are bounded', async (t) => {
	const f = await fixture(t);
	assert.equal((await f.call({}, null)).status, 401);
	for (let i = 0; i < 5; i++) f.add('m' + i);
	assert.equal((await f.call({limit: 100000, days: 100000})).status, 200);
	assert.equal((await f.call({limit: -3})).data.messages.length, 1);
	assert.equal((await f.call({limit: 'abc', days: 'abc'})).status, 200);
});

test('a user who can read more than 100 mailboxes still syncs', async (t) => {
	const f = await fixture(t);
	const mailbox = f.DB.db.prepare("INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES (?,'owner','domain',?,'personal',1)");
	const message = f.DB.db.prepare("INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,status,category,read,created_at) VALUES (?,'owner',?,'inbound','a@example.test','b@example.test','Note','received','primary',0,?)");
	for (let i = 0; i < 130; i++) { mailbox.run('box' + i, 'local' + i); message.run('msg' + i, 'box' + i, now() - i); }
	const initial = await f.drain(undefined, {limit: 200});
	assert.equal(initial.messages.length, 130);
	f.DB.db.exec('UPDATE messages SET read=1');
	assert.equal((await f.drain(initial.cursor, {limit: 200})).messages.length, 130);
});
