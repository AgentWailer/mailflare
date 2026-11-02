import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const dir=mkdtempSync(join(process.cwd(),'node_modules','restore-safety-'));
after(()=>rmSync(dir,{recursive:true,force:true}));
writeFileSync(join(dir,'headers.mjs'),'export async function cookies(){return {get:()=>undefined};}');
await build({stdin:{contents:`export {SqliteDatabase} from './server/runtime/sqlite-database';export {applyMigrations} from './server/runtime/migrate';export {createSession} from './src/lib/auth/session';export {exportDatabaseRecords,restoreDatabaseRecords} from './src/lib/backups/export';export {POST} from './src/app/api/backups/restore/route';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:'tsconfig.json',alias:{'next/headers':join(dir,'headers.mjs'),'next/server':'next/server.js','cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')));
const bytes=doc=>new TextEncoder().encode(JSON.stringify(doc)).buffer;
async function fixture(t){
 const DB=new app.SqliteDatabase(':memory:');t.after(()=>{DB.db.close();delete globalThis.__mailflareNodeEnv;});
 await app.applyMigrations(DB,join(process.cwd(),'drizzle/migrations'));
 DB.db.exec(`INSERT INTO users(id,email,password_hash,name,role,is_primary_admin,created_at) VALUES('owner','owner@example.test','hash','Keep owner','admin',1,1);
 INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES('domain','owner','example.test','zone','active',1);
 INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES('box','owner','domain','owner','personal',1);
 INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,status,subject,text_body,created_at) VALUES('mail','owner','box','inbound','sender@example.test','owner@example.test','received','Keep mail','Body',1);`);
 const env={DB},token=await app.createSession(env,'owner');globalThis.__mailflareNodeEnv=env;
 const document=JSON.parse(new TextDecoder().decode(await app.exportDatabaseRecords(DB)));
 const queries=[],prepare=DB.prepare.bind(DB);DB.prepare=sql=>{queries.push(sql);return prepare(sql);};
 const unchanged=()=>{assert.equal(DB.db.prepare('SELECT name FROM users').get().name,'Keep owner');assert.equal(DB.db.prepare('SELECT subject FROM messages').get().subject,'Keep mail');assert.equal(DB.db.prepare('SELECT count(*) n FROM sessions').get().n,1);};
 return {DB,env,token,document,queries,unchanged};
}

test('invalid required data and schema mismatch are rejected before preparing any deletion',async t=>{
 const f=await fixture(t);
 for(const mutate of [doc=>doc.tables.users[0].email=null,doc=>doc.tables.users[0].future_column='new schema',doc=>doc.tables.messages[0].text_body={nested:'invalid'}]){
  const doc=structuredClone(f.document);mutate(doc);f.queries.length=0;
  await assert.rejects(app.restoreDatabaseRecords(f.DB,bytes(doc)),/invalid|pending database migrations/);
  assert(!f.queries.some(sql=>/^DELETE\b/i.test(sql)),'preflight must finish before destructive work is prepared');f.unchanged();
 }
});

test('late unique and foreign-key failures roll back the entire legacy restore',async t=>{
 const f=await fixture(t);
 for(const mutate of [doc=>doc.tables.users.push({...doc.tables.users[0]}),doc=>doc.tables.messages[0].mailbox_id='missing-box']){
  const doc=structuredClone(f.document);doc.tables.users[0].name='Replacement';mutate(doc);
  await assert.rejects(app.restoreDatabaseRecords(f.DB,bytes(doc)),/UNIQUE|FOREIGN KEY/);f.unchanged();
 }
});

test('a database write failure after earlier replacement rows cannot leave a partial restore',async t=>{
 const f=await fixture(t);f.DB.db.exec("CREATE TRIGGER reject_restored_mail BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END");
 const doc=structuredClone(f.document);doc.tables.users[0].name='Replacement';
 await assert.rejects(app.restoreDatabaseRecords(f.DB,bytes(doc)),/simulated disk failure/);f.unchanged();
});

test('valid legacy JSON restores atomically and a second restore remains idempotent',async t=>{
 const f=await fixture(t);f.document.tables.users[0].name='Restored';
 await app.restoreDatabaseRecords(f.DB,bytes(f.document));await app.restoreDatabaseRecords(f.DB,bytes(f.document));
 assert.equal(f.DB.db.prepare('SELECT name FROM users').get().name,'Restored');assert.equal(f.DB.db.prepare('SELECT count(*) n FROM messages').get().n,1);
});

test('Cloudflare legacy restore is retired before reading the upload or changing data',async t=>{
 const f=await fixture(t);const request=new Request('https://mailflare.test/api/backups/restore',{method:'POST',headers:{Authorization:'Bearer '+f.token}});
 request.formData=async()=>{throw Error('upload must not be parsed');};
 const response=await app.POST(request),body=await response.json();assert.equal(response.status,410);assert.equal(body.code,'rescue_restore_required');assert.match(body.recoveryGuide,/rescue-backup\.md$/);f.unchanged();assert(!f.queries.some(sql=>/^(DELETE|UPDATE|INSERT)\b/i.test(sql)));
});

test('bounded Node uploads retain supported legacy restore while malformed input changes nothing',async t=>{
 const f=await fixture(t);f.env.MAILFLARE_RUNTIME='node';
 const form=new FormData();form.set('backup',new File([bytes(f.document)],'backup.json',{type:'application/json'}));
 const response=await app.POST(new Request('https://mailflare.test/api/backups/restore',{method:'POST',headers:{Authorization:'Bearer '+f.token},body:form}));
 assert.equal(response.status,200);f.unchanged();
 const bad=new FormData();bad.set('backup',new File(['{'],'bad.json'));
 const failure=await app.POST(new Request('https://mailflare.test/api/backups/restore',{method:'POST',headers:{Authorization:'Bearer '+f.token},body:bad}));assert.equal(failure.status,400);f.unchanged();
});
