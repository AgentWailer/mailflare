// Regenerates the JSON fixtures the Swift tests decode, from the real routes over a local
// SQLite database with the real migrations. Run from the repository root:
//   node ios/MailflareKit/Tests/MailflareKitTests/Fixtures/generate.mjs
import {build} from 'esbuild';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const out = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(process.cwd(), 'node_modules', 'mailflare-ios-fixtures-'));
try {
	writeFileSync(join(dir, 'headers.mjs'), 'export async function cookies(){return {get:()=>undefined};}');
	await build({stdin: {contents: `
	 export {SqliteDatabase} from './server/runtime/sqlite-database';
	 export {applyMigrations} from './server/runtime/migrate';
	 export {createSession} from './src/lib/auth/session';
	 export {GET as sync} from './src/app/api/app/sync/route';
	 export {GET as message} from './src/app/api/messages/[messageId]/route';
	 export {GET as thread} from './src/app/api/messages/[messageId]/thread/route';
	 export {GET as mailboxes} from './src/app/api/mailboxes/route';
	 export {GET as folders} from './src/app/api/folders/route';
	 export {GET as counts} from './src/app/api/messages/counts/route';
	 export {GET as list} from './src/app/api/messages/route';
	 export {GET as me} from './src/app/api/auth/me/route';
	`, resolveDir: process.cwd()}, outfile: join(dir, 'app.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', tsconfig: 'tsconfig.json', alias: {'next/headers': join(dir, 'headers.mjs'), 'next/server': 'next/server.js', 'cloudflare:workers': './server/runtime/cloudflare-workers.ts'}, logLevel: 'silent'});
	const app = await import(pathToFileURL(join(dir, 'app.mjs')).href);
	const DB = new app.SqliteDatabase(':memory:');
	await app.applyMigrations(DB, join(process.cwd(), 'drizzle/migrations'));
	// The local database interleaves concurrent batches; D1 does not. Run them one at a time here.
	const batch = DB.batch.bind(DB);
	let queue = Promise.resolve();
	DB.batch = (statements) => { const run = queue.then(() => batch(statements)); queue = run.catch(() => undefined); return run; };
	const at = 1795000000;
	DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES ('owner','owner@example.test','hash','Owner','admin',1);
	INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES ('domain','owner','example.test','zone','active',1);
	INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES ('box','owner','domain','owner','personal',1),('shared','owner','domain','team','shared',1);
	INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES ('label','owner','box','Work',1);
	INSERT INTO contacts(id,user_id,email,display_name,source,created_at) VALUES ('c1','owner','anna@example.org','Anna Krüger','manual',1);
	INSERT INTO messages(id,user_id,mailbox_id,direction,provider_message_id,from_addr,to_addr,cc_addr,subject,snippet,text_body,html_body,raw_r2_key,status,category,read,starred,thread_id,created_at) VALUES
	 ('m1','owner','box','inbound','<one@example.org>','Anna Krüger <anna@example.org>','owner@example.test','team@example.test','Termin am Donnerstag','Passt dir 14 Uhr?','Passt dir 14 Uhr?\nIch bringe die Unterlagen mit.','<p>Passt dir 14 Uhr?</p><p>Ich bringe die Unterlagen mit.</p>','raw/m1','received','primary',0,1,'t1',${at}),
	 ('m2','owner','box','outbound',NULL,'owner@example.test','anna@example.org',NULL,'Re: Termin am Donnerstag','Ja, passt.','Ja, passt.',NULL,NULL,'sent','primary',1,0,'t1',${at + 60}),
	 ('m3','owner','shared','inbound',NULL,'Stadtwerke <service@stadtwerke.example>','team@example.test',NULL,'Ihre Abrechnung','Anbei Ihre Abrechnung','Anbei Ihre Abrechnung',NULL,NULL,'received','invoices',1,0,NULL,${at - 86400});
	INSERT INTO message_labels(message_id,folder_id) VALUES ('m1','label');
	INSERT INTO message_attachments(id,message_id,filename,content_type,size,r2_key,disposition,created_at) VALUES ('a1','m1','Unterlagen.pdf','application/pdf',48213,'att/a1','attachment',${at});
	UPDATE messages SET snoozed_until=${at + 7200} WHERE id='m3';`);
	const env = {DB, MAILFLARE_RUNTIME: 'node', BUCKET: {get: async () => null, head: async () => null}};
	globalThis.__mailflareNodeEnv = env;
	const token = await app.createSession(env, 'owner');
	const get = async (handler, path, params) => {
		const response = await handler(new Request('https://mailflare.test' + path, {headers: {Authorization: 'Bearer ' + token}}), params ? {params: Promise.resolve(params)} : undefined);
		if (response.status !== 200) throw new Error(path + ' answered ' + response.status);
		return response.json();
	};
	const save = (name, data) => writeFileSync(join(out, name + '.json'), JSON.stringify(data, null, 2) + '\n');
	// The window is anchored to "now"; a 90 day window around a fixed date would be empty.
	DB.db.exec(`UPDATE messages SET created_at = created_at + (unixepoch() - ${at} - 3600)`);
	const first = await get(app.sync, '/api/app/sync?limit=2');
	save('sync-first', first);
	save('sync-second', await get(app.sync, '/api/app/sync?limit=2&cursor=' + first.cursor));
	save('message', await get(app.message, '/api/messages/m1', {messageId: 'm1'}));
	save('thread', await get(app.thread, '/api/messages/m1/thread', {messageId: 'm1'}));
	save('mailboxes', await get(app.mailboxes, '/api/mailboxes'));
	save('folders', await get(app.folders, '/api/folders?mailboxId=box'));
	save('counts', await get(app.counts, '/api/messages/counts'));
	save('counts-mailbox', await get(app.counts, '/api/messages/counts?mailboxId=box'));
	save('list', await get(app.list, '/api/messages?status=received&limit=50'));
	save('me', await get(app.me, '/api/auth/me'));
	DB.db.close();
} finally {
	rmSync(dir, {recursive: true, force: true});
}
