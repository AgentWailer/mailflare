import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const dir = mkdtempSync(join(process.cwd(), 'node_modules', 'mailflare-mail-changes-test-'));
after(() => rmSync(dir, {recursive: true, force: true}));
await build({stdin: {contents: `
 export {SqliteDatabase} from './server/runtime/sqlite-database';
 export {applyMigrations} from './server/runtime/migrate';
`, resolveDir: process.cwd()}, outfile: join(dir, 'app.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', tsconfig: 'tsconfig.json', logLevel: 'silent'});
const app = await import(pathToFileURL(join(dir, 'app.mjs')).href);

async function fixture(t) {
	const DB = new app.SqliteDatabase(':memory:');
	t.after(() => DB.db.close());
	await app.applyMigrations(DB, join(process.cwd(), 'drizzle/migrations'));
	DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES ('owner','owner@example.test','hash','Owner','user',1);
	INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES ('domain','owner','example.test','zone','active',1);
	INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES ('box','owner','domain','owner','personal',1),('shared','owner','domain','shared','shared',1);
	INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES ('label','owner','box','Work',1);`);
	const insert = DB.db.prepare(`INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,status,category,read,created_at) VALUES (?,'owner',?,'inbound','sender@example.test','owner@example.test','Note','received','primary',0,1)`);
	const add = (id, mailbox = 'box') => insert.run(id, mailbox);
	const changes = () => DB.db.prepare('SELECT mailbox_id, message_id, kind FROM mail_changes ORDER BY seq').all().map((row) => ({...row}));
	const clear = () => DB.db.exec('DELETE FROM mail_changes');
	return {DB, add, changes, clear};
}

test('inserting a message writes one changed row', async (t) => {
	const f = await fixture(t);
	f.add('m1');
	assert.deepEqual(f.changes(), [{mailbox_id: 'box', message_id: 'm1', kind: 'changed'}]);
	assert.ok(f.DB.db.prepare('SELECT changed_at FROM mail_changes').get().changed_at > 1_700_000_000);
});

test('updates a list or reader shows write a row and other updates do not', async (t) => {
	const f = await fixture(t);
	f.add('m1');
	const shown = {
		read: 1, starred: 1, status: "'archived'", folder_id: "'label'", category: "'promotions'", snoozed_until: 99,
		subject: "'New'", snippet: "'Short'", thread_id: "'thread'", text_body: "'Body'", html_body: "'<p>Body</p>'",
	};
	for (const [column, value] of Object.entries(shown)) {
		f.clear();
		f.DB.db.exec(`UPDATE messages SET ${column}=${value} WHERE id='m1'`);
		// A folder change also files the message under its label, which logs a second identical row.
		const rows = f.changes();
		assert.ok(rows.length >= 1, column);
		for (const row of rows) assert.deepEqual(row, {mailbox_id: 'box', message_id: 'm1', kind: 'changed'}, column);
	}
	for (const [column, value] of Object.entries({spam_score: 7, header_metadata: "'{}'"})) {
		f.clear();
		f.DB.db.exec(`UPDATE messages SET ${column}=${value} WHERE id='m1'`);
		assert.deepEqual(f.changes(), [], column);
	}
});

test('moving a message to another mailbox removes it from the old one', async (t) => {
	const f = await fixture(t);
	f.add('m1');
	f.clear();
	f.DB.db.exec("UPDATE messages SET mailbox_id='shared' WHERE id='m1'");
	assert.deepEqual(f.changes(), [
		{mailbox_id: 'box', message_id: 'm1', kind: 'removed'},
		{mailbox_id: 'shared', message_id: 'm1', kind: 'changed'},
	]);
});

test('deleting a message writes removed', async (t) => {
	const f = await fixture(t);
	f.add('m1');
	f.clear();
	f.DB.db.exec("DELETE FROM messages WHERE id='m1'");
	assert.deepEqual(f.changes(), [{mailbox_id: 'box', message_id: 'm1', kind: 'removed'}]);
});

test('assigning and removing a label writes changed', async (t) => {
	const f = await fixture(t);
	f.add('m1');
	f.clear();
	f.DB.db.exec("INSERT INTO message_labels(message_id,folder_id) VALUES ('m1','label')");
	assert.deepEqual(f.changes(), [{mailbox_id: 'box', message_id: 'm1', kind: 'changed'}]);
	f.clear();
	f.DB.db.exec("DELETE FROM message_labels WHERE message_id='m1'");
	assert.deepEqual(f.changes(), [{mailbox_id: 'box', message_id: 'm1', kind: 'changed'}]);
});

test('a message without a mailbox writes nothing', async (t) => {
	const f = await fixture(t);
	f.DB.db.exec("INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,status,created_at) VALUES ('loose','owner',NULL,'inbound','a@example.test','b@example.test','received',1)");
	f.DB.db.exec("UPDATE messages SET read=1 WHERE id='loose'");
	f.DB.db.exec("DELETE FROM messages WHERE id='loose'");
	assert.deepEqual(f.changes(), []);
});

test('a sequence number is never reused after pruning', async (t) => {
	const f = await fixture(t);
	f.add('m1');
	f.add('m2');
	const highest = f.DB.db.prepare('SELECT max(seq) AS seq FROM mail_changes').get().seq;
	f.clear();
	f.add('m3');
	assert.ok(f.DB.db.prepare('SELECT seq FROM mail_changes').get().seq > highest);
});

test('marking 5000 messages read stays within twice the cost without the change log', async (t) => {
	const names = ['mail_changes_messages_ai', 'mail_changes_messages_au', 'mail_changes_messages_ad'];
	const measure = async (withLog) => {
		const f = await fixture(t);
		if (!withLog) for (const name of names) f.DB.db.exec(`DROP TRIGGER ${name}`);
		f.DB.db.exec('BEGIN');
		for (let i = 0; i < 5000; i++) f.add('m' + i);
		f.DB.db.exec('COMMIT');
		let best = Infinity;
		for (let round = 0; round < 5; round++) {
			f.DB.db.exec('UPDATE messages SET read=0');
			const started = performance.now();
			f.DB.db.exec('UPDATE messages SET read=1');
			best = Math.min(best, performance.now() - started);
		}
		return best;
	};
	const baseline = await measure(false);
	const logged = await measure(true);
	t.diagnostic(`5000 updates: ${baseline.toFixed(1)} ms without the change log, ${logged.toFixed(1)} ms with it`);
	assert.ok(logged < baseline * 2, `change log made the update ${(logged / baseline).toFixed(2)} times slower`);
});
