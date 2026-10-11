import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const dir = mkdtempSync(join(process.cwd(), 'node_modules', 'mailflare-label-visibility-'));
after(() => rmSync(dir, {recursive:true, force:true}));
writeFileSync(join(dir,'headers.mjs'), 'export async function cookies(){return {get:()=>undefined};}');
await build({stdin:{contents:`
 export {SqliteDatabase} from './server/runtime/sqlite-database.ts';
 export {applyMigrations} from './server/runtime/migrate.ts';
 export {createSession} from './src/lib/auth/session.ts';
 export {GET,PATCH} from './src/app/api/settings/labels/route.ts';
 export {GET as listLabels} from './src/app/api/folders/route.ts';
 export {exportDatabaseRecords,restoreDatabaseRecords} from './src/lib/backups/export.ts';
`, resolveDir:process.cwd()}, outfile:join(dir,'app.mjs'), bundle:true, platform:'node', format:'esm', packages:'external', tsconfig:'tsconfig.json', alias:{'next/headers':join(dir,'headers.mjs'),'next/server':'next/server.js','cloudflare:workers':'./server/runtime/cloudflare-workers.ts'}, logLevel:'silent'});
const app = await import(pathToFileURL(join(dir,'app.mjs')).href);

async function fixture(t) {
 const DB = new app.SqliteDatabase(':memory:');
 await app.applyMigrations(DB, join(process.cwd(),'drizzle/migrations'));
 t.after(() => {DB.db.close(); delete globalThis.__mailflareNodeEnv;});
 DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES
 ('owner','owner@example.test','hash','Owner','user',1),('delegate','delegate@example.test','hash','Delegate','user',1),('foreign','foreign@example.test','hash','Foreign','user',1);
 INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES ('domain','owner','example.test','manual','active',1);
 INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES ('box','owner','domain','owner','personal',1),('other','foreign','domain','foreign','personal',1);
 INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES ('work','owner','box','Work',1),('family','owner','box','Family',1),('secret','foreign','other','Secret',1);
 INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES ('access','box','delegate','read_only',1);
 INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,status,created_at,folder_id) VALUES ('message','owner','box','inbound','sender@example.test','owner@example.test','received',1,'work');
 INSERT OR IGNORE INTO message_labels(message_id,folder_id) VALUES ('message','work');`);
 const env={DB,MAILFLARE_RUNTIME:'node'};globalThis.__mailflareNodeEnv=env;
 const tokens={};for(const id of ['owner','delegate','foreign']) tokens[id]=await app.createSession(env,id);
 const request=(actor='owner',body,mailbox='box')=>new Request('https://mailflare.test/api/settings/labels?mailboxId='+mailbox,{method:body===undefined?'GET':'PATCH',headers:{...(tokens[actor]?{Authorization:'Bearer '+tokens[actor]}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const patch=(labelId,visible=false,actor='owner',mailboxId='box')=>app.PATCH(request(actor,{mailboxId,labelId,visible}));
 const hidden=async(actor='owner',mailbox='box')=>{const response=await app.GET(request(actor,undefined,mailbox));assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'private, no-store');return (await response.json()).hiddenLabelIds;};
 return {DB,env,request,patch,hidden};
}

test('new users see every label; hide/show persists without altering mail or label definitions', async t => {
 const f=await fixture(t);assert.deepEqual(await f.hidden(),[]);
 assert.equal((await f.patch('work')).status,200);assert.deepEqual(await f.hidden(),['work']);
 assert.equal((await f.patch('work')).status,200);assert.deepEqual(await f.hidden(),['work']);
 assert.equal(f.DB.db.prepare('SELECT count(*) n FROM message_labels').get().n,1);
 assert.equal(f.DB.db.prepare("SELECT folder_id,status FROM messages WHERE id='message'").get().folder_id,'work');
 const labels=await app.listLabels(f.request());assert.equal((await labels.json()).folders.length,2);
 assert.equal((await f.patch('work',true)).status,200);assert.deepEqual(await f.hidden(),[]);
});

test('read-only delegates can change only their own sidebar; another device reads the saved choice', async t => {
 const f=await fixture(t);f.DB.db.exec("UPDATE mailboxes SET type='shared' WHERE id='box'");assert.equal((await f.patch('work',false,'delegate')).status,200);
 assert.deepEqual(await f.hidden('delegate'),['work']);assert.deepEqual(await f.hidden('owner'),[]);
 assert.equal((await f.patch('secret',false,'delegate','other')).status,404);
 assert.equal((await app.GET(f.request('delegate',undefined,'other'))).status,404);
 assert.deepEqual(await f.hidden('foreign','other'),[]);
});

test('authentication and strict validation reject missing, foreign and malformed label changes', async t => {
 const f=await fixture(t);
 assert.equal((await app.GET(f.request('unauthenticated'))).status,401);
 assert.equal((await f.patch('work',false,'unauthenticated')).status,401);
 for(const label of ['missing','secret']) assert.equal((await f.patch(label)).status,404);
 for(const body of [{mailboxId:'box',labelId:'work',visible:'false'},{mailboxId:'box',labelId:'work',visible:false,userId:'foreign'},{}]) assert.equal((await app.PATCH(f.request('owner',body))).status,400);
 assert.deepEqual(await f.hidden(),[]);
});

test('simultaneous changes retain both choices and corrupt historical JSON recovers safely', async t => {
 const f=await fixture(t);const results=await Promise.all([f.patch('work'),f.patch('family')]);assert(results.every(r=>r.status===200));
 assert.deepEqual(new Set(await f.hidden()),new Set(['work','family']));
 for(const value of ['invalid JSON','{}','null']) {
  f.DB.db.prepare("UPDATE users SET hidden_label_ids=? WHERE id='owner'").run(value);
  assert.deepEqual(await f.hidden(),[]);assert.equal((await f.patch('work')).status,200);assert.deepEqual(await f.hidden(),['work']);
 }
});

test('backups preserve visibility and older backups restore the all-visible default', async t => {
 const f=await fixture(t);await f.patch('work');
 const backup=await app.exportDatabaseRecords(f.DB);
 await f.patch('work',true);await app.restoreDatabaseRecords(f.DB,backup.buffer);
 assert.deepEqual(await f.hidden(),['work']);
 const legacy=JSON.parse(new TextDecoder().decode(backup));for(const user of legacy.tables.users) delete user.hidden_label_ids;
 await app.restoreDatabaseRecords(f.DB,new TextEncoder().encode(JSON.stringify(legacy)).buffer);
 assert.deepEqual(await f.hidden(),[]);assert.equal(f.DB.db.prepare('SELECT count(*) n FROM message_labels').get().n,1);
});
